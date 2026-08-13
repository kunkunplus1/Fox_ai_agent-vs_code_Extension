'use strict';

const assert = require('assert');
const rp = require('../src/reasoningParams.js');

function t(name, fn) {
  try {
    fn();
    console.log('  ✓', name);
  } catch (e) {
    console.error('  ✗', name);
    console.error('   ', e && e.message);
    process.exitCode = 1;
  }
}

/** 造一份最小 cfg */
function mk(provider, model, over) {
  return Object.assign(
    {
      providerId: provider,
      provider,
      model,
      apiMode: 'chat',
      transport: 'openai',
      deepThinking: { enabled: true, effort: 'medium', budgetTokens: 0, promptFallback: true }
    },
    over || {}
  );
}

console.log('reasoningParams —— 深度思考跨后端参数映射');

// ── 策略识别 ──────────────────────────────────────────────
t('anthropic 传输 → anthropic 策略', () => {
  assert.strictEqual(rp.pickStrategy({ transport: 'anthropic', model: 'claude-sonnet-4-5' }), 'anthropic');
});

t('老 claude（3.5/3-opus）不支持扩展思考 → none', () => {
  assert.strictEqual(rp.pickStrategy({ transport: 'anthropic', model: 'claude-3-5-sonnet' }), 'none');
});

t('responses 协议优先于 provider → responses', () => {
  assert.strictEqual(rp.pickStrategy({ provider: 'deepseek', apiMode: 'responses', model: 'deepseek-v4-flash' }), 'responses');
});

t('openai gpt-5 → openai_effort', () => {
  assert.strictEqual(rp.pickStrategy({ provider: 'openai', model: 'gpt-5' }), 'openai_effort');
});

t('openai gpt-4o（非推理模型）→ none', () => {
  assert.strictEqual(rp.pickStrategy({ provider: 'openai', model: 'gpt-4o' }), 'none');
});

t('dashscope qwen → qwen', () => {
  assert.strictEqual(rp.pickStrategy({ provider: 'dashscope', model: 'qwen3-max' }), 'qwen');
});

t('zhipu glm → zhipu', () => {
  assert.strictEqual(rp.pickStrategy({ provider: 'zhipu', model: 'glm-4.5' }), 'zhipu');
});

