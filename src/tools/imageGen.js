'use strict';

/**
 * generate_image 工具：调用专门配置的「生图模型」（foxAi.imageGen.*）生成图片。
 *
 * 通道定位（与 vision 识图平行，方向相反）：
 *   - vision 识图：用户发图 → 第二个多模态模型把图转文字 → 交纯文本主模型推理（图→文字）。
 *   - 本生图通道：主模型（文本）判断需要出图 → 调取专用的生图模型 → 把图渲染到对话（文字→图）。
 * 两者都服务于总控 agent，且生图模型与主控聊天模型完全隔离，互不影响。
 *
 * 为什么需要「专门」构造请求：
 *   通义 wan2.1-image 这类图像生成模型对 chat/completions 请求格式极其严格——
 *   不允许 system role（首条 messages.0.role 必须是 user），且每条 content 必须是数组（list）。
 *   直接复用主控的 payload（带 system + 字符串 content）会被服务端拒绝：
 *     Input should be 'user': input.messages.0.role
 *     Input should be a valid list: input.messages.0.content
 *   因此本工具自己构造「单条 user + list content」的最简请求，专门绕过该限制。
 */

// 注意：config / client 含 vscode 依赖，仅在 run() 内部 require（避免纯函数/测试在扩展宿主外加载失败）。

/** 诊断日志：把请求与原始响应落盘，便于排查生图模型返回格式问题。 */
function debugImageGen(label, obj) {
  try {
    const fs = require('fs');
    const path = require('path');
    const base = process.env.USERPROFILE || process.env.HOME || '.';
    const dir = path.join(base, '.fox-ai', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'image-gen-debug.log'),
      new Date().toISOString() + ' [' + label + '] ' + JSON.stringify(obj, null, 2).slice(0, 20000) + '\n---\n'
    );
  } catch (_) { /* 诊断失败不影响主流程 */ }
}

/**
 * 从「已知图片承载位置」抽取图片 URL / data URI。
 * 关键：只扫描生图模型约定的图片字段（choices[].message.content / data[]），
 * 绝不把整个响应对象（含错误页 / 教程页 / debug_info）里的任意 .png 当成生图结果。
 * @param {object} raw client.chatNonStream 原始响应
 * @returns {string[]}
 */
function extractImagesFromRaw(raw) {
  const out = [];
  const push = (s) => { if (s && !out.includes(s)) out.push(s); };
  if (!raw || typeof raw !== 'object') return out;

  // 通义 wan / dashscope 风格：raw.output.choices[].message.content[].image | b64_json
  const choices = (raw.output && raw.output.choices) || raw.choices || [];
  if (Array.isArray(choices)) {
    for (const ch of choices) {
      const msg = ch && (ch.message || ch);
      if (!msg) continue;
      // 部分实现把图片直接挂在 message.image / message.b64_json（无 content 包裹）
      if (typeof msg.image === 'string') push(msg.image);
      else if (msg.image_url) {
        const u = typeof msg.image_url === 'string' ? msg.image_url : (msg.image_url.url || '');
        if (u) push(u);
      } else if (msg.b64_json) push('data:image/png;base64,' + msg.b64_json);
      const content = msg && msg.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (!part) continue;
          if (typeof part.image === 'string') push(part.image);
          else if (part.image_url) {
            const u = typeof part.image_url === 'string' ? part.image_url : (part.image_url.url || '');
            if (u) push(u);
          } else if (part.type === 'image' && part.b64_json) {
            push('data:image/png;base64,' + part.b64_json);
          }
        }
      } else if (typeof content === 'string') {
        const re = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
        let m;
        while ((m = re.exec(content))) push(m[0]);
      }
    }
  }

  // OpenAI images.generate 风格：raw.data[].url | b64_json
  if (Array.isArray(raw.data)) {
    for (const d of raw.data) {
      if (!d) continue;
      if (d.url) push(d.url);
      if (d.b64_json) push('data:image/png;base64,' + d.b64_json);
    }
  }
  return out;
}

/**
 * 从模型原始响应里尽可能抽出图片 URL / data URI（兼容多种生图模型返回格式）。
 * @param {object} result client.chatNonStream 的返回值（含 content / images / raw）
 * @returns {string[]}
 */
