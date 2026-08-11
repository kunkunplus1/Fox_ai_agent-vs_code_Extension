// 富文本渲染单测：代码高亮结构 / KaTeX 公式 / 外链图片 / 引用角标 / 表格回归
// 运行：node test/render.js
'use strict';
const assert = require('assert');
const path = require('path');

// ---- 最小 DOM 桩，使 chat.js 的 IIFE 能在 Node 下执行 ----
function fakeEl() {
  const el = {
    textContent: '', innerHTML: '', value: '', disabled: false,
    dataset: {}, style: {}, classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, appendChild() {}, removeChild() {}, remove() {},
    addEventListener() {}, querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    parentElement: null, isConnected: true, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
  };
  return el;
}
const doc = {
  getElementById: () => fakeEl(),
  createElement: () => fakeEl(),
  querySelectorAll: () => [],
  documentElement: { lang: '' },
  addEventListener() {},
};
global.window = { __FOX_LOCALE__: 'zh-cn', __FOX_I18N__: {}, addEventListener() {} };
global.document = doc;
global.acquireVsCodeApi = () => ({ postMessage() {}, asWebviewUri() {} });
global.requestAnimationFrame = (cb) => cb();
global.t = (k) => (k == null ? '' : String(k));

// 注入 KaTeX（UMD 在 node 下走 module.exports）
try {
  global.window.katex = require(path.join(__dirname, '..', 'media', 'vendor', 'katex', 'katex.min.js'));
} catch (e) { /* 无 katex 时公式走降级分支，测试会单独覆盖 */ }

const chat = require(path.join(__dirname, '..', 'media', 'chat.js'));

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + '\n    ' + (e && e.message)); }
}

console.log('renderMarkdown / renderInline / renderAssistant:');

check('行内代码、加粗、斜体、删除线', () => {
  const h = chat.renderInline('`code` **b** *i* ~~d~~');
  assert.ok(h.includes('<code class="inline">code</code>'), 'inline code');
  assert.ok(h.includes('<strong>b</strong>'), 'bold');
  assert.ok(h.includes('<em>i</em>'), 'italic');
  assert.ok(h.includes('<del>d</del>'), 'del');
});

check('普通链接 [text](url) → 可点击 data-url', () => {
  const h = chat.renderInline('[百度](https://baidu.com)');
  assert.ok(h.includes('class="ext-link"'), 'ext-link: ' + h);
  assert.ok(h.includes('data-url="https://baidu.com"'), 'data-url: ' + h);
  assert.ok(h.includes('>百度</a>'), 'text: ' + h);
});

check('裸链接自动变可点击', () => {
  const h = chat.renderInline('详见 https://example.com/a?b=1 谢谢');
  assert.ok(h.includes('data-url="https://example.com/a?b=1"'), 'bare link: ' + h);
});

check('句末标点不吞进链接', () => {
  const h = chat.renderInline('见 https://example.com/x.');
  assert.ok(h.includes('data-url="https://example.com/x"'), 'trim dot: ' + h);
});

check('行内代码里的链接不被二次链接化', () => {
  const h = chat.renderInline('`https://a.com` 这是代码');
  assert.ok(h.includes('<code class="inline">https://a.com</code>'), 'code kept: ' + h);
  assert.ok(!h.includes('data-url'), 'no link inside code: ' + h);
});

check('图片 markdown ![alt](url)', () => {
  const h = chat.renderInline('![图](https://x.com/a.png)');
  assert.ok(h.includes('<img class="ext-img"'), 'img tag');
  assert.ok(h.includes('src="https://x.com/a.png"'), 'img src');
});

check('裸图片链接自动缩略图', () => {
  const h = chat.renderInline('看 https://x.com/b.jpg 这张图');
  assert.ok(h.includes('<img class="ext-img" src="https://x.com/b.jpg"'), 'bare img: ' + h);
});

check('链接里的图片后缀不被误判为图片', () => {
  const h = chat.renderInline('[下载](https://x.com/c.png)');
  assert.ok(h.includes('data-url="https://x.com/c.png"') && h.includes('>下载</a>'), 'link only: ' + h);
  assert.ok(!h.includes('<img'), 'no img: ' + h);
});

check('拒绝 javascript: 注入', () => {
  const h = chat.renderInline('[x](javascript:alert(1))');
  // 链接正则只认 https?://，javascript: 不会变成可点击链接，仅作为纯文本显示
  assert.ok(!h.includes('<a href="javascript:'), 'no js anchor: ' + h);
  assert.ok(!h.includes('data-url="javascript:'), 'no js data-url: ' + h);
});

check('linkTag 只放行 http(s)', () => {
  assert.strictEqual(chat.linkTag('javascript:alert(1)', 'x'), 'x');
  assert.strictEqual(chat.linkTag('file:///etc/passwd', 'x'), 'x');
  assert.ok(chat.linkTag('https://a.com', 'a').includes('data-url="https://a.com"'));
});

