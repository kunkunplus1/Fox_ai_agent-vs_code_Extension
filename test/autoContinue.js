'use strict';

const assert = require('assert');
const { shouldAutoContinue: _shouldAutoContinue, buildContinuePrompt: _buildContinuePrompt, isStuckRepeat: _isStuckRepeat } = require('../src/autoContinue.js');

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

t('buildContinuePrompt 短文本用通用提示', () => {
  assert.ok(_buildContinuePrompt('短文本').indexOf('继续输出剩余内容') === 0);
});

t('buildContinuePrompt 长文本带回传末尾原文', () => {
  const long = 'x'.repeat(500) + '这是截断处';
  const p = _buildContinuePrompt(long);
  assert.ok(p.indexOf('这是截断处') !== -1, '应回传末尾原文');
  assert.ok(p.indexOf('不要调用任何工具') !== -1, '应要求纯文本续写');
});

t('isStuckRepeat 明显推进 -> false', () => {
  const prev = '第一章讲了很多内容'.repeat(40);
  const now = '第二章全新的内容展开论述'.repeat(40);
  assert.strictEqual(_isStuckRepeat(prev, now), false);
});

t('isStuckRepeat 完全重复 -> true', () => {
  const prev = '同一段被截断的内容重复出现'.repeat(40);
  const now = '同一段被截断的内容重复出现'.repeat(40);
  assert.strictEqual(_isStuckRepeat(prev, now), true);
});

t('isStuckRepeat 太短 -> false', () => {
  assert.strictEqual(_isStuckRepeat('短', '短'), false);
});

console.log('[autoContinue] 决策逻辑测试完成');
