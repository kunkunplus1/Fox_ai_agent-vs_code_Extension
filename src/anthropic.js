'use strict';

/**
 * Anthropic Claude 官方 Messages API 适配层（零依赖，Node 内置 http/https）。
 *
 * 对外暴露与 client.js 完全相同的契约：
 *   streamChat(options) / chatNonStream(options) / chatOnce(options)
 * 但内部把 fox-ai 的「OpenAI 格式」消息/工具 ↔ Anthropic Messages 格式互译，
 * 这样 agent.js 无需感知协议差异——它仍以为在跟 OpenAI 格式对话。
 *
 * 注意：Claude 不支持 OpenAI Responses API，此模块只实现 chat（/v1/messages）。
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');
const { requestJson } = require('./client');
const nativeSearch = require('./nativeSearch'); // 多厂商原生联网引用收割（纯函数）

const UA = 'fox-ai-vscode/0.2.0';

function pickAgent(url) {
  return url.protocol === 'https:' ? https : http;
}

function wrapDecompress(res) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase().trim();
  if (!enc || enc === 'identity') return res;
  if (enc === 'gzip') return res.pipe(zlib.createGunzip({ flush: zlib.constants.Z_SYNC_FLUSH }));
  if (enc === 'deflate') return res.pipe(zlib.createInflate());
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress());
  return res;
}

function guard(fn, label) {
  if (typeof fn !== 'function') return null;
  return function () {
    try {
      return fn.apply(null, arguments);
    } catch (e) {
      console.error('[fox-ai anthropic] callback threw in ' + label + ':', (e && e.stack) || e);
      return undefined;
    }
  };
}

function buildHeaders(apiKey, extra) {
  const headers = Object.assign(
    { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA, 'anthropic-version': '2023-06-01' },
    extra || {}
  );
  if (apiKey) headers['x-api-key'] = apiKey;
  return headers;
}

function normalizeError(err, urlString) {
  const code = err && err.code;
  if (code === 'ECONNREFUSED') return new Error('连不上 ' + urlString + '\n检查 baseUrl 与网络');
  if (code === 'ENOTFOUND') return new Error('域名解析失败：' + urlString);
  if (code === 'ETIMEDOUT') return new Error('连接超时：' + urlString);
  if (code === 'ECONNRESET') return new Error('连接被重置：' + urlString);
  return err instanceof Error ? err : new Error(String(err));
}

function explainHttpError(status, text, baseUrl) {
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = (j.error && (j.error.message || j.error.type)) || j.message || text;
  } catch (_) {}
  const hints = {
    401: '401 鉴权失败：Anthropic API Key 不对或没设置',
    403: '403 无权限',
    404: build404Hint(baseUrl),
    429: '429 触发限流：请求过快或额度用尽'
  };
  const hint = hints[status];
  return (hint ? hint + '\n' : `HTTP ${status}\n`) + String(msg).slice(0, 800);
}

/**
 * 各厂商官方 Anthropic 兼容端点映射（依据官方文档，勿猜）：
 *   - DeepSeek：https://api.deepseek.com/anthropic（官方「Using the Anthropic API」）
 *   - 智谱 GLM：https://open.bigmodel.cn/api/anthropic（官方「Claude API 兼容」）
 *   - Kimi / 月之暗面：https://api.moonshot.cn/anthropic（官方 platform.moonshot.cn/docs/guide/claude-code-kimi）
 *   - 硅基流动：https://api.siliconflow.cn（官方 docs.siliconflow.cn，注意不带 /v1）
 *   - 腾讯混元：https://api.hunyuan.cloud.tencent.com/anthropic（官方 cloud.tencent.com/doc 1729/127293）
 *   - 阿里百炼：https://dashscope.aliyuncs.com/apps/anthropic（官方 help.aliyun.com Claude Code 文档；旧 compatible-mode/v1 无 anthropic 端点）
 *   - MiniMax：https://api.minimaxi.com/anthropic（官方开发者文档）
 *   - 火山方舟 / 豆包：https://ark.cn-beijing.volces.com/api/coding（官方 volcengine.com 接入三方工具）
 * 命中官方 OpenAI 端点但未映射到的 → 原样返回 baseUrl（可能用户走的是中转站，直接拼 /v1/messages）
 */
