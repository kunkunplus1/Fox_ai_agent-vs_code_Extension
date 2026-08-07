'use strict';

/*
 * src/extensionBridge.js — 插件互调用桥
 *
 * 让 fox-ai 在用户授权下调用其它已安装 VS Code 扩展的命令，并把自己的
 * 能力（聊天 / 文件读写 / 命令执行）暴露成可被其它扩展调用的命令。
 *
 * 安全原则：
 *   1. 默认禁止一切跨插件调用；只有用户手动勾选的「命令白名单」才放行。
 *   2. 调用外部命令前必须弹窗确认（除非该命令已在白名单且用户开启免确认）。
 *   3. 所有调用写入审计日志。
 */

function vscode() { return require('vscode'); }
function conf() { return require('./config').conf(); }
const { tw } = require('./i18n');

// VS Code 命令 title 可能是字符串，也可能是本地化对象 { value, original }
function normalizeTitle(title) {
  if (typeof title === 'string') return title;
  if (title && typeof title === 'object') {
    if (typeof title.value === 'string') return title.value;
    if (typeof title.original === 'string') return title.original;
    if (typeof title.label === 'string') return title.label;
  }
  return '';
}

// 发现所有已装扩展，返回精简信息
function listExtensions() {
  const ext = vscode().extensions;
  return ext.all.map((e) => {
    const pkg = e.packageJSON || {};
    const commands = (pkg.contributes && pkg.contributes.commands) || [];
    return {
      id: e.id,
      displayName: pkg.displayName || pkg.name,
      version: pkg.version,
      isBuiltin: e.isBuiltin,
      active: e.isActive,
      commands: commands.map((c) => ({ command: c.command, title: normalizeTitle(c.title) }))
    };
  });
}

// 汇总所有扩展暴露的命令，形成可调用目录
function commandCatalog() {
  const out = [];
  for (const e of listExtensions()) {
    for (const c of e.commands) {
      out.push({ command: c.command, title: c.title, extension: e.id, builtin: e.isBuiltin });
    }
  }
  return out;
}

function allowedCommands() {
  return conf().get('bridge.allowedCommands', []);
}
function isAllowed(commandId) {
  return allowedCommands().includes(commandId);
}

// 调用外部扩展命令（带授权检查）
async function callExtensionCommand(context, commandId, args, { skipConfirm = false } = {}) {
  const catalog = commandCatalog();
  const entry = catalog.find((c) => c.command === commandId);
  if (!entry) throw new Error('找不到命令：' + commandId);

  const allowed = isAllowed(commandId);
  audit(context, 'bridge.call', { command: commandId, allowed });

  if (!allowed) {
    const choice = await vscode().window.showWarningMessage(
      `狐狸 AI 想调用扩展「${entry.extension}」的命令：\n${entry.title} (${commandId})\n是否允许？`,
      { modal: true }, '允许一次', '允许并加入白名单', '拒绝'
    );
    if (choice === '拒绝' || choice === undefined) {
      audit(context, 'bridge.denied', { command: commandId });
      throw new Error('用户拒绝调用：' + commandId);
    }
    if (choice === '允许并加入白名单') {
      const list = allowedCommands();
      if (!list.includes(commandId)) list.push(commandId);
      await conf().update('bridge.allowedCommands', list, vscode().ConfigurationTarget.Global);
      vscode().window.showInformationMessage(tw('已把 {0} 加入白名单', commandId));
    }
  } else if (!skipConfirm) {
    // 已授权但默认仍确认一次（除非用户在设置里开启免确认）
    if (!conf().get('bridge.silentAllowed', false)) {
      const choice = await vscode().window.showInformationMessage(
        `即将调用白名单命令：${entry.title}\n(${commandId})`, '继续', '取消'
      );
      if (choice !== '继续') { audit(context, 'bridge.cancelled', { command: commandId }); return null; }
    }
  }

  try {
    const result = await vscode().commands.executeCommand(commandId, ...(Array.isArray(args) ? args : (args ? [args] : [])));
    audit(context, 'bridge.ok', { command: commandId });
    return result;
  } catch (e) {
    audit(context, 'bridge.error', { command: commandId, error: String(e.message) });
    throw e;
  }
}

// 暴露 fox-ai 自身能力供其它扩展调用
function registerFoxApi(context, chatProvider) {
  const reg = (id, fn) => context.subscriptions.push(vscode().commands.registerCommand(id, fn));
  // 其它扩展可在授权后调用：狐狸 AI 发起一次提问
  reg('foxAi.bridge.ask', async (question, options) => {
    if (!chatProvider) throw new Error('chat 未就绪');
    return chatProvider.ask(question, options || {});
  });
  reg('foxAi.bridge.isReady', () => !!chatProvider);
}

// 审计
function audit(context, action, detail) {
  try {
    const fs = require('fs');
    const path = require('path');
    const dir = context && context.logUri ? context.logUri.fsPath : require('os').tmpdir();
    fs.mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] ${action} ${detail ? JSON.stringify(detail) : ''}\n`;
    fs.appendFileSync(path.join(dir, 'bridge-audit.log'), line);
  } catch (_) {}
}

module.exports = {
  listExtensions, commandCatalog, allowedCommands, isAllowed,
  callExtensionCommand, registerFoxApi, audit
};
