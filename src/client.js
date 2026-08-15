'use strict';

/**
 * 零依赖的 OpenAI 兼容客户端（Node 内置 http/https）。
 * 适配 llama.cpp server / Ollama / LM Studio 以及 DeepSeek、智谱、通义、Kimi、硅基流动等。
 * 支持流式输出、function calling（tool_calls）增量拼装、随时中断。
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');
const crypto = require('crypto');
const nativeSearch = require('./nativeSearch'); // 多厂商原生联网引用收割（纯函数）

// 全局 keep-alive 连接池：主代理请求与审查/裁判等子代理请求复用 TCP/TLS 连接，
// 省去重复握手（对本地模型尤其明显），直接降低端到端延迟。
const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 16 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 16 });
function agentFor(url) {
  return url.protocol === 'https:' ? httpsAgent : httpAgent;
}

const UA = 'fox-ai-vscode/0.2.0';

// 诊断：把 Responses API 实际发出的 tools / tool_choice 可靠落盘（VS Code Output 落盘会吞掉 console.log）
function debugResponses(tag, obj) {
  try {
    const fs = require('fs');
    const path = require('path');
    const base = process.env.USERPROFILE || process.env.HOME || '.';
    const dir = path.join(base, '.fox-ai', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'responses-debug.log'), new Date().toISOString() + ' ' + tag + ' ' + JSON.stringify(obj) + '\n');
  } catch (_) { /* 诊断失败不影响主流程 */ }
}

// 原始结构 dump（截断保护），用于定位服务商把 web_search 结果放在哪个字段
function debugRaw(tag, obj) {
  try {
    const fs = require('fs');
    const path = require('path');
    const base = process.env.USERPROFILE || process.env.HOME || '.';
    const dir = path.join(base, '.fox-ai', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    let s;
    try { s = typeof obj === 'string' ? obj : JSON.stringify(obj); } catch (e) { s = String(obj); }
    if (typeof s !== 'string') s = String(s);
    if (s.length > 8000) s = s.slice(0, 8000) + ' ...[truncated]';
    fs.appendFileSync(path.join(dir, 'responses-debug.log'), new Date().toISOString() + ' ' + tag + ' ' + s + '\n');
  } catch (_) { /* 诊断失败不影响主流程 */ }
}

function pickAgent(url) {
  return url.protocol === 'https:' ? https : http;
}

/** 根据 Content-Encoding 返回解压流；无编码时返回原响应 */
function wrapDecompress(res) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase().trim();
  if (!enc || enc === 'identity') return res;
  if (enc === 'gzip') return res.pipe(zlib.createGunzip({ flush: zlib.constants.Z_SYNC_FLUSH }));
  if (enc === 'deflate') return res.pipe(zlib.createInflate());
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress());
  // 遇到未知编码：直接读原流，让上层按乱码处理并记录
  console.log('[fox-ai] unknown content-encoding:', enc);
  return res;
}

const MAX_REDIRECTS = 5;

function shouldRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * 把回调包一层：任何异常都不允许冒泡回 Node 的 HTTP 解析器。
 * 否则 llhttp 会把它报成 `Parse Error: JS Exception`，
 * 同时 VS Code 会弹「出现未知错误」，真正的错误反而被埋掉。
 */
function guard(fn, label) {
  if (typeof fn !== 'function') return null;
  return function () {
    try {
      return fn.apply(null, arguments);
    } catch (e) {
      console.error('[fox-ai] callback threw in ' + label + ':', (e && e.stack) || e);
      return undefined;
    }
  };
}

