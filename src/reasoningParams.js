'use strict';
/**
 * 深度思考（reasoning / thinking）跨后端参数映射。
 *
 * 各家厂商开启「先思考再回答」的字段完全不同，这里统一成一个纯函数：
 *   输入 cfg（config.resolve 的结果）+ 是否流式
 *   输出 { extraBody, temperature, minMaxTokens, promptHint, ... }
 * 调用方（agent.js callModel）只需把 extraBody 并进请求 options，无需关心厂商差异。
 *
 * 所有参数名/取值均核对自各厂商官方文档（2026-08）：
 *   - OpenAI        Chat: reasoning_effort(顶层)   Responses: reasoning.effort
 *   - Anthropic     thinking:{type:"enabled",budget_tokens}（temp 必须=1）
 *   - DeepSeek V4   thinking:{type:"enabled"} + reasoning_effort(low/high/max)，默认即开思考
 *   - 智谱 GLM      thinking:{type:"enabled"} + reasoning_effort(max/xhigh/high/medium/low/minimal/none)，默认即开思考
 *   - 月之暗面 Kimi  thinking:{type:"enabled"/"disabled"}（思考模型 temp 不可改，强制 1）
 *   - 通义 Qwen     enable_thinking + thinking_budget
 *   - xAI Grok      reasoning_effort(low/medium/high)，grok-4.x 全支持
 *   - Gemini(OC)    reasoning_effort(顶层)  minimal/low/medium/high/none(2.5)
 *   - OpenRouter    reasoning:{effort}（嵌套，由 OR 统一映射到底层）
 *
 * 纯函数、无 vscode 依赖，方便单测。
 */

const EFFORTS = ['low', 'medium', 'high'];

// Claude 思考预算（token）
const CLAUDE_BUDGET = { low: 2048, medium: 4096, high: 8192 };
// 通义千问 thinking_budget（token）
const QWEN_BUDGET = { low: 1024, medium: 4096, high: 16384 };

// 深度思考提示词由下方 buildDeepThinkingPrompt / buildDeepSeekStructuredPrompt 动态生成，
// 按 effort 强度变化，并统一追加「聚焦当前问题、抵抗无关上下文干扰」的约束。

function normEffort(e) {
  const v = String(e || 'medium').toLowerCase();
  return EFFORTS.indexOf(v) >= 0 ? v : 'medium';
}

function budgetForEffort(effort, table) {
  return (table || CLAUDE_BUDGET)[normEffort(effort)] || 4096;
}

/** 按强度给出具体推理要求 */
function effortSpecific(effort) {
  switch (normEffort(effort)) {
    case 'low':
      return '简洁推理：简要拆分问题，快速抓住核心，结论附一句关键依据，不要过度展开。';
    case 'high':
      return '充分推理：把问题拆成子问题，多角度验证，主动挑战自身假设并检查边界条件与反例；涉及代码/数据时必须先核对事实（读文件、跑命令）再下结论；优先基于当前问题本身推理，不要让多轮对话中的无关上下文带偏判断；若发现前文推理有误，明确纠正后再继续；结论必须附关键推理依据。';
    case 'medium':
    default:
      return '分步推理：把问题拆成子问题，逐步推导，检查边界条件与反例；涉及代码/数据时先核对事实再下结论；结论附关键推理依据。';
  }
}

/** 通用深度思考提示词（所有厂商、所有强度共用，作为原生开关之外的兜底声明） */
function buildDeepThinkingPrompt(effort) {
  return [
    '【深度思考模式 · 强度：' + normEffort(effort) + '】',
    '你当前必须先完成完整推理，再输出最终答案。',
    effortSpecific(effort),
    '注意：聚焦用户当前问题，不要让无关上下文干扰判断。'
  ].join('\n');
}

