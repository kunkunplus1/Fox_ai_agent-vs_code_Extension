'use strict';

/**
 * Headless / CI 集成入口（零 vscode 依赖，纯 Node）。
 *
 * 设计约束（来自 1.1.0 跨切面硬约束）：
 *  - 零外部依赖、零 vscode 依赖：可直接被 CLI、CI 脚本、或扩展命令 require。
 *  - 无缓存、无常驻监听、无全局副作用：每次调用都是一次性、用完即弃，内存占用恒定。
 *  - 凭据注入：优先显式参数 → 其次环境变量（FOXAI_*）→ 最后回落到 providers 预设默认值。
 *  - 复用既有的 client.js / anthropic.js（已确认零 vscode 依赖），保持与主对话一致的协议行为。
 *
 * 对外：
 *   resolveConfig(partial)  合并预设/env/显式参数，返回一次调用所需的完整配置。
 *   pickNonStream(cfg)      按 transport/apiMode 选非流式后端（与 agent.selectBackend 一致）。
 *   pickStream(cfg)         按 transport/apiMode 选流式后端。
 *   runHeadless(opts)       单次调用（可流式 / 可直传 messages），返回 { ok, text, reasoning, error, finishReason, meta }。
 *   cli(argv, out, err)     命令行解析入口（供根目录 `foxai` 脚本调用）。
 */

const fs = require('fs');
const { PROVIDERS } = require('./providers');
const client = require('./client');
const anthropic = require('./anthropic');

const VERSION = '1.1.1';

/** 把任意值解析成有限数字，失败回退 fallback */
function num(v, fallback) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 合并配置：explicit（显式参数） > 环境变量（FOXAI_*） > providers 预设。
 * @param {object} [partial] 显式覆盖项（可含 provider/baseUrl/apiKey/model/transport/apiMode/temperature/maxTokens/timeout）
 * @returns {{provider,baseUrl,apiKey,model,transport,apiMode,temperature,maxTokens,timeout}}
 */
function resolveConfig(partial) {
  partial = partial || {};
  const env = process.env || {};

  const provider = partial.provider || env.FOXAI_PROVIDER || 'llamacpp';
  const meta = PROVIDERS[provider] || PROVIDERS.llamacpp;

  const baseUrl = (partial.baseUrl || env.FOXAI_BASE_URL || meta.baseUrl || '').trim().replace(/\/+$/, '');
  const isLocal = !!(meta && meta.local);
  const apiKey = partial.apiKey != null ? partial.apiKey : (env.FOXAI_API_KEY != null ? env.FOXAI_API_KEY : (isLocal ? '' : ''));
  const model = (partial.model || env.FOXAI_MODEL || meta.model || 'local-model').trim();
  const transport = partial.transport || env.FOXAI_TRANSPORT || meta.transport || 'openai';
  const apiMode = partial.apiMode || env.FOXAI_API_MODE
    || (transport === 'anthropic' ? 'chat' : (meta.apiMode || 'chat'));

  return {
    provider,
    baseUrl,
    apiKey: apiKey || '',
    model,
    transport,
    apiMode,
    temperature: num(partial.temperature != null ? partial.temperature : env.FOXAI_TEMPERATURE, num(meta.temperature, 0.3)),
    maxTokens: num(partial.maxTokens != null ? partial.maxTokens : env.FOXAI_MAX_TOKENS, 4096),
    timeout: num(partial.timeout != null ? partial.timeout : env.FOXAI_TIMEOUT, 120000)
  };
}

/**
 * 选非流式后端，与 agent.js selectBackend 完全一致：
 *  - anthropic 传输 → 原生 Messages 协议
 *  - 否则 apiMode==='responses' → chatNonStreamResponses
 *  - 否则 → chatNonStream
 */
function pickNonStream(cfg) {
  if (cfg.transport === 'anthropic') return anthropic.chatNonStream;
  if (cfg.apiMode === 'responses') return client.chatNonStreamResponses;
  return client.chatNonStream;
}