function anthropicEndpointFor(baseUrl) {
  const u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) return u;
  // DeepSeek 官方：api.deepseek.com 或 api.deepseek.com/v1
  if (/^https?:\/\/(www\.)?api\.deepseek\.com(\/v1)?$/i.test(u)) return 'https://api.deepseek.com/anthropic';
  // 智谱：open.bigmodel.cn/api/paas/v4
  if (/^https?:\/\/open\.bigmodel\.cn(\/api\/paas\/v4)?$/i.test(u)) return 'https://open.bigmodel.cn/api/anthropic';
  // Kimi / 月之暗面：api.moonshot.cn 或 /v1
  if (/^https?:\/\/api\.moonshot\.cn(\/v1)?$/i.test(u)) return 'https://api.moonshot.cn/anthropic';
  // 硅基流动：api.siliconflow.cn 或 /v1（官方 base 不带 /v1）
  if (/^https?:\/\/api\.siliconflow\.cn(\/v1)?$/i.test(u)) return 'https://api.siliconflow.cn';
  // 腾讯混元：api.hunyuan.cloud.tencent.com 或 /v1
  if (/^https?:\/\/api\.hunyuan\.cloud\.tencent\.com(\/v1)?$/i.test(u)) return 'https://api.hunyuan.cloud.tencent.com/anthropic';
  // 阿里百炼：旧 OpenAI 兼容端点（compatible-mode/v1）→ 新 anthropic 端点；若无映射则提示
  if (/^https?:\/\/dashscope\.aliyuncs\.com\/compatible-mode\/v1$/i.test(u)) return 'https://dashscope.aliyuncs.com/apps/anthropic';
  // MiniMax：api.minimaxi.com 或 /v1
  if (/^https?:\/\/api\.minimaxi\.com(\/v1)?$/i.test(u)) return 'https://api.minimaxi.com/anthropic';
  // 火山方舟 / 豆包：ark.cn-beijing.volces.com/api/v3 → /api/coding
  if (/^https?:\/\/ark\.cn-beijing\.volces\.com\/api\/v3$/i.test(u)) return 'https://ark.cn-beijing.volces.com/api/coding';
  // 其它（中转站 / 自定义）原样
  return u;
}

function build404Hint(baseUrl) {
  const ep = anthropicEndpointFor(baseUrl);
  if (ep === 'NO_ANTHROPIC_ENDPOINT') {
    return '404：该服务商官方不提供 Anthropic Messages 兼容端点（只有 OpenAI 兼容 compatible-mode/v1）。\n'
      + '请把 API 协议切回 chat（OpenAI 兼容），或改用支持 Anthropic 格式的中转站。';
  }
  if (ep !== String(baseUrl || '').trim().replace(/\/+$/, '')) {
    return `404：看起来 baseUrl 是 ${baseUrl}（OpenAI 兼容地址）。该厂商的 Anthropic 兼容端点是 ${ep}，`
      + '狐狸 AI 已按官方文档自动映射，但仍 404 的话请检查 API Key、模型名，或确认该中转站是否真的支持 Anthropic 格式。';
  }
  return '404 找不到接口：检查 baseUrl 是否为 https://api.anthropic.com/v1（或厂商的 Anthropic 兼容端点，如 DeepSeek https://api.deepseek.com/anthropic、智谱 https://open.bigmodel.cn/api/anthropic、Kimi https://api.moonshot.cn/anthropic、混元 https://api.hunyuan.cloud.tencent.com/anthropic、火山 https://ark.cn-beijing.volces.com/api/coding 等）。';
}

// ─────────────────────────────────────────────────────────────
// 格式互译
// ─────────────────────────────────────────────────────────────

/** OpenAI tools → Anthropic tools */
function toAnthropicTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools
    .map((t) => (t.function ? t.function : t))
    .map((f) => ({
      name: f.name,
      description: f.description || '',
      input_schema: f.parameters || { type: 'object', properties: {} }
    }));
}

