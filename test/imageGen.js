'use strict';
// 生图通道测试：重点验证各种生图模型返回格式都能被抽出图片 URL/data URI
const assert = require('assert');
const ig = require('../src/tools/imageGen');
const { extractImageUrls } = ig;

const b64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let pass = 0;
function ok(name, cond) {
  assert.ok(cond, '❌ ' + name);
  console.log('✅ ' + name);
  pass++;
}

// 1) client 已标准化的 images 数组（0.8.42 抽取）
ok('images[].url', extractImageUrls({ images: [{ url: 'https://x.com/a.png' }] }).join() === 'https://x.com/a.png');
ok('images[].b64', extractImageUrls({ images: [{ b64: 'QUJD' }] }).join() === 'data:image/png;base64,QUJD');

// 2) 字符串 content 里嵌 data URL / URL
ok('string content data URL', extractImageUrls({ content: '看图：' + b64 + ' 结束' }).join() === b64);
ok('string content url', extractImageUrls({ content: '见 https://y.com/b.jpg 与 https://z.com/c.png' }).length === 2);

// 3) 通义 wan2.1-image 风格：content 数组含 {type:'image', image:'data:...'}
ok('wan array image string', extractImageUrls({ content: [{ type: 'text', text: 'ok' }, { type: 'image', image: b64 }] }).join() === b64);

// 4) OpenAI 风格 chat：content 数组含 {type:'image_url', image_url:{url}}
ok('openai image_url obj', extractImageUrls({ content: [{ type: 'image_url', image_url: { url: b64 } }] }).join() === b64);
ok('openai image_url str', extractImageUrls({ content: [{ type: 'image_url', image_url: b64 }] }).join() === b64);

// 5) Anthropic 风格：{type:'image', source:{type:'base64', media_type, data}}
ok('anthropic base64', extractImageUrls({ content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }] }).join() === 'data:image/png;base64,QUJD');

// 6) Responses 风格 b64_json
ok('responses b64_json', extractImageUrls({ content: [{ type: 'image', b64_json: 'QUJD' }] }).join() === 'data:image/png;base64,QUJD');

// 7) client 标准化 images 也支持 {src: ...}（0.8.45 新增 message.image / data 数组抽图后会带 src）
ok('images[].src', extractImageUrls({ images: [{ src: b64 }] }).join() === b64);

// 8) 原始响应扫描：/images/generations 风格 data 数组
ok('raw data array url', extractImageUrls({ content: '', images: [], raw: { data: [{ url: 'https://x.com/gen.png' }] } }).join() === 'https://x.com/gen.png');
ok('raw data array b64_json', extractImageUrls({ content: '', images: [], raw: { data: [{ b64_json: 'QUJD' }] } }).join() === 'data:image/png;base64,QUJD');

// 9) 原始响应扫描：message.image 直接放图
ok('raw message.image', extractImageUrls({ content: '', images: [], raw: { choices: [{ message: { image: b64 } }] } }).join() === b64);

// 10) 空结果：既无 images 也无可识别 content
ok('empty -> []', extractImageUrls({ content: '没有图片的一段纯文本' }).length === 0);
ok('undefined -> []', extractImageUrls(undefined).length === 0);

console.log('\n[imageGen] 通过 ' + pass + ' 项断言');