function buildHeaders(apiKey, extra) {
  const headers = Object.assign(
    { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
    extra || {}
  );
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  return headers;
}

// DeepSeek Responses web_search 不返回结构化 results/URL，只在正文里写「（来源：xxx）」。
// 兜底：解析所有来源标签（含 web_search 的合并列表与单个站点名），用原始搜索 query 生成可点击链接。
function cleanSourceLabel(label) {
  return String(label || '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').trim();
}
// 过滤掉明显是「本地知识库」或「非真实网页来源」的标签，避免把模型给本地文件/工具名包装生成 Bing 链接。
function looksLikeLocalSource(label) {
  const s = String(label || '').toLowerCase();
  if (s.includes('知识库')) return true;
  // 只过滤像文件路径的斜杠：无空格包着（如 folder/file）或带本地扩展名；保留 "A / B / C" 这种来源列举
  if (/\S[\\/]\S/.test(s)) return true;
  if (/[\\/][^\\/]*\.(md|txt|jsonl)$/i.test(s)) return true;
  if (/\.(md|txt|jsonl)(\s*[》〉\]])?$/.test(s)) return true;
  const wrapped = label.match(/[《〈「『]([^』」〉》]+)[』」〉》]/);
  if (wrapped && /\.(md|txt|jsonl)$/.test(wrapped[1])) return true;
  return false;
}
function looksLikeToolName(label) {
  const s = String(label || '').toLowerCase().replace(/[\s_\-]/g, '');
  if (s === 'websearch' || s === 'websearch结果') return true;
  if (/^(web[\s_\-]*search|搜索|来源|参考|网页|结果|results?|sources?)([：:]|$)/i.test(s)) return true;
  return false;
}
function parseInlineSourceLabels(text) {
  if (typeof text !== 'string' || !text) return [];
  const labels = [];
  const seen = new Set();
  const addOne = (s) => {
    const t = cleanSourceLabel(s);
    if (t && !seen.has(t) && !looksLikeLocalSource(t) && !looksLikeToolName(t)) { seen.add(t); labels.push(t); }
  };
  const add = (s) => {
    const t = cleanSourceLabel(s);
    if (!t || seen.has(t)) return;
    // 先整体过滤本地路径/工具名；再把 "A / B / C" 拆成独立来源
    if (looksLikeLocalSource(t) || looksLikeToolName(t)) return;
    const parts = t.split(/\s*\/\s*/).filter(Boolean);
    parts.forEach((p) => addOne(p));
  };
  // 1) 合并列表形式：（来源：web_search 结果——A、B、C）
  const listRe = /[（(]来源[：:]\s*web[_\-]?search[^）)\u2014\u2013]*[\u2014\u2013]+\s*([^）)]+)[）)]/gi;
  let m;
  while ((m = listRe.exec(text))) {
    m[1].split(/[、,，;；]/).forEach((s) => add(s));
  }
  // 2) 单个标签形式：（来源：IT之家）、（来源：web_search 结果）
  const singleRe = /[（(]来源[：:]\s*([^）)\u2014\u2013]+)[）)]/g;
  while ((m = singleRe.exec(text))) {
    add(m[1]);
  }
  return labels;
}
function fallbackUrlForSource(label, query) {
  // 优先把原始搜索词和来源标签组合，提高 fallback 命中率；没有 query 时才单独用标签
  const raw = (query ? query.trim() : '') || label.trim();
  const q = encodeURIComponent(raw);
  const lower = label.toLowerCase();
  if (lower.includes('百度')) return 'https://www.baidu.com/s?wd=' + q;
  if (lower.includes('萌娘')) return 'https://zh.moegirl.org.cn/Special:Search?search=' + encodeURIComponent(raw);
  if (lower.includes('必应') || lower.includes('bing')) return 'https://www.bing.com/search?q=' + q;
  if (lower.includes('google')) return 'https://www.google.com/search?q=' + q;
  if (lower.includes('知乎')) return 'https://www.zhihu.com/search?type=content&q=' + encodeURIComponent(raw);
  if (lower.includes('bilibili') || lower.includes('哔哩')) return 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(raw);
  if (lower.includes('微博')) return 'https://s.weibo.com/weibo?q=' + encodeURIComponent(raw);
  if (lower.includes('搜狗')) return 'https://www.sogou.com/web?query=' + q;
  // 常见中文站点：用 site: 在 Bing 里精确到站点
  const siteDomains = [
    ['it之家', 'ithome.com'], ['ithome', 'ithome.com'], ['36氪', '36kr.com'], ['36kr', '36kr.com'],
    ['腾讯新闻', 'news.qq.com'], ['网易', '163.com'], ['搜狐', 'sohu.com'], ['新浪', 'sina.com.cn'],
    ['澎湃新闻', 'thepaper.cn'], ['界面新闻', 'jiemian.com'], ['虎嗅', 'huxiu.com'],
    ['贴吧', 'tieba.baidu.com'], ['豆瓣', 'douban.com'], ['小红书', 'xiaohongshu.com'],
    ['抖音', 'douyin.com'], ['快手', 'kuaishou.com'], ['csdn', 'csdn.net'],
    ['光明网', 'gmw.cn'], ['央视新闻', 'cctv.com'], ['新华社', 'xinhuanet.com'], ['科技日报', 'stdaily.com'],
    ['17173', '17173.com'], ['playstation', 'playstation.com']
  ];
  for (const [name, domain] of siteDomains) {
    if (lower.includes(name)) return 'https://www.bing.com/search?q=site%3A' + domain + '+' + encodeURIComponent(raw);
  }
  return 'https://www.bing.com/search?q=' + encodeURIComponent(raw);
}
function buildInlineSourcesText(text, queries) {
  const labels = parseInlineSourceLabels(text);
  if (!labels.length) return '';
  const query = (Array.isArray(queries) ? queries.find((q) => q && !q.startsWith('ws_call_id=')) : '') || '';
  return labels
    .map((label, i) => {
      // 把原始搜索词拼到来源标签前，让 fallback 链接更容易命中目标页面
      const combinedQuery = query ? (query + ' ' + label) : '';
      const url = fallbackUrlForSource(label, combinedQuery);
      return '[' + (i + 1) + '] ' + label + '\nURL: ' + url;
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * 从各家 usage 字段里统一抽取前缀缓存（Prompt Cache / KV Cache）命中情况。
 * 覆盖：
 *  - OpenAI Chat Completions：usage.prompt_tokens_details.cached_tokens
 *  - DeepSeek Chat：usage.prompt_cache_hit_tokens / prompt_cache_miss_tokens
 *  - Anthropic：usage.cache_read_input_tokens
 *  - OpenAI/DeepSeek Responses：usage.input_tokens_details.cached_tokens / usage.cached_tokens
 * 返回 { cachedTokens, promptTokens, completionTokens, hitRate } 或 null。
 */
function extractCacheStats(usage) {
  if (!usage || typeof usage !== 'object') return null;
  let cached = 0;
  const ptd = usage.prompt_tokens_details;
  if (ptd && typeof ptd.cached_tokens === 'number') cached += ptd.cached_tokens;
  if (typeof usage.prompt_cache_hit_tokens === 'number') cached += usage.prompt_cache_hit_tokens;
  if (typeof usage.cache_read_input_tokens === 'number') cached += usage.cache_read_input_tokens;
  const itd = usage.input_tokens_details;
  if (itd && typeof itd.cached_tokens === 'number') cached += itd.cached_tokens;
  if (typeof usage.cached_tokens === 'number') cached += usage.cached_tokens;
  if (typeof usage.total_cached_tokens === 'number') cached += usage.total_cached_tokens; // Gemini Interactions API
  let promptTokens = 0;
  if (typeof usage.prompt_tokens === 'number') promptTokens = usage.prompt_tokens;
  else if (typeof usage.input_tokens === 'number') promptTokens = usage.input_tokens;
  let miss = 0;
  if (typeof usage.prompt_cache_miss_tokens === 'number') miss = usage.prompt_cache_miss_tokens;
  if (!promptTokens && (cached || miss)) promptTokens = cached + miss;
  const total = promptTokens || cached;
  const hitRate = total > 0 ? cached / total : 0;
  const completionTokens =
    typeof usage.completion_tokens === 'number' ? usage.completion_tokens :
    (typeof usage.output_tokens === 'number' ? usage.output_tokens : 0);
  return { cachedTokens: cached, promptTokens, completionTokens, hitRate };
}

/**
 * 点对点判定某模型/服务商是否支持服务端前缀缓存（Prompt Cache / KV Cache / Context Cache）。
 * 依据各官方文档（2026-08 核实）：
 *  - Anthropic Claude（transport==='anthropic'）：必须显式 cache_control 才有缓存（kind:'explicit'）。
 *  - OpenAI / DeepSeek / Gemini / Qwen / 智谱 等 OpenAI 兼容系：自动前缀缓存（kind:'auto'），只需 system+tools 前缀稳定。
 *  - 本地模型（meta.local，llama.cpp / Ollama 等）：通常无服务端缓存（supported:false）。
 * 返回 { supported, kind, provider, reason }。
 */
function detectOpenaiFamily(model) {
  const m = String(model || '').toLowerCase();
  if (/gemini|google/.test(m)) return 'gemini';
  if (/deepseek/.test(m)) return 'deepseek';
  if (/gpt-|openai|o[0-9]/.test(m)) return 'openai';
  if (/qwen/.test(m)) return 'qwen';
  if (/zhipu|glm/.test(m)) return 'zhipu';
  return 'openai-compatible';
}

function getCacheCapability(meta, transport, model) {
  if (meta && meta.local) {
    return { supported: false, kind: null, provider: 'local',
      reason: '本地模型（llama.cpp / Ollama 等）通常不支持服务端前缀缓存，已静默跳过缓存优化' };
  }
  if (transport === 'anthropic') {
    return { supported: true, kind: 'explicit', provider: 'anthropic' };
  }
  // OpenAI 兼容系：自动前缀缓存
  return { supported: true, kind: 'auto', provider: detectOpenaiFamily(model) };
}

function normalizeError(err, urlString) {
  const code = err && err.code;
  if (code === 'ECONNREFUSED') {
    return new Error(
      `连不上 ${urlString}\n本地服务没起来？llama.cpp 用：llama-server -m 模型.gguf --port 8080 --jinja`
    );
  }
  if (code === 'ENOTFOUND') return new Error('域名解析失败：' + urlString);
  if (code === 'ETIMEDOUT') return new Error('连接超时：' + urlString);
  if (code === 'ECONNRESET') return new Error('连接被重置（可能是服务端主动断开）：' + urlString);
  if (typeof code === 'string' && code.startsWith('HPE_')) {
    const e = new Error('HTTP 响应格式异常（' + code + '）。常见于模型名不存在、服务商拦截流式请求，或中间代理返回非标准响应。');
    e.canRetryNonStream = true;
    return e;
  }
  if (err && err.message && err.message.toLowerCase().includes('parse error')) {
    const e = new Error('流式响应解析失败：' + err.message + '\n可能原因：模型名不存在、该模型不支持流式/tools、或网络中间件截断了 SSE。');
    e.canRetryNonStream = true;
    return e;
  }
  return err instanceof Error ? err : new Error(String(err));
}

function explainHttpError(status, text) {
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = (j.error && (j.error.message || j.error.code)) || j.message || text;
  } catch (_) {}
  const hints = {
    400: '400 请求被拒：可能是模型不支持 tools（llama.cpp 需加 --jinja 启动），或参数不合法',
    401: '401 鉴权失败：API Key 不对或没设置（命令面板 → 狐狸 AI: 设置 API Key）',
    403: '403 无权限：Key 未开通该模型，或余额 / 实名认证问题',
    404: '404 找不到接口：检查 baseUrl 版本前缀（如 /v1）与模型名',
    422: '422 参数不被接受：换个模型或关闭工具调用试试',
    429: '429 触发限流：请求过快或额度用尽',
    500: '500 服务端错误',
    502: '502 网关错误',
    503: '503 服务不可用：本地模型可能仍在加载'
  };
  const hint = hints[status];
  return (hint ? hint + '\n' : `HTTP ${status}\n`) + String(msg).slice(0, 800);
}

/** 普通 JSON 请求（支持 gzip/deflate/br 与重定向） */
function requestJson(urlString, { method = 'GET', apiKey, body, timeout = 15000, insecureHTTPParser = false, extra, _redirects = 0, signal, conversationId } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let onAbort = null;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      if (onAbort && signal) { try { signal.removeEventListener('abort', onAbort); } catch (_) {} }
      fn(val);
    };
    if (signal && signal.aborted) { reject(new Error('请求已取消')); return; }
    if (_redirects > MAX_REDIRECTS) {
      finish(reject, new Error('重定向次数过多：' + urlString));
      return;
    }
    let url;
    try {
      url = new URL(urlString);
    } catch (e) {
      finish(reject, new Error('接口地址不合法：' + urlString));
      return;
    }
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = buildHeaders(apiKey, Object.assign({ 'Accept-Encoding': 'gzip, deflate, br' }, extra || {}));
    if (payload) headers['Content-Length'] = payload.length;

    const req = pickAgent(url).request(url, { method, headers, timeout, insecureHTTPParser, agent: agentFor(url) }, (res) => {
      if (shouldRedirect(res.statusCode) && res.headers.location) {
        let next;
        try {
          next = new URL(res.headers.location, urlString).href;
        } catch (e) {
          finish(reject, new Error('重定向地址不合法：' + res.headers.location));
          return;
        }
        requestJson(next, { method, apiKey, body, timeout, insecureHTTPParser, extra, _redirects: _redirects + 1, signal }).then(
          (v) => finish(resolve, v),
          (e) => finish(reject, e)
        );
        return;
      }

      const bodyStream = wrapDecompress(res);
      const chunks = [];
      bodyStream.on('data', (c) => chunks.push(c));
      bodyStream.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          const err = new Error(explainHttpError(res.statusCode, text));
          err.status = res.statusCode;
          finish(reject, err);
          return;
        }
        try {
          finish(resolve, text ? JSON.parse(text) : {});
        } catch (e) {
          finish(reject, new Error('返回内容不是 JSON：' + text.slice(0, 300)));
        }
      });
      bodyStream.on('error', (e) => finish(reject, normalizeError(e, urlString)));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => finish(reject, normalizeError(e, urlString)));
    if (payload) req.write(payload);
    req.end();
    if (signal) {
      onAbort = () => { try { req.destroy(new Error('请求已取消')); } catch (_) {} };
      signal.addEventListener('abort', onAbort);
    }
  });
}

function findSeparator(buf) {
  const i1 = buf.indexOf('\n\n');
  const i2 = buf.indexOf('\r\n\r\n');
  if (i1 === -1 && i2 === -1) return -1;
  if (i2 !== -1 && (i1 === -1 || i2 < i1)) return { index: i2, length: 4 };
  return { index: i1, length: 2 };
}