/** tool_choice 映射：OpenAI string/object → Anthropic object */
function toAnthropicToolChoice(toolChoice) {
  if (!toolChoice || toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'none') return { type: 'none' };
  if (toolChoice === 'any' || toolChoice === 'required') return { type: 'any' };
  if (typeof toolChoice === 'object' && toolChoice.type === 'function' && toolChoice.function) {
    return { type: 'tool', name: toolChoice.function.name };
  }
  if (typeof toolChoice === 'object' && toolChoice.type === 'tool' && toolChoice.name) {
    return { type: 'tool', name: toolChoice.name };
  }
  return { type: 'auto' };
}

/** 把 OpenAI image_url 块转成 Anthropic image 块；无法转换则降级为文本说明 */
function imagePartToAnthropic(part) {
  const raw = (part && part.image_url && (part.image_url.url || part.image_url)) || '';
  if (!raw) return null;
  const m = /^data:([^;]+);base64,(.+)$/.exec(raw);
  if (m) {
    return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  }
  // 远程 URL：Anthropic 需要 base64，这里降级成文字（fox-ai 本地附件通常是 data URI）
  return { type: 'text', text: '[图片附件：远程 URL，Claude 需 base64，已忽略] ' + raw };
}

/** 把一条 OpenAI 格式消息转成 Anthropic content blocks（user/assistant 用） */
function messageContentToAnthropic(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;
  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') blocks.push({ type: 'text', text: part.text || '' });
    else if (part.type === 'image_url') {
      const img = imagePartToAnthropic(part);
      if (img) blocks.push(img);
    } else if (part.type === 'input_image') {
      const img = imagePartToAnthropic({ type: 'image_url', image_url: { url: part.image_url || part.image || '' } });
      if (img) blocks.push(img);
    } else if (part.type === 'input_text') blocks.push({ type: 'text', text: part.text || '' });
  }
  if (!blocks.length) return '';
  if (blocks.length === 1 && blocks[0].type === 'text') return blocks[0].text;
  return blocks;
}

/**
 * OpenAI 格式 messages → Anthropic { system, messages }
 * 关键转换：
 *  - system 消息 → 顶层 system 字段
 *  - assistant.tool_calls → content 里的 tool_use 块
 *  - role:'tool' 消息 → 紧跟其后的 user 消息，content 为 tool_result 数组
 */
function toAnthropic(messages) {
  const systemParts = [];
  const out = [];
  let pendingToolResults = null; // 累积连续的 tool 消息

  const flushToolResults = () => {
    if (pendingToolResults && pendingToolResults.length) {
      out.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = null;
    }
  };

  for (const m of messages || []) {
    if (!m || !m.role) continue;
    if (m.role === 'system') {
      systemParts.push(typeof m.content === 'string' ? m.content : textOfContent(m.content));
      continue;
    }
    if (m.role === 'user') {
      flushToolResults();
      out.push({ role: 'user', content: messageContentToAnthropic(m.content) });
      continue;
    }
    if (m.role === 'assistant') {
      flushToolResults();
      const content = messageContentToAnthropic(m.content);
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content.slice() : [];
      const calls = m.tool_calls || (m.toolCalls || []);
      for (const tc of calls) {
        let input = {};
        const args = tc.function ? tc.function.arguments : tc.arguments;
        if (typeof args === 'string' && args.trim()) {
          try { input = JSON.parse(args); } catch (_) { input = { _raw: args }; }
        } else if (args && typeof args === 'object') {
          input = args;
        }
        blocks.push({ type: 'tool_use', id: tc.id || 'call_' + Math.random().toString(36).slice(2, 10), name: (tc.function && tc.function.name) || tc.name, input });
      }
      out.push({ role: 'assistant', content: blocks.length ? blocks : '' });
      continue;
    }
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id || m.toolCallId, content: typeof m.content === 'string' ? m.content : textOfContent(m.content) };
      if (!pendingToolResults) pendingToolResults = [];
      pendingToolResults.push(block);
      continue;
    }
  }
  flushToolResults();
  return { system: systemParts.join('\n\n'), messages: out };
}

