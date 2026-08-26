// 富文本渲染单测：代码块结构 / 数学公式（KaTeX 渲染，未加载时降级 math-fallback）/ 外链图片 / 引用角标 / 表格回归
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

// 数学公式：优先 KaTeX 渲染（vendor/katex，离线）；测试环境 global.window 无 katex，故降级为 math-fallback 纯文本（断言保持）。

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
  const h = chat.renderAssistant('a（来源：知识库《A》）b【来源：file.js:12】', 'fid1');
  assert.ok(h.includes('<sup class="cite link" data-source-id="fid1:0"'), 'has sup (source 0)');
  assert.ok(h.includes('<sup class="cite link" data-source-id="fid1:1"'), 'has sup (source 1)');
  assert.ok(h.includes('[1]') && h.includes('[2]'), 'two badges');
  assert.ok(h.includes('class="cites"'), 'cites list');
  assert.ok(h.includes('知识库《A》') && h.includes('file.js:12'), 'labels');
  assert.ok(!h.includes('data-url'), '无链接来源改用 data-source-id 而非 data-url: ' + h);
  assert.strictEqual(chat.getSource('fid1', 0).label, '知识库《A》', 'getSource label');
  assert.strictEqual(chat.getSource('fid1', 0).url, '', 'getSource no url');
});

check('本地知识库角标：剥掉「知识库《...》」包装后定位本地文件', () => {
  chat.setKbSources([{ label: '大纲 副本.md', file: '/abs/path/大纲 副本.md' }]);
  const h = chat.renderAssistant('结论（来源：知识库《大纲 副本.md》）', 'fid-kb1');
  const src = chat.getSource('fid-kb1', 0);
  assert.strictEqual(src.type, 'kb', 'type=kb: ' + JSON.stringify(src));
  assert.strictEqual(src.localPath, '/abs/path/大纲 副本.md', 'localPath: ' + JSON.stringify(src));
  assert.strictEqual(src.url, '', 'url 应为空，不能是 Bing: ' + JSON.stringify(src));
  assert.ok(h.includes('data-source-id="fid-kb1:0"'), 'render 出可点击角标');
});

check('本地知识库角标：模型只写 basename 也能匹配到相对路径', () => {
  chat.setKbSources([{ label: 'notes/大纲.md', file: '/abs/path/notes/大纲.md' }]);
  const h = chat.renderAssistant('结论（来源：知识库《大纲.md》）', 'fid-kb2');
  const src = chat.getSource('fid-kb2', 0);
  assert.strictEqual(src.type, 'kb', 'type=kb');
  assert.strictEqual(src.localPath, '/abs/path/notes/大纲.md', 'basename 匹配到相对路径');
  assert.strictEqual(src.url, '', 'url 为空');
});

check('本地知识库角标：重置后不再误识别', () => {
  chat.setKbSources([]);
  const { cites } = chat.extractCitations('结论（来源：知识库《大纲 副本.md》）');
  assert.strictEqual(cites[0].url, '', 'kbSourceMap 为空时无 URL');
  assert.ok(!cites[0].type, 'type 为空/未设置');
});

check('本地知识库角标：文末参考列表 [n] 知识库《...》也能定位本地文件', () => {
  chat.setKbSources([{ label: '大纲 副本.md', file: '/abs/path/大纲 副本.md' }]);
  const raw = '结论。\n\n来源\n[1] 知识库《大纲 副本.md》:总故事梗概\n[2] 大纲 副本.md';
  const h = chat.renderAssistant(raw, 'fid-kb3');
  const src1 = chat.getSource('fid-kb3', 0);
  const src2 = chat.getSource('fid-kb3', 1);
  assert.strictEqual(src1.type, 'kb', 'source1 type=kb: ' + JSON.stringify(src1));
  assert.strictEqual(src1.localPath, '/abs/path/大纲 副本.md', 'source1 localPath');
  assert.strictEqual(src2.type, 'kb', 'source2 type=kb: ' + JSON.stringify(src2));
  assert.strictEqual(src2.localPath, '/abs/path/大纲 副本.md', 'source2 localPath');
  assert.ok(h.includes('class="cite-link"'), 'render 出来源列表项可点击');
  assert.ok(h.includes('class="cites"'), 'render 出来源列表');
});

check('本地知识库角标：内联（来源：《大纲 副本.md》）无知识库前缀也能匹配', () => {
  chat.setKbSources([{ label: '大纲 副本.md', file: '/abs/path/大纲 副本.md' }]);
  const h = chat.renderAssistant('结论（来源：《大纲 副本.md》）', 'fid-kb4');
  const src = chat.getSource('fid-kb4', 0);
  assert.strictEqual(src.type, 'kb', 'type=kb: ' + JSON.stringify(src));
  assert.strictEqual(src.localPath, '/abs/path/大纲 副本.md', 'localPath');
  assert.strictEqual(src.url, '', 'url 为空');
});

