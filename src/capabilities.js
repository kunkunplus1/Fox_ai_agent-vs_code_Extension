'use strict';

/**
 * 模型能力探测。
 * 目的：不要把图片（image_url）发给纯文本模型——
 * DeepSeek 之类会直接 400：unknown variant `image_url`, expected `text`。
 */

/** 已知支持读图的模型名特征 */
const VISION_PATTERNS = [
  /gpt-4o/i,
  /gpt-4\.\d/i,
  /gpt-4-turbo/i,
  /gpt-5/i,
  /\bo[34]\b/i,
  /vision/i,
  /(^|[-/_])vl\d*([-_.]|$)/i,
  /qwen[\w.]*-vl/i,
  /qvq/i,
  /qwen[\w.-]*omni/i,
  /qwen3\.[6-9]/i,
  /qwen[4-9][\w.]*/i,
  /glm-[\w.]*v\b/i,
  /glm-4v/i,
  /glm-[\w.]*v-/i,
  /claude-3/i,
  /claude-[4-9]/i,
  /claude-(sonnet|opus|haiku)-[3-9]/i,
  /gemini/i,
  /llava/i,
  /internvl/i,
  /minicpm-?v/i,
  /deepseek-vl/i,
  /step-1v/i,
  /step-1o/i,
  /pixtral/i,
  /moondream/i,
  /doubao[\w.-]*(vision|vl)/i,
  /ernie[\w.-]*vl/i,
  /kimi-latest/i,
  /kimi[\w.-]*(vl|thinking)/i,
  /grok[\w.-]*vision/i,
  /grok-[4-9]/i,
  /llama[\w.-]*(vision|3\.2-11b|3\.2-90b|4-(scout|maverick))/i,
  /(^|[-/_])(molmo|cogvlm|yi-vl|phi-\d-vision|aria)/i
];

/**
 * 明确不支持读图的（优先级高于 VISION_PATTERNS）。
 * 用来纠正上面的宽泛规则造成的误判。
 */
const TEXT_ONLY_PATTERNS = [
  /deepseek-chat/i,
  /deepseek-reasoner/i,
  /deepseek-coder/i,
  /deepseek-r1/i,
  /deepseek-v3/i,
  // o1-mini / o3-mini 不支持读图（o1/o3/o4-mini 支持）
  /\bo[13]-mini\b/i,
  // 各家纯文本 coder / math / embedding / rerank
  /[\w.-]*coder[\w.-]*/i,
  /[\w.-]*(math|embedding|reranker?|bge-|gte-)[\w.-]*/i,
  // Qwen2 ~ Qwen3.5 的纯文本版（A3B/A22B 只是激活参数，跟视觉无关；3.6+ 起默认多模态）
  /qwen(2(\.5)?|3(\.[0-5])?)-/i
];

/** 运行时学习到的「这个模型发图会 400」名单（由 markNoVision 写入） */
const learnedNoVision = new Set();
/** 运行时确认过能读图的模型 */
const learnedVision = new Set();

function normName(model) {
  return String(model || '').trim().toLowerCase();
}

/** 用户手动指定的白/黑名单（子串匹配，大小写不敏感） */
function matchList(list, name) {
  if (!Array.isArray(list)) return false;
  return list.some((item) => {
    const s = String(item || '').trim().toLowerCase();
    return s && name.includes(s);
  });
}

/**
 * @param {string} model 模型名
 * @param {'auto'|'on'|'off'} mode 用户设置
 * @param {{visionModels?:string[], textOnlyModels?:string[]}} [lists] 用户自定义白/黑名单
 */
function supportsVision(model, mode, lists) {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  const name = normName(model);
  if (!name) return false;

  // 1. 用户手动白名单最高优先级 —— 自动判断错了可以一键纠正
  if (lists && matchList(lists.visionModels, name)) return true;
  if (lists && matchList(lists.textOnlyModels, name)) return false;

  // 2. 运行时学习结果（实际发图成功/被服务端 400 拒绝）
  if (learnedVision.has(name)) return true;
  if (learnedNoVision.has(name)) return false;

  // 3. 名称规则：TEXT_ONLY 优先于 VISION
  const visionHit = VISION_PATTERNS.some((re) => re.test(name));
  const textOnlyHit = TEXT_ONLY_PATTERNS.some((re) => re.test(name));
  if (textOnlyHit && !hasExplicitVisionMarker(name)) return false;
  return visionHit;
}

/** 名字里有明确的视觉标记（vl / vision / v 结尾等），此时忽略 TEXT_ONLY 规则 */
function hasExplicitVisionMarker(name) {
  return (
    /vision/i.test(name) ||
    /(^|[-/_])vl\d*([-_.]|$)/i.test(name) ||
    /-vl/i.test(name) ||
    /qvq/i.test(name) ||
    /omni/i.test(name) ||
    /glm-[\w.]*v\b/i.test(name)
  );
}

/** 服务端因为「不认识图片」而报错时调用，之后这个模型不再发图 */
function markNoVision(model) {
  const name = normName(model);
  if (name) {
    learnedNoVision.add(name);
    learnedVision.delete(name);
  }
}

/** 确认这个模型能读图（发过图且没报错） */
function markVisionOk(model) {
  const name = normName(model);
  if (name) {
    learnedVision.add(name);
    learnedNoVision.delete(name);
  }
}