/**
 * 选流式后端（与 pickNonStream 对称的流式版本）：
 *  - anthropic 传输 → anthropic.streamChat
 *  - 否则 apiMode==='responses' → client.streamResponses
 *  - 否则 → client.streamChat
 * 三者回调接口统一：onStart/onDelta/onReasoning/onToolCallStart/onDone/onError。
 */
function pickStream(cfg) {
  if (cfg.transport === 'anthropic') return anthropic.streamChat;
  if (cfg.apiMode === 'responses') return client.streamResponses;
  return client.streamChat;
}

/**
 * 流式运行：调用 streamFn，把文本/reasoning 分块喂给 onChunk，结束后 resolve。
 * @param {object} cfg 解析后的配置（用于 meta）
 * @param {object} safe 传给 streamFn 的请求参数（含 messages 等）
 * @param {function} streamFn 流式后端（来自 pickStream）
 * @param {function} onChunk (text, info) => void，info.type ∈ {'text','reasoning'}
 * @returns {Promise<{ok:boolean,text?:string,reasoning?:string,error?:string,finishReason?:string,meta?:object}>}
 */
function runStreamWith(cfg, safe, streamFn, onChunk) {
  return new Promise((resolve) => {
    const handle = streamFn(Object.assign({}, safe, {
      onDelta: (text) => { try { onChunk(String(text == null ? '' : text), { type: 'text' }); } catch (_) {} },
      onReasoning: (text) => { try { onChunk(String(text == null ? '' : text), { type: 'reasoning' }); } catch (_) {} },
      onDone: (result) => {
        resolve({
          ok: true,
          text: (result && result.content) || '',
          reasoning: (result && result.reasoning) || '',
          finishReason: (result && result.finishReason) || 'stop',
          meta: { provider: cfg.provider, model: cfg.model, transport: cfg.transport, apiMode: cfg.apiMode }
        });
      },
      onError: (err) => { resolve({ ok: false, error: (err && err.message) || String(err) }); }
    }));
    // handle 为 EventEmitter（可 .destroy() 中止），此处不主动监听，仅防止被 GC 提前回收。
    if (handle && typeof handle.on === 'function') {
      handle.on('error', () => {});
    }
  });
}

/**
 * 单次调用（可流式、可直传 messages）。
 * @param {object} opts
 * @param {string} [opts.prompt] 用户消息（与 opts.messages 二选一；优先用 messages）
 * @param {string} [opts.system] 系统提示词（仅当未提供 messages 时用于拼首条 system）
 * @param {Array<{role:string,content:string}>} [opts.messages] 完整消息数组（多轮直传）
 * @param {object} [opts.config] 配置覆盖（传给 resolveConfig 的 partial）
 * @param {number} [opts.temperature] 临时覆盖
 * @param {number} [opts.maxTokens] 临时覆盖
 * @param {number} [opts.timeout] 临时覆盖
 * @param {boolean} [opts.stream] 是否流式
 * @param {function} [opts.onChunk] 流式分块回调 (text, info) => void
 * @param {object} [opts.backends] 测试注入：{ nonStream, stream } 覆盖默认后端选择
 * @returns {Promise<{ok:boolean,text?:string,reasoning?:string,error?:string,finishReason?:string,meta?:object}>}
 */