/**
 * 给 system 注入 Anthropic 显式缓存断点（prompt caching 必需）。
 * 文档要求至少一个 cache_control 块才会缓存前缀；这里标在 system 末尾，
 * 使庞大的系统提示词被 KV 缓存命中（tools 紧随其后，非首句稳定的前缀不强制缓存）。
 */
function applyCacheControl(system) {
  if (!system) return undefined;
  const blocks = typeof system === 'string'
    ? [{ type: 'text', text: system }]
    : (Array.isArray(system) ? system.slice() : [{ type: 'text', text: String(system) }]);
  const last = blocks[blocks.length - 1];
  if (last && typeof last === 'object') last.cache_control = { type: 'ephemeral' };
  return blocks;
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c && (c.type === 'text' || c.type === 'input_text' || c.type === 'output_text')).map((c) => c.text || '').join('\n');
  }
  return '';
}

/** Anthropic 响应 → OpenAI 风格 { content, reasoning, toolCalls, finishReason } */
function fromAnthropic(data) {
  const content = (data && data.content) || [];
  let text = '';
  let reasoning = '';
  const toolCalls = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') text += block.text || '';
    else if (block.type === 'thinking') reasoning += block.thinking || '';
    else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input || {}) });
    }
  }
  let finishReason = 'stop';
  const sr = data && data.stop_reason;
  if (sr === 'tool_use') finishReason = 'tool_calls';
  else if (sr === 'max_tokens') finishReason = 'length';
  else if (sr === 'end_turn' || sr === 'stop_sequence') finishReason = 'stop';
  return { content: text, reasoning, toolCalls, finishReason };
}

// ─────────────────────────────────────────────────────────────
// 流式（Anthropic SSE：event: + data: 行）
// ─────────────────────────────────────────────────────────────

