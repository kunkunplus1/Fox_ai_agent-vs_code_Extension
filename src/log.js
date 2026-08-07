// 轻量持久日志：统一落盘到 ~/.fox-ai/logs/<name>.log
// 失败静默忽略，绝不影响主流程。供新能力（planner / selfConsistency / timeoutGuard）打点，
// 方便出 bug 时把日志文件发给维护者定位问题。
const fs = require('fs');
const path = require('path');
const os = require('os');

function appendLog(name, lines) {
  try {
    const dir = path.join(os.homedir(), '.fox-ai', 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name + '.log');
    const prefix = new Date().toISOString() + ' [pid:' + process.pid + '] ';
    const text = (Array.isArray(lines) ? lines : [String(lines)])
      .map((l) => prefix + (typeof l === 'string' ? l : JSON.stringify(l)))
      .join('\n') + '\n';
    fs.writeFileSync(file, text, { flag: 'a' });
  } catch (_) { /* 日志写入失败不得影响主流程 */ }
}

module.exports = { appendLog };
