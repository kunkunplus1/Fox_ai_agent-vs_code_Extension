'use strict';

/**
 * 多厂商原生联网（服务端执行）深度适配 —— 纯函数模块。
 *
 * 不依赖 vscode / 网络，可在 node 下离线单测。所有「能力判定」与「引用收割」都集中在此，
 * 后端（client.js / anthropic.js / tools/index.js / agent.js）只负责调用，不散落各家 if。
 *
 * 覆盖厂商与形态（2026-08 调研结论）：
 *  - Responses 原生 web_search（OpenAI / DeepSeek / 通义百炼 responses）：注入 {type:'web_search'}，
 *    结果在 web_search_call 事件 / output[]（streamResponses 已收割）。
 *  - Chat 标记式（通义百炼 chat）：enable_search:true + search_options.enable_source:true，
 *    结果在 chunk 顶层 search_info.search_results（chat 流由 client.js 收割）。
 *  - Chat 工具式（智谱 GLM / Kimi Moonshot chat）：注入原生 web_search / $web_search 工具，
 *    结果在工具消息 search_results[]（chat 流由 client.js 递归扫描收割）。
 *  - Anthropic Claude（独立 Messages 协议）：注入 server tool web_search_20250305，
 *    结果在 web_search_tool_result block + 文本 citations[]（anthropic.js 解析）。
 */

// ─────────────────────────────────────────────────────────────
// 能力判定
// ─────────────────────────────────────────────────────────────

function normProvider(cfg) {
  if (!cfg) return { provider: '', apiMode: 'chat' };
  const provider = String(cfg.provider || cfg.providerId || '').toLowerCase();
  const apiMode = String(cfg.apiMode || 'chat').toLowerCase();
  return { provider, apiMode };
}

// Responses 原生 web_search 支持的厂商（apiMode==='responses'）
const RESPONSES_PROVIDERS = ['openai', 'deepseek', 'dashscope'];
// Chat 标记式联网（enable_search）
const CHAT_FLAG_PROVIDERS = ['dashscope'];
// Chat 工具式原生联网（注入原生 web_search / $web_search 工具）
const CHAT_TOOL_PROVIDERS = ['zhipu', 'moonshot'];
// Anthropic 独立 Messages 协议原生联网
const ANTHROPIC_PROVIDERS = ['claude'];

function isResponsesNativeSearch(cfg) {
  const { provider, apiMode } = normProvider(cfg);
  return apiMode === 'responses' && RESPONSES_PROVIDERS.includes(provider);
}

function isChatNativeFlagSearch(cfg) {
  const { provider, apiMode } = normProvider(cfg);
  return apiMode === 'chat' && CHAT_FLAG_PROVIDERS.includes(provider);
}

function isChatNativeToolSearch(cfg) {
  const { provider, apiMode } = normProvider(cfg);
  return apiMode === 'chat' && CHAT_TOOL_PROVIDERS.includes(provider);
}

function isChatNativeSearch(cfg) {
  return isChatNativeFlagSearch(cfg) || isChatNativeToolSearch(cfg);
}

function isAnthropicNativeSearch(cfg) {
  const { provider } = normProvider(cfg);
  return ANTHROPIC_PROVIDERS.includes(provider);
}

/** 顶层家族：'responses' | 'chat' | 'claude' | null */
function nativeSearchProvider(cfg) {
  if (isResponsesNativeSearch(cfg)) return 'responses';
  if (isChatNativeSearch(cfg)) return 'chat';
  if (isAnthropicNativeSearch(cfg)) return 'claude';
  return null;
}