async function runHeadless(opts) {
  opts = opts || {};
  const cfg = resolveConfig(Object.assign({}, opts.config, {
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    timeout: opts.timeout
  }));

  if (!cfg.baseUrl) {
    return { ok: false, error: 'baseUrl 未配置：请设置 FOXAI_BASE_URL / --base-url，或在 providers 预设里填好' };
  }

  // messages：显式直传 > (system+prompt 拼接)
  let messages;
  if (Array.isArray(opts.messages) && opts.messages.length) {
    messages = opts.messages;
  } else {
    const prompt = opts.prompt;
    if (!prompt || !String(prompt).trim()) {
      return { ok: false, error: 'prompt 不能为空（用 -p/--prompt 或 stdin 传入）；或传 opts.messages 做多轮' };
    }
    messages = [];
    if (opts.system && String(opts.system).trim()) {
      messages.push({ role: 'system', content: String(opts.system) });
    }
    messages.push({ role: 'user', content: String(prompt) });
  }

  const safe = {
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    timeout: cfg.timeout
  };

  // 流式路径
  if (opts.stream && typeof opts.onChunk === 'function') {
    const streamFn = (opts.backends && opts.backends.stream) || pickStream(cfg);
    return runStreamWith(cfg, safe, streamFn, opts.onChunk);
  }

  // 非流式路径
  const nonStream = (opts.backends && opts.backends.nonStream) || pickNonStream(cfg);
  try {
    const r = await nonStream(safe);
    const text = (r && r.content) || '';
    return {
      ok: true,
      text,
      reasoning: (r && r.reasoning) || '',
      finishReason: (r && r.finishReason) || 'stop',
      meta: {
        provider: cfg.provider,
        model: cfg.model,
        transport: cfg.transport,
        apiMode: cfg.apiMode
      }
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// ─────────────────────────────────────────────────────────────
// CLI 解析（供根目录 `foxai` 脚本 require 后调用）
// ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _pos: [] };
  const bools = { json: false, help: false, verbose: false, stream: false };
  const singles = {
    p: 'prompt', prompt: 'prompt',
    s: 'system', system: 'system',
    m: 'model', model: 'model',
    P: 'provider', provider: 'provider',
    u: 'baseUrl', 'base-url': 'baseUrl', url: 'baseUrl',
    k: 'apiKey', 'api-key': 'apiKey', key: 'apiKey',
    t: 'transport', transport: 'transport',
    a: 'apiMode', 'api-mode': 'apiMode',
    f: 'file', file: 'file',
    e: 'temperature', temperature: 'temperature',
    n: 'maxTokens', 'max-tokens': 'maxTokens',
    o: 'timeout', timeout: 'timeout',
    session: 'session',
    turns: 'turns'
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { bools.help = true; continue; }
    if (a === '--json') { bools.json = true; continue; }
    if (a === '--verbose') { bools.verbose = true; continue; }
    if (a === '-S' || a === '--stream') { bools.stream = true; continue; }
    if (a.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=');
      const k = a.slice(2, eq);
      const v = a.slice(eq + 1);
      if (singles[k]) out[singles[k]] = v; else out[k] = v;
      continue;
    }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (singles[k] !== undefined) {
        const v = argv[++i];
        out[singles[k]] = v;
      } else {
        out[k] = true;
      }
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-?\d/.test(a)) {
      const k = a.slice(1);
      if (singles[k] !== undefined) {
        const v = argv[++i];
        out[singles[k]] = v;
      }
      continue;
    }
    out._pos.push(a);
  }
  return Object.assign(out, bools);
}

const HELP = [
  '狐狸 AI Headless / CI 命令行',
  '',
  '用法: node foxai [选项]',
  '',
  '提示词来源（任选其一）:',
  '  -p, --prompt <text>      直接传入提示词',
  '  -f, --file <path>        从文件读取提示词',
  '  （无上述两项时从 stdin 读取，适合管道）',
  '',
  '模型/端点（均可被环境变量覆盖，环境变量优先级低于此处显式参数）:',
  '  -P, --provider <id>      预设服务商（llamacpp/ollama/deepseek/claude/...）',
  '  -u, --base-url <url>     API 基址（也可 FOXAI_BASE_URL）',
  '  -k, --api-key <key>      API Key（也可 FOXAI_API_KEY）',
  '  -m, --model <name>       模型名（也可 FOXAI_MODEL）',
  '  -t, --transport <t>      openai | anthropic（也可 FOXAI_TRANSPORT）',
  '  -a, --api-mode <m>       chat | responses（也可 FOXAI_API_MODE）',
  '  -s, --system <text>      系统提示词',
  '  -e, --temperature <n>    温度（也可 FOXAI_TEMPERATURE）',
  '  -n, --max-tokens <n>     最大生成 token（也可 FOXAI_MAX_TOKENS）',
  '  -o, --timeout <ms>       超时毫秒（也可 FOXAI_TIMEOUT）',
  '',
  '输出与模式:',
  '  --json        以 JSON 输出 {ok,text,reasoning,meta}',
  '  --verbose     把 reasoning 输出到 stderr',
  '  -S, --stream  流式输出：文本逐块写到 stdout，reasoning 写到 stderr',
  '  --session <file>   多轮会话：从 <file> 加载历史，追加本轮，结束后写回（跨调用持久化）',
  '  --turns <file>     批量多轮：从 JSON 文件读取 [{role,content}] 或 {messages,turns}，依次跑完',
  '  -h, --help    显示本帮助',
  '',
  '退出码: 0=成功, 1=调用失败',
  '',
  '示例：',
  '  单轮:  echo "解释这段正则" | node foxai -P deepseek',
  '  流式:  echo "写一首诗" | node foxai -P llamacpp -S',
  '  JSON:  node foxai -p "hello" -P llamacpp --json',
  '  多轮持久化:  node foxai -p "记住我叫小明" --session chat.json -P llamacpp',
  '               node foxai -p "我刚说我叫什么？" --session chat.json -P llamacpp',
  '  批量多轮:  node foxai --turns turns.json -P llamacpp   # turns.json: ["问题1","问题2"] 或 {"messages":[...],"turns":[...]}'
].join('\n');

/** 读取完整 stdin（同步阻塞，仅 CLI 使用） */
function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8'); // fd 0 = stdin
  } catch (_) {
    return '';
  }
}

