'use strict';

/**
 * Harness（管理系统）核心模块
 * 三层职责：
 *   1. TaskManager  —— 任务状态机 + 持久化（长期记忆）
 *   2. PolicyEngine —— 统一策略引擎（审批/安全/敏感文件/命令黑名单）
 *   3. verify       —— 自动验证层（命令 exit code / 写后诊断 / 安装版本校验）
 *
 * 本模块不依赖 'vscode'，storage 以接口注入，便于在纯 Node 下单测。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

/* ===================== 1. 任务状态机 ===================== */

const TASK_STATES = {
  QUEUED: 'queued',
  RUNNING: 'running',
  PAUSED: 'paused',
  AWAITING: 'awaiting-approval',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

// 允许的状态迁移（防止状态机乱跳）
const VALID_TRANSITIONS = {
  queued: ['running', 'cancelled'],
  running: ['paused', 'awaiting-approval', 'completed', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  'awaiting-approval': ['running', 'cancelled', 'failed'],
  completed: [],
  failed: ['running'], // 失败后可重试
  cancelled: []
};

class TaskManager {
  /**
   * @param {object} opts
   * @param {object} [opts.storage] Memento 兼容接口 { get(k, d), update(k, v) }
   * @param {string} [opts.dir] 持久化目录（无 storage 时落盘）
   */
  constructor(opts = {}) {
    this.storage = opts.storage || null;
    this.dir = opts.dir || path.join(os.homedir(), '.fox-ai', 'tasks');
    this.indexKey = 'foxAi.tasks.index';
    if (!this.storage) fs.mkdirSync(path.join(this.dir, 'tasks'), { recursive: true });
  }

  _indexFile() { return path.join(this.dir, 'tasks', 'index.json'); }
  _taskFile(id) { return path.join(this.dir, 'tasks', id + '.json'); }
  _taskKey(id) { return 'foxAi.task.' + id; }

  async _loadIndex() {
    if (this.storage) return (await this.storage.get(this.indexKey, {})) || {};
    try { return JSON.parse(fs.readFileSync(this._indexFile(), 'utf8')); } catch (_) { return {}; }
  }

  async _saveIndex(idx) {
    if (this.storage) { await this.storage.update(this.indexKey, idx); return; }
    fs.writeFileSync(this._indexFile(), JSON.stringify(idx, null, 2));
  }

  async _loadTask(id) {
    if (this.storage) return await this.storage.get(this._taskKey(id), null);
    try { return JSON.parse(fs.readFileSync(this._taskFile(id), 'utf8')); } catch (_) { return null; }
  }

  async _saveTask(task) {
    if (this.storage) {
      await this.storage.update(this._taskKey(task.id), task);
    } else {
      fs.writeFileSync(this._taskFile(task.id), JSON.stringify(task, null, 2));
    }
    const idx = await this._loadIndex();
    idx[task.id] = {
      id: task.id, type: task.type, title: task.title,
      state: task.state, createdAt: task.createdAt, updatedAt: task.updatedAt,
      finishedAt: task.finishedAt || null,
      sessionId: task.sessionId || null,
      stepsCount: (task.steps || []).length
    };
    await this._saveIndex(idx);
  }

  async createTask({ type, title, meta = {}, sessionId = null }) {
    const id = 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const now = new Date().toISOString();
    const task = {
      id, type, title, state: TASK_STATES.QUEUED,
      createdAt: now, updatedAt: now, finishedAt: null,
      meta, steps: [], sessionId: sessionId || null
    };
    await this._saveTask(task);
    return task;
  }

  async getTask(id) { return this._loadTask(id); }

  async updateState(id, state, { force = false } = {}) {
    const task = await this._loadTask(id);
    if (!task) return null;
    const allowed = VALID_TRANSITIONS[task.state] || [];
    if (!force && allowed.length && !allowed.includes(state)) {
      // 不允许的迁移：记录但不强改
      task._lastInvalidTransition = { from: task.state, to: state, at: new Date().toISOString() };
    } else {
      task.state = state;
    }
    task.updatedAt = new Date().toISOString();
    if ([TASK_STATES.COMPLETED, TASK_STATES.FAILED, TASK_STATES.CANCELLED].includes(state)) {
      task.finishedAt = task.updatedAt;
    }
    await this._saveTask(task);
    return task;
  }

  async appendStep(id, step) {
    const task = await this._loadTask(id);
    if (!task) return null;
    step.ts = new Date().toISOString();
    task.steps.push(step);
    task.updatedAt = step.ts;
    await this._saveTask(task);
    return task;
  }

  async updateTask(id, patch) {
    const task = await this._loadTask(id);
    if (!task) return null;
    Object.assign(task, patch);
    task.updatedAt = new Date().toISOString();
    await this._saveTask(task);
    return task;
  }

  async listTasks() {
    const idx = await this._loadIndex();
    const list = Object.values(idx);
    // 兼容旧索引：补回 stepsCount（避免 UI 一直显示 0 步）
    let needsSave = false;
    for (const item of list) {
      if (typeof item.stepsCount !== 'number') {
        const full = await this._loadTask(item.id);
        item.stepsCount = (full && full.steps || []).length;
        idx[item.id] = item;
        needsSave = true;
      }
    }
    if (needsSave) await this._saveIndex(idx);
    list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return list;
  }

  async deleteTask(id) {
    if (this.storage) {
      await this.storage.update(this._taskKey(id), null);
    } else {
      try { fs.unlinkSync(this._taskFile(id)); } catch (_) {}
    }
    const idx = await this._loadIndex();
    delete idx[id];
    await this._saveIndex(idx);
  }

  /** 找出可恢复的未完成任务（崩溃恢复用） */
  async listResumable() {
    const all = await this.listTasks();
    return all.filter((t) => ['queued', 'running', 'paused', 'awaiting-approval', 'failed'].includes(t.state));
  }
}

/* ===================== 2. 统一策略引擎 ===================== */

const OP = {
  READ: 'read',
  WRITE: 'write',
  EXEC: 'exec',
  NETWORK: 'network',
  DOWNLOAD: 'download',
  INSTALL: 'install',
  ELEVATE: 'elevate',
  CALL_EXT: 'call_ext'
};

// 敏感文件/目录（命中则「写」操作强制拦截）
const DEFAULT_SENSITIVE = [
  /[\\/]\.env(\.|$)/i,
  /[\\/]\.ssh[\\/]/i,
  /id_(rsa|dsa|ecdsa|ed25519)/i,
  /[\\/](private_key|\.private_key)/i,
  /\.(pem|key|p12|pfx)$/i,
  /(credentials|secrets?)\.json$/i,
  /[\\/]\.aws[\\/]credentials/i,
  /known_hosts$/i,
  /[\\/]shadow$/i,
  /[\\/]gshadow$/i
];

// 危险命令黑名单（命中则强制拦截）
const DEFAULT_BLOCKED_COMMANDS = [
  /rm\s+-rf?\s+[\\/]/i,
  /rmdir\s+\/?\s*\/s/i,
  /format\s+[a-z]:/i,
  /shutdown(\.exe)?(\s|$)/i,
  /mkfs/i,
  /dd\s+if=/i,
  /diskpart/i,
  /cipher\s+\/w/i,
  />?\s*\/dev\/(sd|hd|nvme|vda)/i,
  /(@|iex|invoke-expression)\s*\(/i
];

function toRegex(x) {
  if (x instanceof RegExp) return x;
  const esc = String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(esc, 'i');
}

class PolicyEngine {
  constructor(cfg = {}) {
    const policy = cfg.policy || {};
    this.mode = cfg.autoApprove || policy.mode || 'read';
    this.sensitive = DEFAULT_SENSITIVE.concat((policy.blockedPaths || []).map(toRegex));
    this.blockedCmds = DEFAULT_BLOCKED_COMMANDS.concat((cfg.blockedCommands || []).map(toRegex));
    this.allowExt = policy.allowedCommands || [];
  }

  /**
   * @param {string} op OP.*
   * @param {object} [opts] { path, command, label }
   * @returns {{decision:'auto'|'ask'|'deny', reason:string}}
   */
  evaluate(op, opts = {}) {
    // 1) 敏感文件写拦截
    if (op === OP.WRITE && opts.path && this._isSensitive(opts.path)) {
      return {
        decision: 'deny',
        reason: `该路径属于敏感文件/目录（${path.basename(opts.path)}），出于安全策略被强制拦截，不会写入。如确需修改请手动进行。`
      };
    }
    // 2) 危险命令拦截
    if ((op === OP.EXEC || op === OP.INSTALL) && opts.command && this._isBlockedCmd(opts.command)) {
      return {
        decision: 'deny',
        reason: `命令命中危险命令黑名单，已被安全策略拦截：${String(opts.command).slice(0, 120)}`
      };
    }
    // 3) 跨扩展调用：白名单内命令自动放行
    if (op === OP.CALL_EXT && opts.command && this.allowExt.includes(opts.command)) {
      return { decision: 'auto', reason: '扩展命令已在白名单内' };
    }

    // 4) 分级放行
    const order = { off: -1, read: 0, edit: 1, network: 2, exec: 3, install: 4, all: 5 };
    const need = { read: 0, write: 1, exec: 3, network: 2, download: 4, install: 4, elevate: 5, call_ext: 3 };
    const m = order[this.mode] != null ? order[this.mode] : 0;
    const n = need[op] != null ? need[op] : 1;
    if (m >= n) return { decision: 'auto', reason: 'autoApprove 分级允许' };
    return { decision: 'ask', reason: `需要用户确认：${opts.label || op}` };
  }

  _isSensitive(p) {
    const s = String(p);
    return this.sensitive.some((re) => re.test(s));
  }

  _isBlockedCmd(cmd) {
    const s = String(cmd);
    return this.blockedCmds.some((re) => re.test(s));
  }

  isSensitive(p) { return this._isSensitive(p); }
  isBlockedCommand(cmd) { return this._isBlockedCmd(cmd); }
}

/* ===================== 3. 自动验证层 ===================== */

/** 命令执行结果校验：非 0 退出码视为失败，反馈 stderr */
function verifyCommand(exitCode, stdout, stderr) {
  if (exitCode === 0) return { ok: true };
  const feedback = String(stderr || stdout || '')
    .split('\n')
    .slice(0, 30)
    .join('\n');
  return {
    ok: false,
    feedback: `命令以退出码 ${exitCode} 结束。错误输出：\n${feedback}\n请分析错误并修复后重试。`
  };
}

/**
 * 写文件后的诊断校验（需注入获取诊断的函数）
 * @param {function} getDiagnostics (uri) => Promise<Array>
 * @param {string} uri
 */
async function verifyWriteDiagnostics(getDiagnostics, uri) {
  if (typeof getDiagnostics !== 'function') return { ok: true, skipped: true };
  try {
    const diags = await getDiagnostics(uri);
    if (diags && diags.length) {
      const errs = diags.filter((d) => d.severity <= 1).length;
      const warns = diags.length - errs;
      return {
        ok: errs === 0,
        diagnostics: diags.length,
        errors: errs,
        warnings: warns,
        feedback: `写入后检测到 ${diags.length} 条诊断（错误 ${errs}，警告 ${warns}），请确认是否需要修复。`
      };
    }
    return { ok: true, diagnostics: 0 };
  } catch (e) {
    return { ok: true, skipped: true, error: String(e && e.message) };
  }
}

/**
 * 安装后版本校验
 * @param {function} run (versionArg) => Promise<{code:number, out:string}>
 * @param {string} [versionArg]
 */
async function verifyInstall(run, versionArg) {
  if (typeof run !== 'function') return { ok: true, skipped: true };
  try {
    const r = await run(versionArg || '--version');
    if (r && r.code === 0) {
      return { ok: true, version: String(r.out || '').trim().split('\n')[0] };
    }
    return {
      ok: false,
      feedback: `安装后版本校验失败（exit ${r ? r.code : '?'})：${String((r && r.out) || '').slice(0, 200)}`
    };
  } catch (e) {
    return { ok: false, feedback: String(e && e.message) };
  }
}

/**
 * 写 JS 文件后的语法校验（node --check）
 * @param {string} filePath 文件绝对路径
 * @param {string} [nodePath] 可选的 node 可执行路径，缺省用 'node'
 * @returns {{ok:boolean, skipped?:boolean, feedback?:string, error?:string}}
 */
function verifyNodeSyntax(filePath, nodePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (!['.js', '.mjs', '.cjs'].includes(ext)) return { ok: true, skipped: true };
  const node = (nodePath && String(nodePath).trim()) || 'node';
  try {
    const r = cp.spawnSync(node, ['--check', filePath], { encoding: 'utf8', timeout: 15000 });
    if (r.error) {
      // 找不到 node 命令则跳过校验
      return { ok: true, skipped: true, error: String(r.error.message) };
    }
    if (r.status === 0) return { ok: true };
    const out = String(r.stderr || r.stdout || '').trim();
    return {
      ok: false,
      feedback: 'node --check 语法检查未通过：\n' + out.split('\n').slice(0, 12).join('\n')
    };
  } catch (e) {
    return { ok: true, skipped: true, error: String(e && e.message) };
  }
}

module.exports = {
  TaskManager,
  TASK_STATES,
  OP,
  DEFAULT_SENSITIVE,
  DEFAULT_BLOCKED_COMMANDS,
  PolicyEngine,
  verifyCommand,
  verifyWriteDiagnostics,
  verifyInstall,
  verifyNodeSyntax
};
