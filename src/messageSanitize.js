'use strict';

/*
 * src/messageSanitize.js — 对话历史清洗与硬截断
 *
 * 防止发给 OpenAI / DeepSeek 兼容格式的 messages 触发 400：
 *   «Messages with role 'tool' must be a response to a preceding message
 *    with 'tool_calls'»
 *
 * 同时提供按 token/字节上限的硬截断，避免 messages 无限膨胀导致内存与 token 双爆炸。
 */

const { estimateTokens, messageText } = require('./contextUsage');

const DEFAULT_MAX_BYTES_PER_MSG = 12000;
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024; // 1MB

// 与 capabilities.isImagePart 同语义，但保持本模块零外部依赖，便于离线测试
const IMAGE_PART_TYPES = new Set(['image_url', 'input_image', 'image']);
function isImagePartLocal(part) {
  return !!(part && IMAGE_PART_TYPES.has(part.type));
}

function clampText(text, maxBytes) {
  if (!text) return text;
  const s = String(text);
  if (s.length <= maxBytes) return s;
  return s.slice(0, maxBytes) + `\n…（内容已截断，原 ${s.length} 字）`;
}

function clampMessage(m, maxBytes) {
  if (!m) return m;
  if (typeof m.content === 'string') {
    if (m.content.length <= maxBytes) return m;
    return Object.assign({}, m, { content: clampText(m.content, maxBytes) });
  }
  if (Array.isArray(m.content)) {
    return Object.assign({}, m, {
      content: m.content.map((c) => {
        if (c && c.type === 'text' && c.text && c.text.length > maxBytes) {
          return Object.assign({}, c, { text: clampText(c.text, maxBytes) });
        }
        return c;
      })
    });
  }
  return m;
}

/**
 * @param {Array} messages  原始消息数组（含 system 也不要紧，这里会过滤）
 * @param {string} protocol 'native' | 'text'
 * @param {number} maxHistory 保留基数，实际保留 maxHistory*2 条
 * @param {object} [opts]
 * @param {number} [opts.maxBytesPerMessage=12000] 单条消息最大字符数
 * @param {number} [opts.maxTotalBytes=1048576] 历史总字符数硬上限
 * @returns {Array} 清洗后的消息数组
 */