/**
 * DeepSeek 非 reasoner 模型（deepseek-chat/deepseek-v4-flash 等）通过 Responses API
 * 开启 reasoning 时，服务端返回的 reasoning_text 常是未经专门训练的意识流：无标点、
 * 无结构、中英文混杂。追加结构化提示词约束输出格式。
 */
function buildDeepSeekStructuredPrompt(effort) {
  return buildDeepThinkingPrompt(effort) + '\n\n' + [
    '【推理过程格式要求】',
    '在输出最终答案前，请先完整完成推理，并按以下格式书写思考过程：',
    '1. 使用 Markdown 层级标题（如 ## 1. 解析用户请求、## 2. 初步分析、## 3. 最终方案）；',
    '2. 每个标题下用 bullet list 展开要点，每条要点必须有完整标点，禁止使用一整段无标点的意识流；',
    '3. 推理过程使用中文，专有名词可保留英文；',
    '4. 必须先完成全部推理，再开始输出最终答案，严禁在推理尚未结束时提前输出答案内容；',
    '5. 最终答案与推理过程之间用换行分隔。'
  ].join('\n');
}

/** 保持向后兼容的导出常量（medium 强度） */
const DEEP_THINKING_PROMPT = buildDeepThinkingPrompt('medium');

/**
 * 把内部 effort(low/medium/high) 映射成各厂商真实支持的强度取值。
 * @returns {string|null} 厂商取值；返回 null 表示该厂商不支持强度控制（调用方不发送）。
 */
function mapEffort(provider, model, effort) {
  const e = normEffort(effort);
  const p = String(provider || '').toLowerCase();
  const m = String(model || '').toLowerCase();

  // DeepSeek Responses/Chat：low/high/max（medium→high，high→max）
  if (p === 'deepseek' || /deepseek/.test(m)) {
    if (e === 'low') return 'low';
    if (e === 'high') return 'max';
    return 'high'; // medium
  }
  // 智谱 GLM：max/xhigh/high/medium/low/minimal/none；low/medium/high 均直接可用
  if (p === 'zhipu' || /glm|chatglm/.test(m)) {
    return e; // low/medium/high
  }
  // xAI Grok：low/medium/high（grok-3-mini 仅 low/high，medium→high）
  if (p === 'grok' || /grok/.test(m)) {
    if (/grok-3-mini/.test(m) && e === 'medium') return 'high';
    return e;
  }
  // 其余（OpenAI / Gemini / OpenRouter 等）：low/medium/high 直接可用
  return e;
}

/**
 * 判断该用哪套思考参数。
 * @returns {'anthropic'|'responses'|'openai_effort'|'qwen'|'zhipu'|'deepseek'|'kimi'|'openrouter'|'none'}
 */
function pickStrategy(ctx) {
  const provider = String((ctx && ctx.provider) || '').toLowerCase();
  const model = String((ctx && ctx.model) || '').toLowerCase();
  const apiMode = String((ctx && ctx.apiMode) || 'chat').toLowerCase();
  const transport = String((ctx && ctx.transport) || 'openai').toLowerCase();

  // 1) Anthropic 原生传输：扩展思考（仅 3.7 及以后支持；4.7+ 已不支持 manual extended thinking）
  if (transport === 'anthropic') {
    if (/claude-3-(5|opus|sonnet|haiku)/.test(model) || /claude-2/.test(model)) return 'none';
    if (/claude-(4-[7-9]|[5-9])/.test(model)) return 'none'; // 4.7+ 拒绝 extended thinking
    return 'anthropic';
  }

  // 2) Responses API：reasoning.effort（OpenAI/DeepSeek 等均用此格式）
  if (apiMode === 'responses') return 'responses';

  // 3) 按 provider 判断
  switch (provider) {
    case 'dashscope':
      return /qwen|qwq|tongyi/.test(model) ? 'qwen' : 'none';
    case 'siliconflow':
      return byModel(model);
    case 'zhipu':
      return /glm|chatglm/.test(model) ? 'zhipu' : 'none';
    case 'deepseek':
      return deepseekSupports(model) ? 'deepseek' : 'none';
    case 'moonshot':
      return kimiSupports(model) ? 'kimi' : 'none';
    case 'openrouter':
      return 'openrouter';
    case 'openai':
      return openaiSupports(model) ? 'openai_effort' : 'none';
    case 'gemini':
      return geminiSupports(model) ? 'openai_effort' : 'none';
    case 'grok':
      return grokSupports(model) ? 'openai_effort' : 'none';
    case 'moonshotai':
      return kimiSupports(model) ? 'kimi' : 'none';
    // 本地模型：参数约定与云端不同（如 ollama 用 think 而非 enable_thinking），
    // 本扩展未实现其原生开关，统一走 none（提示词兜底），避免发错字段被拒。
    case 'ollama':
    case 'llamacpp':
    case 'lmstudio':
      return 'none';
    default:
      // custom / 中转站：只能按模型名猜
      return byModel(model);
  }
}