/** 原生 web_search 工具（仅 Chat 工具式厂商需要；其余走标记/Responses/Claude server tool，返回 null） */
function nativeSearchTool(cfg) {
  const { provider } = normProvider(cfg);
  if (isChatNativeToolSearch(cfg)) {
    if (provider === 'zhipu') return { type: 'web_search', web_search: { search_result: true } };
    if (provider === 'moonshot') return { type: 'builtin_function', function: { name: '$web_search' } };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 引用收割（各厂商 → 统一 [{title, url}]）
// ─────────────────────────────────────────────────────────────

function _pushUrl(list, title, url) {
  const u = String(url || '').trim();
  if (/^https?:\/\//i.test(u)) {
    list.push({ title: String(title || '').trim(), url: u });
  }
  return list;
}

/** 通义百炼 enable_search 的 search_info.search_results（也可能直接给 search_results 数组） */
function harvestSearchInfo(obj) {
  const out = [];
  if (!obj || typeof obj !== 'object') return out;
  let arr = null;
  if (Array.isArray(obj.search_results)) arr = obj.search_results;
  else if (Array.isArray(obj.searchResults)) arr = obj.searchResults;
  else if (Array.isArray(obj.results)) arr = obj.results;
  else if (obj.search_info && Array.isArray(obj.search_info.search_results)) arr = obj.search_info.search_results;
  else if (obj.search_info && Array.isArray(obj.search_info.searchResults)) arr = obj.search_info.searchResults;
  if (!arr) return out;
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const url = r.url || r.link || r.href || r.source_url || r.web_url;
    const title = r.title || r.name || r.snippet || r.headline || '';
    _pushUrl(out, title, url);
  }
  return out;
}

/** 智谱 GLM / Kimi Moonshot 工具消息 search_results[]（字段兼容 link/url/href） */
function harvestGlmKimi(obj) {
  const out = [];
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj.search_results)) {
    for (const r of obj.search_results) {
      if (!r || typeof r !== 'object') continue;
      const url = r.link || r.url || r.href || r.web_url || r.source_url;
      const title = r.title || r.name || r.snippet || r.content || '';
      _pushUrl(out, title, url);
    }
  }
  return out;
}

/** 递归扫描任意 chunk，找出嵌套的 search_results / searchResults 数组（best-effort，只收 http(s)） */
function collectSearchResultsArrays(node, acc) {
  if (!node) return;
  if (typeof node === 'string') {
    // 工具消息 content 常为「嵌入 search_results 的 JSON 字符串」（智谱/Kimi 常见），尝试解析再下钻
    const s = node.trim();
    if (s.charAt(0) === '{' || s.charAt(0) === '[') {
      try { collectSearchResultsArrays(JSON.parse(s), acc); } catch (_) {}
    }
    return;
  }
  if (typeof node !== 'object') return; // number / boolean / null
  if (Array.isArray(node)) {
    // 整段是一个「每条都带 url/link/href」的对象数组？直接当结果处理
    const looksLikeResults =
      node.length > 0 &&
      node.every((x) => x && typeof x === 'object' && (x.url || x.link || x.href));
    if (looksLikeResults) {
      for (const x of node) harvestGlmKimi({ search_results: [x] }).forEach((s) => acc.push(s));
    }
    for (const x of node) collectSearchResultsArrays(x, acc);
    return;
  }
  for (const k of Object.keys(node)) {
    if (k === 'search_results' || k === 'searchResults') {
      if (Array.isArray(node[k])) {
        for (const r of node[k]) {
          if (r && typeof r === 'object') {
            const url = r.link || r.url || r.href || r.web_url || r.source_url;
            const title = r.title || r.name || r.snippet || r.content || '';
            _pushUrl(acc, title, url);
          }
        }
      }
    } else {
      collectSearchResultsArrays(node[k], acc);
    }
  }
}

/**
 * Chat 家族通用收割：给整个 chunk（含顶层 search_info 与嵌套 search_results），
 * 返回所有可识别的 {title, url}。仅收 http(s)，过度匹配风险极低。
 */
function harvestChatChunk(json) {
  const out = [];
  if (!json || typeof json !== 'object') return out;
  harvestSearchInfo(json).forEach((s) => out.push(s));
  collectSearchResultsArrays(json, out);
  return out;
}

/** Anthropic Claude：递归找 web_search_tool_result block 内容 + citations[] */
function harvestClaudeSources(obj) {
  const out = [];
  if (!obj || typeof obj !== 'object') return out;
  collectClaudeSources(obj, out);
  return out;
}