function extractImageUrls(result) {
  const out = [];
  const seen = new Set();
  const push = (s) => {
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };

  // 1) 优先用 client.js 已标准化的 images（image_url / Anthropic base64 / responses b64_json / message.image / data数组 等）
  for (const im of (result && result.images) || []) {
    if (im && im.src) push(im.src);
    else if (im && im.url) push(im.url);
    else if (im && im.b64) push('data:image/png;base64,' + im.b64);
  }
  if (out.length) return out;

  // 2) 兜底：从 content 解析（字符串或数组块），覆盖各家不标准返回
  const content = (result && result.content) || '';
  if (typeof content === 'string') {
    const re = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
    let m;
    while ((m = re.exec(content))) push(m[0]);
    // 仅当 content 整体就是「单个图片链接」时才采信其中的 http(s) 图片；
    // 普通文本 / 错误说明 / HTML 页面不从中扒链接，避免把错误页、教程页里
    // 嵌入的图当成生图结果（这正是曾出现「返回动漫教程截图」的根因之一）。
    const trimmed = content.trim();
    if (/^https?:\/\/\S+$/i.test(trimmed) && /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(trimmed)) {
      push(trimmed);
    }
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part) continue;
      // 通义 wan2.1-image 风格：{ type:'image', image:'data:...' }
      if (typeof part.image === 'string') push(part.image);
      else if (part.image_url) {
        const u = typeof part.image_url === 'string' ? part.image_url : (part.image_url.url || '');
        if (u) push(u);
      } else if (part.type === 'image') {
        if (typeof part.image === 'string') push(part.image);
        else if (part.b64_json) push('data:image/png;base64,' + part.b64_json);
        else if (part.source && part.source.type === 'base64') {
          push('data:' + (part.source.media_type || 'image/png') + ';base64,' + part.source.data);
        }
      } else if (part.b64_json) push('data:image/png;base64,' + part.b64_json);
    }
  }
  if (out.length) return out;

  // 3) 定向兜底：只扫描生图模型约定的图片字段，不再全对象扫描
  for (const s of extractImagesFromRaw(result && result.raw)) push(s);

  return out;
}

/**
 * 按厂商/模型自动选择生图通道（1.1.31 通用厂商适配）。
 *  - dashscope-native：阿里百炼 / 通义万相。百炼的 OpenAI 兼容端点（compatible-mode/v1）官方只支持
 *    qwen 对话/视觉模型，万相文生图系列（wanx* / wan2* / qwen-image*）**只能走百炼原生异步 API**
 *    （/api/v1/services/aigc/text2image/image-synthesis），否则报
 *    "Unsupported model `wanx2.1-t2i-turbo` for OpenAI compatibility mode."——即伙伴遇到的「协议不匹配」。
 *  - openai-images：OpenAI 官方 DALL·E / gpt-image，走 /images/generations。
 *  - openai-chat：其余（Qwen 兼容端点 chat、本地模型、自托管等）沿用 OpenAI 兼容 chat/completions。
 */
function isDashscopeHost(baseUrl) {
  return /dashscope|maas\.aliyuncs\.com/i.test(baseUrl || '');
}
function classifyImageVendor({ provider, baseUrl, model }) {
  const m = String(model || '').toLowerCase();
  const p = String(provider || '').toLowerCase();
  // 百炼（按 provider 或域名判定）一律走原生异步 API——万相与通义万相都如此，chat 兼容端点不支持生图。
  if (p === 'dashscope' || isDashscopeHost(baseUrl)) return 'dashscope-native';
  // 非百炼：模型名命中 OpenAI 官方生图（DALL·E / gpt-image）时走 images 接口
  if ((p === 'openai' || /openai\.com/i.test(baseUrl || '')) && /(dall-e|gpt-image|sora|image-)/.test(m)) {
    return 'openai-images';
  }
  return 'openai-chat';
}

/** 从任意 baseUrl（兼容端点 /v1、/compatible-mode/v1 等）推导出厂商原生 API 的 origin。 */
function deriveNativeBase(baseUrl) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '');
  b = b.replace(/\/(compatible-mode|v1|chat|completions|images)\b.*$/i, '');
  return b || 'https://dashscope.aliyuncs.com';
}

