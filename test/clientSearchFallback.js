'use strict';

/**
 * 离线单测：DeepSeek Responses 官方联网不返回 URL 时的 fallback 链接生成。
 *
 * 运行：node test/clientSearchFallback.js
 */

const assert = require('assert');
const client = require('../src/client');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); }
}

(function () {
  console.log('clientSearchFallback 单测：\n');

  console.log('1) parseInlineSourceLabels');
  check('解析单个中文来源标签', () => {
    const out = client.parseInlineSourceLabels('结论（来源：IT之家）');
    assert.deepStrictEqual(out, ['IT之家']);
  });
  check('解析合并列表并拆分', () => {
    const out = client.parseInlineSourceLabels('结果（来源：web_search 结果——A、B、C）');
    assert.deepStrictEqual(out, ['A', 'B', 'C']);
  });
  check('过滤 web_search 工具名本身', () => {
    const out = client.parseInlineSourceLabels('结果（来源：web_search）');
    assert.deepStrictEqual(out, []);
  });
  check('过滤带空格的 web search 结果 工具名', () => {
    const out = client.parseInlineSourceLabels('结果（来源：web search 结果）');
    assert.deepStrictEqual(out, []);
  });
  check('过滤 web_search 结果 组合工具名', () => {
    const out = client.parseInlineSourceLabels('结果（来源：web_search 结果）');
    assert.deepStrictEqual(out, []);
  });
  check('过滤本地知识库标签', () => {
    const out = client.parseInlineSourceLabels('结果（来源：知识库《大纲.md》）');
    assert.deepStrictEqual(out, []);
  });
  check('拆分 / 分隔的多个来源', () => {
    const out = client.parseInlineSourceLabels('资料（来源：bilibili WIKI / 百度百科 / 萌娘百科）');
    assert.deepStrictEqual(out, ['bilibili WIKI', '百度百科', '萌娘百科']);
  });
  check('仍过滤文件路径形式的标签', () => {
    const out = client.parseInlineSourceLabels('资料（来源：folder/file.md）');
    assert.deepStrictEqual(out, []);
  });

  console.log('\n2) fallbackUrlForSource');
  check('有组合 query 时优先组合词搜索', () => {
    const combined = '今天的热点新闻 光明网 2026-08-12';
    const url = client.fallbackUrlForSource('光明网 2026-08-12', combined);
    assert.ok(url.includes('bing.com'), '默认走 Bing');
    assert.ok(url.includes(encodeURIComponent('今天的热点新闻')), '包含原始 query');
    assert.ok(url.includes(encodeURIComponent('光明网')), '包含 label');
    assert.ok(url.includes('site%3Agmw.cn'), '光明网走 site 精确');
  });
  check('无 query 时单独用 label', () => {
    const url = client.fallbackUrlForSource('光明网 2026-08-12', '');
    assert.ok(!url.includes(encodeURIComponent('今天的热点新闻')), '不含 query');
    assert.ok(url.includes('site%3Agmw.cn'), '仍走 site 精确');
  });
  check('IT之家 走 site:ithome.com', () => {
    const url = client.fallbackUrlForSource('IT之家', '今日新闻');
    assert.ok(url.includes('site%3Aithome.com'));
  });
  check('bilibili WIKI 走 bilibili 搜索', () => {
    const url = client.fallbackUrlForSource('bilibili WIKI', '原神 奥黛塔');
    assert.ok(url.includes('search.bilibili.com'));
    assert.ok(url.includes(encodeURIComponent('原神 奥黛塔')));
  });
  check('百度百科 走百度搜索', () => {
    const url = client.fallbackUrlForSource('百度百科', '原神 奥黛塔');
    assert.ok(url.includes('baidu.com'));
    assert.ok(url.includes(encodeURIComponent('原神 奥黛塔')));
  });
  check('萌娘百科 走萌娘搜索', () => {
    const url = client.fallbackUrlForSource('萌娘百科', '原神 奥黛塔');
    assert.ok(url.includes('moegirl.org.cn'));
    assert.ok(url.includes(encodeURIComponent('原神 奥黛塔')));
  });
  check('未知来源默认 Bing 搜组合词', () => {
    const url = client.fallbackUrlForSource('某某博客', 'foo bar');
    assert.ok(url.startsWith('https://www.bing.com/search?q='));
  });

  console.log('\n3) buildInlineSourcesText');
  check('组合 query 与 label 生成 URL', () => {
    const txt = client.buildInlineSourcesText('结论（来源：光明网 2026-08-12）', ['今天的热点新闻']);
    assert.ok(txt.includes('[1] 光明网 2026-08-12'));
    assert.ok(txt.includes('URL: https://www.bing.com/search?q='));
    assert.ok(txt.includes(encodeURIComponent('今天的热点新闻')));
    assert.ok(txt.includes(encodeURIComponent('光明网 2026-08-12')));
  });
  check('web_search 合并列表拆分为多个标签', () => {
    const txt = client.buildInlineSourcesText('结果（来源：web_search 结果——A、B）', ['q']);
    const lines = txt.split('\n\n');
    assert.strictEqual(lines.length, 2);
    assert.ok(lines[0].includes('[1] A'));
    assert.ok(lines[1].includes('[2] B'));
  });
  check('无有效标签返回空串', () => {
    assert.strictEqual(client.buildInlineSourcesText('没有来源', ['q']), '');
  });

  console.log('\n4) toResponsesTools 透传原生搜索工具');
  check('保留 web_search 类型', () => {
    const out = client.toResponsesTools([{ type: 'web_search' }]);
    assert.deepStrictEqual(out, [{ type: 'web_search' }]);
  });
  check('保留 web_search_2025_08_26 类型', () => {
    const out = client.toResponsesTools([{ type: 'web_search_2025_08_26' }]);
    assert.deepStrictEqual(out, [{ type: 'web_search_2025_08_26' }]);
  });

  console.log('\n─────────────────────────────────');
  console.log('pass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})();
