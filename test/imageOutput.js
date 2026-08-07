const fs = require('fs');
const path = require('path');
const assert = require('assert');

// 直接加载 client.js 的内部函数用于单元测试
const clientPath = path.join(__dirname, '..', 'src', 'client.js');
const clientSource = fs.readFileSync(clientPath, 'utf8');

// 提取并暴露内部函数：把模块包装一下，让 module.exports 前的函数可被调用
const clientModule = { exports: {} };
const clientFn = new Function('module', 'exports', 'require', '__dirname', clientSource);
clientFn(clientModule, clientModule.exports, require, path.dirname(clientPath));

// 由于 client.js 内部函数未导出，我们用正则/截取的方式太脆弱。
// 这里改成：直接 require client.js，它导出的对象里没有内部函数；
// 但我们可以通过 vm 运行并修改源码，在末尾把内部函数挂到 exports 上。
const vm = require('vm');
const script = new vm.Script(clientSource + "\nmodule.exports.__extractContentFromJson = extractContentFromJson;\nmodule.exports.__parseResponsesOutput = parseResponsesOutput;\nmodule.exports.__imageUrlFromBlock = imageUrlFromBlock;");
const context = { module: { exports: {} }, exports: {}, require, console, Buffer, process, setImmediate, URL };
vm.createContext(context);
script.runInContext(context);
const { __extractContentFromJson, __parseResponsesOutput, __imageUrlFromBlock } = context.module.exports;

const TEST_IMG_PATH = 'C:/Users/asis/Desktop/VipSongsDownload/Snipaste_2026-07-26_14-02-15.png';

function loadTestImageBase64() {
  if (!fs.existsSync(TEST_IMG_PATH)) return '';
  const buf = fs.readFileSync(TEST_IMG_PATH);
  const ext = path.extname(TEST_IMG_PATH).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function run(label, fn) {
  try {
    fn();
    console.log(`✓ ${label}`);
  } catch (e) {
    console.error(`✗ ${label}`);
    console.error(e.message);
    process.exitCode = 1;
  }
}

const dataUrl = loadTestImageBase64();

run('imageUrlFromBlock normalizes object image_url', () => {
  assert.strictEqual(__imageUrlFromBlock({ type: 'image_url', image_url: { url: 'https://x/a.png' } }), 'https://x/a.png');
  assert.strictEqual(__imageUrlFromBlock({ type: 'image_url', image_url: 'https://x/b.png' }), 'https://x/b.png');
  assert.strictEqual(__imageUrlFromBlock({ type: 'image', image: { url: 'data:image/png;base64,ABC' } }), 'data:image/png;base64,ABC');
});

run('extractContentFromJson collects text and drops image blocks before', () => {
  const resp = {
    choices: [{
      message: {
        content: [
          { type: 'text', text: '这是一张图' },
          { type: 'image_url', image_url: { url: 'https://x/a.png' } }
        ]
      }
    }]
  };
  const r = __extractContentFromJson(resp);
  assert.strictEqual(r.content, '这是一张图');
  assert.strictEqual(r.images.length, 1);
  assert.strictEqual(r.images[0].src, 'https://x/a.png');
});

run('extractContentFromJson captures data URL image from real test file', () => {
  if (!dataUrl) {
    console.log('  (skip: test image not found)');
    return;
  }
  const resp = {
    choices: [{
      message: {
        content: [
          { type: 'text', text: '给你看看这张图' },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    }]
  };
  const r = __extractContentFromJson(resp);
  assert.strictEqual(r.content, '给你看看这张图');
  assert.strictEqual(r.images.length, 1);
  assert(r.images[0].src.startsWith('data:image/png;base64,'));
  assert(r.images[0].src.length > 100);
});

run('parseResponsesOutput extracts image_generation_call b64_json', () => {
  const output = [
    { type: 'message', content: [{ type: 'output_text', text: '画好了' }] },
    { type: 'image_generation_call', b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' }
  ];
  const r = __parseResponsesOutput(output);
  assert.strictEqual(r.content, '画好了');
  assert.strictEqual(r.images.length, 1);
  assert(r.images[0].src.startsWith('data:image/png;base64,'));
});

run('parseResponsesOutput extracts image content block in message', () => {
  const output = [
    { type: 'message', content: [{ type: 'image', image_url: { url: 'https://x/c.png' } }] }
  ];
  const r = __parseResponsesOutput(output);
  assert.strictEqual(r.images.length, 1);
  assert.strictEqual(r.images[0].src, 'https://x/c.png');
});

console.log('\nimageOutput tests done.');