function extractData(rawEvent) {
  const lines = rawEvent.split(/\r?\n/);
  const parts = [];
  for (const line of lines) {
    if (line.startsWith('data:')) parts.push(line.slice(5).trim());
  }
  if (!parts.length) return null;
  return parts.join('\n');
}

function parseChoiceMessage(choice) {
  const msg = choice && (choice.message || choice.delta);
  return msg || {};
}

function imageUrlFromBlock(c) {
  if (!c || typeof c !== 'object') return '';
  // OpenAI chat.completions / responses 常见 image_url 块
  if (c.type === 'image_url' || c.type === 'image') {
    const iu = c.image_url || c.image;
    if (typeof iu === 'string') return iu;
    if (iu && typeof iu === 'object') return iu.url || '';
  }
  // Anthropic 风格（较少见于 assistant 输出，但以防万一）
  const s = c.source;
  if (s && s.type === 'base64' && s.data) {
    return 'data:' + (s.media_type || 'image/png') + ';base64,' + s.data;
  }
  // 部分生图模型把图直接放在 { image: 'data:image/...' } 字段
  if (typeof c.image === 'string') return c.image;
  if (typeof c.url === 'string') return c.url;
  if (typeof c.b64_json === 'string') return 'data:image/png;base64,' + c.b64_json;
  return '';
}

function extractImagesFromContent(content) {
  if (!Array.isArray(content)) return [];
  const images = [];
  for (const c of content) {
    const src = imageUrlFromBlock(c);
    if (src) images.push({ src, alt: c.alt || '模型生成图片' });
  }
  return images;
}

