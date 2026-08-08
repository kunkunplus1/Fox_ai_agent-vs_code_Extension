'use strict';
/**
 * 深度思考（reasoning / thinking）跨后端参数映射。
 *
 * 各家厂商开启「先思考再回答」的字段完全不同，这里统一成一个纯函数：
 *   输入 cfg（config.resolve 的结果）+ 是否流式
 *   输出 { extraBody, temperature, minMaxTokens, promptHint, ... }
 * 调用方（agent.js callModel）只需把 extraBody 并进请求 options，无需关心厂商差异。
 *
 * 纯函数、无 vscode 依赖，方便单测。
 */

const EFFORTS = ['low', 'medium', 'high'];

// Claude 思考预算（token）
const CLAUDE_BUDGET = { low: 2048, medium: 4096, high: 8192 };
// 通义千问 thinking_budget（token）
const QWEN_BUDGET = { low: 1024, medium: 4096, high: 16384 };

/** 开启深度思考但模型没有原生开关时，用提示词兜底 */
const DEEP_THINKING_PROMPT = [
  '【深度思考模式】本次会话要求你先推理再作答：',
  '1. 回答前先在心里把问题拆成子问题，逐步推导，检查边界条件与反例；',
  '2. 涉及代码/数据时，先核对事实（读文件、跑命令）再下结论，不要凭印象；',
  '3. 给出结论时附上关键推理依据，但不要输出冗长的自言自语；',
  '4. 如果发现自己前面的推理有误，明确纠正后再继续。'
].join('\n');

function normEffort(e) {
  const v = String(e || 'medium').toLowerCase();
  return EFFORTS.indexOf(v) >= 0 ? v : 'medium';
}

function budgetForEffort(effort, table) {
  return (table || CLAUDE_BUDGET)[normEffort(effort)] || 4096;
}

/**
 * 判断该用哪套思考参数。
 * @returns {'anthropic'|'responses'|'openai_effort'|'qwen'|'zhipu'|'openrouter'|'none'}
 */
function pickStrategy(ctx) {
  const provider = String((ctx && ctx.provider) || '').toLowerCase();
  const model = String((ctx && ctx.model) || '').toLowerCase();
  const apiMode = String((ctx && ctx.apiMode) || 'chat').toLowerCase();
  const transport = String((ctx && ctx.transport) || 'openai').toLowerCase();

  // 1) Anthropic 原生传输：扩展思考（仅 3.7 及以后支持）
  if (transport === 'anthropic') {
    if (/claude-3-(5|opus|sonnet|haiku)/.test(model) || /claude-2/.test(model)) return 'none';
    return 'anthropic';
  }

  // 2) Responses API：reasoning.effort
  if (apiMode === 'responses') return 'responses';

  // 3) 按 provider 判断
  switch (provider) {
    case 'dashscope':
      return /qwen|qwq|tongyi/.test(model) ? 'qwen' : 'none';
    case 'siliconflow':
      return byModel(model);
    case 'zhipu':
      return /glm|chatglm/.test(model) ? 'zhipu' : 'none';
    case 'openrouter':
      return 'openrouter';
    case 'openai':
      return openaiSupports(model) ? 'openai_effort' : 'none';
    case 'gemini':
      return geminiSupports(model) ? 'openai_effort' : 'none';
    case 'grok':
      return grokSupports(model) ? 'openai_effort' : 'none';
    case 'deepseek':
      // deepseek-reasoner 内生思考、无开关；deepseek-chat 无原生参数 → 提示词兜底
      return 'none';
    case 'moonshot':
    case 'mistral':
    case 'ollama':
    case 'lmstudio':
    case 'llamacpp':
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
  // grok-4 一直思考且不接受 reasoning_effort；grok-3-mini 支持 low|high
  if (/grok-4/.test(model)) return false;
  return /mini/.test(model);
}

/** 按模型名推断（custom 中转站 / siliconflow 场景） */
function byModel(model) {
  if (/qwen|qwq|tongyi/.test(model)) return 'qwen';
  if (/glm|chatglm/.test(model)) return 'zhipu';
  if (/claude/.test(model)) {
    if (/claude-3-(5|opus|sonnet|haiku)/.test(model) || /claude-2/.test(model)) return 'none';
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
  const strategy = pickStrategy({
    provider: (cfg && (cfg.providerId || cfg.provider)) || '',
    model,
    apiMode: (cfg && cfg.apiMode) || 'chat',
    transport: (cfg && cfg.transport) || 'openai'
  });

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

  // —— 关闭：对「默认就会思考」的模型主动下发关闭开关 ——
  if (!enabled) {
    if (strategy === 'qwen') {
      out.extraBody.enable_thinking = false;
      out.reason = '显式关闭通义思考';
    } else if (strategy === 'zhipu') {
      out.extraBody.thinking = { type: 'disabled' };
      out.reason = '显式关闭 GLM 思考';
    } else {
      out.reason = '未开启深度思考';
    }
    return out;
  }

  switch (strategy) {
    case 'anthropic': {
      const budget = dt.budgetTokens > 0 ? Math.floor(dt.budgetTokens) : budgetForEffort(effort, CLAUDE_BUDGET);
      out.extraBody.thinking = { type: 'enabled', budget_tokens: budget };
      // Anthropic 规定：开启 thinking 时 temperature 只能是 1，且 max_tokens 必须大于预算
      out.temperature = 1;
      out.minMaxTokens = budget + 1024;
      out.native = true;
      out.reason = 'Anthropic 扩展思考 budget=' + budget;
      break;
    }
    case 'responses': {
      const r = { effort };
      // 官方 OpenAI 才支持思考摘要，第三方 /responses 实现可能不认
      if (String(cfg.providerId || cfg.provider || '') === 'openai') r.summary = 'auto';
      out.extraBody.reasoning = r;
      out.native = true;
      out.reason = 'Responses API reasoning.effort=' + effort;
      break;
    }
    case 'openai_effort': {
      let e = effort;
      if (/grok/i.test(model) && e === 'medium') e = 'high'; // xAI 只认 low|high
      out.extraBody.reasoning_effort = e;
      out.native = true;
      out.reason = 'reasoning_effort=' + e;
      break;
    }
    case 'qwen': {
      if (!stream) {
        // DashScope 规定：非流式调用必须 enable_thinking=false，否则直接报错
        out.extraBody.enable_thinking = false;
        out.promptHint = dt.promptFallback === false ? '' : DEEP_THINKING_PROMPT;
        out.reason = '通义非流式不支持思考，改用提示词兜底';
        break;
      }
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
      out.native = true;
      out.reason = 'GLM thinking=enabled';
      break;
    }
    case 'openrouter': {
      out.extraBody.reasoning = dt.budgetTokens > 0
        ? { max_tokens: Math.floor(dt.budgetTokens) }
        : { effort };
      out.native = true;
      out.reason = 'OpenRouter reasoning';
      break;
    }
    default: {
      // 没有原生开关：用提示词兜底（可关）
      out.promptHint = dt.promptFallback === false ? '' : DEEP_THINKING_PROMPT;
      out.reason = out.promptHint ? '无原生开关，提示词兜底' : '无原生开关且已关闭提示词兜底';
      break;
    }
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
  pickStrategy,
  buildReasoningParams,
  looksLikeReasoningRejection
};