check('本地知识库角标：模型写「本地知识库《...》」前缀也能定位', () => {
  chat.setKbSources([{ label: '大纲 副本.md', file: '/abs/path/大纲 副本.md' }]);
  const raw = '结论。\n\n来源\n[1] 本地知识库《大纲 副本.md》';
  const h = chat.renderAssistant(raw, 'fid-kb5');
  const src = chat.getSource('fid-kb5', 0);
  assert.strictEqual(src.type, 'kb', 'type=kb: ' + JSON.stringify(src));
  assert.strictEqual(src.localPath, '/abs/path/大纲 副本.md', 'localPath');
  assert.strictEqual(src.url, '', 'url 为空');
  assert.ok(h.includes('class="cite-link"'), 'render 出来源列表项可点击');
});

check('引用角标：来源带裸链接 → 可点击', () => {
  const { cites } = chat.extractCitations('结论（来源：知乎专栏 https://zhuanlan.zhihu.com/p/1）');
  assert.strictEqual(cites[0].url, 'https://zhuanlan.zhihu.com/p/1', 'url: ' + JSON.stringify(cites));
  assert.strictEqual(cites[0].label, '知乎专栏', 'label 去掉裸 url: ' + cites[0].label);
  const h = chat.renderAssistant('结论（来源：知乎专栏 https://zhuanlan.zhihu.com/p/1）', 'fid2');
  assert.ok(h.includes('<sup class="cite link" data-source-id="fid2:0"'), 'sup link: ' + h);
  assert.ok(h.includes('https://zhuanlan.zhihu.com/p/1'), 'url 保留在 title/source: ' + h);
  assert.ok(h.includes('class="cite-link" data-source-id="fid2:0"'), 'list link: ' + h);
  assert.ok(!h.includes('data-url'), '改用 data-source-id: ' + h);
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
  const h = chat.renderAssistant('结论（来源：狐狸 AI 官方文档）', 'fid3');
  assert.ok(h.includes('<sup class="cite link" data-source-id="fid3:0"'), '角标反查可点');
  assert.ok(h.includes('https://fox.example.com/docs'), '角标反查到链接: ' + h);
});

check('harvestSourceUrls 支持 [^n] 前缀', () => {
  chat.harvestSourceUrls('[^1] 中国科学院官网\nURL: https://www.cas.cn/\n\n[^2] 新华社\nURL: http://www.xinhuanet.com/');
  assert.strictEqual(chat.citeUrlByNum[1].url, 'https://www.cas.cn/', 'num 1 url');
  assert.strictEqual(chat.citeUrlByNum[2].url, 'http://www.xinhuanet.com/', 'num 2 url');
});

check('[^n] 数字引用渲染为可点击角标', () => {
  const h = chat.renderAssistant('2025 诺奖[^1][^2]', 'fid4');
  assert.ok(h.includes('<sup class="cite link" data-source-id="fid4:0"'), '[^1] link: ' + h);
  assert.ok(h.includes('https://www.cas.cn/'), '[^1] url: ' + h);
  assert.ok(h.includes('<sup class="cite link" data-source-id="fid4:1"'), '[^2] link: ' + h);
  assert.ok(h.includes('http://www.xinhuanet.com/'), '[^2] url: ' + h);
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
  const h = chat.renderAssistant('参见 [3] 文档', 'fid5');
  assert.ok(h.includes('<sup class="cite link" data-source-id="fid5:0"'), '[3] link: ' + h);
  assert.ok(h.includes('https://api.deepseek.com/'), '[3] url: ' + h);
});

