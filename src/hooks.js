'use strict';

/**
 * src/hooks.js — 生命周期钩子（Hooks）
 *
 * 让「确定性策略」不再只写在系统提示词里靠模型自觉，而是由事件驱动强制执行。
 * 大厂智能体（Claude Code / Copilot）都用 hooks 做安全门与自动化：
 *   preToolUse  → 工具执行前，可 deny / ask / allow（安全门、危险命令拦截）
 *   postToolUse → 工具执行后，可跑 lint / 格式化 / 注入提示
 *   userPromptSubmit → 用户提问时注入额外上下文
 *   sessionStart / sessionEnd → 会话起止的准备与收尾
 *   onError → 出错时告警 / 记录
 *
 * 配置来源（后者覆盖/追加前者）：
 *   1) 用户级 ~/.fox-ai/hooks/hooks.json
 *   2) 工作区 <root>/.fox-ai/hooks/hooks.json
 *
 * 设计要点：
 *   - 零外部依赖，可离线单测（命令执行器可注入）。
 *   - 命令执行走 execFile 风格的参数数组，禁用 shell 元字符注入。
 *   - 单钩子超时、输出截断、异常永不冒泡打断主流程（除非显式 blockOnFail）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { appendLog } = require('./log');

const EVENTS = [
  'sessionStart',
  'userPromptSubmit',
  'preToolUse',
  'postToolUse',
  'onError',
  'sessionEnd'
];

const MAX_OUTPUT = 4000;
const DEFAULT_TIMEOUT = 15000;

/* ---------------- 路径 ---------------- */

function userHooksFile() {
  return path.join(os.homedir(), '.fox-ai', 'hooks', 'hooks.json');
}

function workspaceHooksFile(root) {
  if (!root) return '';
  return path.join(root, '.fox-ai', 'hooks', 'hooks.json');
}

/* ---------------- 加载与校验 ---------------- */

function readJson(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    const txt = fs.readFileSync(file, 'utf8');
    if (!txt.trim()) return null;
    return JSON.parse(txt);
  } catch (e) {
    appendLog('hooks', '[parse-fail] file=' + file + ' err=' + (e && e.message));
    return null;
  }
}

/** 规范化单条钩子定义，非法项返回 null（被丢弃并记日志） */
function normalizeHook(raw, event, source) {
  if (!raw || typeof raw !== 'object') return null;
  const action = raw.action || {};
  const type = String(action.type || '').toLowerCase();
  if (!['deny', 'ask', 'allow', 'command', 'log', 'inject'].includes(type)) {
    appendLog('hooks', '[skip-invalid-action] event=' + event + ' type=' + type);
    return null;
  }
  if (type === 'command' && !action.command) {
    appendLog('hooks', '[skip-no-command] event=' + event);
    return null;
  }
  if (type === 'inject' && !action.text) {
    appendLog('hooks', '[skip-no-text] event=' + event);
    return null;
  }
  const m = raw.matcher || {};
  return {
    name: String(raw.name || '未命名钩子'),
    event,
    source,
    enabled: raw.enabled !== false,
    matcher: {
      tool: m.tool ? String(m.tool) : '',
      kind: m.kind ? String(m.kind) : '',
      argsMatch: m.argsMatch && typeof m.argsMatch === 'object' ? m.argsMatch : null,
      textMatch: m.textMatch ? String(m.textMatch) : '',
      outputMatch: m.outputMatch ? String(m.outputMatch) : ''
    },
    action: {
      type,
      message: action.message ? String(action.message) : '',
      text: action.text ? String(action.text) : '',
      command: action.command ? String(action.command) : '',
      args: Array.isArray(action.args) ? action.args.map(String) : [],
      cwd: action.cwd ? String(action.cwd) : '',
      timeoutMs: Number(action.timeoutMs) > 0 ? Number(action.timeoutMs) : DEFAULT_TIMEOUT,
      blockOnFail: !!action.blockOnFail,
      injectOutput: !!action.injectOutput
    }
  };
}

/**
 * 加载并合并钩子配置。
 * @returns {{hooks: Object<string, Array>, files: string[], errors: string[]}}
 */
