'use strict';

/**
 * 前缀/上下文缓存「强制保留本会话缓存副本」的按厂商请求指令适配器。
 *
 * 设计原则（严守「搜官网文档，勿猜」铁律）：
 *  - 只注入各厂商**官方文档明确支持**的缓存指令，绝不臆造 header/body 参数
 *    （臆造参数在严格校验的服务端会返回 4xx，反而炸请求）。
 *  - 各厂商机制不同，有的走请求头、有的走请求体、有的靠稳定前缀自动命中：
 *      · OpenRouter        → 请求头 `x-api-cache-control: ephemeral`（+ `x-api-cache-key`）。官方文档明确，
 *                            这是唯一「在请求头里强制开启缓存」的标准做法。
 *      · OpenAI（gpt-5.6+） → 请求体 `prompt_cache_key` + `prompt_cache_retention:"24h"`。
 *                            旧模型（gpt-4o 等）缓存是自动的，且不支持这两个参数 → 不注入。
 *      · Anthropic          → 必须在请求体 system 块加 `cache_control:{type:'ephemeral'}` 才缓存，
 *                            无 header 形式。该工作已由 anthropic.js 的 applyCacheControl 完成，这里返回空。
 *      · DeepSeek / Kimi / 智谱 / 通义 / Gemini / 其它 OpenAI 兼容 / 中转站
 *                            → 官网确认均为「稳定前缀 → 服务端自动前缀缓存」，没有「强制保留」的
 *                            header/body 旋钮。前缀稳定性由 1.1.29 基线逻辑保证，这里不注入任何字段。
 *
 * 返回 { provider, headers, body }：
 *  - headers：要并入请求头的键值对（按厂商）。
 *  - body：要并入请求体的键值对（按厂商，OpenAI/Responses 通用顶层字段）。
 *  无可用指令时两者皆为空对象（调用方可直接 Object.assign，零副作用）。
 */

function isLocal(meta) {
  return !!(meta && meta.local);
}

function isOpenRouter(baseUrl) {
  return /openrouter\.ai/i.test(baseUrl || '');
}

function isOpenAI(baseUrl, model) {
  if (/(api\.openai\.com|openai\.azure\.com|\/openai\/)/i.test(baseUrl || '')) return true;
  // 没写 baseUrl 但模型名像 OpenAI 官方（兜底）
  return /^(gpt-|chatgpt-|o[0-9])/i.test(String(model || ''));
}

// 仅 GPT-5.6 及更新家族支持 prompt_cache_key / prompt_cache_retention 显式参数；
// 更早模型（gpt-4o 等）缓存是自动的，且传这两个参数服务端会 422。
function isGpt56Plus(model) {
  return /gpt-5\.[6-9]|gpt-5\.1\d|gpt-6|gpt-5-1/i.test(String(model || ''));
}

function isAnthropicTransport(transport) {
  return transport === 'anthropic';
}

/**
 * @param {object} o
 * @param {string} [o.transport]       端点传输类型（'anthropic' / 'openai' / ...）
 * @param {string} [o.baseUrl]         端点地址（用于识别 OpenRouter / OpenAI / Azure）
 * @param {string} [o.model]           模型名（用于识别 OpenAI 家族与 gpt-5.6+）
 * @param {string} [o.conversationId]  会话 id（作缓存路由键，让同会话请求命中同一副本）
 * @param {string} [o.prefixHash]      前缀指纹（无 conversationId 时的兜底路由键）
 * @param {boolean} [o.enabled]        总开关（默认 true）
 * @param {string} [o.retention]       OpenAI 缓存 TTL（默认 '24h'）
 * @param {object} [o.meta]            端点 meta（meta.local 表示本地模型，无服务端缓存）
 * @returns {{provider:string, headers:object, body:object}}
 */
function getCacheDirective(o) {
  const opt = o || {};
  const directive = { provider: 'none', headers: {}, body: {} };
  if (opt.enabled === false) return directive;
  if (isLocal(opt.meta)) { directive.provider = 'local'; return directive; }

  const key = opt.conversationId || opt.prefixHash || '';

  // 1) OpenRouter：官方请求头形式，强制开启并保留缓存副本（本功能的核心诉求）
  if (isOpenRouter(opt.baseUrl)) {
    directive.provider = 'openrouter';
    directive.headers['x-api-cache-control'] = 'ephemeral';
    if (key) directive.headers['x-api-cache-key'] = String(key);
    return directive;
  }

  // 2) OpenAI（含 Azure OpenAI）：gpt-5.6+ 用显式参数延长 TTL 并锁定会话路由
  if (isOpenAI(opt.baseUrl, opt.model)) {
    directive.provider = 'openai';
    if (isGpt56Plus(opt.model)) {
      if (key) directive.body.prompt_cache_key = String(key);
      if (opt.retention) directive.body.prompt_cache_retention = String(opt.retention);
    }
    return directive;
  }

  // 3) Anthropic：缓存靠 system 块的 cache_control（applyCacheControl 已处理），无 header 形式
  if (isAnthropicTransport(opt.transport)) {
    directive.provider = 'anthropic';
    return directive;
  }

  // 4) 其余：自动前缀缓存，稳定前缀即可命中，无需也不应注入额外参数
  directive.provider = 'auto';
  return directive;
}

module.exports = { getCacheDirective, isOpenRouter, isOpenAI, isGpt56Plus, isAnthropicTransport };