t('openrouter → openrouter', () => {
  assert.strictEqual(rp.pickStrategy({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4' }), 'openrouter');
});

t('grok-4.x 支持 reasoning_effort → openai_effort', () => {
  assert.strictEqual(rp.pickStrategy({ provider: 'grok', model: 'grok-4' }), 'openai_effort');
  assert.strictEqual(rp.pickStrategy({ provider: 'grok', model: 'grok-4.5' }), 'openai_effort');
});

t('grok-3-mini → openai_effort', () => {
  assert.strictEqual(rp.pickStrategy({ provider: 'grok', model: 'grok-3-mini' }), 'openai_effort');
});

t('custom 中转站按模型名推断 claude → anthropic', () => {
  assert.strictEqual(rp.pickStrategy({ provider: 'custom', model: 'claude-sonnet-4-20250514' }), 'anthropic');
});

t('custom 中转站按模型名推断 qwen → qwen', () => {
  assert.strictEqual(rp.pickStrategy({ provider: 'custom', model: 'qwen3-235b' }), 'qwen');
});

t('gemini-2.0（无思考）→ none，gemini-2.5 → openai_effort', () => {
  assert.strictEqual(rp.pickStrategy({ provider: 'gemini', model: 'gemini-2.0-flash' }), 'none');
  assert.strictEqual(rp.pickStrategy({ provider: 'gemini', model: 'gemini-2.5-pro' }), 'openai_effort');
});

t('本地 ollama / llamacpp → none', () => {
  assert.strictEqual(rp.pickStrategy({ provider: 'ollama', model: 'qwen3:8b' }), 'none');
  assert.strictEqual(rp.pickStrategy({ provider: 'llamacpp', model: 'local' }), 'none');
});

// ── 参数生成（开启态）────────────────────────────────────
t('openai_effort 生成 reasoning_effort', () => {
  const o = rp.buildReasoningParams(mk('openai', 'gpt-5'));
  assert.deepStrictEqual(o.extraBody, { reasoning_effort: 'medium' });
  assert.strictEqual(o.native, true);
});

t('effort=high 透传', () => {
  const o = rp.buildReasoningParams(mk('openai', 'o3', { deepThinking: { enabled: true, effort: 'high' } }));
  assert.strictEqual(o.extraBody.reasoning_effort, 'high');
});

t('非法 effort 归一到 medium', () => {
  const o = rp.buildReasoningParams(mk('openai', 'gpt-5', { deepThinking: { enabled: true, effort: '超级思考' } }));
  assert.strictEqual(o.extraBody.reasoning_effort, 'medium');
});

t('grok 只认 low|high：medium → high', () => {
  const o = rp.buildReasoningParams(mk('grok', 'grok-3-mini'));
  assert.strictEqual(o.extraBody.reasoning_effort, 'high');
});

t('anthropic 生成 thinking 块并强制 temperature=1 / 抬高 max_tokens', () => {
  const o = rp.buildReasoningParams(mk('claude', 'claude-sonnet-4-5', { transport: 'anthropic' }));
  assert.deepStrictEqual(o.extraBody.thinking, { type: 'enabled', budget_tokens: 4096 });
  assert.strictEqual(o.temperature, 1);
  assert.strictEqual(o.minMaxTokens, 4096 + 1024);
});

t('anthropic 自定义 budgetTokens 优先于 effort', () => {
  const o = rp.buildReasoningParams(
    mk('claude', 'claude-sonnet-4-5', { transport: 'anthropic', deepThinking: { enabled: true, effort: 'low', budgetTokens: 12000 } })
  );
  assert.strictEqual(o.extraBody.thinking.budget_tokens, 12000);
  assert.strictEqual(o.minMaxTokens, 13024);
});

t('responses 生成 reasoning.effort；官方 openai 附带 summary', () => {
  const o = rp.buildReasoningParams(mk('openai', 'gpt-5', { apiMode: 'responses' }));
  assert.strictEqual(o.extraBody.reasoning.effort, 'medium');
  assert.strictEqual(o.extraBody.reasoning.summary, 'auto');
});

t('responses 第三方（deepseek）不加 summary，避免被拒', () => {
  const o = rp.buildReasoningParams(mk('deepseek', 'deepseek-v4-flash', { apiMode: 'responses' }));
  assert.strictEqual(o.extraBody.reasoning.summary, undefined);
});

t('qwen 流式：enable_thinking=true + thinking_budget', () => {
  const o = rp.buildReasoningParams(mk('dashscope', 'qwen3-max'), { stream: true });
  assert.strictEqual(o.extraBody.enable_thinking, true);
  assert.strictEqual(o.extraBody.thinking_budget, 4096);
});

t('qwen 非流式：同样开启思考（官方文档无此限制，靠拒绝重试兜底老模型）', () => {
  const o = rp.buildReasoningParams(mk('dashscope', 'qwen3-max'), { stream: false });
  assert.strictEqual(o.extraBody.enable_thinking, true);
  assert.strictEqual(o.extraBody.thinking_budget, 4096);
  assert.strictEqual(o.native, true);
});

t('zhipu 生成 thinking:{type:enabled}', () => {
  const o = rp.buildReasoningParams(mk('zhipu', 'glm-4.5'));
  assert.deepStrictEqual(o.extraBody.thinking, { type: 'enabled' });
});

t('openrouter 默认用 effort，有预算时改用 max_tokens', () => {
  const a = rp.buildReasoningParams(mk('openrouter', 'x/y'));
  assert.deepStrictEqual(a.extraBody.reasoning, { effort: 'medium' });
  const b = rp.buildReasoningParams(mk('openrouter', 'x/y', { deepThinking: { enabled: true, effort: 'low', budgetTokens: 3000 } }));
  assert.deepStrictEqual(b.extraBody.reasoning, { max_tokens: 3000 });
});

t('无原生开关（deepseek-chat）→ 空 body + 提示词兜底', () => {
  const o = rp.buildReasoningParams(mk('deepseek', 'deepseek-chat'));
  assert.deepStrictEqual(o.extraBody, {});
  assert.ok(o.promptHint.length > 0);
});

t('promptFallback=false 时不注入提示词', () => {
  const o = rp.buildReasoningParams(mk('deepseek', 'deepseek-chat', { deepThinking: { enabled: true, effort: 'medium', promptFallback: false } }));
  assert.strictEqual(o.promptHint, '');
});

t('DeepSeek V4 原生思考：thinking:{enabled} + reasoning_effort（high→max）', () => {
  const o = rp.buildReasoningParams(mk('deepseek', 'deepseek-v4-flash', { deepThinking: { enabled: true, effort: 'high' } }));
  assert.deepStrictEqual(o.extraBody.thinking, { type: 'enabled' });
  assert.strictEqual(o.extraBody.reasoning_effort, 'max');
  assert.strictEqual(o.native, true);
  const med = rp.buildReasoningParams(mk('deepseek', 'deepseek-v4-flash', { deepThinking: { enabled: true, effort: 'medium' } }));
  assert.strictEqual(med.extraBody.reasoning_effort, 'high');
  const low = rp.buildReasoningParams(mk('deepseek', 'deepseek-v4-flash', { deepThinking: { enabled: true, effort: 'low' } }));
  assert.strictEqual(low.extraBody.reasoning_effort, 'low');
});

t('DeepSeek Responses：reasoning.effort（high→max），第三方不加 summary', () => {
  const o = rp.buildReasoningParams(mk('deepseek', 'deepseek-v4-flash', { apiMode: 'responses', deepThinking: { enabled: true, effort: 'high' } }));
  assert.deepStrictEqual(o.extraBody.reasoning, { effort: 'max' });
});

t('智谱 GLM 原生思考：thinking:{enabled} + reasoning_effort 控制强度', () => {
  const o = rp.buildReasoningParams(mk('zhipu', 'glm-5.2', { deepThinking: { enabled: true, effort: 'high' } }));
  assert.deepStrictEqual(o.extraBody.thinking, { type: 'enabled' });
  assert.strictEqual(o.extraBody.reasoning_effort, 'high');
  assert.strictEqual(o.native, true);
});

t('月之暗面 Kimi 原生思考：thinking:{enabled}，强制 temperature=1', () => {
  const o = rp.buildReasoningParams(mk('moonshot', 'kimi-k2.6', { deepThinking: { enabled: true, effort: 'medium' } }));
  assert.deepStrictEqual(o.extraBody.thinking, { type: 'enabled' });
  assert.strictEqual(o.temperature, 1);
  assert.strictEqual(o.native, true);
  // k2.7-code 始终思考，enabled 安全（disabled 会报错，但本策略只发 enabled）
  const code = rp.buildReasoningParams(mk('moonshot', 'kimi-k2.7-code', { deepThinking: { enabled: true, effort: 'medium' } }));
  assert.deepStrictEqual(code.extraBody.thinking, { type: 'enabled' });
});

t('grok-4.5 原生思考：reasoning_effort 透传', () => {
  const o = rp.buildReasoningParams(mk('grok', 'grok-4.5', { deepThinking: { enabled: true, effort: 'high' } }));
  assert.strictEqual(o.extraBody.reasoning_effort, 'high');
  assert.strictEqual(o.native, true);
});

t('关闭态对默认开思考的模型显式下发 disabled', () => {
  const ds = rp.buildReasoningParams(mk('deepseek', 'deepseek-v4-flash', { deepThinking: { enabled: false } }));
  assert.deepStrictEqual(ds.extraBody.thinking, { type: 'disabled' });
  const glm = rp.buildReasoningParams(mk('zhipu', 'glm-5.2', { deepThinking: { enabled: false } }));
  assert.deepStrictEqual(glm.extraBody.thinking, { type: 'disabled' });
  const kimi = rp.buildReasoningParams(mk('moonshot', 'kimi-k2.6', { deepThinking: { enabled: false } }));
  assert.deepStrictEqual(kimi.extraBody.thinking, { type: 'disabled' });
});

// ── 关闭态 ────────────────────────────────────────────────
t('关闭时对 qwen 主动下发 enable_thinking=false', () => {
  const o = rp.buildReasoningParams(mk('dashscope', 'qwen3-max', { deepThinking: { enabled: false } }));
  assert.strictEqual(o.extraBody.enable_thinking, false);
  assert.strictEqual(o.enabled, false);
});

t('关闭时对 GLM 主动下发 thinking:{type:disabled}', () => {
  const o = rp.buildReasoningParams(mk('zhipu', 'glm-4.5', { deepThinking: { enabled: false } }));
  assert.deepStrictEqual(o.extraBody.thinking, { type: 'disabled' });
});

t('关闭时其它后端不注入任何字段、不注入提示词', () => {
  const o = rp.buildReasoningParams(mk('openai', 'gpt-5', { deepThinking: { enabled: false } }));
  assert.deepStrictEqual(o.extraBody, {});
  assert.strictEqual(o.promptHint, '');
});

t('cfg 缺 deepThinking 字段时安全降级为关闭', () => {
  const o = rp.buildReasoningParams({ provider: 'openai', model: 'gpt-5' });
  assert.strictEqual(o.enabled, false);
  assert.deepStrictEqual(o.extraBody, {});
});

// ── 服务端拒绝识别 ────────────────────────────────────────
t('识别「不支持 reasoning_effort」类报错', () => {
  assert.strictEqual(rp.looksLikeReasoningRejection(new Error('Unrecognized request argument supplied: reasoning_effort')), true);
  assert.strictEqual(rp.looksLikeReasoningRejection(new Error('参数 enable_thinking 不支持')), true);
});

t('普通报错不误判', () => {
  assert.strictEqual(rp.looksLikeReasoningRejection(new Error('rate limit exceeded')), false);
  assert.strictEqual(rp.looksLikeReasoningRejection(new Error('invalid api key')), false);
  assert.strictEqual(rp.looksLikeReasoningRejection(null), false);
});

// ── 提示词声明（让模型自知处于深度思考模式 + 强度感知 + 抗上下文干扰）────────────────
t('high 强度提示词包含模式声明与抗上下文干扰指令', () => {
  const o = rp.buildReasoningParams(mk('deepseek', 'deepseek-chat', { deepThinking: { enabled: true, effort: 'high' } }));
  assert.ok(o.promptHint.indexOf('【深度思考模式 · 强度：high】') >= 0);
  assert.ok(o.promptHint.indexOf('不要让多轮对话中的无关上下文带偏判断') >= 0);
});

t('low / medium / high 的提示词强度不同', () => {
  const low = rp.buildReasoningParams(mk('deepseek', 'deepseek-chat', { deepThinking: { enabled: true, effort: 'low' } })).promptHint;
  const med = rp.buildReasoningParams(mk('deepseek', 'deepseek-chat', { deepThinking: { enabled: true, effort: 'medium' } })).promptHint;
  const high = rp.buildReasoningParams(mk('deepseek', 'deepseek-chat', { deepThinking: { enabled: true, effort: 'high' } })).promptHint;
  assert.ok(low.indexOf('简洁推理') >= 0);
  assert.ok(med.indexOf('分步推理') >= 0);
  assert.ok(high.indexOf('充分推理') >= 0);
  assert.notStrictEqual(low, med);
  assert.notStrictEqual(med, high);
});

t('原生支持思考的模型也注入提示词声明（OpenAI/Claude/通义/glm/openrouter）', () => {
  const openai = rp.buildReasoningParams(mk('openai', 'gpt-5'));
  assert.ok(openai.promptHint.indexOf('【深度思考模式 · 强度：medium】') >= 0);
  const claude = rp.buildReasoningParams(mk('claude', 'claude-sonnet-4-5', { transport: 'anthropic' }));
  assert.ok(claude.promptHint.indexOf('【深度思考模式') >= 0);
  const qwen = rp.buildReasoningParams(mk('dashscope', 'qwen3-max'), { stream: true });
  assert.ok(qwen.promptHint.indexOf('【深度思考模式') >= 0);
  const glm = rp.buildReasoningParams(mk('zhipu', 'glm-4.5'));
  assert.ok(glm.promptHint.indexOf('【深度思考模式') >= 0);
  const or_ = rp.buildReasoningParams(mk('openrouter', 'x/y'));
  assert.ok(or_.promptHint.indexOf('【深度思考模式') >= 0);
});

t('DeepSeek Responses 非 reasoner 同时拿到模式声明与结构化格式要求', () => {
  const o = rp.buildReasoningParams(mk('deepseek', 'deepseek-v4-flash', { apiMode: 'responses', deepThinking: { enabled: true, effort: 'high' } }));
  assert.ok(o.promptHint.indexOf('【深度思考模式 · 强度：high】') >= 0);
  assert.ok(o.promptHint.indexOf('【推理过程格式要求】') >= 0);
  assert.ok(o.promptHint.indexOf('Markdown 层级标题') >= 0);
});

if (!process.exitCode) console.log('reasoningParams 全部通过');