check('原生联网：多结果 [n] 标题/URL 全被 harvest 且角标可点', () => {
  // 模拟 client.js buildSourcesText 产出的原生 web_search_call results 文本
  const native = '[1] 狐狸的百科\nURL: https://zh.wikipedia.org/wiki/狐狸\n狐狸是犬科动物。\n\n[2] DeepSeek 官方文档\nURL: https://api.deepseek.com/';
  chat.harvestSourceUrls(native);
  assert.strictEqual(chat.citeUrlByNum[1].url, 'https://zh.wikipedia.org/wiki/狐狸', 'num1');
  assert.strictEqual(chat.citeUrlByNum[2].url, 'https://api.deepseek.com/', 'num2');
  const h = chat.renderAssistant('据搜索显示[^1] 与官方资料[^2] 一致。', 'fid6');
  assert.ok(h.includes('<sup class="cite link" data-source-id="fid6:0"'), '[^1] link');
  assert.ok(h.includes('https://zh.wikipedia.org/wiki/狐狸'), '[^1] url');
  assert.ok(h.includes('<sup class="cite link" data-source-id="fid6:1"'), '[^2] link');
  assert.ok(h.includes('https://api.deepseek.com/'), '[^2] url');
  // 原生联网模型也常用 [n] 而非 [^n]，同源索引下应同样可点
  const h2 = chat.renderAssistant('见 [1] 百科与 [2] 文档。', 'fid6b');
  assert.ok(h2.includes('<sup class="cite link" data-source-id="fid6b:0"'), '[1] link');
  assert.ok(h2.includes('https://zh.wikipedia.org/wiki/狐狸'), '[1] url');
  assert.ok(h2.includes('<sup class="cite link" data-source-id="fid6b:1"'), '[2] link');
  assert.ok(h2.includes('https://api.deepseek.com/'), '[2] url');
});