/** 从字符串里尽可能抽图片 URL / data URI */
function extractImageUrlsFromString(text) {
  const images = [];
  const seen = new Set();
  const push = (s) => {
    if (s && !seen.has(s)) {
      seen.add(s);
      images.push(s);
    }
  };
  const dataRe = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
  let m;
  while ((m = dataRe.exec(text))) push(m[0]);
  const urlRe = /https?:\/\/[^\s"')<>]+(?:\.(?:png|jpe?g|gif|webp|bmp|svg))(?:\?[^\s"')<>]*)?/gi;
  while ((m = urlRe.exec(text))) push(m[0]);
  return images;
}

function extractContentFromJson(obj) {
  const choice = (obj.choices && obj.choices[0]) || {};
  const msg = parseChoiceMessage(choice);
  let content = '';
  let images = [];
  if (typeof msg.content === 'string') {
    content = msg.content;
    // 有些生图模型把 data URL 或图链嵌在文本内容里
    for (const src of extractImageUrlsFromString(content)) {
      images.push({ src, alt: '模型生成图片' });
    }
  } else if (Array.isArray(msg.content)) {
    content = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    images = extractImagesFromContent(msg.content);
  }
  // 部分模型把图放在 message.image（非 content）
  const msgImage = imageUrlFromBlock(msg);
  if (msgImage) images.push({ src: msgImage, alt: '模型生成图片' });

  // /images/generations 风格：顶层 data 数组 [{url}, {b64_json}]
  if (Array.isArray(obj.data)) {
    for (const d of obj.data) {
      const src = imageUrlFromBlock(d);
      if (src) images.push({ src, alt: '模型生成图片' });
      else if (d && d.revised_prompt) content += (content ? '\n' : '') + d.revised_prompt;
    }
  }
  // 顶层 single image/url（兜底）
  if (obj.url) {
    const src = imageUrlFromBlock({ url: obj.url });
    if (src) images.push({ src, alt: '模型生成图片' });
  }
  if (obj.b64_json) {
    images.push({ src: 'data:image/png;base64,' + obj.b64_json, alt: '模型生成图片' });
  }

  return {
    content,
    images,
    reasoning: msg.reasoning_content || msg.reasoning || '',
    toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
    finishReason: choice.finish_reason || obj.finish_reason || ''
  };
}

/**
 * 流式对话（支持工具调用）
 * onDone(result)  result = { content, reasoning, toolCalls, finishReason, aborted }
 * @returns {{ abort: (reason?:string) => void, aborted: boolean }}
 */
function streamChat(options) {
  const {
    baseUrl,
    apiKey,
    model,
    messages,
    tools,
    toolChoice,
    temperature = 0.3,
    maxTokens = 0,
    timeout = 120000,
    stop,
    extraBody,
    stopMarker,
    insecureHTTPParser = false,
    streamFormat = 'auto',
    conversationId
  } = options;

  // 所有对外回调都套上安全罩，避免 UI 侧异常把 HTTP 解析器搞崩
  const onStart = guard(options.onStart, 'onStart');
  const onDelta = guard(options.onDelta, 'onDelta');
  const onReasoning = guard(options.onReasoning, 'onReasoning');
  const onToolCallStart = guard(options.onToolCallStart, 'onToolCallStart');
  const onDone = guard(options.onDone, 'onDone');
  const onError = guard(options.onError, 'onError');
  const onSearchResults = guard(options.onSearchResults, 'onSearchResults');

  // reasoning gate：非原生 reasoning 模型（如 deepseek-v4-flash）返回的 reasoning_text
  // 和 output_text 可能交替到达，导致“思考还没结束就回答”。开启 gate 后，只要还在收
  // reasoning delta，content 就先缓存，等 reasoning 静默窗口（默认 300ms）过后再释放。
  // 原生 reasoning 模型（deepseek-reasoner / Claude / o-series）不建议开，它们分段清晰。
  const reasoningGate = options.reasoningGate === true || options.reasoningGateMs > 0;
  const reasoningGateMs = Math.max(100, options.reasoningGateMs || 300);
  let reasoningActive = false;
  let pendingContent = '';
  let reasoningTimer = null;
  let flushTimer = null;
  // 思考结束后，把缓存的正文「小步流式」重放出去（打字机渐显），而不是一次性直出。
  // 若重放途中模型又进入思考（reasoningActive 再变 true），则暂停重放、内容保留在
  // pendingContent，等下一轮推理静默后再继续；若流被中止则直接丢弃。
  const GATE_CHUNK = 20;     // 每次重放字符数
  const GATE_INTERVAL = 16;  // 重放节奏(ms)
  let flushCallbacks = [];
  const runFlushCallbacks = () => {
    const cbs = flushCallbacks;
    flushCallbacks = [];
    for (const cb of cbs) cb();
  };
  const flushPendingContent = () => {
    if (flushTimer) return;                       // 已有重放在进行，继续消费 pendingContent 即可
    if (!pendingContent || !onDelta) { pendingContent = ''; runFlushCallbacks(); return; }
    const pump = () => {
      if (handle && handle.aborted) { pendingContent = ''; flushTimer = null; runFlushCallbacks(); return; }
      if (reasoningActive) { flushTimer = null; runFlushCallbacks(); return; }  // 思考又激活，暂停，等下次静默
      const slice = pendingContent.slice(0, GATE_CHUNK);
      pendingContent = pendingContent.slice(GATE_CHUNK);
      if (slice) onDelta(slice);
      if (pendingContent) flushTimer = setTimeout(pump, GATE_INTERVAL);
      else { flushTimer = null; runFlushCallbacks(); }
    };
    pump();
  };
  const gatedOnDelta = reasoningGate
    ? (t) => {
        if (reasoningActive) {
          pendingContent += t;
          if (reasoningTimer) clearTimeout(reasoningTimer);
          reasoningTimer = setTimeout(() => {
            reasoningActive = false;
            flushPendingContent();
          }, reasoningGateMs);
        } else {
          onDelta(t);
        }
      }
    : onDelta;
  const gatedOnReasoning = reasoningGate
    ? (t) => {
        reasoningActive = true;
        if (reasoningTimer) clearTimeout(reasoningTimer);
        onReasoning(t);
      }
    : onReasoning;
  const gatedFinish = (cb) => {
    if (reasoningTimer) clearTimeout(reasoningTimer);
    reasoningActive = false;
    if (cb) flushCallbacks.push(cb);
    flushPendingContent();
  };
  const onUsage = guard(options.onUsage, 'onUsage');
  const collectedSources = [];
  const collectSources = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    const push = (title, url) => {
      const u = String(url || '').trim();
      if (u.startsWith('http://') || u.startsWith('https://')) collectedSources.push({ title: String(title || '').trim(), url: u });
    };
    if (Array.isArray(obj.annotations)) {
      for (const a of obj.annotations) { const uc = a && (a.url_citation || a); push(uc && uc.title, uc && uc.url); }
    }
    if (Array.isArray(obj.citations)) {
      for (const ci of obj.citations) { if (typeof ci === 'string') push('', ci); else if (ci && ci.url) push(ci.title, ci.url); }
    }
  };
  const handle = { aborted: false, abort() {} };

  let url;
  try {
    url = new URL(String(baseUrl).replace(/\/+$/, '') + '/chat/completions');
  } catch (e) {
    setImmediate(() => onError && onError(new Error('接口地址不合法：' + baseUrl)));
    return handle;
  }

  const body = { model, messages, stream: true, temperature };
  if (maxTokens && maxTokens > 0) body.max_tokens = maxTokens;
  if (stop && stop.length) body.stop = stop;
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }
  Object.assign(body, extraBody || {});
  // 注意：日志里把 function 工具显示成 "fn:<name>"，明确它们是「完整对象 {type:'function', name,...}」
  // 而不是字符串占位符（之前曾被误读为把 "function" 当字符串塞进 tools 数组）。
  debugResponses('SEND', { tools: (body.tools || []).map((t) => (t.type === 'function' ? 'fn:' + (t.name || '?') : t.type)), tool_choice: body.tool_choice });

  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const headers = buildHeaders(apiKey, Object.assign({ Accept: 'text/event-stream' }));
  headers['Content-Length'] = payload.length;

  let finished = false;
  let lastUsage = null;
  let content = '';
  let reasoning = '';
  let finishReason = '';
  const toolAcc = [];
  const imagesAcc = [];
  const announced = new Set();
  const rawSamples = [];

  const finish = (err) => {
    if (finished) return;
    finished = true;
    gatedFinish(() => {
      if (err && !handle.aborted) {
        onError && onError(err);
        return;
      }
      onDone &&
        onDone({
          content,
          images: imagesAcc,
          reasoning,
          toolCalls: toolAcc.filter(Boolean).map((t) => ({
            id: t.id,
            name: t.name,
            arguments: t.args
          })),
          finishReason,
          usage: lastUsage,
          aborted: handle.aborted,
          empty: !content && !reasoning && !imagesAcc.length && !toolAcc.filter(Boolean).length && !handle.aborted
        });
      if (collectedSources.length && onSearchResults) {
        const seen = new Set();
        const dedup = [];
        for (const s of collectedSources) { if (s.url && !seen.has(s.url)) { seen.add(s.url); dedup.push(s); } }
        const txt = dedup.map((r, i) => {
          const url = String(r.url || '').trim();
          const title = String(r.title || '').trim();
          const body = String(r.content || r.snippet || '').trim();
          return '[' + (i + 1) + '] ' + title + '\nURL: ' + url + (body ? '\n' + body : '');
        }).join('\n\n');
        onSearchResults(txt);
      }
    });
  };

  function doStreamRequest(targetUrl, redirectsLeft) {
    if (redirectsLeft < 0) {
      finish(new Error('流式请求重定向次数过多'));
      return;
    }

    const req = pickAgent(targetUrl).request(targetUrl, { method: 'POST', headers, timeout, insecureHTTPParser, agent: agentFor(targetUrl) }, (res) => {
      const contentType = String(res.headers['content-type'] || '').toLowerCase();
      const detectedSse = contentType.includes('text/event-stream');
      const detectedNdjson = contentType.includes('application/x-ndjson') || contentType.includes('application/jsonlines');
      const detectedJson = contentType.includes('application/json');
      const isSse = streamFormat === 'sse' || (streamFormat === 'auto' && detectedSse);
      const isNdjson = streamFormat === 'jsonl' || (streamFormat === 'auto' && detectedNdjson);
      const isJson = streamFormat === 'auto' && detectedJson && !isSse && !isNdjson;
      console.log('[fox-ai] streamChat response', res.statusCode, contentType || '(no content-type)', 'enc=', res.headers['content-encoding'] || 'identity', 'fmt=', streamFormat);

      // 重定向：跟随 location，并复用同一套 finish 回调
      if (shouldRedirect(res.statusCode) && res.headers.location) {
        let next;
        try {
          next = new URL(res.headers.location, targetUrl.href).href;
        } catch (e) {
          finish(new Error('重定向地址不合法：' + res.headers.location));
          return;
        }
        try { res.destroy(); } catch (_) {}
        doStreamRequest(new URL(next), redirectsLeft - 1);
        return;
      }

      if (res.statusCode >= 400) {
        const bodyStream = wrapDecompress(res);
        const chunks = [];
        bodyStream.on('data', (c) => chunks.push(c));
        bodyStream.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const err = new Error(explainHttpError(res.statusCode, text));
          err.status = res.statusCode;
          err.raw = text;
          finish(err);
        });
        bodyStream.on('error', (e) => finish(normalizeError(e, targetUrl.href)));
        return;
      }

      // 有些服务对错误模型名也会返回 200 + application/json（而非 SSE），直接解析避免空回复
      if (!isSse && isJson && !isNdjson) {
        const bodyStream = wrapDecompress(res);
        const chunks = [];
        bodyStream.on('data', (c) => chunks.push(c));
        bodyStream.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            const obj = JSON.parse(text);
            if (obj.error) {
              finish(new Error(obj.error.message || JSON.stringify(obj.error)));
              return;
            }
            const extracted = extractContentFromJson(obj);
            content = extracted.content;
            reasoning = extracted.reasoning;
            for (const img of extracted.images) imagesAcc.push(img);
            for (const tc of extracted.toolCalls) {
              toolAcc.push({ id: tc.id || 'call_' + toolAcc.length, name: (tc.function && tc.function.name) || tc.name, args: (tc.function && tc.function.arguments) || tc.arguments || '{}' });
            }
            finishReason = extracted.finishReason;
            finish(null);
          } catch (e) {
            finish(new Error('返回内容不是 JSON：' + text.slice(0, 300)));
          }
        });
        bodyStream.on('error', (e) => finish(normalizeError(e, targetUrl.href)));
        return;
      }

      onStart && onStart();
      const bodyStream = wrapDecompress(res);
      bodyStream.setEncoding('utf8');
      let buffer = '';
      let parseErrors = 0;

      const applyDelta = (delta) => {
        const rc = delta.reasoning_content || delta.reasoning;
        if (typeof rc === 'string' && rc.length) {
          reasoning += rc;
          gatedOnReasoning && gatedOnReasoning(rc);
        }
        if (Array.isArray(delta.tool_calls)) absorbToolCalls(delta.tool_calls);
        collectSources(delta);

        let deltaText = '';
        if (typeof delta.content === 'string' && delta.content.length) {
          deltaText = delta.content;
        } else if (Array.isArray(delta.content)) {
          deltaText = delta.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
          for (const img of extractImagesFromContent(delta.content)) imagesAcc.push(img);
        }
        if (deltaText) {
          content += deltaText;
          gatedOnDelta && gatedOnDelta(deltaText);
          if (stopMarker && content.includes(stopMarker)) {
            finishReason = 'tool_marker';
            try { bodyStream.destroy(); } catch (_) {}
            try { req.destroy(); } catch (_) {}
            finish(null);
            return true;
          }
        }
        return false;
      };

      const processJsonObject = (text) => {
        if (!text || !text.trim()) return false;
        let json;
        try {
          json = JSON.parse(text);
        } catch (e) {
          parseErrors++;
          if (parseErrors <= 3) {
            console.log('[fox-ai] stream JSON parse error:', e.message, 'text=', text.slice(0, 400));
          }
          return false;
        }
        if (json.error) {
          try { bodyStream.destroy(); } catch (_) {}
          try { req.destroy(); } catch (_) {}
          finish(new Error(json.error.message || JSON.stringify(json.error)));
          return true;
        }
        if (json.usage) { lastUsage = json.usage; if (onUsage) { try { onUsage(json.usage); } catch (_) {} } }
        // 多厂商原生联网收割：通义 search_info（chunk 顶层）/ 智谱·Kimi 工具消息 search_results（嵌套），
        // 仅收 http(s)，push 进 collectedSources，复用 finish 的去重 + onSearchResults 透传。
        if (nativeSearch && collectedSources) {
          const nat = nativeSearch.harvestChatChunk(json);
          for (const s of nat) collectedSources.push(s);
        }
        const choice = (json.choices && json.choices[0]) || {};
        if (choice.finish_reason) finishReason = choice.finish_reason;
        collectSources(choice.message);
        return applyDelta(choice.delta || choice.message || {});
      };

      const processEvent = (rawEvent) => {
        const data = extractData(rawEvent);
        if (data === null) {
          if (rawEvent.trim()) console.log('[fox-ai] SSE event has no data line:', JSON.stringify(rawEvent));
          return false;
        }
        if (data === '[DONE]') {
          try { bodyStream.destroy(); } catch (_) {}
          try { req.destroy(); } catch (_) {}
          finish(null);
          return true;
        }
        return processJsonObject(data);
      };

      const absorbToolCalls = (list) => {
        for (const tc of list) {
          const idx = typeof tc.index === 'number' ? tc.index : Math.max(0, toolAcc.length - 1);
          if (!toolAcc[idx]) toolAcc[idx] = { id: '', name: '', args: '' };
          const slot = toolAcc[idx];
          if (tc.id) slot.id = tc.id;
          const fn = tc.function || {};
          if (fn.name) slot.name = slot.name && fn.name.startsWith(slot.name) ? fn.name : slot.name + fn.name;
          if (typeof fn.arguments === 'string') slot.args += fn.arguments;
          if (slot.name && !announced.has(idx)) {
            announced.add(idx);
            onToolCallStart && onToolCallStart(slot.name);
          }
        }
      };

      // 通用帧处理：SSE 按 \n\n 分事件；JSONL / Streamable HTTP 按 \n 分行
      const handleChunk = (chunk) => {
        if (finished) return;
        try {
          if (rawSamples.length < 3) rawSamples.push(String(chunk).slice(0, 600));
          buffer += chunk;

          if (isNdjson) {
            // JSON Lines：每个完整 JSON 对象占一行
            let nl;
            while ((nl = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 1);
              if (processJsonObject(line)) return;
            }
            return;
          }

          // SSE 标准分隔：\n\n 或 \r\n\r\n
          let sep;
          while ((sep = findSeparator(buffer)) !== -1) {
            const rawEvent = buffer.slice(0, sep.index);
            buffer = buffer.slice(sep.index + sep.length);
            if (processEvent(rawEvent)) return;
          }
        } catch (e) {
          console.error('[fox-ai] stream data handler threw:', (e && e.stack) || e);
          try { bodyStream.destroy(); } catch (_) {}
          try { req.destroy(); } catch (_) {}
          finish(new Error('处理流式数据时出错：' + ((e && e.message) || String(e))));
        }
      };

      bodyStream.on('data', handleChunk);

      bodyStream.on('end', () => {
        if (finished) return;
        try {
          // 有些服务最后一个事件没有尾随 \n\n，或 JSONL 最后一行没有换行，buffer 里可能还残留内容
          if (buffer.trim()) {
            console.log('[fox-ai] stream ended with leftover buffer:', JSON.stringify(buffer.slice(0, 400)));
            if (isNdjson) {
              if (processJsonObject(buffer)) return;
            } else if (processEvent(buffer)) {
              return;
            }
          }
          if (!content && !reasoning && !toolAcc.filter(Boolean).length && rawSamples.length) {
            console.log('[fox-ai] stream finished but empty. samples:', rawSamples);
          }
        } catch (e) {
          console.error('[fox-ai] stream end handler threw:', (e && e.stack) || e);
        }
        finish(null);
      });
      bodyStream.on('error', (e) => finish(normalizeError(e, targetUrl.href)));
    });

    req.on('timeout', () => req.destroy(new Error('请求超时，可在设置里调大 foxAi.timeout')));
    req.on('error', (e) => finish(normalizeError(e, targetUrl.href)));
    req.write(payload);
    req.end();

    handle.abort = function () {
      handle.aborted = true;
      try { req.destroy(); } catch (_) {}
      finish(null);
    };
  }

  doStreamRequest(url, MAX_REDIRECTS);
  return handle;
}