function loadHooks(opts) {
  const o = opts || {};
  const files = [];
  const errors = [];
  const hooks = {};
  for (const ev of EVENTS) hooks[ev] = [];

  const candidates = [
    { file: o.userFile || userHooksFile(), source: 'user' },
    { file: o.workspaceFile || workspaceHooksFile(o.workspaceRoot), source: 'workspace' }
  ];

  for (const c of candidates) {
    if (!c.file) continue;
    const data = readJson(c.file);
    if (!data) continue;
    files.push(c.file);
    const table = data.hooks && typeof data.hooks === 'object' ? data.hooks : data;
    for (const ev of EVENTS) {
      const list = table[ev];
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        const h = normalizeHook(raw, ev, c.source);
        if (h) hooks[ev].push(h);
        else errors.push(`${c.source}/${ev}: 无效钩子已跳过`);
      }
    }
  }
  return { hooks, files, errors };
}

/* ---------------- 匹配 ---------------- */

function safeRegex(pattern) {
  try {
    return new RegExp(pattern, 'i');
  } catch (_) {
    return null;
  }
}

/** 判断一条钩子是否匹配当前 payload */
function matches(hook, payload) {
  if (!hook.enabled) return false;
  const p = payload || {};
  const m = hook.matcher;

  if (m.tool) {
    const re = safeRegex('^(?:' + m.tool + ')$');
    if (!re || !re.test(String(p.tool || ''))) return false;
  }
  if (m.kind) {
    const re = safeRegex('^(?:' + m.kind + ')$');
    if (!re || !re.test(String(p.kind || ''))) return false;
  }
  if (m.argsMatch) {
    const args = p.args || {};
    for (const key of Object.keys(m.argsMatch)) {
      const re = safeRegex(String(m.argsMatch[key]));
      let val = args[key] === undefined || args[key] === null ? '' : String(args[key]);
      // argv 数组兜底（1.1.22）：run_command 传 argv 时 command 为空，把 argv 拼回字符串再匹配，
      // 避免「危险命令需人工确认」这类 command 正则钩子被 argv 模式绕过。
      if (!val && key === 'command' && Array.isArray(args.argv) && args.argv.length) {
        val = args.argv.join(' ');
      }
      if (!re || !re.test(val)) return false;
    }
  }
  if (m.textMatch) {
    const re = safeRegex(m.textMatch);
    if (!re || !re.test(String(p.text || ''))) return false;
  }
  if (m.outputMatch) {
    const re = safeRegex(m.outputMatch);
    if (!re || !re.test(String(p.output || ''))) return false;
  }
  return true;
}

/* ---------------- 变量插值 ---------------- */

/**
 * 把 ${tool} ${kind} ${path} ${command} ${text} ${output} ${cwd} ${args.xxx} 替换成真实值。
 * 注意：只用于参数数组元素（execFile 不经 shell），因此不需要 shell 转义，
 * 但仍剔除换行与控制字符，避免污染日志与命令行。
 */
function interpolate(str, payload) {
  const p = payload || {};
  const args = p.args || {};
  return String(str).replace(/\$\{([\w.]+)\}/g, (_m, key) => {
    let v;
    if (key.startsWith('args.')) v = args[key.slice(5)];
    else if (key === 'tool') v = p.tool;
    else if (key === 'kind') v = p.kind;
    else if (key === 'text') v = p.text;
    else if (key === 'output') v = p.output;
    else if (key === 'cwd') v = p.cwd;
    else if (key === 'error') v = p.error;
    else v = args[key];
    if (v === undefined || v === null) {
      // argv 兜底（1.1.22）：${command} 在 argv 模式下拼回字符串，message/描述不显示空值
      if (key === 'command' && Array.isArray(args.argv) && args.argv.length) v = args.argv.join(' ');
      else return '';
    }
    return String(v).replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 500);
  });
}

/* ---------------- 执行器 ---------------- */

/** 默认命令执行器：execFile 风格，不经 shell，避免注入 */
function defaultExec(cmd, args, opts) {
  return new Promise((resolve) => {
    let cp;
    try {
      cp = require('child_process').execFile(
        cmd,
        args,
        {
          cwd: opts.cwd || undefined,
          timeout: opts.timeoutMs || DEFAULT_TIMEOUT,
          maxBuffer: 1024 * 1024,
          windowsHide: true
        },
        (err, stdout, stderr) => {
          const out = String(stdout || '') + (stderr ? '\n' + String(stderr) : '');
          resolve({
            code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
            output: out.slice(0, MAX_OUTPUT),
            timedOut: !!(err && err.killed)
          });
        }
      );
    } catch (e) {
      resolve({ code: 1, output: '钩子命令启动失败：' + (e && e.message), timedOut: false });
      return;
    }
    if (!cp) resolve({ code: 1, output: '钩子命令未能启动', timedOut: false });
  });
}

