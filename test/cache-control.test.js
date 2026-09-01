'use strict';

// cacheControl.js 单测：按厂商返回正确的缓存指令（请求头/请求体/空指令），严守「搜官网勿猜」。
// 覆盖：OpenRouter header / OpenAI gpt-5.6+ body / 旧 OpenAI 自动缓存空指令 /
// Anthropic 交给 applyCacheControl / DeepSeek·Kimi·智谱·通义·Gemini·中转 自动前缀缓存空指令 /
// 本地模型禁用 / 总开关关闭。

const { getCacheDirective } = require('../src/cacheControl');

let passed = 0;
let failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ FAIL: ' + name); }
}

// 1) OpenRouter：请求头 x-api-cache-control: ephemeral + x-api-cache-key
{
  const d = getCacheDirective({
    transport: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-chat', conversationId: 'conv-abc', prefixHash: 'hash1'
  });
  ok('OpenRouter -> provider=openrouter', d.provider === 'openrouter');
  ok('OpenRouter -> 头 x-api-cache-control=ephemeral', d.headers['x-api-cache-control'] === 'ephemeral');
  ok('OpenRouter -> 头 x-api-cache-key=conversationId', d.headers['x-api-cache-key'] === 'conv-abc');
  ok('OpenRouter -> 无 body 指令', Object.keys(d.body).length === 0);
}

// 2) OpenAI gpt-5.6+：请求体 prompt_cache_key + prompt_cache_retention
{
  const d = getCacheDirective({
    transport: 'openai', baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.6', conversationId: 'conv-xyz', retention: '24h'
  });
  ok('OpenAI gpt-5.6 -> provider=openai', d.provider === 'openai');
  ok('OpenAI gpt-5.6 -> body.prompt_cache_key=conv-xyz', d.body.prompt_cache_key === 'conv-xyz');
  ok('OpenAI gpt-5.6 -> body.prompt_cache_retention=24h', d.body.prompt_cache_retention === '24h');
  ok('OpenAI gpt-5.6 -> 无 headers', Object.keys(d.headers).length === 0);
}

// 3) OpenAI 旧模型（gpt-4o）：自动缓存，不注入（传参数会 422）
{
  const d = getCacheDirective({
    transport: 'openai', baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o', conversationId: 'conv-old'
  });
  ok('OpenAI gpt-4o -> provider=openai', d.provider === 'openai');
  ok('OpenAI gpt-4o -> 不注入 body', Object.keys(d.body).length === 0);
  ok('OpenAI gpt-4o -> 不注入 headers', Object.keys(d.headers).length === 0);
}

// 4) Anthropic：交给 applyCacheControl（system 块 cache_control），此处返回空指令
{
  const d = getCacheDirective({
    transport: 'anthropic', baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5', conversationId: 'conv-a'
  });
  ok('Anthropic -> provider=anthropic', d.provider === 'anthropic');
  ok('Anthropic -> 不注入 headers', Object.keys(d.headers).length === 0);
  ok('Anthropic -> 不注入 body', Object.keys(d.body).length === 0);
}

// 5) DeepSeek/Kimi/智谱/通义/Gemini/中转：自动前缀缓存，无强制指令
{
  const cases = [
    { transport: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
    { transport: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0711-preview' },
    { transport: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
    { transport: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max' },
    { transport: 'openai', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-pro' },
    { transport: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' }
  ];
  let allOk = true;
  for (const c of cases) {
    const d = getCacheDirective(c);
    if (Object.keys(d.headers).length !== 0 || Object.keys(d.body).length !== 0) allOk = false;
  }
  ok('自动前缀缓存厂商（DeepSeek/Kimi/智谱/通义/Gemini/中转）不注入任何字段', allOk);
}

// 6) 本地模型（meta.local）：无服务端缓存，返回 provider=local
{
  const d = getCacheDirective({ transport: 'openai', baseUrl: 'http://127.0.0.1:11434', model: 'llama3', meta: { local: true } });
  ok('本地模型 -> provider=local', d.provider === 'local');
  ok('本地模型 -> 不注入', Object.keys(d.headers).length === 0 && Object.keys(d.body).length === 0);
}

// 7) 总开关 enabled:false -> 一律空指令
{
  const d = getCacheDirective({ transport: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'x', enabled: false });
  ok('总开关关闭 -> provider=none', d.provider === 'none');
  ok('总开关关闭 -> 不注入', Object.keys(d.headers).length === 0 && Object.keys(d.body).length === 0);
}

// 8) gpt-5.6+ 家族正则覆盖
{
  ok('gpt-5.6 命中', getCacheDirective({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6' }).body.prompt_cache_key !== undefined || getCacheDirective({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6' }).provider === 'openai');
  ok('gpt-5.10 命中', getCacheDirective({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.10' }).provider === 'openai');
  ok('gpt-4.1 不注入 body', Object.keys(getCacheDirective({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' }).body).length === 0);
}

console.log('\ncache-control.test: ' + passed + ' 通过, ' + failed + ' 失败');
process.exit(failed ? 1 : 0);