check('引用角标：解析并去重', () => {
  const { cites } = chat.extractCitations('结论一（来源：知识库《A》）结论二（来源：知识库《A》）');
  assert.strictEqual(cites.length, 1, 'dedupe -> 1: ' + JSON.stringify(cites));
  assert.strictEqual(cites[0].label, '知识库《A》', 'label');
  assert.strictEqual(cites[0].url, '', 'no url');
});

check('引用角标：多来源 + 角标 + 列表', () => {
  const h = chat.renderAssistant('a（来源：知识库《A》）b【来源：file.js:12】');
  assert.ok(h.includes('<sup class="cite"'), 'has sup');
  assert.ok(h.includes('[1]') && h.includes('[2]'), 'two badges');
  assert.ok(h.includes('class="cites"'), 'cites list');
  assert.ok(h.includes('知识库《A》') && h.includes('file.js:12'), 'labels');
  assert.ok(!h.includes('data-url'), '无链接来源不生成可点击元素: ' + h);
});

check('引用角标：来源带裸链接 → 可点击', () => {
  const { cites } = chat.extractCitations('结论（来源：知乎专栏 https://zhuanlan.zhihu.com/p/1）');
  assert.strictEqual(cites[0].url, 'https://zhuanlan.zhihu.com/p/1', 'url: ' + JSON.stringify(cites));
  assert.strictEqual(cites[0].label, '知乎专栏', 'label 去掉裸 url: ' + cites[0].label);
  const h = chat.renderAssistant('结论（来源：知乎专栏 https://zhuanlan.zhihu.com/p/1）');
  assert.ok(h.includes('<sup class="cite link" data-url="https://zhuanlan.zhihu.com/p/1"'), 'sup link: ' + h);
  assert.ok(h.includes('class="cite-link" data-url="https://zhuanlan.zhihu.com/p/1"'), 'list link: ' + h);
});

check('引用角标：来源写 markdown 链接 → 可点击', () => {
  const { cites } = chat.extractCitations('结论（来源：[MDN](https://developer.mozilla.org/zh-CN)）');
  assert.strictEqual(cites[0].url, 'https://developer.mozilla.org/zh-CN', 'md url');
  assert.strictEqual(cites[0].label, 'MDN', 'md label');
});

check('引用角标：来源只写域名 → 自动补 https', () => {
  const { cites } = chat.extractCitations('结论（来源：www.example.com）');
  assert.strictEqual(cites[0].url, 'https://www.example.com', 'domain: ' + JSON.stringify(cites));
});

check('引用角标：文件路径不会被误判成网址', () => {
  const { cites } = chat.extractCitations('结论（来源：src/a.js:12）');
  assert.strictEqual(cites[0].url, '', 'path not url: ' + JSON.stringify(cites));
});

check('搜索结果索引：按标题反查 URL', () => {
  chat.harvestSourceUrls('[1] 狐狸 AI 官方文档\nURL: https://fox.example.com/docs\n简介…\n\n[2] 别的\nURL: https://other.example.com/x\n');
  assert.strictEqual(chat.lookupCiteUrl('狐狸 AI 官方文档'), 'https://fox.example.com/docs', 'exact');
  const h = chat.renderAssistant('结论（来源：狐狸 AI 官方文档）');
  assert.ok(h.includes('data-url="https://fox.example.com/docs"'), '角标反查到链接: ' + h);
});

check('harvestSourceUrls 支持 [^n] 前缀', () => {
  chat.harvestSourceUrls('[^1] 中国科学院官网\nURL: https://www.cas.cn/\n\n[^2] 新华社\nURL: http://www.xinhuanet.com/');
  assert.strictEqual(chat.citeUrlByNum[1].url, 'https://www.cas.cn/', 'num 1 url');
  assert.strictEqual(chat.citeUrlByNum[2].url, 'http://www.xinhuanet.com/', 'num 2 url');
});

check('[^n] 数字引用渲染为可点击角标', () => {
  const h = chat.renderAssistant('2025 诺奖[^1][^2]');
  assert.ok(h.includes('<sup class="cite link" data-url="https://www.cas.cn/"'), '[^1] link: ' + h);
  assert.ok(h.includes('<sup class="cite link" data-url="http://www.xinhuanet.com/"'), '[^2] link: ' + h);
  assert.ok(h.includes('[1]') && h.includes('[2]'), 'badges');
});

check('普通 [n] 文本不会被误切成角标', () => {
  // 当前索引里只有 1/2/3，没有 9；[9] 应保持原样
  const h = chat.renderAssistant('排名第 [9] 的产品');
  assert.ok(h.includes('[9]'), 'keep literal: ' + h);
  assert.ok(!h.includes('<sup class="cite"'), 'no cite for [9]: ' + h);
});