function openaiSupports(model) {
  return /gpt-5|gpt-oss|(^|[^a-z])o[134]([^0-9a-z]|$)/.test(model);
}
function geminiSupports(model) {
  return /2\.5|3\.\d|thinking/.test(model);
}
function grokSupports(model) {
  // 所有 grok 推理模型都接受 reasoning_effort（grok-4.x 全支持；grok-3-mini 仅 low/high，由 mapEffort 归一）
  return /grok/.test(model);
}
function deepseekSupports(model) {
  // deepseek-chat 是非思考模式别名（v4-flash 的非思考态），不要强制开思考
  if (/deepseek-chat/.test(model)) return false;
  return /deepseek/.test(model);
}
function kimiSupports(model) {
  // kimi-k2.5/k2.6/k2.7-code 均支持 thinking 参数；k2.7-code 始终思考（传 disabled 会报错，但 enabled 安全）
  // Moonshot-Kimi-K2-Instruct 不支持思考
  if (/k2-instruct/.test(model)) return false;
  return /kimi|k2/.test(model);
}

/** 按模型名推断（custom 中转站 / siliconflow 场景） */
function byModel(model) {
  if (/qwen|qwq|tongyi/.test(model)) return 'qwen';
  if (/glm|chatglm/.test(model)) return 'zhipu';
  if (/deepseek/.test(model)) return /deepseek-chat/.test(model) ? 'none' : 'deepseek';
  if (/kimi|k2/.test(model)) return /k2-instruct/.test(model) ? 'none' : 'kimi';
  if (/claude/.test(model)) {
    if (/claude-3-(5|opus|sonnet|haiku)/.test(model) || /claude-2/.test(model)) return 'none';
    if (/claude-(4-[7-9]|[5-9])/.test(model)) return 'none';
    return 'anthropic';
  }
  if (/gemini/.test(model)) return geminiSupports(model) ? 'openai_effort' : 'none';
  if (/grok/.test(model)) return grokSupports(model) ? 'openai_effort' : 'none';
  if (openaiSupports(model)) return 'openai_effort';
  return 'none';
}

/**
 * 构造本次调用要注入的思考参数。
 * @param {object} cfg config.resolve 结果（需含 deepThinking / provider / model / apiMode / transport）
 * @param {object} [opts] { stream: boolean }
 * @returns {{
 *   enabled: boolean, effort: string, strategy: string,
 *   extraBody: object, temperature: (number|null), minMaxTokens: number,
 *   promptHint: string, native: boolean, reason: string
 * }}
 */