function normTurn(t) {
  if (typeof t === 'string') return { role: 'user', content: t };
  if (t && typeof t.content === 'string') return { role: (t.role === 'assistant' ? 'assistant' : 'user'), content: t.content };
  throw new Error('无法识别的 turn 格式（需为字符串或 {role,content}）');
}

/** 解析 turns 文件：支持 [turn,...] 或 {messages:[...], turns:[...]} */
function normalizeTurns(data) {
  if (Array.isArray(data)) {
    return { seed: [], turns: data.map(normTurn) };
  }
  if (data && Array.isArray(data.messages)) {
    const seed = data.messages;
    const turns = Array.isArray(data.turns) ? data.turns.map(normTurn) : [];
    return { seed, turns };
  }
  throw new Error('turns 文件需为 [turn,...] 或 {messages,turns}');
}

/**
 * 多轮执行（用于 --session / --turns）。
 * @returns {Promise<number>} 退出码
 */
async function runMultiTurn(args, opts) {
  const { out, err, sessionFile, turnsFile, stream, json, verbose, baseOpts } = opts;
  let messages = [];

  if (sessionFile && fs.existsSync(sessionFile)) {
    try {
      const s = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      if (Array.isArray(s.messages)) messages = s.messages;
    } catch (e) {
      err.write('读取 session 失败: ' + ((e && e.message) || String(e)) + '\n');
    }
  }

  if (args.system && !messages.some((m) => m.role === 'system')) {
    messages.unshift({ role: 'system', content: String(args.system) });
  }

  let turns = [];
  if (turnsFile) {
    try {
      const data = JSON.parse(fs.readFileSync(turnsFile, 'utf8'));
      const parsed = normalizeTurns(data);
      messages = messages.concat(parsed.seed);
      turns = parsed.turns;
    } catch (e) {
      err.write('读取 turns 失败: ' + ((e && e.message) || String(e)) + '\n');
      return 1;
    }
  } else {
    let prompt = args.prompt;
    if (!prompt && args.file) {
      try { prompt = fs.readFileSync(args.file, 'utf8'); } catch (e) { err.write('读取 --file 失败: ' + ((e && e.message) || String(e)) + '\n'); return 1; }
    }
    if (!prompt) prompt = readStdinSync();
    if (!prompt || !String(prompt).trim()) { err.write('未提供 prompt（用 -p/--prompt、--file 或 stdin）\n'); return 1; }
    turns = [{ role: 'user', content: String(prompt) }];
  }

  let last = null;
  for (const turn of turns) {
    messages.push(turn);
    const r = await runHeadless(Object.assign({}, baseOpts, {
      messages,
      stream,
      onChunk: stream ? (text, info) => {
        if (json) return;
        if (info.type === 'reasoning') { if (verbose) err.write(text); }
        else out.write(text);
      } : undefined
    }));
    if (!r.ok) { err.write('调用失败: ' + r.error + '\n'); return 1; }
    last = r;
    messages.push({ role: 'assistant', content: r.text });
  }

  if (sessionFile) {
    try { fs.writeFileSync(sessionFile, JSON.stringify({ messages }, null, 2)); } catch (e) { err.write('保存 session 失败: ' + ((e && e.message) || String(e)) + '\n'); }
  }

  if (json) {
    out.write(JSON.stringify({ ok: true, messages, last: { text: last.text, reasoning: last.reasoning, meta: last.meta } }, null, 2) + '\n');
  } else if (!stream) {
    out.write(last.text + '\n');
  }
  return 0;
}