/** Promise 版流式调用，便于在 agent 循环里 await */
function chatOnce(options) {
  let handle;
  const promise = new Promise((resolve, reject) => {
    handle = streamChat(
      Object.assign({}, options, {
        onDone: (result) => resolve(result),
        onError: (err) => reject(err)
      })
    );
  });
  return { promise, handle };
}

/** 非流式对话，作为流式解析失败时的兜底 */
async function chatNonStream(options) {
  const {
    baseUrl,
    apiKey,
    model,
    messages,
    tools,
    toolChoice,
    temperature = 0.3,
    maxTokens = 0,
    timeout = 120000,
    stop,
    extraBody,
    insecureHTTPParser = false,
    signal,
    includeRaw = false,
    conversationId
  } = options;
  const onUsage = guard(options.onUsage, 'onUsage');

  const body = { model, messages, stream: false, temperature };
  if (maxTokens && maxTokens > 0) body.max_tokens = maxTokens;
  if (stop && stop.length) body.stop = stop;
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }
  Object.assign(body, extraBody || {});

  // 非流式要等模型一次性算完（推理模型尤其慢），超时不能沿用流式那套短值
  const data = await requestJson(String(baseUrl).replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    apiKey,
    timeout: Math.max(timeout || 0, 30000),
    insecureHTTPParser,
    signal,
    conversationId,
    body
  });

  if (data.error) {
    console.log('[fox-ai] non-stream error:', JSON.stringify(data.error).slice(0, 400));
    throw new Error(data.error.message || JSON.stringify(data.error));
  }
  if (data.usage && onUsage) { try { onUsage(data.usage); } catch (_) {} }
  const extracted = extractContentFromJson(data);
  console.log('[fox-ai] non-stream ok, contentLen=', (extracted.content || '').length, 'reasoningLen=', (extracted.reasoning || '').length, 'toolCalls=', extracted.toolCalls.length, 'images=', extracted.images.length);
  const result = {
    content: extracted.content,
    images: extracted.images,
    reasoning: extracted.reasoning,
    toolCalls: extracted.toolCalls.map((tc) => ({
      id: tc.id || 'call_' + Math.random().toString(36).slice(2, 10),
      name: (tc.function && tc.function.name) || tc.name,
      arguments: (tc.function && typeof tc.function.arguments === 'string') ? tc.function.arguments : JSON.stringify(tc.function && tc.function.arguments || tc.arguments || {})
    })),
    finishReason: extracted.finishReason,
    usage: data.usage || null,
    aborted: false,
    empty: !extracted.content && !extracted.reasoning && !extracted.images.length && !extracted.toolCalls.length
  };
  if (includeRaw) result.raw = data;
  return result;
}

/**
 * 专用 FIM 补全端点（DeepSeek Beta 等老的 /completions 接口，非 chat）。
 * 与 chat/completions 不同：这里不包 FIM token，而是把前缀/后缀作为
 * 原生参数 prompt / suffix 提交，由端点自己处理前后文。
 * 返回结构：{ choices: [ { text: '...' } ] }（text completion，不是 chat message）。
 * 参考：https://api-docs.deepseek.com/zh-cn/guides/fim_completion
 * 注：DeepSeek 该端点需 baseUrl=https://api.deepseek.com/beta（开启 Beta 功能）。
 * _requestJson 仅供单测注入，生产环境走默认 requestJson。
 */
function fimCompleteOnce(opts) {
  const { baseUrl, apiKey, model, prompt, suffix, maxTokens = 128, temperature = 0.1, stop, timeout = 20000, signal, _requestJson } = opts || {};
  const request = _requestJson || requestJson;
  const body = { model, prompt, stream: false, max_tokens: maxTokens, temperature };
  if (suffix) body.suffix = suffix;
  if (stop && stop.length) body.stop = stop;
  const handle = {
    aborted: false,
    abort() {
      this.aborted = true;
      if (signal) { try { signal.abort(); } catch (_) {} }
    }
  };
  const promise = (async () => {
    const data = await request(String(baseUrl).replace(/\/+$/, '') + '/completions', {
      method: 'POST',
      apiKey,
      timeout: Math.max(timeout || 0, 30000),
      insecureHTTPParser: opts && opts.insecureHTTPParser,
      signal,
      body
    });
    if (data.error) {
      throw new Error(data.error.message || JSON.stringify(data.error));
    }
    const text = (data.choices && data.choices[0] && data.choices[0].text) || '';
    return { content: text, usage: data.usage || null, aborted: handle.aborted };
  })();
  return { promise, handle };
}

// ─────────────────────────────────────────────────────────────
// OpenAI Responses API（/v1/responses）支持：原生 function calling、
// 推理增量、结构化输出。与 chat/completions 协议平行，按需选择。
// ─────────────────────────────────────────────────────────────

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && (c.type === 'text' || c.type === 'input_text' || c.type === 'output_text'))
      .map((c) => c.text || '')
      .join('\n');
  }
  return '';
}

/** messages（fox-ai 内部格式）→ Responses API 的 input 数组 */
function toResponsesInput(messages) {
  const input = [];
  for (const m of messages || []) {
    if (!m || !m.role) continue;
    if (m.role === 'user') {
      // 支持图片：chat 模式的 image_url part → Responses 的 input_image item。
      // 否则 vision 模型在 responses 模式下会拿不到图（图片被 textOfContent 静默过滤掉）。
      if (typeof m.content === 'string') {
        input.push({ role: 'user', content: [{ type: 'input_text', text: m.content }] });
      } else if (Array.isArray(m.content)) {
        const parts = [];
        for (const c of m.content) {
          if (!c) continue;
          if (c.type === 'image_url') {
            const url = (c.image_url && (c.image_url.url || c.image_url)) || '';
            if (url) parts.push(Object.assign({ type: 'input_image', image_url: url }, (c.image_url && c.image_url.detail ? { detail: c.image_url.detail } : {})));
          } else if (c.type === 'input_image') {
            const url = c.image_url || (c.image && c.image.url) || '';
            if (url) parts.push({ type: 'input_image', image_url: url });
          } else if (c.type === 'text') {
            if (c.text) parts.push({ type: 'input_text', text: c.text });
          } else if (c.type === 'input_text') {
            if (c.text) parts.push({ type: 'input_text', text: c.text });
          }
        }
        if (parts.length) input.push({ role: 'user', content: parts });
      }
    } else if (m.role === 'assistant') {
      const t = textOfContent(m.content);
      const reasoning = m.reasoning && String(m.reasoning).trim();
      if (reasoning) {
        // DeepSeek 等「思考模式」实现要求多轮时把上一轮 assistant 的 reasoning 回传，
        // 否则报 "reasoning_text in the thinking mode must be passed back"。
        input.push({ type: 'reasoning', content: [{ type: 'reasoning_text', text: reasoning }] });
      }
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        // 工具调用：必须以「顶层独立 item」形式给出（type:'function_call'）。
        // 不能包进 assistant.content 数组——DeepSeek 等严格实现会报
        // "unknown variant function_call, expected input_text/output_text/..."。
        // 兼容两种 tool_calls 写法：OpenAI chat 格式（arguments 嵌套在 function.arguments）
        // 与扁平格式（arguments 直接在顶层）。
        for (const tc of m.tool_calls) {
          const fn = tc.function || tc;
          const args = fn.arguments;
          input.push({
            type: 'function_call',
            call_id: tc.id || fn.id || ('call_' + input.length),
            name: fn.name || tc.name,
            arguments: typeof args === 'string' ? args : '{}'
          });
        }
      } else if (t) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: t }] });
      }
    } else if (m.role === 'tool') {
      // 工具结果通过顶层 function_call_output item 回传（与对应的 function_call 配对）
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: textOfContent(m.content)
      });
    }
  }
  return input;
}