/** 判断一个报错是不是「模型不支持图片」 */
function looksLikeVisionRejection(err) {
  const m = String((err && err.message) || err || '').toLowerCase();
  if (!m) return false;
  return (
    (m.includes('image_url') && (m.includes('unknown variant') || m.includes('invalid') || m.includes('expected'))) ||
    m.includes('does not support image') ||
    m.includes('not support vision') ||
    m.includes('multimodal is not supported') ||
    m.includes('image input is not supported') ||
    (m.includes('image') && m.includes('unsupported'))
  );
}

/** 当前学习状态，便于调试 */
function learnedState() {
  return { noVision: Array.from(learnedNoVision), vision: Array.from(learnedVision) };
}

function isImagePart(part) {
  return part && (part.type === 'image_url' || part.type === 'input_image' || part.type === 'image');
}

/** 把一条消息里的图片降级成文字占位 */
function degradeImageParts(content, note) {
  if (!Array.isArray(content)) return content;
  const out = [];
  let dropped = 0;
  for (const part of content) {
    if (isImagePart(part)) {
      dropped++;
      continue;
    }
    out.push(part);
  }
  if (!dropped) return content;
  out.push({ type: 'text', text: note || `[已省略 ${dropped} 张图片]` });
  // 只剩纯文本时压回字符串，兼容对 content 数组比较挑剔的服务端
  if (out.every((p) => p && p.type === 'text')) {
    return out.map((p) => p.text).join('\n');
  }
  return out;
}

/**
 * 发送前清洗整个消息数组：
 * 1. 模型不支持读图 → 把所有图片换成文字说明，避免 400；
 * 2. 模型支持读图 → 只保留最近 keepTurns 轮里的图片，老图片扔掉，
 *    否则每轮都要重传几 MB 的 base64，又慢又烧 token。
 *
 * @returns {{messages: Array, degraded: number, trimmed: number}}
 */
function sanitizeMessages(messages, { vision, keepTurns = 1 } = {}) {
  let degraded = 0;
  let trimmed = 0;

  // 找出带图片的用户消息下标
  const imageTurns = [];
  messages.forEach((m, i) => {
    if (Array.isArray(m.content) && m.content.some(isImagePart)) imageTurns.push(i);
  });
  if (!imageTurns.length) return { messages, degraded: 0, trimmed: 0 };

  const keep = new Set(vision ? imageTurns.slice(-Math.max(0, keepTurns)) : []);

  const out = messages.map((m, i) => {
    if (!Array.isArray(m.content) || !m.content.some(isImagePart)) return m;
    if (keep.has(i)) return m;
    if (vision) trimmed++;
    else degraded++;
    return Object.assign({}, m, {
      content: degradeImageParts(
        m.content,
        vision ? '[历史图片已省略，如需重看请重新上传]' : '[图片附件：当前模型不支持读图，已忽略]'
      )
    });
  });

  return { messages: out, degraded, trimmed };
}

/** 估算消息体积（字节），用于提醒用户 */
function estimateSize(messages) {
  try {
    return JSON.stringify(messages).length;
  } catch (_) {
    return 0;
  }
}

/** 从图片 part 里取出可用的 URL / data URI（兼容 OpenAI chat / responses / Anthropic 三种格式） */
function imageUrlOf(part) {
  if (!part) return '';
  if (part.type === 'image_url') {
    const u = part.image_url;
    return typeof u === 'string' ? u : (u && u.url) || '';
  }
  if (part.type === 'input_image') return part.image_url || part.image || '';
  if (part.type === 'image') {
    const s = part.source;
    if (s && s.type === 'base64') return 'data:' + (s.media_type || 'image/png') + ';base64,' + s.data;
    return (s && s.url) || '';
  }
  return '';
}

/**
 * 用「第二个多模态模型」把图片转成文字描述，替换原图片。
 * 用于主模型不支持读图、但配置了 foxAi.vision 的场景——给纯文本主模型借一双眼睛。
 * @param {Array} messages 原始消息
 * @param {function} callSecondary 异步 (imageUrl) => descriptionText
 * @returns {Promise<{messages: Array, described: number}>}
 */
async function describeImages(messages, callSecondary) {
  if (typeof callSecondary !== 'function') return { messages, described: 0 };
  const out = [];
  let described = 0;
  for (const m of messages || []) {
    if (!Array.isArray(m.content) || !m.content.some(isImagePart)) {
      out.push(m);
      continue;
    }
    const newParts = [];
    for (const part of m.content) {
      if (isImagePart(part)) {
        const url = imageUrlOf(part);
        let desc = '';
        try {
          desc = (await callSecondary(url)) || '';
        } catch (e) {
          desc = '[图片识别失败：' + String((e && e.message) || e) + ']';
        }
        described++;
        newParts.push({ type: 'text', text: '[图片描述：' + (desc || '（无内容）') + ']' });
      } else {
        newParts.push(part);
      }
    }
    out.push(Object.assign({}, m, { content: newParts }));
  }
  return { messages: out, described };
}

module.exports = {
  supportsVision,
  sanitizeMessages,
  degradeImageParts,
  isImagePart,
  estimateSize,
  describeImages,
  imageUrlOf,
  markNoVision,
  markVisionOk,
  looksLikeVisionRejection,
  learnedState
};
