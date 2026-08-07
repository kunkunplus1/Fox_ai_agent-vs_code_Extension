'use strict';

/**
 * 轻量上下文用量估算器。
 * 狐狸 AI 零依赖，没有真正的 tokenizer；这里用混合字符估算 + 经验校准来逼近真实值。
 * 对中文按约 1 token / 1.5 字符估算（Qwen/GPT 类 tokenizer 实测更接近 1.3~1.7），
 * 对 ASCII 按 1 token / 4 字符估算，同时加上 OpenAI 格式消息与工具定义的经验开销。
 * 结果仍只是估算，可用于观察占比；与服务商账单存在 ±20% 偏差属正常。
 */

function isCjk(ch) {
  const c = ch.charCodeAt(0);
  // CJK 统一表意文字及其扩展区 A/B/C/D/E/F/G
  if (c >= 0x4e00 && c <= 0x9fff) return true;
  if (c >= 0x3400 && c <= 0x4dbf) return true;
  if (c >= 0x20000 && c <= 0x2ebef) return true;
  // 平假名、片假名、谚文、全角标点等也按较密的 token 估算
  if (c >= 0x3040 && c <= 0x309f) return true;
  if (c >= 0x30a0 && c <= 0x30ff) return true;
  if (c >= 0xac00 && c <= 0xd7af) return true;
  if (c >= 0xff00 && c <= 0xffef) return true;
  return false;
}

function estimateTokens(text) {
  if (text == null) return 0;
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  if (!s) return 0;
  let tokens = 0;
  for (const ch of s) {
    // CJK 类字符通常 1.5 字符/token；ASCII / 常见符号通常 4 字符/token
    tokens += isCjk(ch) ? 0.667 : 0.25;
  }
  return Math.max(1, Math.ceil(tokens));
}

function messageText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((c) => {
        if (!c) return '';
        if (c.type === 'text') return c.text || '';
        if (c.type === 'image_url' || c.type === 'image') return '[图片]';
        return '';
      })
      .join('\n');
  }
  return '';
}

function messageTokens(m) {
  if (!m) return 0;
  // 每条消息在 OpenAI 格式下有 role/name/tool_call_id 等固定开销，约 4~8 tokens
  const overhead = (m.role === 'tool' ? 6 : 4);
  return estimateTokens(messageText(m)) + overhead;
}

function toolsTokens(toolsText) {
  if (!toolsText) return 0;
  let count = 0;
  try {
    const arr = JSON.parse(toolsText);
    if (Array.isArray(arr)) count = arr.length;
  } catch (_) {
    // 文本协议：按 function 声明数量粗估
    count = (String(toolsText).match(/function\s+\w+/g) || []).length;
  }
  // 工具定义的 JSON schema 本身 + 每个工具约 9 tokens 的函数调用格式开销
  return estimateTokens(toolsText) + count * 9;
}

/**
 * 测量当前 prompt 各组成部分的 token 占比。
 * @param {object} params
 * @param {string} params.baseSystem       系统提示词本体（不含注入段落）
 * @param {string} params.memoryText       长期记忆段落
 * @param {string} params.skillText        用户技能段落
 * @param {string} params.planTaskText     项目任务清单段落
 * @param {string} params.knowledgeText    知识库/参考注入段落
 * @param {string} params.toolsText        工具定义（JSON 或文本手册）
 * @param {Array}  params.history          已清洗的历史消息数组
 * @param {number} params.maxTokens        本次请求的输出上限
 * @param {number} params.contextWindow    模型上下文窗口（0 表示未配置）
 * @returns {object}
 */
function measureContext({
  baseSystem = '',
  memoryText = '',
  skillText = '',
  planTaskText = '',
  knowledgeText = '',
  toolsText = '',
  history = [],
  maxTokens = 0,
  contextWindow = 0
} = {}) {
  const systemParts = [
    { key: 'system', label: '系统提示词', text: baseSystem },
    { key: 'memory', label: '长期记忆', text: memoryText },
    { key: 'skills', label: '用户技能', text: skillText },
    { key: 'planTasks', label: '项目任务清单', text: planTaskText },
    { key: 'knowledge', label: '知识库 / 参考', text: knowledgeText }
  ];

  const items = [];
  let inputTokens = 0;
  for (const p of systemParts) {
    const tokens = estimateTokens(p.text);
    inputTokens += tokens;
    if (tokens > 0) {
      items.push({ key: p.key, label: p.label, tokens, chars: String(p.text).length });
    }
  }
  // system 消息 role + 格式开销
  inputTokens += 2;

  // 工具定义
  const toolTok = toolsTokens(toolsText);
  if (toolTok > 0) {
    inputTokens += toolTok;
    items.push({ key: 'tools', label: '工具及智能体', tokens: toolTok, chars: String(toolsText).length });
  }

  let historyTokens = 0;
  for (const m of history) {
    historyTokens += messageTokens(m);
  }
  if (historyTokens > 0 || history.length > 0) {
    items.push({ key: 'history', label: '对话消息', tokens: historyTokens, chars: history.reduce((s, m) => s + messageText(m).length, 0) });
  }
  inputTokens += historyTokens;

  // 连接器及 MCP：当前狐狸 AI 还没直接接入 WorkBuddy 的 MCP 连接器，保留占位
  const connectorTokens = 0;

  // 输出槽位：按 maxTokens 预留，算作用量的一部分提醒用户
  const outputTokens = maxTokens > 0 ? maxTokens : 0;

  // 总用量 = 输入 + 预留输出（用于百分比计算）
  const totalMeasured = inputTokens + outputTokens;

  // 上限
  const effectiveLimit = contextWindow > 0 ? contextWindow : 0;
  const percentage = effectiveLimit > 0 ? Math.min(100, Math.round((totalMeasured / effectiveLimit) * 1000) / 10) : 0;

  return {
    inputTokens,
    outputTokens,
    totalMeasured,
    contextWindow: effectiveLimit,
    percentage,
    maxTokens,
    items: items.sort((a, b) => b.tokens - a.tokens),
    raw: { baseSystem, memoryText, skillText, planTaskText, knowledgeText, toolsText, historyLength: history.length }
  };
}

/**
 * 估算一组历史消息的总 token（含每条消息的格式开销），用于在 run() 开头
 * 快速判断上下文是否超阈值（无需完整 measureContext 的所有字段）。
 */
function estimateMessages(list) {
  if (!Array.isArray(list) || !list.length) return 0;
  let total = 0;
  for (const m of list) total += messageTokens(m);
  return total;
}

module.exports = { estimateTokens, measureContext, isCjk, estimateMessages, messageText };
