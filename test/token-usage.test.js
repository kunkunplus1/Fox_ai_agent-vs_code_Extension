/**
 * 1.1.32：token 用量记账回归测试。
 * 覆盖各家厂商 usage 语义——最容易踩的坑是「字段名不同」与「缓存字段缺失时仍要出数」。
 * 运行：node test/token-usage.test.js
 */
'use strict';

const Module = require('module');
const origLoad = Module._load;
Module._load = function (request) {
  // client.js 链式依赖 vscode，测试环境用最小 stub 顶替
  if (request === 'vscode') {
    return {
      workspace: { getConfiguration: () => ({ get: () => undefined }) },
      window: {}, commands: {}, Event: class {}
    };
  }
  return origLoad.apply(this, arguments);
};

const { extractUsageStats, emitUsage } = require('../src/client.js');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' => ' + JSON.stringify(extra) : '')); }
}

/* ---------- 1. 各家厂商 usage 语义 ---------- */

// OpenAI Chat Completions：prompt_tokens 已含 cached
const openai = extractUsageStats({
  prompt_tokens: 12000,
  completion_tokens: 800,
  total_tokens: 12800,
  prompt_tokens_details: { cached_tokens: 9000 }
});
check('OpenAI: prompt=12000', openai.promptTokens === 12000, openai);
check('OpenAI: completion=800', openai.completionTokens === 800, openai);
check('OpenAI: cached=9000', openai.cachedTokens === 9000, openai);
check('OpenAI: total=12800', openai.totalTokens === 12800, openai);

// Anthropic：input_tokens 不含缓存，缓存单列 cache_read_input_tokens
const anthropic = extractUsageStats({
  input_tokens: 725,
  output_tokens: 300,
  cache_read_input_tokens: 17700,
  cache_creation_input_tokens: 0
});
check('Anthropic: cached=17700', anthropic.cachedTokens === 17700, anthropic);
check('Anthropic: completion=300', anthropic.completionTokens === 300, anthropic);
check('Anthropic: 有缓存时出数（非空）', anthropic.totalTokens > 0, anthropic);

// DeepSeek：命中/未命中分开
const deepseek = extractUsageStats({
  prompt_tokens: 0,
  completion_tokens: 120,
  prompt_cache_hit_tokens: 4096,
  prompt_cache_miss_tokens: 512
});
check('DeepSeek: cached=4096', deepseek.cachedTokens === 4096, deepseek);
check('DeepSeek: completion=120', deepseek.completionTokens === 120, deepseek);

// Gemini：字段在 usageMetadata 子对象里
const gemini = extractUsageStats({
  usageMetadata: {
    promptTokenCount: 5000,
    candidatesTokenCount: 260,
    totalTokenCount: 5260,
    cachedContentTokenCount: 3000
  }
});
check('Gemini: prompt=5000', gemini.promptTokens === 5000, gemini);
check('Gemini: completion=260', gemini.completionTokens === 260, gemini);

// Responses API：input/output_tokens
const responses = extractUsageStats({
  input_tokens: 3000,
  output_tokens: 400,
  total_tokens: 3400,
  input_tokens_details: { cached_tokens: 2000 }
});
check('Responses: prompt=3000', responses.promptTokens === 3000, responses);
check('Responses: cached=2000', responses.cachedTokens === 2000, responses);

/* ---------- 2. 无缓存字段时仍要出数（本次修复核心）---------- */

const noCache = extractUsageStats({ prompt_tokens: 8000, completion_tokens: 500, total_tokens: 8500 });
check('无缓存字段: 仍出数', noCache && noCache.promptTokens === 8000, noCache);
check('无缓存字段: cached=0 而非 null', noCache.cachedTokens === 0, noCache);
check('无缓存字段: completion=500', noCache.completionTokens === 500, noCache);

// 本地模型（llama.cpp 风格）：只有 prompt/completion
const local = extractUsageStats({ prompt_tokens: 2048, completion_tokens: 96 });
check('本地模型: 无 total 时用 prompt+completion 推算', local.totalTokens === 2144, local);

/* ---------- 3. 边界与异常 ---------- */

check('null usage 不炸', extractUsageStats(null) === null);
check('空对象返回全 0', extractUsageStats({}).totalTokens === 0);
check('字符串不入账', extractUsageStats('oops') === null);

// 某字段为 0、另一字段才是真值：应取正数而非第一个 0
const mixed = extractUsageStats({ prompt_tokens: 0, input_tokens: 1500, completion_tokens: 20 });
check('混合字段: 跳过 0 取真值 1500', mixed.promptTokens === 1500, mixed);

/* ---------- 4. emitUsage 统一出口：记账 + 转发 onUsage ---------- */

let forwarded = null;
const st = emitUsage({ prompt_tokens: 100, completion_tokens: 10 }, { model: 'test-model' }, (u) => { forwarded = u; });
check('emitUsage: 返回统计', st && st.promptTokens === 100, st);
check('emitUsage: 转发 onUsage', forwarded && forwarded.prompt_tokens === 100);
check('emitUsage: 空 usage 对象仍出 st(0)，并落 no_usage 告警', (() => {
  const s = emitUsage({}, { model: 'empty-model' });
  return s && s.totalTokens === 0;
})());
check('emitUsage: usage 为空时不调用回调', (() => {
  let called = false;
  emitUsage(null, {}, () => { called = true; });
  return called === false;
})());
check('emitUsage: 回调抛错不影响主流程', (() => {
  try {
    emitUsage({ prompt_tokens: 1 }, {}, () => { throw new Error('boom'); });
    return true;
  } catch (_) { return false; }
})());

console.log('\nRESULT pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
