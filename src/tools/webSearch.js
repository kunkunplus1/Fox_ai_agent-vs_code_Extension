'use strict';

const https = require('https');
const { URL, URLSearchParams } = require('url');
const { requestJson } = require('../client');

function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      u,
      {
        method: options.method || 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          ...(options.headers || {})
        },
        timeout: options.timeout || 25000
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return httpsRequest(res.headers.location, options).then(resolve).catch(reject);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body: buf.toString('utf8') });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('搜索请求超时')));
    if (options.body) req.write(options.body);
    req.end();
  });
}

function parseDuckDuckGoHtml(html) {
  const results = [];
  // DuckDuckGo HTML 版结果块
  const blockRe = /<div class="result results_links[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null && results.length < 5) {
    const block = m[0];
    const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    const hrefMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"/i);
    const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    const title = titleMatch ? stripHtml(titleMatch[1]) : '';
    const url = hrefMatch ? decodeEntities(hrefMatch[1]) : '';
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : '';
    if (title || snippet) {
      results.push({ title, url, snippet });
    }
  }
  if (!results.length) {
    // 备用：找任何结果链接
    const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = linkRe.exec(html)) !== null && results.length < 5) {
      results.push({ title: stripHtml(m[2]), url: decodeEntities(m[1]), snippet: '' });
    }
  }
  return results;
}

function stripHtml(raw) {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

async function searchDuckDuckGo(query) {
  const params = new URLSearchParams({ q: query, kl: 'us-en' });
  const url = 'https://html.duckduckgo.com/html/?' + params.toString();
  const { status, body } = await httpsRequest(url, { method: 'GET' });
  if (status !== 200) throw new Error(`DuckDuckGo 返回 ${status}`);
  const results = parseDuckDuckGoHtml(body);
  if (!results.length) {
    // 可能被要求验证或被拦截，给友好提示
    if (body.includes('cf-challenge') || body.includes('traffic')) {
      throw new Error('DuckDuckGo 触发了验证，建议配置 Tavily/Serper API Key 使用更稳定的搜索');
    }
    return '未找到搜索结果。';
  }
  return results.map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`).join('\n\n');
}

function parseBingHtml(html) {
  const results = [];
  // Bing 结果块
  const blockRe = /<li class="b_algo"[^>]*>[\s\S]*?<\/li>/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null && results.length < 5) {
    const block = m[0];
    const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i);
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const title = titleMatch ? stripHtml(titleMatch[2]) : '';
    const url = titleMatch ? decodeEntities(titleMatch[1]) : '';
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : '';
    if (title || snippet) results.push({ title, url, snippet });
  }
  return results;
}

async function searchBing(query) {
  const params = new URLSearchParams({ q: query, setmkt: 'zh-CN', setlang: 'zh' });
  const url = 'https://www.bing.com/search?' + params.toString();
  const { status, body } = await httpsRequest(url, { method: 'GET' });
  if (status !== 200) throw new Error(`Bing 返回 ${status}`);
  const results = parseBingHtml(body);
  if (!results.length) throw new Error('Bing 未返回有效结果');
  return results.map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`).join('\n\n');
}

async function searchBuiltin(query) {
  // "builtin" 不再指望模型自带搜索，而是插件自己搜
  const errors = [];
  try {
    return await searchDuckDuckGo(query);
  } catch (e) {
    errors.push('DuckDuckGo: ' + e.message);
  }
  try {
    return await searchBing(query);
  } catch (e) {
    errors.push('Bing: ' + e.message);
  }
  return `联网搜索失败：\n${errors.join('\n')}\n\n在中国大陆等网络环境下，DuckDuckGo/Bing 可能无法直接访问。如需稳定搜索，请在设置里把 foxAi.webSearch.provider 改成 tavily 或 serper，并填写对应 API Key；或确保 VS Code / 系统代理能访问上述站点。`;
}

async function searchTavily(query, apiKey) {
  if (!apiKey) throw new Error('未配置 Tavily API Key，请在 foxAi.webSearch.apiKey 中填写');
  const data = await requestJson('https://api.tavily.com/search', {
    method: 'POST',
    timeout: 20000,
    body: {
      api_key: apiKey,
      query,
      search_depth: 'basic',
      max_results: 5,
      include_answer: true
    }
  });
  const answer = data.answer ? `简要答案：${data.answer}\n\n` : '';
  const results = (data.results || []).map((r, i) =>
    `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content || r.snippet || ''}`
  ).join('\n\n');
  return answer + results || '未找到相关结果';
}

async function searchSerper(query, apiKey) {
  if (!apiKey) throw new Error('未配置 Serper API Key，请在 foxAi.webSearch.apiKey 中填写');
  const data = await requestJson('https://google.serper.dev/search', {
    method: 'POST',
    apiKey,
    timeout: 20000,
    body: { q: query, num: 5 }
  });
  const out = [];
  const organic = data.organic || [];
  for (let i = 0; i < organic.length; i++) {
    const r = organic[i];
    out.push(`[${i + 1}] ${r.title}\nURL: ${r.link}\n${r.snippet || ''}`);
  }
  if (data.answerBox) {
    out.unshift(`简要答案：${data.answerBox.title || ''}\n${data.answerBox.answer || data.answerBox.snippet || ''}`);
  }
  return out.join('\n\n') || '未找到相关结果';
}

async function webSearch(query, provider, apiKey) {
  switch (provider) {
    case 'tavily':
      return await searchTavily(query, apiKey);
    case 'serper':
      return await searchSerper(query, apiKey);
    case 'duckduckgo':
      return await searchDuckDuckGo(query);
    default:
      return await searchBuiltin(query);
  }
}

async function getCurrentTime(timezone) {
  const tz = timezone || 'Asia/Shanghai';
  const now = new Date();
  try {
    // 优先用本机系统时间（最可靠，不需要联网）
    const local = now.toLocaleString('zh-CN', { timeZone: tz, hour12: false });
    const date = now.toLocaleDateString('zh-CN', { timeZone: tz });
    const time = now.toLocaleTimeString('zh-CN', { timeZone: tz, hour12: false });
    const week = now.toLocaleDateString('zh-CN', { timeZone: tz, weekday: 'long' });
    return `时区：${tz}\n日期：${date}\n时间：${time}\n星期：${week}\n（来自本机系统时钟）`;
  } catch (e) {
    return `当前时间：${now.toLocaleString('zh-CN')}（时区：${tz}）`;
  }
}

module.exports = { webSearch, getCurrentTime };