/** OpenAI 工具 schema（{type:'function', function:{...}}）→ Responses API 扁平格式 */
function toResponsesTools(tools) {
  return (tools || []).map((t) => {
    // 保留服务商内置工具（如 DeepSeek 的 web_search）
    if (t.type === 'web_search' || t.type === 'web_search_2025_08_26') {
      return { type: t.type };
    }
    const f = t.function || t;
    return {
      type: 'function',
      name: f.name,
      description: f.description || '',
      parameters: f.parameters || { type: 'object', properties: {} }
    };
  });
}

/** 解析 Responses API 非流式 output 数组 */
function parseResponsesOutput(output) {
  let content = '';
  let reasoning = '';
  const toolCalls = [];
  const images = [];
  for (const it of output || []) {
    if (it.type === 'message') {
      for (const c of it.content || []) {
        if (c.type === 'output_text' || c.type === 'input_text') {
          content += (content ? '\n' : '') + (c.text || '');
        } else {
          const src = imageUrlFromBlock(c);
          if (src) images.push({ src, alt: c.alt || '模型生成图片' });
        }
      }
    } else if (it.type === 'reasoning') {
      for (const c of it.content || []) {
        if (c.type === 'reasoning_text') reasoning += (reasoning ? '\n' : '') + (c.text || '');
      }
    } else if (it.type === 'function_call') {
      toolCalls.push({
        id: it.call_id || 'call_' + Math.random().toString(36).slice(2, 10),
        name: it.name,
        arguments: typeof it.arguments === 'string' ? it.arguments : '{}'
      });
    } else if (it.type === 'image_generation_call' && it.b64_json) {
      images.push({ src: 'data:image/png;base64,' + it.b64_json, alt: '模型生成图片' });
    }
    // web_search_call 为 DeepSeek 等服务商内置联网搜索，服务端已执行，结果会跟随后续 output_text 返回，无需本地执行
  }
  return { content, reasoning, toolCalls, images };
}

/**
 * 流式对话（Responses API 协议）
 * onDone(result)  result = { content, reasoning, toolCalls, finishReason, aborted, empty }
 */