/**
 * CLI 入口。
 * @param {string[]} argv 去掉 node/脚本名后的参数
 * @param {object} [out] 可注入的 stdout（测试用）
 * @param {object} [err] 可注入的 stderr（测试用）
 * @param {object} [inject] 测试注入：{ backends: { nonStream, stream } }
 * @returns {Promise<number>} 退出码 0/1
 */
async function cli(argv, out, err, inject) {
  out = out || process.stdout;
  err = err || process.stderr;
  const args = parseArgs(argv || []);
  if (args.help) {
    out.write(HELP + '\n');
    return 0;
  }

  const stream = !!args.stream;
  const json = !!args.json;
  const verbose = !!args.verbose;
  const config = {
    provider: args.provider,
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    model: args.model,
    transport: args.transport,
    apiMode: args.apiMode
  };
  const baseOpts = {
    config,
    temperature: args.temperature != null ? num(args.temperature, undefined) : undefined,
    maxTokens: args.maxTokens != null ? num(args.maxTokens, undefined) : undefined,
    timeout: args.timeout != null ? num(args.timeout, undefined) : undefined,
    backends: inject && inject.backends
  };

  // 多轮模式
  if (args.session || args.turns) {
    return runMultiTurn(args, { out, err, sessionFile: args.session, turnsFile: args.turns, stream, json, verbose, baseOpts });
  }

  // 单轮
  let prompt = args.prompt;
  if (!prompt && args.file) {
    try { prompt = fs.readFileSync(args.file, 'utf8'); } catch (e) { err.write('读取 --file 失败: ' + ((e && e.message) || String(e)) + '\n'); return 1; }
  }
  if (!prompt) prompt = readStdinSync();

  const runOpts = Object.assign({}, baseOpts, { prompt, system: args.system });
  if (stream) {
    runOpts.stream = true;
    runOpts.onChunk = (text, info) => {
      if (json) return;
      if (info.type === 'reasoning') { if (verbose) err.write(text); }
      else out.write(text);
    };
  }

  const result = await runHeadless(runOpts);

  if (json) {
    out.write(JSON.stringify(result, null, 2) + '\n');
  } else if (result.ok) {
    if (verbose && result.reasoning) err.write('[reasoning]\n' + result.reasoning + '\n\n');
    if (!stream) out.write(result.text + '\n');
  } else {
    err.write('[fox-ai headless] 调用失败: ' + result.error + '\n');
  }
  return result.ok ? 0 : 1;
}

module.exports = { VERSION, resolveConfig, pickNonStream, pickStream, runHeadless, cli, HELP };