function buildReasoningParams(cfg, opts) {
  const dt = (cfg && cfg.deepThinking) || {};
  const enabled = !!dt.enabled;
  const effort = normEffort(dt.effort);
  const stream = !opts || opts.stream !== false;
  const model = String((cfg && cfg.model) || '');
  const provider = String((cfg && (cfg.providerId || cfg.provider)) || '').toLowerCase();
  const apiMode = String((cfg && cfg.apiMode) || 'chat').toLowerCase();
  const strategy = pickStrategy({
    provider: (cfg && (cfg.providerId || cfg.provider)) || '',
    model,
    apiMode: (cfg && cfg.apiMode) || 'chat',
    transport: (cfg && cfg.transport) || 'openai'
  });

  // 是否属于 DeepSeek + Responses API（非 reasoner），需要追加结构化格式要求
  const isDeepSeekResp = strategy === 'responses' && (
    provider === 'deepseek' || /deepseek/.test(String(cfg.baseUrl || '').toLowerCase())
  );
  const isReasoner = /reasoner|r1/.test(model);

  const out = {
    enabled,
    effort,
    strategy,
    extraBody: {},
    temperature: null,
    minMaxTokens: 0,
    promptHint: '',
    native: false,
    reason: ''
  };

  // —— 关闭：对「默认就会思考」的模型主动下发关闭开关，否则它们会一直思考 ——
  if (!enabled) {
    if (isDeepSeekResp && !isReasoner) {
      // DeepSeek 非 reasoner（v4-flash / v4-pro）Responses API 默认开启思考（默认 effort=high），
      // 必须显式下发 effort:none 关闭，否则模型以高强度思考产生超长意识流：反复规划、吃光
      // max_output_tokens 导致正文为空/截断（「问一句干一个事」「模型没有返回任何内容」的根因）。
      out.extraBody.reasoning = { effort: 'none' };
      out.reason = '显式关闭 DeepSeek Responses 思考（effort=none）';
    } else if (strategy === 'qwen') {
      out.extraBody.enable_thinking = false;
      out.reason = '显式关闭通义思考';
    } else if (strategy === 'zhipu') {
      out.extraBody.thinking = { type: 'disabled' };
      out.reason = '显式关闭 GLM 思考（默认开启）';
    } else if (strategy === 'deepseek') {
      out.extraBody.thinking = { type: 'disabled' };
      out.reason = '显式关闭 DeepSeek 思考（默认开启）';
    } else if (strategy === 'kimi') {
      out.extraBody.thinking = { type: 'disabled' };
      out.reason = '显式关闭 Kimi 思考（默认开启）';
    } else {
      out.reason = '未开启深度思考';
    }
    return out;
  }

  switch (strategy) {
    case 'anthropic': {
      const budget = dt.budgetTokens > 0 ? Math.floor(dt.budgetTokens) : budgetForEffort(effort, CLAUDE_BUDGET);
      out.extraBody.thinking = { type: 'enabled', budget_tokens: budget };
      // Anthropic 规定：开启 thinking 时 temperature 只能是 1
      out.temperature = 1;
      out.minMaxTokens = budget + 1024;
      out.native = true;
      out.reason = 'Anthropic 扩展思考 budget=' + budget;
      break;
    }
    case 'responses': {
      // DeepSeek Responses 的 reasoning.effort 取值是 none/minimal/low/medium/high/xhigh/max（区别于
      // Chat 的 low/high/max）：minimal/low=低强度，medium/high/xhigh=高强度，max=最高。这里把内部
      // low/medium/high 正确映射为 low/medium/max，避免沿用 Chat 的 high 取值导致强度错档。
      const eff = isDeepSeekResp
        ? (effort === 'low' ? 'low' : effort === 'high' ? 'max' : 'medium')
        : mapEffort(provider, model, effort);
      const r = { effort: eff };
      // 官方 OpenAI 才支持思考摘要，第三方 /responses 实现可能不认
      if (provider === 'openai') r.summary = 'auto';
      out.extraBody.reasoning = r;
      out.native = true;
      out.reason = 'Responses API reasoning.effort=' + eff + (isDeepSeekResp && !isReasoner ? ' + DeepSeek 结构化推理提示词' : '');
      break;
    }
    case 'openai_effort': {
      const e = mapEffort(provider, model, effort);
      out.extraBody.reasoning_effort = e;
      out.native = true;
      out.reason = 'reasoning_effort=' + e;
      break;
    }
    case 'qwen': {
      out.extraBody.enable_thinking = true;
      out.extraBody.thinking_budget = dt.budgetTokens > 0
        ? Math.floor(dt.budgetTokens)
        : budgetForEffort(effort, QWEN_BUDGET);
      out.native = true;
      out.reason = 'enable_thinking=true budget=' + out.extraBody.thinking_budget;
      break;
    }
    case 'zhipu': {
      out.extraBody.thinking = { type: 'enabled' };
      const eff = mapEffort('zhipu', model, effort);
      if (eff) out.extraBody.reasoning_effort = eff;
      out.native = true;
      out.reason = 'GLM thinking=enabled' + (eff ? ' effort=' + eff : '');
      break;
    }
    case 'deepseek': {
      out.extraBody.thinking = { type: 'enabled' };
      const eff = mapEffort('deepseek', model, effort);
      if (eff) out.extraBody.reasoning_effort = eff;
      out.native = true;
      // 注：DeepSeek 思考模式忽略 temperature，无需覆盖
      out.reason = 'DeepSeek thinking=enabled effort=' + eff;
      break;
    }
    case 'kimi': {
      out.extraBody.thinking = { type: 'enabled' };
      out.temperature = 1; // Kimi 思考模型 temperature 不可改，强制 1
      out.native = true;
      out.reason = 'Kimi thinking=enabled';
      break;
    }
    case 'openrouter': {
      // OpenRouter 统一用 reasoning 对象：可指定 effort，或指定 max_tokens（更精确控制预算）
      out.extraBody.reasoning = dt.budgetTokens > 0
        ? { max_tokens: Math.floor(dt.budgetTokens) }
        : { effort: mapEffort('openrouter', model, effort) };
      out.native = true;
      out.reason = 'OpenRouter reasoning=' + JSON.stringify(out.extraBody.reasoning);
      break;
    }
    default: {
      // 没有原生开关：完全依赖提示词兜底（最终由下方统一注入）
      out.reason = dt.promptFallback === false ? '无原生开关且已关闭提示词兜底' : '无原生开关，提示词兜底';
      break;
    }
  }

  // 提示词声明：开启深度思考后，统一追加「模式+强度+聚焦/抗上下文干扰」提示词，
  // 让所有厂商模型都明确自知处于深度思考模式；DeepSeek 非 reasoner + Responses 额外追加结构化格式。
  if (enabled && dt.promptFallback !== false) {
    out.promptHint = isDeepSeekResp && !isReasoner
      ? buildDeepSeekStructuredPrompt(effort)
      : buildDeepThinkingPrompt(effort);
  }

  return out;
}

/** 请求被服务端以「不认识思考参数」为由拒绝时，用于去参重试的判断 */
function looksLikeReasoningRejection(err) {
  const msg = String((err && (err.message || err.error || err)) || '').toLowerCase();
  if (!msg) return false;
  if (!/(unknown|unsupport|not support|unrecognized|invalid|unexpected|extra|无效|不支持|不存在)/.test(msg)) return false;
  return /(reasoning_effort|enable_thinking|thinking_budget|thinking|reasoning)/.test(msg);
}

module.exports = {
  EFFORTS,
  CLAUDE_BUDGET,
  QWEN_BUDGET,
  DEEP_THINKING_PROMPT,
  normEffort,
  budgetForEffort,
  mapEffort,
  pickStrategy,
  buildReasoningParams,
  looksLikeReasoningRejection,
  buildDeepThinkingPrompt,
  buildDeepSeekStructuredPrompt,
  openaiSupports,
  geminiSupports,
  grokSupports,
  deepseekSupports,
  kimiSupports
};
