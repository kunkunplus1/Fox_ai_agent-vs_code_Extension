// 验证 DeepSeek Responses 官方联网兜底解析：
// 1) parseInlineSourceLabels 正确提取合并列表与单个标签；
// 2) looksLikeLocalSource 能识别本地知识库/文件型标签，防止它们被生成 Bing 搜索链接。
'use strict';
const assert = require('assert');
const {
  looksLikeLocalSource, parseInlineSourceLabels, buildInlineSourcesText
} = require('../src/client');

let pass = 0;
function check(name, cond) {
  assert.ok(cond, '❌ ' + name);
  console.log('✅ ' + name);
  pass++;
}

check('looksLikeLocalSource: 知识库《大纲.md》是本地来源', looksLikeLocalSource('知识库《大纲.md》'));
check('looksLikeLocalSource: 含 .md 是本地来源', looksLikeLocalSource('某文档.md'));
check('looksLikeLocalSource: 含路径分隔符是本地来源', looksLikeLocalSource('notes/某文档.md'));
check('looksLikeLocalSource: IT之家是联网来源', !looksLikeLocalSource('IT之家'));
check('looksLikeLocalSource: 百度百科是联网来源', !looksLikeLocalSource('百度百科'));
check('looksLikeLocalSource: web_search 结果是联网来源', !looksLikeLocalSource('web_search 结果'));

check('parseInlineSourceLabels: 合并列表', () => {
  const labels = parseInlineSourceLabels('（来源：web_search 结果——百度百科、萌娘百科）');
  assert.deepStrictEqual(labels, ['百度百科', '萌娘百科']);
});

check('parseInlineSourceLabels: 单个标签', () => {
  const labels = parseInlineSourceLabels('结论（来源：IT之家）');
  assert.deepStrictEqual(labels, ['IT之家']);
});

check('parseInlineSourceLabels: 本地知识库标签被过滤', () => {
  const labels = parseInlineSourceLabels('结论（来源：知识库《大纲 副本.md》）');
  assert.deepStrictEqual(labels, []);
});

check('parseInlineSourceLabels: 混合场景只留联网来源', () => {
  const labels = parseInlineSourceLabels('（来源：web_search 结果——IT之家、知识库《大纲.md》）');
  assert.deepStrictEqual(labels, ['IT之家']);
});

check('buildInlineSourcesText: 本地来源不生成 Bing URL', () => {
  const txt = buildInlineSourcesText('结论（来源：知识库《大纲 副本.md》）', ['query']);
  assert.strictEqual(txt, '', '本地标签应被过滤，返回空字符串');
});

check('buildInlineSourcesText: 联网来源生成 Bing 兜底链接', () => {
  const txt = buildInlineSourcesText('结论（来源：某科技站点）', ['某科技站点 最新']);
  assert.ok(txt.includes('某科技站点'), '含标题');
  assert.ok(txt.includes('https://www.bing.com/search?q='), '含 Bing 搜索链接');
});

console.log(`\n结果：${pass} 通过 / 0 失败`);