function trimHistory(messages, protocol, maxHistory, opts) {
  opts = opts || {};
  const maxBytesPerMsg = opts.maxBytesPerMessage || DEFAULT_MAX_BYTES_PER_MSG;
  const maxTotalBytes = opts.maxTotalBytes || DEFAULT_MAX_TOTAL_BYTES;
  const limit = Math.max(6, (maxHistory || 20) * 2);
  let list = (messages || []).filter((m) => m && m.role !== 'system');

  // 1) 单条消息截断：防止 read_file / search_text / terminal 输出把单条消息撑爆
  //    注意：clampMessage 是「前缀保持」的确定性截断（保留前 maxBytes 字符），不是改写——
  //    同一条消息截断结果逐字节一致，截断一次后即冻结，不破坏前缀缓存。
  list = list.map((m) => clampMessage(m, maxBytesPerMsg));

  // 2) 超长截断：优先按「token 预算」截断（窗口大、低频、前缀更稳定，命中率更高）；
  //    未配置 token 预算时退回固定条数窗口。两者都不能把「assistant(tool_calls) + 其 tool 结果」
  //    整块切断，否则会留下孤立 tool 消息导致 400。
  const maxHistoryTokens = opts.maxHistoryTokens > 0 ? opts.maxHistoryTokens : 0;
  if (maxHistoryTokens > 0) {
    let totalTok = 0;
    for (const m of list) totalTok += estimateTokens(messageText(m)) + 4;
    if (totalTok > maxHistoryTokens) {
      let start = 0;
      while (totalTok > maxHistoryTokens && start < list.length - 4) {
        const removed = list[start];
        let removeCount = 1;
        if (removed.role === 'assistant' && removed.tool_calls) {
          const ids = new Set(removed.tool_calls.map((t) => t.id));
          let i = start + 1;
          while (i < list.length && list[i].role === 'tool' && ids.has(list[i].tool_call_id)) { i++; removeCount++; }
        }
        for (let i = 0; i < removeCount && start < list.length; i++) {
          totalTok -= estimateTokens(messageText(list[start])) + 4;
          list.splice(start, 1);
        }
      }
    }
  } else if (list.length > limit) {
    let start = list.length - limit;
    while (start > 0 && list[start - 1] && list[start - 1].role === 'tool') start--;
    if (start > 0 && list[start - 1] && list[start - 1].role === 'assistant' && list[start - 1].tool_calls) {
      start--;
    }
    list = list.slice(start);
  }
  // 去掉开头可能残留的孤立 tool 消息
  while (list.length && list[0].role === 'tool') list.shift();

  // 3) 总字节硬上限：从最早的消息开始丢，丢到总字符低于阈值；同样保证不切断 tool 对
  let total = list.reduce((s, m) => s + messageText(m).length, 0);
  if (total > maxTotalBytes) {
    let start = 0;
    while (total > maxTotalBytes && start < list.length - 4) {
      const removed = list[start];
      let removeCount = 1;
      // 如果起点是 assistant(tool_calls)，把后续对应的 tool 结果一起丢掉
      if (removed.role === 'assistant' && removed.tool_calls) {
        const ids = new Set(removed.tool_calls.map((t) => t.id));
        let i = start + 1;
        while (i < list.length && list[i].role === 'tool' && ids.has(list[i].tool_call_id)) {
          i++;
          removeCount++;
        }
      }
      for (let i = 0; i < removeCount && start < list.length; i++) {
        total -= messageText(list[start]).length;
        list.splice(start, 1);
      }
    }
    // 再次清理开头孤立 tool
    while (list.length && list[0].role === 'tool') list.shift();
  }

  // 收集每条 tool 结果的 tool_call_id
  const ids = new Set();
  for (const m of list) if (m.role === 'tool' && m.tool_call_id) ids.add(m.tool_call_id);

  if (protocol === 'native') {
    // 4) 丢弃「孤立 tool 消息」
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.role === 'tool') {
        let ok = false;
        for (let j = i - 1; j >= 0; j--) {
          const p = list[j];
          if (p.role === 'assistant') {
            ok = !!(p.tool_calls && p.tool_calls.some((t) => t.id === m.tool_call_id));
            break;
          }
          if (p.role === 'user') break;
        }
        if (!ok) continue;
      }
      out.push(m);
    }
    list = out;
    // 5) 清理 assistant 里没有对应 tool 结果的 tool_calls
    return list.map((m) => {
      if (m.role === 'assistant' && m.tool_calls) {
        const kept = m.tool_calls.filter((t) => ids.has(t.id));
        if (kept.length === m.tool_calls.length) return m;
        const copy = Object.assign({}, m);
        if (kept.length) copy.tool_calls = kept;
        else delete copy.tool_calls;
        if (!copy.content && !copy.tool_calls) copy.content = '(略)';
        return copy;
      }
      return m;
    });
  }

  // 文本协议（或降级后）：不允许 role:'tool'，把残留 tool 结果转成 user 文本
  return list.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: `[工具 ${m.name || 'unknown'} 的结果]\n${m.content || ''}\n\n请根据结果继续，或给出最终回答。`
      };
    }
    if (m.role === 'assistant' && m.tool_calls) {
      const c = Object.assign({}, m);
      delete c.tool_calls;
      if (!c.content) c.content = '(已调用工具并获取结果)';
      return c;
    }
    return m;
  });
}

/**
 * 就地（in-place）把超出保留窗口的历史图片降级为占位，释放大 base64 字符串占用的内存。
 * 只处理真正「超窗口」的图片：保留最近 keepTurns 条带图用户消息的完整 base64，
 * 更早的带图消息里图片 part 被删除、追加一句占位文本，从而断开对大字符串的引用便于 GC。
 *
 * @param {Array} messages  会直接被就地修改（this.messages 本体）
 * @param {number} keepTurns 保留最近几条带图用户消息的 base64
 * @returns {number} 被移除（释放）的图片张数
 */
function stripOldImageBase64(messages, keepTurns) {
  keepTurns = Math.max(0, keepTurns | 0);
  if (!Array.isArray(messages) || !messages.length) return 0;
  const idxs = [];
  messages.forEach((m, i) => {
    if (m && Array.isArray(m.content) && m.content.some(isImagePartLocal)) idxs.push(i);
  });
  if (idxs.length <= keepTurns) return 0;
  const keep = new Set(idxs.slice(idxs.length - keepTurns));
  let removed = 0;
  for (let i = 0; i < messages.length; i++) {
    if (keep.has(i)) continue;
    const m = messages[i];
    if (!m || !Array.isArray(m.content) || !m.content.some(isImagePartLocal)) continue;
    const keptParts = [];
    for (const part of m.content) {
      if (isImagePartLocal(part)) { removed++; continue; }
      keptParts.push(part);
    }
    const note = { type: 'text', text: '\n[历史图片已省略，如需重看请重新上传]' };
    const allText = keptParts.length && keptParts.every((p) => p && p.type === 'text');
    messages[i] = Object.assign({}, m, {
      content: allText
        ? keptParts.map((p) => p.text).join('\n') + note.text
        : keptParts.concat([note])
    });
  }
  return removed;
}

module.exports = { trimHistory, clampText, clampMessage, stripOldImageBase64, isImagePartLocal };