function collectClaudeSources(node, acc) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) collectClaudeSources(x, acc);
    return;
  }
  if (node.type === 'web_search_tool_result' && Array.isArray(node.content)) {
    for (const c of node.content) {
      if (c && c.type === 'web_search_result') _pushUrl(acc, c.title, c.url);
    }
  }
  if (Array.isArray(node.citations)) {
    for (const c of node.citations) {
      if (c && c.url) _pushUrl(acc, c.title, c.url);
    }
  }
  for (const k of Object.keys(node)) {
    // web_search_tool_result 的 content 已专门处理，避免重复下钻
    if (k === 'content' && node.type === 'web_search_tool_result') continue;
    collectClaudeSources(node[k], acc);
  }
}

// ─────────────────────────────────────────────────────────────
// 格式化 + 系统提示
// ─────────────────────────────────────────────────────────────

/** 把 [{title,url}] 拼成 harvest 期望的「[n] 标题 / URL: …」文本（去重） */
function sourcesToText(results) {
  if (!Array.isArray(results) || !results.length) return '';
  const seen = new Set();
  const lines = [];
  for (const r of results) {
    const url = String((r && r.url) || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    let title = String((r && r.title) || '').trim();
    if (!title) title = url.replace(/^https?:\/\//, '').split('/')[0] || url;
    const body = String((r && (r.content || r.snippet)) || '').trim();
    lines.push('[' + (lines.length + 1) + '] ' + title + '\nURL: ' + url + (body ? '\n' + body : ''));
  }
  return lines.join('\n\n');
}

function _hintHead(pname) {
  return (
    '\n【联网能力（重要）】当前为 ' +
    pname +
    ' 模式，你已具备服务端内置的官方联网搜索（由服务端自动执行，免费免 key）。当用户问到时效性、实时、最新资讯、排行、价格、当前事件、今天/本周/最新 等需要最新数据的问题时：\n' +
    '1) 你必须先通过联网搜索获取真实最新信息，再据此回答；\n' +
    '2) 严禁用 fetch / 浏览器 / 其他 MCP 去抓取实时数据——这些拿不到实时结果，只会得到过期或错误内容；\n' +
    '3) 不要以“我没有实时信息”为由拒绝回答，联网搜索会被自动执行，你只需在回答里引用搜索到的内容。\n' +
    '4) 【准确性要求】你必须严格基于联网搜索返回的真实结果来回答，禁止编造、臆测或把不相关的内容套到问题上；如果搜索结果里没有明确给出答案，就如实说明“搜索结果未直接提及”，并给出已检索到的相关线索，不要硬凑一个似是而非的答案。\n' +
    '5) 【不要自己拼 URL】不要尝试用 open_page / fetch / 构造链接去“验证”搜索结果；官方联网搜索已经把可信结果返回给你，直接基于它回答即可。'
  );
}

/** 按 provider/apiMode 生成「原生联网能力」系统提示段（无能力则返回 ''） */
function nativeSearchSystemHint(cfg) {
  const { provider, apiMode } = normProvider(cfg);
  if (isAnthropicNativeSearch(cfg)) {
    return _hintHead('Claude（Anthropic Messages）');
  }
  if (isResponsesNativeSearch(cfg)) {
    const pname = provider === 'openai' ? 'OpenAI' : provider === 'dashscope' ? '通义百炼' : 'DeepSeek';
    return _hintHead(pname + ' Responses API');
  }
  if (isChatNativeSearch(cfg)) {
    const pname = provider === 'dashscope' ? '通义百炼' : provider === 'zhipu' ? '智谱 GLM' : 'Kimi（Moonshot）';
    return _hintHead(pname + ' Chat');
  }
  return '';
}

module.exports = {
  isResponsesNativeSearch,
  isChatNativeFlagSearch,
  isChatNativeToolSearch,
  isChatNativeSearch,
  isAnthropicNativeSearch,
  nativeSearchProvider,
  nativeSearchTool,
  harvestSearchInfo,
  harvestGlmKimi,
  collectSearchResultsArrays,
  harvestChatChunk,
  harvestClaudeSources,
  sourcesToText,
  nativeSearchSystemHint
};
