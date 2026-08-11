'use strict';

/**
 * run_in_sandbox 工具：让主控 agent 用沙盒自测它自己写的代码。
 *
 * action:
 *   - run（默认）：在指定沙盒里跑 code，返回 stdout/stderr/exit（隔离在临时目录）。
 *   - list：列出所有可用沙盒（内置 + 用户，含状态）。
 *   - reload：重新扫描沙盒目录，对新沙盒重跑 canary 校验。
 *
 * sandbox 参数用沙盒名或语言（不区分大小写，模糊匹配）。
 */

const sandbox = require('../sandbox');

const MAX_OUT = 2500;

function trunc(s) {
  if (!s) return '';
  s = String(s);
  if (s.length <= MAX_OUT) return s;
  const head = Math.floor(MAX_OUT * 0.6);
  const tail = MAX_OUT - head;
  return s.slice(0, head) + '\n…[输出已截断，共 ' + s.length + ' 字符，仅显示首尾]…\n' + s.slice(s.length - tail);
}

function formatList(res) {
  const rows = [];
  for (const b of res.builtins) {
    rows.push('🔒 ' + b.name + ' [' + b.language + '] 内置·' + (b.status === 'ready' ? 'ok' : 'err'));
  }
  for (const u of res.user) {
    const tag = u.status === 'ready' ? 'ok' : u.status === 'invalid' ? 'ERR' : '?';
    rows.push('🧩 ' + u.name + ' [' + u.language + '] ' + tag + (u.error ? ' ' + u.error : ''));
  }
  if (!rows.length) rows.push('（暂无沙盒）');
  return '沙盒目录 ' + sandbox.getManager().defaultDir() + '\n' + rows.join('\n');
}

function formatRun(res, key) {
  if (!res) {
    return '⚠️ 找不到可用的沙盒「' + key + '」。用 action="list" 查看。';
  }
  const lines = [
    key + '：' + (res.ok ? '✅ 成功' : '❌ 失败') + ' · 退出码 ' + (res.exit === null ? (res.killed ? '超时' : '?') : res.exit)
  ];
  if (res.error) lines.push('错误：' + res.error);
  if (res.stdout) lines.push('stdout:\n```\n' + trunc(res.stdout) + '\n```');
  if (res.stderr) lines.push('stderr:\n```\n' + trunc(res.stderr) + '\n```');
  // 仅失败时给日志路径，省 token
  if (!res.ok) lines.push('详细过程见 ~/.fox-ai/logs/sandbox.log');
  return lines.join('\n');
}

async function run(a, ctx) {
  a = a || {};
  const cfg = ctx && ctx.cfg;
  const mgr = sandbox.getManager(cfg);

  if (a.action === 'list') {
    return formatList(mgr.list());
  }
  if (a.action === 'reload') {
    await mgr.reload();
    return '🔄 已重新扫描沙盒目录并校验新沙盒：\n\n' + formatList(mgr.list());
  }

  // 默认 action=run
  if (!a.sandbox) {
    return '⚠️ 请指定 `sandbox`（沙盒名或语言，如 "node" / "python" / "go"）。可用 action="list" 查看全部。';
  }
  if (typeof a.code !== 'string' || !a.code.trim()) {
    return '⚠️ 请提供要运行的 `code`（源码字符串）。';
  }

  const res = await mgr.run(a.sandbox, a.code, { stdin: a.stdin });
  return formatRun(res, a.sandbox);
}

module.exports = { run };