function streamChat(options) {
  const {
    baseUrl,
    apiKey,
    model,
    messages,
    tools,
    toolChoice,
    temperature = 0.3,
    maxTokens = 4096,
    timeout = 120000,
    insecureHTTPParser = false,
    extraBody,
    stopMarker
  } = options;

  const onStart = guard(options.onStart, 'onStart');
  const onDelta = guard(options.onDelta, 'onDelta');
  const onReasoning = guard(options.onReasoning, 'onReasoning');
  const onToolCallStart = guard(options.onToolCallStart, 'onToolCallStart');
  const onDone = guard(options.onDone, 'onDone');
  const onError = guard(options.onError, 'onError');
  const onUsage = guard(options.onUsage, 'onUsage');
  // 原生联网（Claude web_search_20250305 server tool）结果含真实 URL：透传给前端 harvest，补全引用角标链接
  const onSearchResults = guard(options.onSearchResults, 'onSearchResults');
  const collectedSources = [];

  const handle = { aborted: false, abort() { this.aborted = true; try { req && req.destroy(); } catch (_) {} } };
  let req;

  let url;
  // 厂商 Anthropic 兼容端点自动映射（DeepSeek / 智谱按官方文档；通义无端点给明确报错）
  const anthUrl = anthropicEndpointFor(baseUrl);
  if (anthUrl === 'NO_ANTHROPIC_ENDPOINT') {
    setImmediate(() => onError && onError(new Error(
      '该服务商（通义千问/百炼）官方不提供 Anthropic Messages 兼容端点（只有 OpenAI 兼容 compatible-mode/v1）。\n'
      + '请把 API 协议切回 chat（OpenAI 兼容），或改用支持 Anthropic 格式的中转站。'
    )));
    return handle;
  }
  try {
    url = new URL(anthUrl + '/v1/messages');
  } catch (e) {
    setImmediate(() => onError && onError(new Error('接口地址不合法：' + baseUrl + '\n自定义 Anthropic 兼容服务需要在设置里填 baseUrl（如 https://api.deepseek.com/anthropic 或中转站地址）。')));
    return handle;
  }

  const { system, messages: antMessages } = toAnthropic(messages);
  const body = { model, max_tokens: maxTokens > 0 ? maxTokens : 4096, stream: true, messages: antMessages };
  if (system) body.system = applyCacheControl(system);
  if (temperature != null) body.temperature = temperature;
  const antTools = toAnthropicTools(tools);
  if (antTools) {
    body.tools = antTools;
    body.tool_choice = toAnthropicToolChoice(toolChoice);
  }
  // Claude 原生联网（server tool web_search_20250305，服务端自动执行）：注入后 Claude 自动联网，
  // 结果在 web_search_tool_result block + 文本 citations 里（dispatchEvent 解析）。
  if (options.nativeSearchProvider === 'claude') {
    if (!body.tools) body.tools = [];
    body.tools.push({ type: 'web_search_20250305', name: 'web_search_20250305', max_uses: 5 });
    body.tool_choice = { type: 'auto' };
    console.log('[fox-ai anthropic] native web search server tool injected');
  }
  // 深度思考等额外字段（thinking 块等）
  Object.assign(body, extraBody || {});
  if (body.thinking && body.thinking.type === 'enabled') {
    // Anthropic 硬性约束：开启思考时 temperature 只能是 1，且 max_tokens 必须大于思考预算
    body.temperature = 1;
    const need = (body.thinking.budget_tokens || 0) + 1024;
    if (!(body.max_tokens > need)) body.max_tokens = need;
  }

  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const headers = buildHeaders(apiKey, { Accept: 'text/event-stream', 'Accept-Encoding': 'gzip, deflate, br' });
  headers['Content-Length'] = payload.length;

  let finished = false;
  let content = '';
  let reasoning = '';
  let finishReason = 'stop';
  const toolAcc = [];
  let curTool = null; // 正在累积 input_json 的工具
  let lastUsage = null; // 整条流只取最后一次 usage（message_delta 每条都是累计值，逐条触发会重复累加）

  const finish = (err) => {
    if (finished) return;
    finished = true;
    if (err && !handle.aborted) { onError && onError(err); return; }
    // 原生联网：去重后把引用 URL 透传给前端 harvest，补全 [^n] 角标链接
    if (collectedSources.length && onSearchResults) {
      const seen = new Set();
      const dedup = [];
      for (const s of collectedSources) { if (s.url && !seen.has(s.url)) { seen.add(s.url); dedup.push(s); } }
      const txt = nativeSearch.sourcesToText(dedup);
      if (txt) onSearchResults(txt);
    }
    // 统一收尾：整条流只触发一次 usage（最后一次累计值），避免多个 message_delta 重复累加
    if (lastUsage && onUsage) { try { onUsage && onUsage(lastUsage); } catch (_) {} }
    onDone && onDone({
      content,
      reasoning,
      toolCalls: toolAcc.filter(Boolean),
      finishReason,
      aborted: handle.aborted,
      empty: !content && !reasoning && !toolAcc.length && !handle.aborted
    });
  };

  req = pickAgent(url).request(url, { method: 'POST', headers, timeout, insecureHTTPParser }, (res) => {
    if (res.statusCode >= 400) {
      const bs = wrapDecompress(res);
      const chunks = [];
      bs.on('data', (c) => chunks.push(c));
      bs.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const err = new Error(explainHttpError(res.statusCode, text, baseUrl));
        err.status = res.statusCode;
        finish(err);
      });
      return;
    }
    const stream = wrapDecompress(res);
    let buf = '';
    let curEvent = null;
    let curData = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line === '') {
          // 空行：一个事件结束，分发
          dispatchEvent(curEvent, curData);
          curEvent = null;
          curData = '';
          continue;
        }
        if (line.startsWith('event:')) curEvent = line.slice(6).trim();
        else if (line.startsWith('data:')) curData += line.slice(5).trim();
      }
    });
    stream.on('end', () => {
      if (curEvent !== null) dispatchEvent(curEvent, curData);
      finish();
    });
    stream.on('error', (e) => finish(normalizeError(e, url.href)));

    function dispatchEvent(event, dataStr) {
      if (!event || handle.aborted) return;
      let data;
      try { data = JSON.parse(dataStr); } catch (_) { return; }
      // Claude 原生联网：每事件尝试解析 web_search_tool_result block + 文本 citations，收集真实 URL
      if (nativeSearch && options.nativeSearchProvider === 'claude') {
        const found = nativeSearch.harvestClaudeSources(data);
        for (const s of found) collectedSources.push(s);
      }
      if (event === 'message_start') {
        onStart && onStart();
        // message_start 也携带初始 usage（message.usage：input_tokens / cache_creation 等）。
        // 部分端点只在 start 报 usage，后续 message_delta 可能不带——把 start 的 usage 也作为
        // lastUsage 起始值，确保这类请求也能统计到（1.1.15 修复：单请求只累计最后一次）。
        if (data && data.message && data.message.usage) { try { lastUsage = data.message.usage; } catch (_) {} }
      } else if (event === 'content_block_start') {
        const d = data.delta || {};
        if (d.type === 'tool_use') {
          curTool = { id: d.id, name: d.name, input: '' };
          onToolCallStart && onToolCallStart(d.name);
        }
      } else if (event === 'content_block_delta') {
        const d = data.delta || {};
        if (d.type === 'text_delta') {
          content += d.text || '';
          onDelta && onDelta(d.text || '');
        } else if (d.type === 'thinking_delta') {
          reasoning += d.thinking || '';
          onReasoning && onReasoning(d.thinking || '');
        } else if (d.type === 'input_json_delta') {
          if (curTool) curTool.input += d.partial_json || '';
        }
      } else if (event === 'content_block_stop') {
        if (curTool) {
          let args = '{}';
          try { JSON.parse(curTool.input); args = curTool.input; } catch (_) { args = JSON.stringify({ _raw: curTool.input }); }
          toolAcc.push({ id: curTool.id, name: curTool.name, arguments: args });
          curTool = null;
        }
      } else if (event === 'message_delta') {
        const sr = data.delta && data.delta.stop_reason;
        if (sr === 'tool_use') finishReason = 'tool_calls';
        else if (sr === 'max_tokens') finishReason = 'length';
        else if (sr === 'end_turn' || sr === 'stop_sequence') finishReason = 'stop';
        // 只记最后一条 usage：message_delta 每条 usage 都是「截至当前」的累计值（cached 全量、input 增量），
        // 逐条触发 onUsage → 会话累计把同一批 cached 重复加 → 累计命中率 >100%（1.1.15 修复）。
        if (data.usage) { try { lastUsage = data.usage; } catch (_) {} }
      } else if (event === 'error') {
        const err = new Error((data.error && (data.error.message || data.error.type)) || 'Anthropic stream error');
        err.status = data.error && data.error.status;
        finish(err);
      }
      // message_stop 由 stream 'end' 统一收尾
    }
  });

  req.on('error', (e) => finish(normalizeError(e, url.href)));
  req.end(payload);
  return handle;
}

