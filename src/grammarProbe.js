'use strict';

/**
 * grammar 约束解码能力探测（1.1.19）。
 *
 * 背景：1.1.17 给本地弱模型默认注入 GBNF `grammar`，但部分本地 llama.cpp / LM Studio
 * 服务端在收到 grammar 后约束解码会「挂起或极慢」——同模型在自带 web UI（不带 grammar）
 * 秒回，在狐狸 AI 里却一直「模型思考中…」。1.1.18 一度改为默认关闭，但这样又丢掉了
 * 约束解码对弱模型格式稳定的巨大收益。
 *
 * 本模块解决「默认也能安全开」：发一个【带 grammar 的极小请求】探一下，
 *   - 服务端支持 → 秒回 → 标记 supported，后续正常注入 grammar；
 *   - 服务端挂起/超时 → 标记 unsupported，【绝不注入】，对话照常进行（不卡死）；
 *   - 服务端显式拒绝（400 等）→ 标记 unsupported，不注入。
 *
 * 探测用极短超时 + max_tokens=1 的极简 GBNF（`root ::= "ok"`），确保「健康服务端」能在
 * 远低于对话超时的窗口内返回，而「挂起型」服务端会在超时后干净失败。结果按 baseUrl 缓存，
 * 整个扩展进程内同一端点只探测一次。
 *
 * 纯函数 + 可注入请求实现，便于离线测试（不依赖 vscode / agent）。
 */

const { requestJson } = require('./client');

// 探测超时（毫秒）：独立于对话超时，专门用来「快速识别挂起」。
// 健康服务端对 1-token grammar 生成通常在 1s 内返回；超过此值基本可判定为挂起/不支持。
const PROBE_TIMEOUT = 12000;

// 极简 GBNF：只允许生成字面量 "ok"。用来验证服务端是否真的执行 grammar 约束。
const PROBE_GRAMMAR = 'root ::= "ok"';

// 模块级缓存：key = baseUrl。值可能是 Promise（探测中）或最终结论对象。
const _cache = new Map();

/** 由 baseUrl 拼出 chat/completions 端点（与 client.js 规则一致）。 */
function endpointFor(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
}

/**
 * 把配置里的 localConstrainedDecoding 值映射成三态模式。
 *   false / 'off' → 'off'  （永不注入，不探测）
 *   true  / 'on'  → 'force'（强制注入，不探测，靠运行时 rejection 兜底）
 *   其余（'auto' / undefined / ''）→ 'auto'（先探测，支持才注入）← 默认
 * @param {any} setting
 * @returns {'off'|'force'|'auto'}
 */
function grammarMode(setting) {
  if (setting === false || setting === 'off') return 'off';
  if (setting === true || setting === 'on') return 'force';
  return 'auto';
}

/**
 * 执行一次真实探测（不发缓存）。
 * @param {{baseUrl:string, apiKey?:string, model?:string, timeout?:number, requestImpl?:Function}} opts
 * @returns {Promise<{supported:boolean, source:string, reason?:string, durationMs:number}>}
 */
async function probeGrammarSupport({ baseUrl, apiKey, model, timeout = PROBE_TIMEOUT, requestImpl } = {}) {
  const req = typeof requestImpl === 'function' ? requestImpl : requestJson;
  const ep = endpointFor(baseUrl);
  const t0 = Date.now();
  const body = {
    model: model || 'local-model',
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    temperature: 0,
    grammar: PROBE_GRAMMAR,
    stream: false
  };
  try {
    const data = await req(ep, { method: 'POST', apiKey, body, timeout, insecureHTTPParser: false });
    const dur = Date.now() - t0;
    // 只要能正常拿到 200 JSON 且像一次合法 chat 返回（有 choices / content / id 之一），
    // 即视为服务端执行了 grammar 并返回，标记支持。即便内容不是 "ok" 也没关系。
    if (data && (data.choices || data.content || data.id)) {
      return { supported: true, source: 'probe', durationMs: dur };
    }
    return { supported: false, source: 'probe', reason: 'empty-or-unexpected-response', durationMs: dur };
  } catch (e) {
    const dur = Date.now() - t0;
    const msg = String((e && e.message) || '');
    const isTimeout = /超时|timeout|ETIMEDOUT/i.test(msg);
    return {
      supported: false,
      source: 'probe',
      reason: isTimeout ? 'timeout-hang' : msg.slice(0, 160),
      durationMs: dur
    };
  }
}

/**
 * 带缓存的探测入口（按 baseUrl 维度缓存）。每个端点只探测一次。
 * @param {{baseUrl:string, apiKey?:string, model?:string, timeout?:number, requestImpl?:Function}} opts
 * @returns {Promise<{supported:boolean, source:string, reason?:string, durationMs:number, cached?:boolean}>}
 */
async function grammarSupported(opts = {}) {
  const key = String(opts.baseUrl || '');
  const hit = _cache.get(key);
  if (hit !== undefined) {
    const val = await hit; // 可能是 Promise（探测中）或结论
    if (val && typeof val.then !== 'function') return Object.assign({ cached: true }, val);
  }
  const p = probeGrammarSupport(opts);
  _cache.set(key, p);
  const res = await p;
  _cache.set(key, res); // 替换为最终结论，避免重复探测
  return res;
}

/** 仅供测试/重载时清空缓存。 */
function resetProbeCache() {
  _cache.clear();
}

module.exports = {
  probeGrammarSupport,
  grammarSupported,
  grammarMode,
  resetProbeCache,
  endpointFor,
  PROBE_TIMEOUT,
  PROBE_GRAMMAR
};
