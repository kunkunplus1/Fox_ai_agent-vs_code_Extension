'use strict';
// 纯离线测试：extractImageUrls 的图片抽取逻辑（尤其验证「不再从错误页/教程页扒图」）
const assert = require('assert');
const { extractImageUrls } = require('../src/tools/imageGen');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// 1) 通义 wan / dashscope 风格：raw.output.choices[].message.content[].image（今日真实格式）
(() => {
  const result = {
    content: '',
    images: [],
    raw: {
      output: { choices: [{ message: { role: 'assistant', content: [{ type: 'image', image: 'https://oss.example.com/tree.png?Expires=1&Signature=x' }] } }] }
    }
  };
  const imgs = extractImageUrls(result);
  ok('wan 风格能从 choices[].message.content[].image 抽图', imgs.length === 1 && imgs[0].includes('tree.png'));
})();

// 2) OpenAI images.generate 风格：raw.data[].url
(() => {
  const result = { content: '', images: [], raw: { data: [{ url: 'https://cdn.example.com/gen.png' }] } };
  const imgs = extractImageUrls(result);
  ok('OpenAI 风格能从 data[].url 抽图', imgs.length === 1 && imgs[0].includes('gen.png'));
})();

// 3) 错误页 / 教程页（HTML 里嵌了无关 .png）：绝不能把页面里的图当成结果
(() => {
  const html = '<html><body><div class="tutorial">动漫插画教程截图<img src="https://blog.example.com/anime-tutorial-cover.png"></div></body></html>';
  const result = { content: html, images: [], raw: { error: { message: 'invalid', page: html } } };
  const imgs = extractImageUrls(result);
  ok('HTML 错误页/教程页里的无关 .png 不会被当成生图结果', imgs.length === 0);
})();

// 4) content 是非图片文本说明（如模型拒绝/报错文字里夹着链接）：不扒
(() => {
  const text = '抱歉，该模型暂不支持生图，详见 https://docs.example.com/guide-banner.png 文档';
  const result = { content: text, images: [], raw: {} };
  const imgs = extractImageUrls(result);
  ok('纯文本说明里的链接不会被当成图片', imgs.length === 0);
})();

// 5) content 整体就是单个图片 URL：应采信
(() => {
  const url = 'https://cdn.example.com/only-image.png';
  const result = { content: url, images: [], raw: {} };
  const imgs = extractImageUrls(result);
  ok('content 整体是单个图片 URL 时采信', imgs.length === 1 && imgs[0] === url);
})();

// 6) 标准 data: URI 直接出现在 content：应抽取
(() => {
  const data = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  const result = { content: data, images: [], raw: {} };
  const imgs = extractImageUrls(result);
  ok('content 里的 data: URI 会被抽取', imgs.length === 1 && imgs[0] === data);
})();

// 7) result.images 优先（结构化）：即使 raw 含无关内容也只用 images
(() => {
  const result = {
    content: '',
    images: [{ src: 'https://oss.example.com/real.png' }],
    raw: { someHtmlPage: '<img src="https://evil.example.com/ad.png">' }
  };
  const imgs = extractImageUrls(result);
  ok('result.images 优先且不被 raw 里的图污染', imgs.length === 1 && imgs[0].includes('real.png'));
})();

console.log(`\nimageGenExtract: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
