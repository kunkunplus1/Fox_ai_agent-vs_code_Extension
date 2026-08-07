'use strict';
// 测试多模态识图中转（capabilities.describeImages / imageUrlOf）：
// - 图片 part 被第二个模型的描述替换
// - 多张图片逐一处理
// - callSecondary 抛错时降级为失败文本
// - 非图片消息原样返回
// capabilities 不依赖 vscode，可直接在 Node 环境运行。

const caps = require('../src/capabilities');

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

async function run() {
  console.log('测试1：describeImages 替换单张图片为描述');
  const msgs = [
    { role: 'user', content: [
      { type: 'text', text: '看看这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
    ] }
  ];
  const { messages, described } = await caps.describeImages(msgs, async (url) => '一只橘猫坐在窗台');
  ok('描述计数=1', described === 1);
  const parts = messages[0].content;
  ok('图片被替换成描述文本', parts.length === 2 && parts[1].type === 'text' && parts[1].text.includes('一只橘猫'));
  ok('原图 url 不再出现', !JSON.stringify(messages).includes('data:image/png'));

  console.log('测试2：多张图片逐一处理');
  const msgs2 = [
    { role: 'user', content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } }
    ] }
  ];
  let calls = 0;
  const { described: d2 } = await caps.describeImages(msgs2, async (url) => { calls++; return '图' + calls; });
  ok('两张图片均被处理', d2 === 2 && calls === 2);

  console.log('测试3：callSecondary 抛错时降级');
  const { messages: m3 } = await caps.describeImages(msgs, async () => { throw new Error('模型挂了'); });
  ok('失败时返回失败占位而非崩溃', m3[0].content.some((p) => p.type === 'text' && p.text.includes('图片识别失败')));

  console.log('测试4：非图片消息原样返回');
  const msgs4 = [{ role: 'user', content: '纯文本' }];
  const { messages: m4, described: d4 } = await caps.describeImages(msgs4, async () => 'x');
  ok('非图片消息不变', d4 === 0 && m4[0].content === '纯文本');

  console.log('测试5：imageUrlOf 提取（三种格式）');
  ok('image_url 嵌套', caps.imageUrlOf({ type: 'image_url', image_url: { url: 'u1' } }) === 'u1');
  ok('image_url 字符串', caps.imageUrlOf({ type: 'image_url', image_url: 'u2' }) === 'u2');
  ok('input_image', caps.imageUrlOf({ type: 'input_image', image_url: 'u3' }) === 'u3');
  ok('anthropic image base64', caps.imageUrlOf({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZZZ' } }) === 'data:image/png;base64,ZZZ');

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  if (fail) process.exit(1);
}

run().catch((e) => { console.error('测试异常：', e); process.exit(1); });
