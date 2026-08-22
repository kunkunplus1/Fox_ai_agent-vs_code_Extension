'use strict';

/*
 * src/auditLog.js — 统一审计日志
 *
 * 所有审计日志统一写入 ~/.fox-ai/logs/（与 memory.log / agent.log 等扩展日志同目录，
 * 该目录在各类环境（WebAI2API、无文件夹、普通工作区）下都可写、且用户可访问）。
 *
 * 不再使用 context.logUri：那是 VS Code 的 exthost 日志目录，可能为空、被轮转清理、
 * 或权限受限，导致审计日志从未落盘、面板永远「（无记录）」。
 *
 * 各文件：
 *   runtime-audit.log  —— 运行时安装/下载/改 PATH（runtimes.js）
 *   bridge-audit.log   —— 扩展桥接命令调用（extensionBridge.js）
 *   kb-organize.log    —— 知识库整理（knowledgeOrganizer.js）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/** 审计日志根目录：~/.fox-ai/logs */
function auditDir() {
  return path.join(os.homedir(), '.fox-ai', 'logs');
}

/** 追加一行审计日志；任何失败静默（审计不阻断主流程） */
function appendAudit(fileName, action, detail) {
  try {
    const dir = auditDir();
    fs.mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] ${action} ${detail ? JSON.stringify(detail) : ''}\n`;
    fs.appendFileSync(path.join(dir, fileName), line);
    return true;
  } catch (_) {
    return false;
  }
}

function auditRuntime(action, detail) { return appendAudit('runtime-audit.log', action, detail); }
function auditBridge(action, detail) { return appendAudit('bridge-audit.log', action, detail); }
function auditKB(action, detail) { return appendAudit('kb-organize.log', action, detail); }

module.exports = {
  auditDir,
  appendAudit,
  auditRuntime,
  auditBridge,
  auditKB
};
