#!/usr/bin/env node
'use strict';
/**
 * fox.js —— fox-ai 工具链 CLI（给 agent 用的固定模板执行层）
 *
 * 设计目标（对齐用户三点担忧）：
 * 1. 缓存红利：agent 每次用「完全相同的调用串」调用（fox <工具名> <JSON 参数>），
 *    长任务中固定前缀反复出现 → 命中 Prompt Cache，不花重复 token。
 * 2. 试错成本低：统一输出协议 foxai-ok / foxai-err，错误单行摘要走 stderr，
 *    agent 一次看懂，不用回传全文；工具自身超时/熔断由 execute() 提供。
 * 3. 输出精简：默认截断（maxToolOutput 默认 8000，智能头尾截断），
 *    --full 才全量 —— agent 不需要额外提醒「只取前 10 行」。
 *
 * 用法：
 *   fox <tool_name> [--json '{"参数":...}'] [--full] [--timeout <ms>] [--cwd <dir>]
 *   fox --list              # 列出 CLI 可用工具（带 kind）
 *   fox --help <tool_name>  # 查看工具参数 Schema 与描述
 *   fox <tool_name> --help  # 同上
 *
 * 退出码：
 *   0 = 成功；1 = 工具执行失败/超时；2 = 参数错误/用法错误；3 = 内部异常
 */

const path = require('path');
const fs = require('fs');

// ---- 拦截 require('vscode')：无窗口 mock，让整条工具链能复用 ----
const _moduleLoad = require('module')._load;
const mockPath = path.join(__dirname, 'vscodeMock.js');
require('module')._load = function (request, parent, isMain) {
  // 必须返回 mock 模块导出的 .vscode 对象本身（不是包了一层 {vscode,...} 的整体）
  if (request === 'vscode') return require(mockPath).vscode;
  return _moduleLoad.apply(this, arguments);
};

const toolsIndex = require('../tools/index.js');
const { UserSkillStore, defaultDir } = require('../skills.js');
const { execFileSync } = require('child_process');

// ---- 35 工具白名单：可脱离编辑器独立执行的纯逻辑/文件/网络/技能/审计/计划工具 ----
// 原则：CLI 只暴露这些，agent 不用拿 token 试错编辑器绑定工具（省 token + 稳定）。
// 排除：get_diagnostics / get_editor_context / get_debug_console（编辑器状态）、
//       open_file / preview_artifact（VS Code 视图）、call_extension_command（扩展命令）、
//       spawn_subagent / run_background_agent（依赖会话内上下文）、get_terminal_output（走 CLI 自实现）。
const FOX_CLI_TOOLS = new Set([
  // 文件与搜索
  'read_file', 'list_dir', 'find_files', 'search_text', 'get_tools',
  'write_file', 'edit_file', 'delete_file',
  // 命令执行（CLI 自实现，不用 VSCode 终端）
  'run_command',
  // 记忆
  'save_memory', 'get_memory',
  // 技能
  'import_skill', 'create_skill', 'list_skills', 'use_skill',
  // 计划（对齐 DSH goal-round-driver：计划即执行，无确认门）
  'create_plan_task', 'update_plan_task', 'list_plan_tasks', 'remove_plan_task', 'set_plan_tasks',
  'present_plan', 'revise_plan',
  // 审查与质量（referee_review 依赖外部裁判模型、CLI 无配置易失败 → 不进白名单）
  'review_changes', 'security_audit', 'skill_audit',
  // 沙盒与代码库
  'run_in_sandbox', 'search_codebase', 'index_codebase',
  // 会话与转换（best_of_n 每次全量多跑几遍模型、token 消耗最大 → 不进白名单）
  'allow_session_access', 'list_other_sessions', 'run_slash_command',
  'convert_file', 'report_feedback',
  // 时间与网络（web_search 需配置 FOXAI_WEBSEARCH_APIKEY 才启用；未启用时 --list 不显示、调用报错提示）
  'current_time', 'web_search'
]);