/** 把用户给的尺寸统一成百炼要求的「宽*高」（星号）格式；无法识别则返回空（交给模型默认）。 */
function normalizeDashscopeSize(size) {
  if (!size) return '';
  const s = String(size).trim().replace(/[xX×]/g, '*');
  if (/^\d+\*\d+$/.test(s)) return s;
  if (/^\d+$/.test(s)) return s + '*' + s;
  return '';
}
/** 把用户给的尺寸统一成 OpenAI 要求的「宽x高」（字母 x）格式。 */
function normalizeOpenAISize(size) {
  if (!size) return '';
  const s = String(size).trim().replace(/[×*]/g, 'x');
  if (/^\d+x\d+$/i.test(s)) return s;
  if (/^\d+$/.test(s)) return s + 'x' + s;
  return '';
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 阿里百炼原生异步文生图（万相 / 通义万相 / qwen-image 通用）。
 * 官方文档：POST {base}/api/v1/services/aigc/text2image/image-synthesis
 *   Headers: Authorization: Bearer <key>, X-DashScope-Async: enable, Content-Type: application/json
 *   Body: { model, input:{ prompt, negative_prompt? }, parameters:{ size?:'1024*1024', n:1 } }
 * 返回 output.task_id → GET {base}/api/v1/tasks/{task_id} 轮询，SUCCEEDED 后 output.results[].url（24h 有效）。
 */
async function generateViaDashscope({ baseUrl, apiKey, model, prompt, size, negativePrompt, timeout, insecureHTTPParser }) {
  const nativeBase = deriveNativeBase(baseUrl);
  const createUrl = nativeBase + '/api/v1/services/aigc/text2image/image-synthesis';
  const body = { model, input: { prompt } };
  if (negativePrompt) body.input.negative_prompt = negativePrompt;
  body.parameters = {};
  const sz = normalizeDashscopeSize(size);
  if (sz) body.parameters.size = sz;
  body.parameters.n = 1; // 万相/qwen-image 的 n 固定为 1，其它值会报错

  debugImageGen('DASHSCOPE_CREATE', { url: createUrl, model, prompt: prompt.slice(0, 80) });
  let createRes;
  try {
    createRes = await (require('../client').requestJson)(createUrl, {
      method: 'POST', apiKey, body, timeout, insecureHTTPParser,
      extra: { 'X-DashScope-Async': 'enable' }
    });
  } catch (e) {
    debugImageGen('DASHSCOPE_CREATE_ERR', { error: String((e && e.message) || e) });
    throw e;
  }

  // 顶层错误（如 { code, message }）
  if (createRes && createRes.code && createRes.message && !(createRes.output && createRes.output.task_id)) {
    throw new Error('百炼生图创建任务失败：' + createRes.code + ' - ' + createRes.message);
  }
  let taskId = createRes && createRes.output && createRes.output.task_id;
  // 极少数同步返回结果的情况（兜底）
  if (!taskId && createRes && createRes.output && Array.isArray(createRes.output.results)) {
    const urls = (createRes.output.results || []).map((r) => r.url).filter(Boolean);
    if (urls.length) return urls;
  }
  if (!taskId) {
    throw new Error('百炼生图未返回 task_id，原始响应：' + JSON.stringify(createRes).slice(0, 300));
  }

  // 轮询任务（每 3.5s 一次，直到 SUCCEEDED / FAILED 或超时）
  const deadline = Date.now() + (timeout || 60000);
  const taskUrl = nativeBase + '/api/v1/tasks/' + encodeURIComponent(taskId);
  let last = null;
  while (Date.now() < deadline) {
    await sleep(3500);
    let poll;
    try {
      poll = await (require('../client').requestJson)(taskUrl, { method: 'GET', apiKey, timeout: 20000, insecureHTTPParser });
    } catch (e) {
      debugImageGen('DASHSCOPE_POLL_ERR', { taskId, error: String((e && e.message) || e) });
      continue; // 单次轮询失败不放弃，等下一轮；直到超时才抛出
    }
    last = poll;
    const st = poll && poll.output && poll.output.task_status;
    if (st === 'SUCCEEDED') {
      const urls = (poll && poll.output.results || []).map((r) => r.url).filter(Boolean);
      if (urls.length) return urls;
      throw new Error('百炼生图任务成功但未返回图片 URL');
    }
    if (st === 'FAILED') {
      const msg = (poll.output && (poll.output.message || poll.output.code)) || poll.message || '未知失败';
      throw new Error('百炼生图任务失败：' + msg);
    }
  }
  debugImageGen('DASHSCOPE_TIMEOUT', { taskId, last });
  throw new Error('百炼生图任务轮询超时（' + (timeout || 60000) + 'ms），task_id=' + taskId + '，可稍后在百炼控制台查看结果');
}

/** OpenAI 官方 DALL·E / gpt-image：走 /images/generations。 */
async function generateViaOpenAIImages({ baseUrl, apiKey, model, prompt, size, timeout, insecureHTTPParser }) {
  const nativeBase = deriveNativeBase(baseUrl);
  const url = nativeBase + '/images/generations';
  const body = { model, prompt, n: 1, response_format: 'url' };
  const sz = normalizeOpenAISize(size);
  if (sz) body.size = sz;
  debugImageGen('OPENAI_IMAGES_CREATE', { url, model, prompt: prompt.slice(0, 80) });
  const res = await (require('../client').requestJson)(
    url, { method: 'POST', apiKey, body, timeout, insecureHTTPParser }
  );
  const out = [];
  if (Array.isArray(res && res.data)) {
    for (const d of res.data) {
      if (d.url) out.push(d.url);
      else if (d.b64_json) out.push('data:image/png;base64,' + d.b64_json);
    }
  }
  return out;
}

/** OpenAI 兼容 chat/completions 生图（Qwen 兼容端点、本地模型等）。沿用旧逻辑。 */
async function generateViaChat({ baseUrl, apiKey, model, prompt, size, maxTokens, timeout, insecureHTTPParser }) {
  const text = size ? `${prompt}\n[尺寸要求：${size}]` : prompt;
  const messages = [{ role: 'user', content: [{ type: 'text', text: text }] }];
  const result = await (require('../client').chatNonStream)({
    baseUrl, apiKey, model, messages,
    temperature: 0.9, maxTokens, timeout, insecureHTTPParser, includeRaw: true
  });
  debugImageGen('RESPONSE', { prompt, model, result: { content: result.content, images: result.images, raw: result.raw } });
  return extractImageUrls(result);
}

async function run(a, ctx) {
  a = a || {};
  const prompt = String(a.prompt || '').trim();
  if (!prompt) return '⚠️ 缺少 prompt 参数，无法生成图片。请描述你想生成的画面。';
  const size = String(a.size || '').trim();
  const negativePrompt = String(a.negative_prompt || '').trim();
  const context = (ctx && ctx.context) || null;

  const cfg = await (require('../config').resolve(context));
  const ig = cfg.imageGenConfig || {};
  if (!ig.enabled) {
    return '⚠️ 生图通道未开启。请在 VS Code 设置里找到「狐狸 AI · 多模态生图（实验）」，勾选 Enabled 并填写 provider/baseUrl/apiKey/model（如阿里万相 wanx2.1-t2i-turbo）。';
  }
  const baseUrl = ig.baseUrl || cfg.baseUrl;
  const apiKey = ig.apiKey || cfg.apiKey;
  const model = ig.model || 'wanx2.1-t2i-turbo';
  if (!baseUrl || !apiKey) {
    return '⚠️ 生图通道缺少 baseUrl 或 apiKey，无法调用。请在「狐狸 AI · 多模态生图（实验）」设置里填好。';
  }

  // 按厂商自动选择生图通道（1.1.31）：阿里万相/通义万相 → 原生异步 API；OpenAI DALL·E → images 接口；其余 → chat。
  const vendor = classifyImageVendor({ provider: ig.provider, baseUrl, model });
  let images;
  try {
    if (vendor === 'dashscope-native') {
      images = await generateViaDashscope({
        baseUrl, apiKey, model, prompt, size, negativePrompt,
        timeout: ig.timeout || 60000, insecureHTTPParser: cfg.insecureHttpParser
      });
    } else if (vendor === 'openai-images') {
      images = await generateViaOpenAIImages({
        baseUrl, apiKey, model, prompt, size,
        timeout: ig.timeout || 60000, insecureHTTPParser: cfg.insecureHttpParser
      });
    } else {
      images = await generateViaChat({
        baseUrl, apiKey, model, prompt, size,
        maxTokens: ig.maxTokens || 1024, timeout: ig.timeout || 60000, insecureHTTPParser: cfg.insecureHttpParser
      });
    }
  } catch (e) {
    debugImageGen('ERROR', { vendor, prompt, model, baseUrl, error: String((e && e.message) || e) });
    return '⚠️ 生图模型调用失败：' + String((e && e.message) || e);
  }

  if (!images || !images.length) {
    return (
      '⚠️ 生图通道已调用但未返回可识别的图片。\n' +
      '可能原因：① 模型名不是生图模型（如把对话模型当生图模型填）；② 该厂商生图协议狐狸 AI 尚未适配；' +
      '③ 服务端返回了拒绝/错误说明。\n' +
      '已把本次请求与响应写入 ~/.fox-ai/logs/image-gen-debug.log，可贴出来帮我进一步定位。'
    );
  }

  // 渲染到聊天 UI（复用 0.8.42 的 image 渲染：execCtx.emitImage → agent.emit('image') → webview）
  if (ctx && typeof ctx.emitImage === 'function') {
    for (const src of images) {
      ctx.emitImage({ src, alt: '生成图片：' + prompt.slice(0, 40) });
    }
  }

  return '✅ 已生成 ' + images.length + ' 张图片（已显示在对话中）：' + prompt.slice(0, 100);
}

module.exports = { run, extractImageUrls, classifyImageVendor, deriveNativeBase, normalizeDashscopeSize, normalizeOpenAISize, isDashscopeHost };
