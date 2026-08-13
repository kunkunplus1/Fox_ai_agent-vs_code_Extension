'use strict';

/**
 * 离线单测：多厂商原生联网（服务端执行）深度适配 —— 纯函数模块 src/nativeSearch.js。
 *
 * 不发起任何外网请求，仅验证：
 *   - 各厂商「能力判定」(Responses / Chat 标记式 / Chat 工具式 / Claude)
 *   - nativeSearchProvider / nativeSearchTool 路由
 *   - 各厂商「引用收割」（通义 search_info / 智谱·Kimi search_results / Claude web_search_tool_result+citations）
 *   - 统一格式化 sourcesToText（去重）
 *   - 系统提示段 nativeSearchSystemHint（有能力的厂商返回非空）
 *
 * 运行：node test/nativeSearch.js
 */

const assert = require('assert');
const ns = require('../src/nativeSearch');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); }
}

(function () {
  console.log('nativeSearch 多厂商原生联网适配单测：\n');

  // ─────────────────────────────────────────────
  // 1) 能力判定
  // ─────────────────────────────────────────────
  console.log('1) 能力判定');

  check('isResponsesNativeSearch: openai+responses → true', () => {
    assert.strictEqual(ns.isResponsesNativeSearch({ provider: 'openai', apiMode: 'responses' }), true);
  });
  check('isResponsesNativeSearch: dashscope+responses → true', () => {
    assert.strictEqual(ns.isResponsesNativeSearch({ provider: 'dashscope', apiMode: 'responses' }), true);
  });
  check('isResponsesNativeSearch: deepseek+responses → true', () => {
    assert.strictEqual(ns.isResponsesNativeSearch({ provider: 'deepseek', apiMode: 'responses' }), true);
  });
  check('isResponsesNativeSearch: openai+chat → false', () => {
    assert.strictEqual(ns.isResponsesNativeSearch({ provider: 'openai', apiMode: 'chat' }), false);
  });
  check('isResponsesNativeSearch: 未知厂商+responses → false', () => {
    assert.strictEqual(ns.isResponsesNativeSearch({ provider: 'foo', apiMode: 'responses' }), false);
  });

  check('isChatNativeFlagSearch: dashscope+chat → true', () => {
    assert.strictEqual(ns.isChatNativeFlagSearch({ provider: 'dashscope', apiMode: 'chat' }), true);
  });
  check('isChatNativeFlagSearch: dashscope+responses → false', () => {
    assert.strictEqual(ns.isChatNativeFlagSearch({ provider: 'dashscope', apiMode: 'responses' }), false);
  });
  check('isChatNativeFlagSearch: zhipu+chat → false（走工具式）', () => {
    assert.strictEqual(ns.isChatNativeFlagSearch({ provider: 'zhipu', apiMode: 'chat' }), false);
  });

  check('isChatNativeToolSearch: zhipu+chat → true', () => {
    assert.strictEqual(ns.isChatNativeToolSearch({ provider: 'zhipu', apiMode: 'chat' }), true);
  });
  check('isChatNativeToolSearch: moonshot+chat → true', () => {
    assert.strictEqual(ns.isChatNativeToolSearch({ provider: 'moonshot', apiMode: 'chat' }), true);
  });
  check('isChatNativeToolSearch: dashscope+chat → false', () => {
    assert.strictEqual(ns.isChatNativeToolSearch({ provider: 'dashscope', apiMode: 'chat' }), false);
  });

  check('isChatNativeSearch: dashscope/zhipu/moonshot + chat → true', () => {
    assert.strictEqual(ns.isChatNativeSearch({ provider: 'dashscope', apiMode: 'chat' }), true);
    assert.strictEqual(ns.isChatNativeSearch({ provider: 'zhipu', apiMode: 'chat' }), true);
    assert.strictEqual(ns.isChatNativeSearch({ provider: 'moonshot', apiMode: 'chat' }), true);
  });
  check('isChatNativeSearch: openai+chat → false', () => {
    assert.strictEqual(ns.isChatNativeSearch({ provider: 'openai', apiMode: 'chat' }), false);
  });

  check('isAnthropicNativeSearch: claude → true', () => {
    assert.strictEqual(ns.isAnthropicNativeSearch({ provider: 'claude' }), true);
  });
  check('isAnthropicNativeSearch: 非 claude → false', () => {
    assert.strictEqual(ns.isAnthropicNativeSearch({ provider: 'zhipu' }), false);
  });

  // ─────────────────────────────────────────────
  // 2) 顶层路由
  // ─────────────────────────────────────────────
  console.log('\n2) nativeSearchProvider / nativeSearchTool');

  check("nativeSearchProvider: openai+responses → 'responses'", () => {
    assert.strictEqual(ns.nativeSearchProvider({ provider: 'openai', apiMode: 'responses' }), 'responses');
  });
  check("nativeSearchProvider: dashscope+chat → 'chat'", () => {
    assert.strictEqual(ns.nativeSearchProvider({ provider: 'dashscope', apiMode: 'chat' }), 'chat');
  });
  check("nativeSearchProvider: zhipu+chat → 'chat'", () => {
    assert.strictEqual(ns.nativeSearchProvider({ provider: 'zhipu', apiMode: 'chat' }), 'chat');
  });
  check("nativeSearchProvider: claude → 'claude'", () => {
    assert.strictEqual(ns.nativeSearchProvider({ provider: 'claude' }), 'claude');
  });
  check('nativeSearchProvider: 无能力厂商 → null', () => {
    assert.strictEqual(ns.nativeSearchProvider({ provider: 'llamacpp' }), null);
    assert.strictEqual(ns.nativeSearchProvider({ provider: 'openai', apiMode: 'chat' }), null);
  });

  check('nativeSearchTool: zhipu → 原生 web_search', () => {
    assert.deepStrictEqual(ns.nativeSearchTool({ provider: 'zhipu', apiMode: 'chat' }), {
      type: 'web_search', web_search: { search_result: true }
    });
  });
  check('nativeSearchTool: moonshot → 原生 $web_search', () => {
    assert.deepStrictEqual(ns.nativeSearchTool({ provider: 'moonshot', apiMode: 'chat' }), {
      type: 'builtin_function', function: { name: '$web_search' }
    });
  });
  check('nativeSearchTool: dashscope/responses/claude → null', () => {
    assert.strictEqual(ns.nativeSearchTool({ provider: 'dashscope', apiMode: 'chat' }), null);
    assert.strictEqual(ns.nativeSearchTool({ provider: 'openai', apiMode: 'responses' }), null);
    assert.strictEqual(ns.nativeSearchTool({ provider: 'claude' }), null);
  });

  // ─────────────────────────────────────────────
  // 3) 引用收割
  // ─────────────────────────────────────────────
  console.log('\n3) 引用收割');

  check('harvestSearchInfo: search_info.search_results（通义 enable_search）', () => {
    const out = ns.harvestSearchInfo({
      search_info: { search_results: [{ title: 'T1', url: 'https://a.com' }, { title: 'T2', link: 'https://b.com' }] }
    });
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].url, 'https://a.com');
    assert.strictEqual(out[1].url, 'https://b.com');
  });
  check('harvestSearchInfo: 顶层 search_results / searchResults / results', () => {
    assert.strictEqual(ns.harvestSearchInfo({ search_results: [{ url: 'https://a.com' }] }).length, 1);
    assert.strictEqual(ns.harvestSearchInfo({ searchResults: [{ url: 'https://b.com' }] }).length, 1);
    assert.strictEqual(ns.harvestSearchInfo({ results: [{ url: 'https://c.com' }] }).length, 1);
  });
  check('harvestSearchInfo: 非 http(s) 被丢弃', () => {
    const out = ns.harvestSearchInfo({ search_results: [{ title: 'x', url: 'ftp://bad' }, { url: 'https://ok.com' }] });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].url, 'https://ok.com');
  });

  check('harvestGlmKimi: link/url/href 字段兼容', () => {
    assert.strictEqual(ns.harvestGlmKimi({ search_results: [{ link: 'https://a.com' }] }).length, 1);
    assert.strictEqual(ns.harvestGlmKimi({ search_results: [{ url: 'https://b.com' }] }).length, 1);
    assert.strictEqual(ns.harvestGlmKimi({ search_results: [{ href: 'https://c.com' }] }).length, 1);
  });
  check('harvestGlmKimi: 非对象条目被跳过', () => {
    const out = ns.harvestGlmKimi({ search_results: ['not-an-object', { url: 'https://a.com' }] });
    assert.strictEqual(out.length, 1);
  });

  check('collectSearchResultsArrays: 嵌套 search_results 递归下钻', () => {
    const acc = [];
    const node = { foo: { bar: { search_results: [{ title: 'N', url: 'https://nest.com' }] } } };
    ns.collectSearchResultsArrays(node, acc);
    assert.strictEqual(acc.length, 1);
    assert.strictEqual(acc[0].url, 'https://nest.com');
  });
  check('collectSearchResultsArrays: 工具消息内 JSON 字符串（智谱/Kimi 常见）', () => {
    const acc = [];
    const node = { content: JSON.stringify({ search_results: [{ title: 'S', url: 'https://str.com' }] }) };
    ns.collectSearchResultsArrays(node, acc);
    assert.strictEqual(acc.length, 1);
    assert.strictEqual(acc[0].url, 'https://str.com');
  });
  check('collectSearchResultsArrays: 整段为「带 url 的对象数组」直接当结果', () => {
    const acc = [];
    ns.collectSearchResultsArrays([{ title: 'A', url: 'https://a.com' }, { title: 'B', url: 'https://b.com' }], acc);
    assert.strictEqual(acc.length, 2);
  });

  check('harvestChatChunk: 顶层 search_info + 嵌套 search_results 合并', () => {
    const out = ns.harvestChatChunk({
      search_info: { search_results: [{ title: 'Top', url: 'https://top.com' }] },
      choices: [{ message: { content: '', search_results: [{ url: 'https://nested.com' }] } }]
    });
    const urls = out.map((x) => x.url);
    const uniq = [...new Set(urls)].sort();
    assert.deepStrictEqual(uniq, ['https://nested.com', 'https://top.com']);
    // 已知两条路径（harvestSearchInfo + 递归）会对 search_info.search_results 各收一次，
    // 重复在 sourcesToText 阶段再去重，此处仅验证两者都生效。
    assert.strictEqual(urls.length, 3);
  });

  check('harvestClaudeSources: web_search_tool_result block', () => {
    const out = ns.harvestClaudeSources({
      type: 'web_search_tool_result',
      content: [
        { type: 'web_search_result', title: 'C1', url: 'https://c1.com' },
        { type: 'web_search_result', title: 'C2', url: 'https://c2.com' }
      ]
    });
    const urls = out.map((x) => x.url).sort();
    assert.deepStrictEqual(urls, ['https://c1.com', 'https://c2.com']);
    assert.strictEqual(out.length, 2);
  });
  check('harvestClaudeSources: 文本 citations[]', () => {
    const out = ns.harvestClaudeSources({
      type: 'text',
      text: '据最新报道…',
      citations: [{ url: 'https://cite.com', title: 'Cite' }]
    });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].url, 'https://cite.com');
  });
  check('harvestClaudeSources: block + citations 合并', () => {
    const obj = {
      type: 'message',
      content: [
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'B', url: 'https://b.com' }] },
        { type: 'text', text: 'x', citations: [{ url: 'https://t.com' }] }
      ]
    };
    const out = ns.harvestClaudeSources(obj);
    const urls = out.map((x) => x.url).sort();
    assert.deepStrictEqual(urls, ['https://b.com', 'https://t.com']);
  });

  // ─────────────────────────────────────────────
  // 4) 格式化 + 系统提示
  // ─────────────────────────────────────────────
  console.log('\n4) sourcesToText / nativeSearchSystemHint');

  check('sourcesToText: 去重 + 标准格式 [n] 标题 / URL', () => {
    const txt = ns.sourcesToText([
      { title: 'A', url: 'https://a.com' },
      { title: 'A2', url: 'https://a.com' }, // 重复 url
      { title: 'B', url: 'https://b.com' }
    ]);
    const lines = txt.split('\n\n');
    assert.strictEqual(lines.length, 2);
    assert.ok(lines[0].startsWith('[1] A'));
    assert.ok(lines[0].includes('URL: https://a.com'));
    assert.ok(lines[1].startsWith('[2] B'));
    assert.ok(lines[1].includes('URL: https://b.com'));
  });
  check('sourcesToText: 非 http(s) 被过滤 / 空数组返回空串', () => {
    assert.strictEqual(ns.sourcesToText([]), '');
    assert.strictEqual(ns.sourcesToText([{ title: 'x', url: 'ftp://bad' }]), '');
  });
  check('sourcesToText: 缺标题回退域名', () => {
    const txt = ns.sourcesToText([{ url: 'https://example.com/p' }]);
    assert.ok(txt.includes('example.com'));
  });

  check('nativeSearchSystemHint: 有能力的厂商非空', () => {
    assert.ok(ns.nativeSearchSystemHint({ provider: 'openai', apiMode: 'responses' }).length > 0);
    assert.ok(ns.nativeSearchSystemHint({ provider: 'dashscope', apiMode: 'chat' }).length > 0);
    assert.ok(ns.nativeSearchSystemHint({ provider: 'zhipu', apiMode: 'chat' }).length > 0);
    assert.ok(ns.nativeSearchSystemHint({ provider: 'moonshot', apiMode: 'chat' }).length > 0);
    assert.ok(ns.nativeSearchSystemHint({ provider: 'claude' }).length > 0);
  });
  check('nativeSearchSystemHint: 无能力厂商返回空串', () => {
    assert.strictEqual(ns.nativeSearchSystemHint({ provider: 'llamacpp' }), '');
    assert.strictEqual(ns.nativeSearchSystemHint({ provider: 'openai', apiMode: 'chat' }), '');
  });
  check('nativeSearchSystemHint: provider 大小写不敏感', () => {
    assert.ok(ns.nativeSearchSystemHint({ provider: 'CLAUDE' }).length > 0);
    assert.ok(ns.nativeSearchSystemHint({ provider: 'DashScope', apiMode: 'Responses' }).length > 0);
  });

  // ─────────────────────────────────────────────
  console.log('\n结果：pass=' + pass + ' fail=' + fail);
  if (fail > 0) { process.exit(1); }
  console.log('✅ nativeSearch 单测全部通过');
})();