function streamResponses(options) {
  const {
    baseUrl, apiKey, model, messages, tools, toolChoice,
    temperature = 0.3, maxTokens = 0, timeout = 120000,
    extraBody, insecureHTTPParser = false, streamFormat = 'auto',
    conversationId
  } = options;

  const onStart = guard(options.onStart, 'onStart');
  const onDelta = guard(options.onDelta, 'onDelta');
  const onReasoning = guard(options.onReasoning, 'onReasoning');
  const onToolCallStart = guard(options.onToolCallStart, 'onToolCallStart');
  const onDone = guard(options.onDone, 'onDone');
  const onError = guard(options.onError, 'onError');
  // 原生联网（DeepSeek/OpenAI Responses 的 web_search_call）的结果里含真实 URL，
  // 透传给上层，供前端把引用角标补全成可点击链接。
  const onSearchResults = guard(options.onSearchResults, 'onSearchResults');
  const onUsage = guard(options.onUsage, 'onUsage');

  // reasoning gate：同 streamChat，防止非原生 reasoning 模型 reasoning/output 交错
  const reasoningGate = options.reasoningGate === true || options.reasoningGateMs > 0;
  const reasoningGateMs = Math.max(100, options.reasoningGateMs || 300);
  let reasoningActive = false;
  let pendingContent = '';
  let reasoningTimer = null;
  let flushTimer = null;
  // 思考结束后，把缓存的正文「小步流式」重放出去（打字机渐显），而不是一次性直出。
  const GATE_CHUNK = 20;     // 每次重放字符数
  const GATE_INTERVAL = 16;  // 重放节奏(ms)
  let flushCallbacks = [];
  const runFlushCallbacks = () => {
    const cbs = flushCallbacks;
    flushCallbacks = [];
    for (const cb of cbs) cb();
  };
  const flushPendingContent = () => {
    if (flushTimer) return;                       // 已有重放在进行，继续消费 pendingContent 即可
    if (!pendingContent || !onDelta) { pendingContent = ''; runFlushCallbacks(); return; }
    const pump = () => {
      if (handle && handle.aborted) { pendingContent = ''; flushTimer = null; runFlushCallbacks(); return; }
      if (reasoningActive) { flushTimer = null; runFlushCallbacks(); return; }  // 思考又激活，暂停，等下次静默
      const slice = pendingContent.slice(0, GATE_CHUNK);
      pendingContent = pendingContent.slice(GATE_CHUNK);
      if (slice) onDelta(slice);
      if (pendingContent) flushTimer = setTimeout(pump, GATE_INTERVAL);
      else { flushTimer = null; runFlushCallbacks(); }
    };
    pump();
  };
  const gatedOnDelta = reasoningGate
    ? (t) => {
        if (reasoningActive) {
          pendingContent += t;
          if (reasoningTimer) clearTimeout(reasoningTimer);
          reasoningTimer = setTimeout(() => {
            reasoningActive = false;
            flushPendingContent();
          }, reasoningGateMs);
        } else {
          onDelta(t);
        }
      }
    : onDelta;
  const gatedOnReasoning = reasoningGate
    ? (t) => {
        reasoningActive = true;
        if (reasoningTimer) clearTimeout(reasoningTimer);
        onReasoning(t);
      }
    : onReasoning;
  const gatedFinish = (cb) => {
    if (reasoningTimer) clearTimeout(reasoningTimer);
    reasoningActive = false;
    if (cb) flushCallbacks.push(cb);
    flushPendingContent();
  };
  // 收集 output_text.delta / output_item.done 里附带的引用链接（部分服务商不在 web_search_call 事件里给 results，而是放在 annotations/citations 中）
  const collectedSources = [];
  const collectSources = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    const push = (title, url) => {
      const u = String(url || '').trim();
      if (u.startsWith('http://') || u.startsWith('https://')) collectedSources.push({ title: String(title || '').trim(), url: u });
    };
    if (Array.isArray(obj.annotations)) {
      for (const a of obj.annotations) { const uc = a && (a.url_citation || a); push(uc && uc.title, uc && uc.url); }
    }
    if (Array.isArray(obj.citations)) {
      for (const ci of obj.citations) { if (typeof ci === 'string') push('', ci); else if (ci && ci.url) push(ci.title, ci.url); }
    }
  };
  // 收集 web_search_call 的原始搜索词，供 DeepSeek 等不返回 URL 的服务商在 fallback 时生成更合理的搜索链接
  const webSearchQueries = [];
  const collectWebSearchQueries = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    const action = obj.action || (obj.web_search_call && obj.web_search_call.action);
    if (action && Array.isArray(action.queries)) {
      for (const q of action.queries) {
        if (q && typeof q === 'string' && !q.startsWith('ws_call_id=') && !webSearchQueries.includes(q)) {
          webSearchQueries.push(q);
        }
      }
    }
  };
  // 把搜索结果数组拼成 harvest 期望的「[n] 标题 / URL: …」文本
  // 兼容字段差异：OpenAI/DeepSeek 常用 url/title/content，部分厂商用 link/href/source/uri 等
  const buildSourcesText = (results) => {
    if (!Array.isArray(results) || !results.length) return '';
    return results
      .map((r, i) => {
        let url = '';
        if (typeof r === 'string') {
          url = r.trim();
        } else if (r && typeof r === 'object') {
          const cand = r.url || r.link || r.href || r.source || r.uri || r.web_url || r.webUrl || r.source_url || r.sourceUrl || r.canonical_url || r.canonicalUrl;
          url = String(cand || '').trim();
        }
        if (!/^https?:\/\//i.test(url)) return '';
        let title = '';
        if (typeof r === 'string') {
          title = '';
        } else if (r && typeof r === 'object') {
          title = String(r.title || r.name || r.headline || r.subject || r.snippet || r.content || r.summary || r.description || '').trim();
        }
        if (!title) title = url.replace(/^https?:\/\//, '').split('/')[0] || url;
        const body = String(r && (r.content || r.snippet || r.summary || r.description) || '').trim();
        return '[' + (i + 1) + '] ' + title + '\nURL: ' + url + (body ? '\n' + body : '');
      })
      .filter(Boolean)
      .join('\n\n');
  };
  // DeepSeek Responses web_search 兜底解析函数已提升为模块级纯函数（cleanSourceLabel / parseInlineSourceLabels / fallbackUrlForSource / buildInlineSourcesText）。

  const handle = { aborted: false, abort() {} };

  let url;
  try {
    url = new URL(String(baseUrl).replace(/\/+$/, '') + '/responses');
  } catch (e) {
    setImmediate(() => onError && onError(new Error('接口地址不合法：' + baseUrl)));
    return handle;
  }

  const sysMsgs = (messages || []).filter((m) => m && m.role === 'system');
  const instructions = sysMsgs.map((m) => textOfContent(m.content)).filter(Boolean).join('\n\n');
  const input = toResponsesInput((messages || []).filter((m) => m && m.role !== 'system'));

  const body = { model, instructions, input, stream: true, temperature, store: false };
  if (maxTokens && maxTokens > 0) body.max_output_tokens = maxTokens;
  if (tools && tools.length) {
    body.tools = toResponsesTools(tools);
    body.tool_choice = toolChoice || 'auto';
  }
  Object.assign(body, extraBody || {});
  // 注意：日志里把 function 工具显示成 "fn:<name>"，明确它们是「完整对象 {type:'function', name,...}」
  // 而不是字符串占位符（之前曾被误读为把 "function" 当字符串塞进 tools 数组）。
  debugResponses('SEND', { tools: (body.tools || []).map((t) => (t.type === 'function' ? 'fn:' + (t.name || '?') : t.type)), tool_choice: body.tool_choice });

  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const headers = buildHeaders(apiKey, Object.assign({ Accept: 'text/event-stream' }));
  headers['Content-Length'] = payload.length;

  let finished = false;
  let lastUsage = null;
  let content = '';
  let reasoning = '';
  let finishReason = '';
  const fcAcc = {};
  const imagesAcc = [];
  const announced = new Set();
  const rawSamples = [];

  const finish = (err) => {
    if (finished) return;
    finished = true;
    gatedFinish(() => {
      if (err && !handle.aborted) {
        onError && onError(err);
        return;
      }
      const toolCalls = Object.keys(fcAcc).map((k) => {
        const t = fcAcc[k];
        return { id: t.id || 'call_' + k, name: t.name, arguments: t.args || '{}' };
      });
      onDone &&
        onDone({
          content,
          images: imagesAcc,
          reasoning,
          toolCalls,
          finishReason,
          usage: lastUsage,
          aborted: handle.aborted,
          empty: !content && !reasoning && !imagesAcc.length && !toolCalls.length && !handle.aborted
        });
    });
  };

  function doStreamRequest(targetUrl, redirectsLeft) {
    if (redirectsLeft < 0) {
      finish(new Error('流式请求重定向次数过多'));
      return;
    }
    const req = pickAgent(targetUrl).request(targetUrl, { method: 'POST', headers, timeout, insecureHTTPParser, agent: agentFor(targetUrl) }, (res) => {
      const contentType = String(res.headers['content-type'] || '').toLowerCase();
      const detectedSse = contentType.includes('text/event-stream');
      const detectedNdjson = contentType.includes('application/x-ndjson') || contentType.includes('application/jsonlines');
      const detectedJson = contentType.includes('application/json');
      const isSse = streamFormat === 'sse' || (streamFormat === 'auto' && detectedSse);
      const isNdjson = streamFormat === 'jsonl' || (streamFormat === 'auto' && detectedNdjson);
      const isJson = streamFormat === 'auto' && detectedJson && !isSse && !isNdjson;
      console.log('[fox-ai] streamResponses response', res.statusCode, contentType || '(no content-type)', 'enc=', res.headers['content-encoding'] || 'identity', 'fmt=', streamFormat);

      if (shouldRedirect(res.statusCode) && res.headers.location) {
        let next;
        try { next = new URL(res.headers.location, targetUrl.href).href; } catch (e) { finish(new Error('重定向地址不合法：' + res.headers.location)); return; }
        try { res.destroy(); } catch (_) {}
        doStreamRequest(new URL(next), redirectsLeft - 1);
        return;
      }

      if (res.statusCode >= 400) {
        const bodyStream = wrapDecompress(res);
        const chunks = [];
        bodyStream.on('data', (c) => chunks.push(c));
        bodyStream.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const err = new Error(explainHttpError(res.statusCode, text));
          err.status = res.statusCode;
          err.raw = text;
          finish(err);
        });
        bodyStream.on('error', (e) => finish(normalizeError(e, targetUrl.href)));
        return;
      }

      // 有些服务对错误模型名也会返回 200 + application/json，直接解析避免空回复
      if (!isSse && isJson && !isNdjson) {
        const bodyStream = wrapDecompress(res);
        const chunks = [];
        bodyStream.on('data', (c) => chunks.push(c));
        bodyStream.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            const obj = JSON.parse(text);
            if (obj.error) { finish(new Error(obj.error.message || JSON.stringify(obj.error))); return; }
            const parsed = parseResponsesOutput(obj.output || []);
            content = parsed.content;
            reasoning = parsed.reasoning;
            for (const img of parsed.images) imagesAcc.push(img);
            for (const tc of parsed.toolCalls) {
              const k = tc.id || ('k' + Object.keys(fcAcc).length);
              fcAcc[k] = { id: tc.id, name: tc.name, args: tc.arguments };
            }
            finishReason = parsed.toolCalls.length ? 'tool_calls' : 'stop';
            finish(null);
          } catch (e) {
            finish(new Error('返回内容不是 JSON：' + text.slice(0, 300)));
          }
        });
        bodyStream.on('error', (e) => finish(normalizeError(e, targetUrl.href)));
        return;
      }

      onStart && onStart();
      const bodyStream = wrapDecompress(res);
      bodyStream.setEncoding('utf8');
      let buffer = '';
      let parseErrors = 0;

      const processJsonObject = (text) => {
        if (!text || !text.trim()) return false;
        let json;
        try { json = JSON.parse(text); } catch (e) {
          parseErrors++;
          if (parseErrors <= 3) console.log('[fox-ai] responses stream JSON parse error:', e.message, 'text=', text.slice(0, 400));
          return false;
        }
        if (json.error) { try { bodyStream.destroy(); } catch (_) {} try { req.destroy(); } catch (_) {} finish(new Error(json.error.message || JSON.stringify(json.error))); return true; }
        const type = json.type;
        if (type === 'response.output_text.delta' || type === 'response.reasoning_text.delta') {
          // OpenAI/DeepSeek 的 delta 事件里 delta 本身就是字符串（不是 delta.text）
          const d = json.delta;
          const t = (d && (typeof d === 'string' ? d : d.text)) || '';
          if (t) {
            if (type === 'response.reasoning_text.delta') { reasoning += t; gatedOnReasoning && gatedOnReasoning(t); }
            else { content += t; gatedOnDelta && gatedOnDelta(t); }
          }
          // 部分厂商把引用链接放在 delta 的 annotations / citations 里（DeepSeek 等）
          if (type === 'response.output_text.delta') collectSources(d);
        } else if (type === 'response.content_part.delta') {
          const part = json.part || {};
          if (part.type === 'output_text' && typeof part.delta === 'string') { content += part.delta; onDelta && onDelta(part.delta); }
          if (part.type === 'output_text') collectSources(part);
        } else if (type === 'response.output_item.added') {
          const it = json.item || {};
          if (it.type === 'function_call') {
            const iid = json.item_id;
            fcAcc[iid] = { id: it.call_id, name: it.name, args: '' };
            if (!announced.has(iid)) { announced.add(iid); onToolCallStart && onToolCallStart(it.name); }
          } else if (it.type === 'image_generation_call' && it.b64_json) {
            imagesAcc.push({ src: 'data:image/png;base64,' + it.b64_json, alt: '模型生成图片' });
          }
        } else if (type === 'response.function_call_arguments.delta') {
          const iid = json.item_id;
          if (fcAcc[iid]) fcAcc[iid].args += (json.delta || '');
        } else if (type === 'response.web_search_call.searching' || type === 'response.web_search_call.in_progress') {
          console.log('[fox-ai] responses web_search_call in progress');
        } else if (type === 'response.web_search_call.completed') {
          // 原生联网搜索完成：把 results（标题/URL）透传给前端 harvest，补全引用角标链接
          debugRaw('RAW web_search_call.completed', json);
          const item = json.item || json.web_search_call || json;
          collectWebSearchQueries(item);
          const results = (item && item.results) || json.results;
          debugResponses('RECV web_search_call.completed', { hasResults: Array.isArray(results), count: Array.isArray(results) ? results.length : 0, sample: Array.isArray(results) ? results.slice(0, 2) : results });
          const txt = buildSourcesText(results);
          debugResponses('EMIT searchSources', { length: txt.length, preview: txt.slice(0, 600) });
          if (txt && onSearchResults) onSearchResults(txt);
        } else if (type === 'response.output_item.done') {
          debugRaw('RAW output_item.done', json);
          const it = json.item || {};
          collectWebSearchQueries(it);
          const iid = json.item_id;
          if (it.type === 'function_call' && fcAcc[iid]) {
            fcAcc[iid].id = it.call_id;
            fcAcc[iid].name = it.name;
            // 仅当 done 事件带有非空 arguments 时才覆盖增量累加结果，
            // 避免部分服务端 done 事件 arguments 为空导致参数被清空。
            if (typeof it.arguments === 'string' && it.arguments.length) fcAcc[iid].args = it.arguments;
          } else if (it.type === 'web_search_call' && Array.isArray(it.results) && it.results.length) {
            // 兜底：部分服务商在 output_item.done 的 web_search_call 项里给 results
            debugResponses('RECV output_item.done web_search_call', { count: it.results.length, sample: it.results.slice(0, 2) });
            const txt = buildSourcesText(it.results);
            debugResponses('EMIT searchSources fallback', { length: txt.length, preview: txt.slice(0, 600) });
            if (txt && onSearchResults) onSearchResults(txt);
          }
        } else if (type === 'response.completed') {
          finishReason = 'stop';
          const ru = (json.response && json.response.usage) || json.usage;
          if (ru) { lastUsage = ru; if (onUsage) { try { onUsage(ru); } catch (_) {} } }
          // 关键兜底：最终 output 数组里通常包含 web_search_call 项及其 results（DeepSeek 不在 streaming 事件里给 results）
          const outArr = (json.response && json.response.output) || json.output;
          if (Array.isArray(outArr)) {
            debugRaw('RAW response.completed.output', outArr);
            for (const o of outArr) {
              if (o && o.type === 'web_search_call' && Array.isArray(o.results) && o.results.length) {
                const t = buildSourcesText(o.results);
                debugResponses('EMIT searchSources from output[]', { length: t.length, count: o.results.length, preview: t.slice(0, 600) });
                if (t && onSearchResults) onSearchResults(t);
              }
              collectWebSearchQueries(o);
            }
          }
          // 兜底：流末把 output_text 里收集到的 annotations/citations 也透传出去
          if (collectedSources.length && onSearchResults) {
            const seen = new Set();
            const dedup = [];
            for (const s of collectedSources) { if (s.url && !seen.has(s.url)) { seen.add(s.url); dedup.push(s); } }
            const txt = dedup.map((r, i) => {
              const url = String(r.url || '').trim();
              const title = String(r.title || '').trim() || url.replace(/^https?:\/\//, '').split('/')[0] || url;
              const body = String(r.content || r.snippet || '').trim();
              return '[' + (i + 1) + '] ' + title + '\nURL: ' + url + (body ? '\n' + body : '');
            }).join('\n\n');
            debugResponses('EMIT searchSources from annotations', { length: txt.length, count: dedup.length, preview: txt.slice(0, 600) });
            if (txt) onSearchResults(txt);
          }
          // DeepSeek 专用兜底：官方 web_search 不返回 URL，只在正文里写来源名称，用原始 query 生成搜索链接
          const inlineTxt = buildInlineSourcesText(content, webSearchQueries);
          debugResponses('EMIT searchSources inline fallback', { length: inlineTxt.length, queries: webSearchQueries, preview: inlineTxt.slice(0, 600) });
          if (inlineTxt && onSearchResults) onSearchResults(inlineTxt);
          try { bodyStream.destroy(); } catch (_) {}
          try { req.destroy(); } catch (_) {}
          finish(null);
          return true;
        } else if (type === 'response.incomplete') {
          // 输出因 max_output_tokens 截断等被标记为 incomplete，仍应立即收尾（已收集的 delta 都已在手）
          finishReason = 'incomplete';
          try { bodyStream.destroy(); } catch (_) {}
          try { req.destroy(); } catch (_) {}
          finish(null);
          return true;
        } else if (type === 'response.failed' || type === 'response.error') {
          const err = new Error((json.error && (json.error.message || json.error.code)) || 'Responses 请求失败');
          try { bodyStream.destroy(); } catch (_) {}
          try { req.destroy(); } catch (_) {}
          finish(err);
          return true;
        }
        return false;
      };

      const processEvent = (rawEvent) => {
        const data = extractData(rawEvent);
        if (data === null) return false;
        if (data === '[DONE]') { try { bodyStream.destroy(); } catch (_) {} try { req.destroy(); } catch (_) {} finish(null); return true; }
        return processJsonObject(data);
      };

      const handleChunk = (chunk) => {
        if (finished) return;
        try {
          if (rawSamples.length < 3) rawSamples.push(String(chunk).slice(0, 600));
          buffer += chunk;
          if (isNdjson) {
            let nl;
            while ((nl = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 1);
              if (processJsonObject(line)) return;
            }
            return;
          }
          let sep;
          while ((sep = findSeparator(buffer)) !== -1) {
            const rawEvent = buffer.slice(0, sep.index);
            buffer = buffer.slice(sep.index + sep.length);
            if (processEvent(rawEvent)) return;
          }
        } catch (e) {
          console.error('[fox-ai] responses stream data handler threw:', (e && e.stack) || e);
          try { bodyStream.destroy(); } catch (_) {}
          try { req.destroy(); } catch (_) {}
          finish(new Error('处理流式数据时出错：' + ((e && e.message) || String(e))));
        }
      };

      bodyStream.on('data', handleChunk);
      bodyStream.on('end', () => {
        if (finished) return;
        try {
          if (buffer.trim()) {
            console.log('[fox-ai] responses stream ended with leftover buffer:', JSON.stringify(buffer.slice(0, 400)));
            if (isNdjson) { if (processJsonObject(buffer)) return; }
            else if (processEvent(buffer)) return;
          }
        } catch (e) { console.error('[fox-ai] responses stream end handler threw:', (e && e.stack) || e); }
        finish(null);
      });
      bodyStream.on('error', (e) => finish(normalizeError(e, targetUrl.href)));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时，可在设置里调大 foxAi.timeout')));
    req.on('error', (e) => finish(normalizeError(e, targetUrl.href)));
    req.write(payload);
    req.end();
    handle.abort = function () {
      handle.aborted = true;
      try { req.destroy(); } catch (_) {}
      finish(null);
    };
  }

  doStreamRequest(url, MAX_REDIRECTS);
  return handle;
}