// ---- CLI 自实现：run_command / get_terminal_output 不走 VSCode 集成终端 ----
// 直接用 child_process 真实执行，支持超时与单行错误摘要（试错成本低、不挂死）。
function cliRunCommand(args) {
  // argv 数组优先（对齐插件 run_command 组合方案）：带空格路径直接放数组元素，转义由执行层处理。
  const hasArgv = Array.isArray(args && args.argv) && args.argv.length > 0;
  const argv = hasArgv ? args.argv.map((x) => String(x)) : null;
  const cmd = argv ? argv.join(' ') : (args && args.command);
  if (!cmd || typeof cmd !== 'string') throw new Error('缺少 command（或 argv 至少包含程序名）');
  const cwd = (args && args.cwd) || process.env.FOXAI_WORKSPACE || process.cwd();
  const timeoutMs = (args && args.timeoutMs) || 120000;
  const started = Date.now();
  try {
    // argv 模式：直接 execFileSync 真数组（不经 shell，空格天然安全，转义完全交给 Node）；
    // .cmd/.bat 必须经 shell（Node 不解析），故 Windows 上有 cmd/bat 后缀时退回 shell 拼串。
    const direct = hasArgv && !(process.platform === 'win32' && /\.(cmd|bat)$/i.test(argv[0]));
    const out = direct
      ? execFileSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : execFileSync(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
          process.platform === 'win32' ? ['/d', '/s', '/c', cmd] : ['-c', cmd],
          { cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return '退出码 0，耗时 ' + (Date.now() - started) + 'ms\n' + (out || '(无输出)');
  } catch (e) {
    const code = e.status !== undefined ? e.status : (e.killed ? 'timeout' : 'error');
    const tail = ((e.stdout || '') + '\n' + (e.stderr || '')).trim().split('\n').slice(-15).join('\n');
    throw new Error('命令失败 code=' + code + ' 耗时 ' + (Date.now() - started) + 'ms\n' + (tail || e.message));
  }
}

function cliTerminalOutput() {
  return '(CLI 模式无集成终端；请用 run_command 直接执行命令查看输出。)';
}

const FOX_CLI_OVERRIDES = {
  run_command: { run: (a) => cliRunCommand(a) },
  get_terminal_output: { run: () => cliTerminalOutput() }
};

const HELP_BANNER = `fox-ai CLI —— 给 agent 用的固定模板工具执行层

用法:
  fox <tool_name> [--json '{"参数":...}'] [--full] [--timeout <ms>] [--cwd <dir>]
  fox --list
  fox --help <tool_name>     （或 fox <tool_name> --help）

输出协议:
  foxai-ok <tool> <ms> <truncated?>   成功（stdout）
  foxai-err <tool> <code> <摘要>       失败（stderr，单行）
  内容随后的 stdout 输出（默认 8000 字符智能截断，--full 全量）

退出码: 0 成功 / 1 工具失败 / 2 用法错误 / 3 内部异常`;

function fail(code, msg) {
  process.stderr.write('foxai-err cli ' + code + ' ' + String(msg).split('\n')[0] + '\n');
  if (process.env.FOXAI_CLI_VERBOSE) {
    process.stderr.write('foxai-debug ' + String(msg).split('\n').slice(1).join('\n') + '\n');
  }
  process.exit(code);
}

function parseArgs(argv) {
  const out = { toolName: null, json: null, full: false, timeout: null, cwd: null, help: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') { out.list = true; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--full') { out.full = true; continue; }
    if (a === '--json') { out.json = argv[++i]; continue; }
    if (a === '--timeout' || a === '-t') { out.timeout = Number(argv[++i]); continue; }
    if (a === '--cwd' || a === '-C') { out.cwd = argv[++i]; continue; }
    if (a.startsWith('--')) { fail(2, '未知参数: ' + a); }
    if (!out.toolName) out.toolName = a;
  }
  return out;
}

function renderHelp(tool) {
  const lines = [];
  lines.push('工具: ' + tool.name + '（kind=' + tool.kind + '）');
  lines.push('');
  lines.push('描述:');
  lines.push('  ' + (tool.description || '(无描述)').replace(/\n/g, '\n  '));
  lines.push('');
  lines.push('调用:');
  lines.push('  fox ' + tool.name + " --json '" + JSON.stringify(pickRequired(tool)) + "'");
  if (tool.parameters && tool.parameters.properties) {
    lines.push('');
    lines.push('参数:');
    for (const [k, v] of Object.entries(tool.parameters.properties)) {
      const req = tool.parameters.required && tool.parameters.required.includes(k);
      lines.push('  ' + (req ? '* ' : '  ') + k + (v.type ? ' (' + v.type + ')' : '') + ' — ' + String(v.description || '').replace(/\n/g, ' '));
    }
  }
  return lines.join('\n');
}

function pickRequired(tool) {
  const out = {};
  const reqs = (tool.parameters && tool.parameters.required) || [];
  for (const r of reqs) out[r] = '<必填>';
  return out;
}

/** CLI 上下文构造：真实 UserSkillStore + 环境配置 + 最大输出截断 */
function buildCtx(opts, cwd) {
  return {
    cwd,
    workspace: cwd,
    skills: new UserSkillStore(opts.skillsDir || process.env.FOXAI_SKILLS_DIR || defaultDir()),
    cfg: {
      get(key, def) {
        const envKey = 'FOXAI_' + String(key).replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
        return process.env[envKey] !== undefined && process.env[envKey] !== '' ? process.env[envKey] : def;
      }
    },
    maxToolOutput: opts.full ? undefined : 8000,
    approval: { silent: true },
    _cli: true
  };
}

/** 工具调用：白名单内工具用 override（CLI 自实现），其余走插件原 run */
async function runTool(name, args, ctx) {
  const override = FOX_CLI_OVERRIDES[name];
  const tool = override || toolsIndex.getTool(name);
  if (!tool) throw new Error('没有名为 ' + name + ' 的工具');
  const started = Date.now();
  let result;
  try {
    result = typeof tool.run === 'function' ? await tool.run(args || {}, ctx) : await tool.execute(args || {}, ctx);
  } catch (e) {
    throw new Error((e && e.message) || String(e));
  }
  const ms = Date.now() - started;
  return { result, ms };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.list) {
    // 按白名单集合遍历（35 个恒定显示），不依赖 allTools() 动态过滤：
    // 未启用的工具（如未配 FOXAI_WEBSEARCH_APIKEY 的 web_search）也显示并标注，
    // agent 不会误以为「列表里没有」而浪费 token 试错。
    const names = Array.from(FOX_CLI_TOOLS).sort();
    const rows = names.map((n) => {
      const t = toolsIndex.getTool(n);
      if (!t) return '  ' + n + ' [未启用] （需配置文件对应环境变量/APIKey 才可用）';
      const params = (t.parameters && t.parameters.required) || [];
      const suffix = params.length ? ' ⟨必填: ' + params.join(',') + '⟩' : '';
      return '  ' + n + ' [' + t.kind + ']' + suffix;
    });
    process.stdout.write('可用 CLI 工具（' + names.length + ' 个）：\n' + rows.join('\n') + '\n');
    return 0;
  }
  if (!opts.toolName) {
    process.stdout.write(HELP_BANNER + '\n');
    return 0;
  }
  if (!FOX_CLI_TOOLS.has(opts.toolName)) {
    fail(2, '工具 ' + opts.toolName + ' 不在 CLI 白名单（35 个可独立执行工具）内，用 fox --list 查看；编辑器绑定工具请走插件内调用。');
  }
  const tool = toolsIndex.getTool(opts.toolName);
  if (!tool) {
    // 白名单内但动态未启用（如 web_search 需 APIKey）——给出明确提示而不是「没有名为」
    if (FOX_CLI_TOOLS.has(opts.toolName)) {
      fail(2, '工具 ' + opts.toolName + ' 未启用（需配置对应环境变量/APIKey，如 FOXAI_WEBSEARCH_APIKEY），用 fox --list 查看启用状态');
    }
    fail(2, '没有名为 ' + opts.toolName + ' 的工具，用 fox --list 查看全部');
  }
  if (opts.help) {
    process.stdout.write(renderHelp(tool) + '\n');
    return 0;
  }

  let args = {};
  if (opts.json) {
    try {
      args = JSON.parse(opts.json);
    } catch (e) {
      fail(2, '--json 不是合法 JSON: ' + e.message);
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) fail(2, '--json 必须是对象');
  }

  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  if (opts.cwd && !fs.existsSync(cwd)) fail(2, '--cwd 目录不存在: ' + cwd);

  // CLI 上下文：真实 UserSkillStore + 环境配置注入 + 默认 8000 截断（省 token）
  const ctx = buildCtx(opts, cwd);

  const start = Date.now();
  let result;
  // CLI 自实现工具（run_command / get_terminal_output）不依赖 VSCode 集成终端，
  // 其余工具统一走插件 execute()：白拿超时保护 / 熔断 / 智能截断（稳定性 + 省 token）。
  if (FOX_CLI_OVERRIDES[opts.toolName]) {
    // CLI 自实现工具：runTool 返回 {result, ms}，这里只取文本结果
    const rr = await runTool(opts.toolName, args, ctx);
    result = rr.result;
  } else {
    result = await toolsIndex.execute(opts.toolName, args, ctx);
  }
  const ms = Date.now() - start;
  const text = typeof result === 'string' ? result : (result === null || result === undefined ? '' : JSON.stringify(result));
  const truncated = opts.full ? false : text.length > 8000;
  process.stdout.write('foxai-ok ' + opts.toolName + ' ' + ms + (truncated ? ' truncated' : '') + '\n');
  process.stdout.write(text + (text.endsWith('\n') ? '' : '\n'));
  return 0;
}

main().catch((e) => {
  fail(3, '内部异常: ' + (e && e.message ? e.message : String(e)));
});