'use strict';

/**
 * review_changes 工具：对比代码「原始版（git HEAD）vs 当前修改版」，
 * 并主动进行一次深度思考，评估改动的可行性与风险。
 *
 * 与自动审查子代理（reviewer.js，每轮改动后静默跑）不同，这是一个**可被 agent
 * 主动调用**的工具：agent 在动手改大段代码前/后，可以拉取原始版与修改版对比，
 * 让模型聚焦「可行性」做结构化深度思考，而不是泛泛地审一遍。
 *
 * 支持焦点切换：feasibility（可行性）/ bugs（缺陷）/ security（安全）/ performance（性能）。
 * 深度思考复用当前 provider（chat / responses / anthropic 三种传输都支持），通过
 * execCtx.context 拿到 ExtensionContext 以读取密钥。模型调用失败时优雅降级为只返回 diff。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const config = require('../config');
const client = require('../client');
const anthropic = require('../anthropic');
const ws = require('./workspace');

const FOCUS_LABEL = {
  feasibility: '改动可行性与风险',
  bugs: '潜在缺陷排查',
  security: '安全风险评估',
  performance: '性能影响评估'
};

/** 各焦点对应的专家角色与附加规则（纯函数，便于测试） */
function buildDeepThinkSystem(focus) {
  const role =
    focus === 'security'
      ? '安全专家'
      : focus === 'performance'
      ? '性能优化专家'
      : focus === 'bugs'
      ? '代码缺陷猎人'
      : '资深架构师';
  const base = `你是一位${role}。你的任务：基于给出的代码改动 diff（原始版 vs 修改版），进行深度思考，帮助判断这次改动是否靠谱。`;
  const rules = `
# 规则
1. 你只能阅读提供的 diff，**绝对不能修改任何文件、不能执行命令、不能调用任何工具**。
2. 只输出 Markdown，不要寒暄，直接给结论。
3. 必须包含以下小节：
   - **可行性结论**：可行 / 基本可行（需微调）/ 风险高（建议重做）
   - **关键风险点**：逐条给出（位置/原因/影响/建议改法），按严重程度排序：🔴严重 / 🟡中等 / 🟢建议
   - **回归与破坏性评估**：本次改动是否会破坏现有功能或引入回归
4. 聚焦真正有价值的问题，不要挑无关紧要的风格问题。`;
  const extra =
    focus === 'security'
      ? '\n5. 安全焦点：必须排查注入（命令/SQL/路径穿越）、越权、密钥/敏感信息泄露、反序列化、XSS 等潜在漏洞，并给出缓解建议。'
      : focus === 'performance'
      ? '\n5. 性能焦点：必须评估时间/空间复杂度变化、是否引入额外 IO/循环/阻塞、是否可能在大输入下劣化。'
      : focus === 'bugs'
      ? '\n5. 缺陷焦点：必须排查空指针/未定义、边界条件、异步竞态、错误处理缺失、类型不一致等会直接导致报错或逻辑错误的点。'
      : '';
  return base + rules + extra;
}

function focusLabel(focus) {
  return FOCUS_LABEL[focus] || '改动分析';
}

/** 取 git 仓库根目录；非 git 返回 null */
function getGitRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim() || null;
  } catch (_) {
    return null;
  }
}

/** 取工作区相对 HEAD 的 diff；指定 path 时只取该文件 */
function getDiff(root, fileRel) {
  const args = ['diff', 'HEAD', '--'];
  if (fileRel) args.push(fileRel);
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    // git 报错（非仓库、无改动等）→ 视为无 diff
    return '';
  }
}

async function run(a, ctx) {
  a = a || {};
  const context = (ctx && ctx.context) || null;
  const folders = vscode.workspace.workspaceFolders;
  const root = (folders && folders[0] && folders[0].uri.fsPath) || process.cwd();
  const focus = a.focus || 'feasibility';

  const gitRoot = getGitRoot(root);
  if (!gitRoot) {
    return (
      '⚠️ 当前目录不是 git 仓库（或 git 不可用），无法获取「原始版 vs 修改版」对比。\n\n' +
      '建议：在该目录执行 `git init` 并提交一个基线版本，之后每次改动都能用本工具对比 HEAD。\n' +
      '（狐狸 AI 的自动代码审查子代理仍会在每轮改动后运行，可关注审查卡片。）'
    );
  }

  let diffText = getDiff(gitRoot, a.path);
  // 指定单文件且 git diff HEAD 为空（可能未跟踪）：尝试以「新增文件」呈现
  if (a.path && !String(diffText || '').trim()) {
    try {
      const abs = path.isAbsolute(a.path) ? a.path : path.join(gitRoot, a.path);
      if (fs.existsSync(abs)) {
        const newText = fs.readFileSync(abs, 'utf8');
        diffText = `diff --git a/${a.path} b/${a.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${a.path}\n@@ -0,0 +1,${String(newText).split('\n').length} @\n` +
          newText.split('\n').map((l) => '+' + l).join('\n') + '\n';
      }
    } catch (_) {
      /* 忽略 */
    }
  }

  if (!String(diffText || '').trim()) {
    return a.path
      ? `文件 ${a.path} 相对 HEAD 没有改动（可能已提交或内容一致）。`
      : '当前工作区相对 HEAD 没有任何改动（可能所有改动已提交）。没有可审查的 diff。';
  }

  // 单文件：打开原生 diff 视图，方便肉眼对照
  if (a.path) {
    try {
      const abs = path.isAbsolute(a.path) ? a.path : path.join(gitRoot, a.path);
      const oldText = execFileSync('git', ['show', 'HEAD:' + a.path], { cwd: gitRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      const newText = fs.readFileSync(abs, 'utf8');
      await ws.showDiff(a.path, oldText, newText, '原始版 vs 修改版');
    } catch (_) {
      /* 视图打开失败不影响返回结果 */
    }
  }

  // 深度思考（best-effort，失败则降级为只返回 diff）
  let analysis = '';
  try {
    const cfg = await config.resolve(context);
    const useResp = cfg.transport !== 'anthropic' && cfg.apiMode === 'responses';
    const backend =
      cfg.transport === 'anthropic'
        ? anthropic.chatNonStream
        : useResp
        ? client.chatNonStreamResponses
        : client.chatNonStream;
    const sys = buildDeepThinkSystem(focus);
    const r = await backend({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: '以下为本次改动（原始版 vs 修改版）的 diff：\n\n' + diffText }
      ],
      temperature: 0.3,
      maxTokens: cfg.maxTokens,
      timeout: cfg.timeout
    });
    analysis = (r && r.content) || '';
  } catch (e) {
    analysis = '（深度思考模型调用失败：' + ((e && e.message) || e) + '。已退回仅返回 diff，请主代理基于以下 diff 自行分析。）';
  }

  const header = a.path ? `文件：${a.path}` : '范围：整个工作区相对 HEAD 的改动';
  return (
    `# 代码改动对比（原始版 vs 修改版）\n\n` +
    `**${header}**\n\n` +
    `## Diff\n\n\`\`\`diff\n${diffText}\n\`\`\`\n\n` +
    (analysis ? `## 深度思考：${focusLabel(focus)}\n\n${analysis}\n` : '')
  );
}

module.exports = { run, buildDeepThinkSystem, focusLabel, getGitRoot, getDiff };