/** 非流式对话（Responses API），作为流式解析失败时的兜底 */
async function chatNonStreamResponses(options) {
  const {
    baseUrl, apiKey, model, messages, tools, toolChoice,
    temperature = 0.3, maxTokens = 0, timeout = 120000,
    extraBody, insecureHTTPParser = false,
    signal, conversationId
  } = options;
  const onUsage = guard(options.onUsage, 'onUsage');

  const sysMsgs = (messages || []).filter((m) => m && m.role === 'system');
  const instructions = sysMsgs.map((m) => textOfContent(m.content)).filter(Boolean).join('\n\n');
  const input = toResponsesInput((messages || []).filter((m) => m && m.role !== 'system'));
  const body = { model, instructions, input, stream: false, temperature, store: false };
  if (maxTokens && maxTokens > 0) body.max_output_tokens = maxTokens;
  if (tools && tools.length) {
    body.tools = toResponsesTools(tools);
    body.tool_choice = toolChoice || 'auto';
  }
  Object.assign(body, extraBody || {});
  // 注意：日志里把 function 工具显示成 "fn:<name>"，明确它们是「完整对象 {type:'function', name,...}」
  // 而不是字符串占位符（之前曾被误读为把 "function" 当字符串塞进 tools 数组）。
  debugResponses('SEND', { tools: (body.tools || []).map((t) => (t.type === 'function' ? 'fn:' + (t.name || '?') : t.type)), tool_choice: body.tool_choice });

  const data = await requestJson(String(baseUrl).replace(/\/+$/, '') + '/responses', {
    method: 'POST',
    apiKey,
    timeout: Math.max(timeout || 0, 30000),
    insecureHTTPParser,
    signal,
    conversationId,
    body
  });
  if (data.error) {
    console.log('[fox-ai] responses non-stream error:', JSON.stringify(data.error).slice(0, 400));
    throw new Error(data.error.message || JSON.stringify(data.error));
  }
  const ru = data.usage || (data.response && data.response.usage);
  if (ru && onUsage) { try { onUsage(ru); } catch (_) {} }
  const parsed = parseResponsesOutput(data.output || []);
  console.log('[fox-ai] responses non-stream ok, contentLen=', (parsed.content || '').length, 'reasoningLen=', (parsed.reasoning || '').length, 'toolCalls=', parsed.toolCalls.length, 'images=', parsed.images.length);
  return {
    content: parsed.content,
    images: parsed.images,
    reasoning: parsed.reasoning,
    toolCalls: parsed.toolCalls,
    finishReason: parsed.toolCalls.length ? 'tool_calls' : 'stop',
    usage: ru || null,
    aborted: false,
    empty: !parsed.content && !parsed.reasoning && !parsed.images.length && !parsed.toolCalls.length
  };
}

async function listModels({ baseUrl, apiKey, timeout = 15000 }) {
  const data = await requestJson(String(baseUrl).replace(/\/+$/, '') + '/models', { apiKey, timeout });
  const arr = (data && (data.data || data.models)) || [];
  return arr.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
}

module.exports = {
  streamChat, chatOnce, chatNonStream, streamResponses, chatNonStreamResponses, toResponsesTools, listModels,
  requestJson, fimCompleteOnce, extractCacheStats, getCacheCapability,
  cleanSourceLabel, looksLikeLocalSource, parseInlineSourceLabels, fallbackUrlForSource, buildInlineSourcesText
};