/* ---------------- HookRunner ---------------- */

class HookRunner {
  /**
   * @param {object} opts
   * @param {string} opts.workspaceRoot 工作区根目录
   * @param {string} [opts.userFile] 覆盖用户级配置路径（测试用）
   * @param {string} [opts.workspaceFile] 覆盖工作区配置路径（测试用）
   * @param {Function} [opts.exec] 注入的命令执行器（测试用）
   * @param {boolean} [opts.enabled] 总开关
   */
  constructor(opts) {
    const o = opts || {};
    this.workspaceRoot = o.workspaceRoot || '';
    this.userFile = o.userFile;
    this.workspaceFile = o.workspaceFile;
    this.exec = o.exec || defaultExec;
    this.enabled = o.enabled !== false;
    this.hooks = {};
    this.files = [];
    this.errors = [];
    this.reload();
  }

  reload() {
    const r = loadHooks({
      workspaceRoot: this.workspaceRoot,
      userFile: this.userFile,
      workspaceFile: this.workspaceFile
    });
    this.hooks = r.hooks;
    this.files = r.files;
    this.errors = r.errors;
    const total = EVENTS.reduce((n, ev) => n + this.hooks[ev].length, 0);
    if (total) appendLog('hooks', '[loaded] total=' + total + ' files=' + this.files.join(','));
    return r;
  }

  /** 某事件下已注册的钩子数量 */
  count(event) {
    return (this.hooks[event] || []).length;
  }

  list(event) {
    if (!event) {
      const all = [];
      for (const ev of EVENTS) all.push(...(this.hooks[ev] || []));
      return all;
    }
    return (this.hooks[event] || []).slice();
  }

  /**
   * 触发一个生命周期事件。
   * @param {string} event
   * @param {object} payload { tool, kind, args, text, output, error, cwd }
   * @returns {Promise<{decision:'allow'|'deny'|'ask', reason:string, injects:string[], ran:number, results:Array}>}
   */
  async fire(event, payload) {
    const result = { decision: 'allow', reason: '', injects: [], ran: 0, results: [] };
    if (!this.enabled) return result;
    const list = this.hooks[event] || [];
    if (!list.length) return result;

    for (const hook of list) {
      if (!matches(hook, payload)) continue;
      result.ran++;
      const a = hook.action;
      try {
        if (a.type === 'log') {
          appendLog('hooks', '[log] ' + hook.name + ' event=' + event + ' tool=' + (payload && payload.tool));
          result.results.push({ hook: hook.name, type: 'log', ok: true });
          continue;
        }
        if (a.type === 'inject') {
          const txt = interpolate(a.text, payload);
          if (txt) result.injects.push(txt);
          result.results.push({ hook: hook.name, type: 'inject', ok: true, output: txt });
          continue;
        }
        if (a.type === 'allow') {
          result.decision = 'allow';
          result.reason = hook.name;
          result.results.push({ hook: hook.name, type: 'allow', ok: true });
          appendLog('hooks', '[allow] ' + hook.name + ' tool=' + (payload && payload.tool));
          return result; // 显式放行，短路
        }
        if (a.type === 'deny') {
          result.decision = 'deny';
          result.reason = interpolate(a.message || `钩子「${hook.name}」阻止了该操作`, payload);
          result.results.push({ hook: hook.name, type: 'deny', ok: true, output: result.reason });
          appendLog('hooks', '[deny] ' + hook.name + ' tool=' + (payload && payload.tool) + ' reason=' + result.reason.slice(0, 80));
          return result; // 阻断，短路
        }
        if (a.type === 'ask') {
          // 强制人工审批：不短路，继续跑后面的钩子（可能有 deny 优先级更高）
          if (result.decision !== 'deny') result.decision = 'ask';
          if (!result.reason) result.reason = interpolate(a.message || `钩子「${hook.name}」要求人工确认`, payload);
          result.results.push({ hook: hook.name, type: 'ask', ok: true });
          continue;
        }
        if (a.type === 'command') {
          const cmd = interpolate(a.command, payload);
          const args = a.args.map((x) => interpolate(x, payload));
          const cwd = a.cwd ? interpolate(a.cwd, payload) : (payload && payload.cwd) || this.workspaceRoot || undefined;
          const r = await this.exec(cmd, args, { cwd, timeoutMs: a.timeoutMs });
          const ok = r && r.code === 0;
          result.results.push({
            hook: hook.name,
            type: 'command',
            ok,
            code: r ? r.code : 1,
            output: r ? String(r.output || '').slice(0, MAX_OUTPUT) : ''
          });
          appendLog('hooks', '[command] ' + hook.name + ' cmd=' + cmd + ' code=' + (r ? r.code : '?'));
          if (a.injectOutput && r && r.output) {
            result.injects.push(`【钩子 ${hook.name} 输出】\n` + String(r.output).slice(0, 1500));
          }
          if (!ok && a.blockOnFail) {
            result.decision = 'deny';
            result.reason =
              interpolate(a.message || `钩子「${hook.name}」执行失败（退出码 ${r ? r.code : '?'}），已阻止该操作`, payload) +
              (r && r.output ? '\n' + String(r.output).slice(0, 800) : '');
            return result;
          }
          continue;
        }
      } catch (e) {
        // 钩子自身异常绝不打断主流程
        appendLog('hooks', '[hook-error] ' + hook.name + ' ' + (e && e.message ? e.message : String(e)));
        result.results.push({ hook: hook.name, type: a.type, ok: false, output: String(e && e.message) });
      }
    }
    return result;
  }