check('[n] 在存在数字索引时被识别为角标', () => {
  chat.harvestSourceUrls('[3] DeepSeek API Docs\nURL: https://api.deepseek.com/');
  const h = chat.renderAssistant('参见 [3] 文档');
  assert.ok(h.includes('<sup class="cite link" data-url="https://api.deepseek.com/"'), '[3] link: ' + h);
});

check('原生联网：多结果 [n] 标题/URL 全被 harvest 且角标可点', () => {
  // 模拟 client.js buildSourcesText 产出的原生 web_search_call results 文本
  const native = '[1] 狐狸的百科\nURL: https://zh.wikipedia.org/wiki/狐狸\n狐狸是犬科动物。\n\n[2] DeepSeek 官方文档\nURL: https://api.deepseek.com/';
  chat.harvestSourceUrls(native);
  assert.strictEqual(chat.citeUrlByNum[1].url, 'https://zh.wikipedia.org/wiki/狐狸', 'num1');
  assert.strictEqual(chat.citeUrlByNum[2].url, 'https://api.deepseek.com/', 'num2');
  const h = chat.renderAssistant('据搜索显示[^1] 与官方资料[^2] 一致。');
  assert.ok(h.includes('<sup class="cite link" data-url="https://zh.wikipedia.org/wiki/狐狸"'), '[^1] link');
  assert.ok(h.includes('<sup class="cite link" data-url="https://api.deepseek.com/"'), '[^2] link');
  // 原生联网模型也常用 [n] 而非 [^n]，同源索引下应同样可点
  const h2 = chat.renderAssistant('见 [1] 百科与 [2] 文档。');
  assert.ok(h2.includes('<sup class="cite link" data-url="https://zh.wikipedia.org/wiki/狐狸"'), '[1] link');
  assert.ok(h2.includes('<sup class="cite link" data-url="https://api.deepseek.com/"'), '[2] link');
});

check('表格回归：GFM 表格仍正常', () => {
  const md = '| 列1 | 列2 |\n| --- | --- |\n| a | b |';
  const h = chat.renderMarkdown(md);
  assert.ok(h.includes('<table>'), 'table: ' + h);
  assert.ok(h.includes('<th>列1</th>') && h.includes('<td>a</td>'), 'cells');
});

check('代码块带 language 类', () => {
  const h = chat.renderMarkdown('```js\nconst a=1;\n```');
  assert.ok(h.includes('class="code-block"'), 'block');
  assert.ok(h.includes('language-js'), 'lang class: ' + h);
});

check('行内公式渲染为 KaTeX', () => {
  const h = chat.renderMarkdown('爱因斯坦说 $E=mc^2$ 成立');
  assert.ok(h.includes('class="katex"'), 'inline katex: ' + h);
  assert.ok(!h.includes('$E=mc^2$'), 'placeholder consumed');
});

check('块级公式渲染为 katex-display', () => {
  const h = chat.renderMarkdown('$$\n\\int_0^1 x\\,dx\n$$');
  assert.ok(h.includes('katex-display'), 'display: ' + h);
});

check('货币 $10 to $20 不被当公式', () => {
  const h = chat.renderMarkdown('价格从 $10 to $20 不等');
  assert.ok(h.includes('$10 to $20'), 'kept literal: ' + h);
  assert.ok(!h.includes('katex'), 'no katex');
});

check('行内代码里的 $x$ 不被当公式', () => {
  const h = chat.renderMarkdown('使用变量 `$x$` 即可');
  assert.ok(h.includes('<code class="inline">$x$</code>'), 'inline code kept: ' + h);
  assert.ok(!h.includes('katex'), 'no katex');
});

check('代码块内的 $ 不被当公式', () => {
  const h = chat.renderMarkdown('```\ncost = $5 + $10\n```');
  assert.ok(h.includes('$5 + $10'), 'code kept literal: ' + h);
  assert.ok(!h.includes('katex'), 'no katex');
});

check('标题/列表/引用/加粗 基本结构', () => {
  const h = chat.renderMarkdown('# 标题\n- a\n- b\n> 引用\n**粗**');
  assert.ok(h.includes('<h1>标题</h1>'), 'h1');
  assert.ok(h.includes('<ul>') && h.includes('<li>a</li>'), 'ul');
  assert.ok(h.includes('<blockquote>引用</blockquote>'), 'quote');
  assert.ok(h.includes('<strong>粗</strong>'), 'bold');
});

check('[^n^] 双尖角标也识别为可点击角标', () => {
  chat.harvestSourceUrls('[1] Foo\nURL: https://foo.example/a\n[2] Bar\nURL: https://bar.example/b\n');
  const h = chat.renderAssistant('见 [^1^] 与 [^2^]。');
  assert.ok(h.includes('data-url="https://foo.example/a"'), '[^1^] link: ' + h);
  assert.ok(h.includes('data-url="https://bar.example/b"'), '[^2^] link: ' + h);
});

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