/** 非流式 JSON POST，使用 Anthropic 专属认证头（x-api-key + anthropic-version）。
 * 注意：不能复用 client.js 的 requestJson——它只加 OpenAI 的 `Authorization: Bearer`，
 * 会让 Claude 的非流式 / 兜底请求认证失败（401）。 */
function postJson(urlString, { method = 'POST', apiKey, body, timeout = 120000, insecureHTTPParser = false, _redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (_redirects > 5) {
      reject(new Error('重定向次数过多：' + urlString));
      return;
    }
    let url;
    try {
      url = new URL(urlString);
    } catch (e) {
      reject(new Error('接口地址不合法：' + urlString));
      return;
    }
    const payload = body != null ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = buildHeaders(apiKey, { Accept: 'application/json' });
    if (payload) headers['Content-Length'] = payload.length;
    const req = pickAgent(url).request(url, { method, headers, timeout, insecureHTTPParser }, (res) => {
      const loc = res.headers.location;
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && loc) {
        let next;
        try {
          next = new URL(loc, urlString).href;
        } catch (_) {
          reject(new Error('重定向地址不合法：' + loc));
          return;
        }
        postJson(next, { method, apiKey, body, timeout, insecureHTTPParser, _redirects: _redirects + 1 }).then(resolve, reject);
        return;
      }
      const bs = wrapDecompress(res);
      const chunks = [];
      bs.on('data', (c) => chunks.push(c));
      bs.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          reject(new Error(explainHttpError(res.statusCode, text, urlString)));
          return;
        }
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch (e) {
          reject(new Error('返回内容不是 JSON：' + text.slice(0, 300)));
        }
      });
      bs.on('error', (e) => reject(normalizeError(e, urlString)));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => reject(normalizeError(e, urlString)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function chatNonStream(options) {
  const {
    baseUrl,
    apiKey,
    model,
    messages,
    tools,
    toolChoice,
    temperature = 0.3,
    maxTokens = 4096,
    timeout = 120000,
    insecureHTTPParser = false,
    extraBody,
    onUsage
  } = options;

  const { system, messages: antMessages } = toAnthropic(messages);
  const body = { model, max_tokens: maxTokens > 0 ? maxTokens : 4096, stream: false, messages: antMessages };
  if (system) body.system = applyCacheControl(system);
  if (temperature != null) body.temperature = temperature;
  const antTools = toAnthropicTools(tools);
  if (antTools) {
    body.tools = antTools;
    body.tool_choice = toAnthropicToolChoice(toolChoice);
  }
  // Claude 原生联网（server tool web_search_20250305）：非流式同样注入
  if (options.nativeSearchProvider === 'claude') {
    if (!body.tools) body.tools = [];
    body.tools.push({ type: 'web_search_20250305', name: 'web_search_20250305', max_uses: 5 });
    body.tool_choice = { type: 'auto' };
  }
  Object.assign(body, extraBody || {});
  if (body.thinking && body.thinking.type === 'enabled') {
    body.temperature = 1;
    const need = (body.thinking.budget_tokens || 0) + 1024;
    if (!(body.max_tokens > need)) body.max_tokens = need;
  }

  const anthUrl = anthropicEndpointFor(baseUrl);
  if (anthUrl === 'NO_ANTHROPIC_ENDPOINT') {
    throw new Error('该服务商（通义千问/百炼）官方不提供 Anthropic Messages 兼容端点（只有 OpenAI 兼容 compatible-mode/v1）。\n请把 API 协议切回 chat（OpenAI 兼容），或改用支持 Anthropic 格式的中转站。');
  }
  const data = await postJson(anthUrl + '/v1/messages', {
    method: 'POST',
    apiKey,
    timeout: Math.max(timeout || 0, 90000),
    insecureHTTPParser,
    body
  });
  if (data && data.error) {
    console.log('[fox-ai anthropic] non-stream error:', JSON.stringify(data.error).slice(0, 400));
    throw new Error((data.error.message || data.error.type || JSON.stringify(data.error)));
  }
  if (data && data.usage) { try { onUsage && onUsage(data.usage); } catch (_) {} }
  const r = fromAnthropic(data);
  // 原生联网：从响应里解析 web_search_tool_result + citations，去重后透传前端 harvest
  if (options.onSearchResults && nativeSearch && options.nativeSearchProvider === 'claude') {
    const found = nativeSearch.harvestClaudeSources(data);
    if (found.length) {
      const seen = new Set();
      const dedup = [];
      for (const s of found) { if (s.url && !seen.has(s.url)) { seen.add(s.url); dedup.push(s); } }
      const txt = nativeSearch.sourcesToText(dedup);
      if (txt) options.onSearchResults(txt);
    }
  }
  return Object.assign(r, { aborted: false, empty: !r.content && !r.reasoning && !r.toolCalls.length });
}

function chatOnce(options) {
  let handle;
  const promise = new Promise((resolve, reject) => {
    handle = streamChat(Object.assign({}, options, {
      onDone: (result) => resolve(result),
      onError: (err) => reject(err)
    }));
  });
  return { promise, handle };
}

module.exports = { streamChat, chatNonStream, chatOnce, toAnthropic, fromAnthropic, anthropicEndpointFor, explainHttpError };
