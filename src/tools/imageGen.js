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
 * 从任意 JSON 响应对象里递归扫描可能的图片 URL / data URI。
 * 用于兜底识别非标准生图返回格式。
 */
function scanObjectForImages(obj, seen) {
  const out = [];
  seen = seen || new Set();
  const push = (s) => {
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const item of obj) out.push(...scanObjectForImages(item, seen));
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      // 显式图片字段
      if ((k === 'image' || k === 'url' || k === 'image_url' || k === 'b64_json') && v) {
        if (k === 'b64_json') push('data:image/png;base64,' + v);
        else push(v);
      }
      // 字符串里嵌的 data URL / 图片链接
      const dataRe = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
      let m;
      while ((m = dataRe.exec(v))) push(m[0]);
      const urlRe = /https?:\/\/[^\s"')<>]+(?:\.(?:png|jpe?g|gif|webp|bmp|svg))(?:\?[^\s"')<>]*)?/gi;
      while ((m = urlRe.exec(v))) push(m[0]);
    } else if (typeof v === 'object' && v !== null) {
      out.push(...scanObjectForImages(v, seen));
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
    const urlRe = /https?:\/\/[^\s"')<>]+(?:\.(?:png|jpe?g|gif|webp|bmp|svg))(?:\?[^\s"')<>]*)?/gi;
    while ((m = urlRe.exec(content))) push(m[0]);
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

  // 3) 终极兜底：扫描整个原始响应对象
  // scan 内部会用自己的 seen 去重；扫描结果再交给外层 push 二次去重
  for (const s of scanObjectForImages(result && result.raw)) push(s);

  return out;
}

async function run(a, ctx) {
  a = a || {};
  const prompt = String(a.prompt || '').trim();
  if (!prompt) return '⚠️ 缺少 prompt 参数，无法生成图片。请描述你想生成的画面。';
  const size = String(a.size || '').trim();
  const context = (ctx && ctx.context) || null;

  const cfg = await (require('../config').resolve(context));
  const ig = cfg.imageGenConfig || {};
  if (!ig.enabled) {
    return '⚠️ 生图通道未开启。请在 VS Code 设置里找到「狐狸 AI · 多模态生图（实验）」，勾选 Enabled 并填写 provider/baseUrl/apiKey/model（如通义 wan2.1-image）。';
  }
  const baseUrl = ig.baseUrl || cfg.baseUrl;
  const apiKey = ig.apiKey || cfg.apiKey;
  const model = ig.model || 'wan2.1-image';
  if (!baseUrl || !apiKey) {
    return '⚠️ 生图通道缺少 baseUrl 或 apiKey，无法调用。请在「狐狸 AI · 多模态生图（实验）」设置里填好。';
  }

  // 专门为图像生成模型构造请求：单条 user + list content（绕开 wan2.1-image 的格式校验）
  const text = size ? `${prompt}\n[尺寸要求：${size}]` : prompt;
  const messages = [{ role: 'user', content: [{ type: 'text', text: text }] }];

  const requestBody = {
    model,
    messages,
    stream: false,
    temperature: 0.9,
    max_tokens: ig.maxTokens || 1024
  };

  let result;
  try {
    result = await (require('../client').chatNonStream)({
      baseUrl,
      apiKey,
      model,
      messages,
      temperature: 0.9,
      maxTokens: ig.maxTokens || 1024,
      timeout: ig.timeout || 60000,
      insecureHTTPParser: cfg.insecureHttpParser,
      includeRaw: true
    });
  } catch (e) {
    debugImageGen('ERROR', { prompt, model, baseUrl, error: String((e && e.message) || e) });
    return '⚠️ 生图模型调用失败：' + String((e && e.message) || e);
  }

  debugImageGen('RESPONSE', { prompt, model, result: { content: result.content, images: result.images, raw: result.raw } });

  const images = extractImageUrls(result);
  if (!images.length) {
    return (
      '⚠️ 生图模型已调用，但未返回可识别的图片。\n' +
      '可能原因：① 该模型不是生图模型；② 返回格式特殊，狐狸 AI 还没适配；③ 服务端返回了文本说明/拒绝。\n' +
      '原始文本回复前 400 字：\n' +
      String((result && result.content) || '').slice(0, 400) + '\n\n' +
      '已将原始响应写入 ~/.fox-ai/logs/image-gen-debug.log，可贴出来帮我进一步定位。'
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

module.exports = { run, extractImageUrls };
