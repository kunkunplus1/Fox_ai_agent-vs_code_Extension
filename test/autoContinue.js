'use strict';

const assert = require('assert');
const { shouldAutoContinue: _shouldAutoContinue } = require('../src/autoContinue.js');

function t(name, fn) {
  try {
    fn();
    console.log('  ✓', name);
  } catch (e) {
    console.error('  ✗', name);
    console.error('   ', e && e.message);
    process.exitCode = 1;
  }
}

t('finishReason=length 有内容 -> 继续', () => {
  assert.strictEqual(
    _shouldAutoContinue({ content: 'hello', finishReason: 'length' }, { maxContinues: 3 }, 0),
    true
  );
});

t('finishReason=incomplete 有内容 -> 继续', () => {
  assert.strictEqual(
    _shouldAutoContinue({ content: 'hello', finishReason: 'incomplete' }, { maxContinues: 3 }, 0),
    true
  );
});

t('finishReason=stop -> 不继续', () => {
  assert.strictEqual(
    _shouldAutoContinue({ content: 'hello', finishReason: 'stop' }, { maxContinues: 3 }, 0),
    false
  );
});

t('finishReason=length 但内容为空 -> 不继续', () => {
  assert.strictEqual(
    _shouldAutoContinue({ content: '', finishReason: 'length' }, { maxContinues: 3 }, 0),
    false
  );
});

t('有 reasoning 无 content -> 继续', () => {
  assert.strictEqual(
    _shouldAutoContinue({ content: '', reasoning: 'thinking...', finishReason: 'length' }, { maxContinues: 3 }, 0),
    true
  );
});

t('有图片无文本 -> 继续', () => {
  assert.strictEqual(
    _shouldAutoContinue({ content: '', images: [{ src: 'data:image/png;base64,abc' }], finishReason: 'length' }, { maxContinues: 3 }, 0),
    true
  );
});

t('已达 maxContinues -> 不继续', () => {
  assert.strictEqual(
    _shouldAutoContinue({ content: 'hello', finishReason: 'length' }, { maxContinues: 3 }, 3),
    false
  );
});

t('maxContinues=0 -> 不继续', () => {
  assert.strictEqual(
    _shouldAutoContinue({ content: 'hello', finishReason: 'length' }, { maxContinues: 0 }, 0),
    false
  );
});

t('缺省 maxContinues 为 3', () => {
  assert.strictEqual(_shouldAutoContinue({ content: 'hello', finishReason: 'length' }, {}, 2), true);
  assert.strictEqual(_shouldAutoContinue({ content: 'hello', finishReason: 'length' }, {}, 3), false);
});

t('maxContinues 字符串可转数字', () => {
  assert.strictEqual(_shouldAutoContinue({ content: 'hello', finishReason: 'length' }, { maxContinues: '2' }, 1), true);
  assert.strictEqual(_shouldAutoContinue({ content: 'hello', finishReason: 'length' }, { maxContinues: '2' }, 2), false);
});

console.log('[autoContinue] 决策逻辑测试完成');