check('搜索结果索引：支持带前缀/合并的模型参考条目标题反查 URL', () => {
  // 模型常把多个搜索来源合并成一条，并加「web_search 结果——」前缀
  chat.harvestSourceUrls('[1] BWiki 原神 Wiki 角色页\nURL: https://wiki.example/genshin\n[2] TapTap 7.0 版本动态\nURL: https://taptap.example/v70');
  // 前缀 + 合并
  assert.strictEqual(chat.lookupCiteUrl('web_search 结果——BWiki 原神 Wiki 角色页、TapTap 7.0 版本动态'), 'https://wiki.example/genshin', 'strip prefix & split');
  // 单条带前缀
  assert.strictEqual(chat.lookupCiteUrl('搜索结果：BWiki 原神 Wiki 角色页'), 'https://wiki.example/genshin', 'single prefix');
  // renderAssistant 用模型自列参考列表时，也应能回填 URL
  const h = chat.renderAssistant('据[1]介绍…\n\n参考来源\n[1] web_search 结果——BWiki 原神 Wiki 角色页、TapTap 7.0 版本动态', 'fid8');
  assert.ok(h.includes('https://wiki.example/genshin'), 'prefixed combined ref gets url: ' + h);
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

check('行内公式降级为纯文本（math-fallback）', () => {
  const h = chat.renderMarkdown('爱因斯坦说 $E=mc^2$ 成立');
  assert.ok(h.includes('$E=mc^2$'), 'inline shown as literal: ' + h);
  assert.ok(!h.includes(String.fromCharCode(2) + 'M'), 'placeholder consumed');
});

check('块级公式降级为 math-fallback 纯文本', () => {
  const h = chat.renderMarkdown('$$\n\\int_0^1 x\\,dx\n$$');
  assert.ok(h.includes('math-fallback'), 'fallback block: ' + h);
  assert.ok(h.includes('$$'), 'display delimiters kept: ' + h);
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
  for (const k of Object.keys(chat.citeUrlByNum)) delete chat.citeUrlByNum[k];
  chat.harvestSourceUrls('[1] Foo\nURL: https://foo.example/a\n[2] Bar\nURL: https://bar.example/b\n');
  const h = chat.renderAssistant('见 [^1^] 与 [^2^]。', 'fid7');
  assert.ok(h.includes('<sup class="cite link" data-source-id="fid7:0"'), '[^1^] link: ' + h);
  assert.ok(h.includes('https://foo.example/a'), '[^1^] url: ' + h);
  assert.ok(h.includes('<sup class="cite link" data-source-id="fid7:1"'), '[^2^] link: ' + h);
  assert.ok(h.includes('https://bar.example/b'), '[^2^] url: ' + h);
});

check('模型自带 [n] 参考列表：内联 [n] 可点 + 正文剥离', () => {
  for (const k of Object.keys(chat.citeUrlByNum)) delete chat.citeUrlByNum[k];
  const src = '结论见[1]与[2]。\n\n参考来源\n[1] 狐狸深度文档 - https://foxdoc.example.com/a\n[2] waveloom 项目 https://waveloom.example.com';
  const { text, cites } = chat.extractCitations(src);
  assert.ok(!/\[1\] 狐狸深度文档/.test(text), 'ref line stripped from body: ' + text);
  assert.ok(!/参考来源/.test(text), 'header stripped: ' + text);
  assert.strictEqual(cites.length, 2, 'cites count: ' + JSON.stringify(cites));
  assert.strictEqual(cites[0].url, 'https://foxdoc.example.com/a', 'cite1 url: ' + JSON.stringify(cites));
  assert.strictEqual(cites[1].url, 'https://waveloom.example.com', 'cite2 url: ' + JSON.stringify(cites));
});

check('模型自带 [n] 参考列表：renderAssistant 生成可点角标与来源列表', () => {
  for (const k of Object.keys(chat.citeUrlByNum)) delete chat.citeUrlByNum[k];
  const src = '结论见[1]与[2]。\n\n参考来源\n[1] 狐狸深度文档 - https://foxdoc.example.com/a\n[2] waveloom 项目 https://waveloom.example.com';
  const h = chat.renderAssistant(src, 'fid8');
  assert.ok(h.includes('<sup class="cite link" data-source-id="fid8:0"'), 'inline [1] link: ' + h);
  assert.ok(h.includes('https://foxdoc.example.com/a'), 'inline [1] url: ' + h);
  assert.ok(h.includes('<sup class="cite link" data-source-id="fid8:1"'), 'inline [2] link: ' + h);
  assert.ok(h.includes('https://waveloom.example.com'), 'inline [2] url: ' + h);
  assert.ok(h.includes('class="cites"'), 'cites list present');
  assert.ok(h.includes('class="cite-link" data-source-id="fid8:0"'), 'list link');
});

check('参考列表无 URL：剥离并展示为静态角标（不误点）', () => {
  for (const k of Object.keys(chat.citeUrlByNum)) delete chat.citeUrlByNum[k];
  const src = '见[1]。\n\n来源\n[1] DeepSeek 官方定价页 / 搜狐报道';
  const h = chat.renderAssistant(src, 'fid9');
  assert.ok(h.includes('<sup class="cite link" data-source-id="fid9:0"'), 'static sup 仍用 data-source-id 可点: ' + h);
  assert.ok(!h.includes('data-url'), '无链接不生成 data-url 直跳元素: ' + h);
  assert.ok(h.includes('DeepSeek 官方定价页'), 'label shown in cites');
  assert.strictEqual(chat.getSource('fid9', 0).url, '', '无链接来源 url 为空（浮窗仅显示标题）');
});

check('单条 [n] 不成参考列表（防误判正文有序列表）', () => {
  for (const k of Object.keys(chat.citeUrlByNum)) delete chat.citeUrlByNum[k];
  const { text } = chat.extractCitations('步骤一[1] 如下');
  assert.ok(text.includes('[1]'), 'kept as literal text: ' + text);
});

console.log('\nsoftSegment 兜底分段（思考过程可读性）:');

check('softSegment：无标点长文本分段为多段', () => {
  const t = '我已经读完了这份文档现在要完善下这份文档我需要想想可以从哪些方向检查内容是否准确联网搜索验证缓存机制的最新信息补充一些缺失的内容比如具体的代码示例提示词组装层改造命中率计算公式更多诊断工具里的实际费相关功能';
  const s = chat.softSegment(t);
  const pieces = s.split('\n\n');
  assert.ok(pieces.length > 1, '应分成多段: ' + pieces.length);
  for (const p of pieces) assert.ok(p.length <= 110, '段过长: ' + p.length);
});

check('softSegment：有标点长文本按句分段', () => {
  const t = '先检查内容是否准确，这一步要联网搜索验证缓存机制的最新信息是否仍然成立。补充缺失内容比如具体的代码示例、提示词组装层改造、命中率计算公式等。再优化提示词组装层，让模型输出结构更清晰。最后做命中率计算并对比优化前后的成本差异，每一步都要有依据。';
  const s = chat.softSegment(t);
  assert.ok(s.split('\n\n').length > 1, '应分段: ' + s.split('\n\n').length);
});

check('softSegment：markdown 结构文本不破坏', () => {
  const t = '## 1. 解析用户请求\n- 要点一\n- 要点二\n## 2. 初步分析';
  assert.strictEqual(chat.softSegment(t), t, '结构文本原样返回');
});

check('softSegment：短文本不分段', () => {
  assert.strictEqual(chat.softSegment('短文本不用分段'), '短文本不用分段');
});

check('softSegment：流式增长时前段边界稳定（不抖动）', () => {
  const base = '我已经读完了这份文档现在要完善下这份文档我需要想想可以从哪些方向检查内容是否准确联网搜索验证缓存机制的最新信息补充一些缺失的内容比如具体的代码示例提示词组装层改造命中率计算公式更多诊断工具里的实际费相关功能';
  const a = chat.softSegment(base.slice(0, 120));
  const b = chat.softSegment(base.slice(0, 260));
  assert.strictEqual(a.split('\n\n')[0], b.split('\n\n')[0], '第一段应一致');
});

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