  /** 生成给用户看的状态摘要（面板/命令用） */
  describe() {
    const lines = [];
    if (!this.enabled) lines.push('钩子功能已关闭（foxAi.hooks.enabled = false）');
    if (!this.files.length) {
      lines.push('未找到钩子配置文件。可创建：');
      lines.push('  用户级：' + userHooksFile());
      if (this.workspaceRoot) lines.push('  工作区：' + workspaceHooksFile(this.workspaceRoot));
      return lines.join('\n');
    }
    lines.push('已加载配置：' + this.files.join('、'));
    for (const ev of EVENTS) {
      const list = this.hooks[ev] || [];
      if (!list.length) continue;
      lines.push(`\n[${ev}] ${list.length} 条`);
      for (const h of list) {
        const cond = [];
        if (h.matcher.tool) cond.push('tool=' + h.matcher.tool);
        if (h.matcher.kind) cond.push('kind=' + h.matcher.kind);
        if (h.matcher.argsMatch) cond.push('args=' + JSON.stringify(h.matcher.argsMatch));
        lines.push(
          `  - ${h.name} [${h.source}] ${h.action.type}${cond.length ? ' 当 ' + cond.join(' 且 ') : ''}${h.enabled ? '' : '（已禁用）'}`
        );
      }
    }
    if (this.errors.length) lines.push('\n⚠️ ' + this.errors.join('；'));
    return lines.join('\n');
  }
}

/** 示例配置（初始化命令写盘用） */
const SAMPLE_CONFIG = {
  version: 1,
  hooks: {
    preToolUse: [
      {
        name: '保护敏感文件',
        matcher: { tool: 'write_file|edit_file|delete_file', argsMatch: { path: '(\\.env|id_rsa|\\.pem)$' } },
        action: { type: 'deny', message: '禁止修改敏感文件 ${path}，请改用环境变量或询问用户。' }
      },
      {
        name: '危险命令需人工确认',
        matcher: { tool: 'run_command', argsMatch: { command: 'rm\\s+-rf|git\\s+reset\\s+--hard|drop\\s+database' } },
        action: { type: 'ask', message: '检测到高危命令，必须人工确认：${command}' }
      }
    ],
    postToolUse: [
      {
        name: 'JS 写后自动语法检查',
        enabled: false,
        matcher: { tool: 'write_file|edit_file', argsMatch: { path: '\\.js$' } },
        action: { type: 'command', command: 'node', args: ['--check', '${path}'], blockOnFail: false, injectOutput: true }
      }
    ],
    userPromptSubmit: [
      {
        name: '注入项目规约',
        enabled: false,
        matcher: {},
        action: { type: 'inject', text: '本项目要求：所有新增代码必须带中文注释，提交前跑 npm test。' }
      }
    ],
    sessionStart: [],
    sessionEnd: [],
    onError: []
  }
};

module.exports = {
  HookRunner,
  loadHooks,
  normalizeHook,
  matches,
  interpolate,
  userHooksFile,
  workspaceHooksFile,
  EVENTS,
  SAMPLE_CONFIG
};
