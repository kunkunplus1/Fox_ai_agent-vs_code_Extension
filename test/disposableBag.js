'use strict';

/**
 * DisposableBag 纯离线单元测试（无 vscode 依赖）。
 * 验证：add 收集、dispose 释放、幂等、重复释放安全、dispose 后再 add 立即释放。
 */
const assert = require('assert');
const DisposableBag = require('../src/disposableBag');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}

// 计数的假 disposable
function fakeDisposable(store, label) {
  return {
    disposed: false,
    dispose() {
      if (this.disposed) throw new Error('double-dispose: ' + label);
      this.disposed = true;
      store.push(label);
    }
  };
}

test('add 收集并 dispose 一次性释放', () => {
  const released = [];
  const bag = new DisposableBag();
  const a = fakeDisposable(released, 'a');
  const b = fakeDisposable(released, 'b');
  bag.add(a);
  bag.add(b);
  assert.strictEqual(bag.disposed, false);
  bag.dispose();
  assert.deepStrictEqual(released.sort(), ['a', 'b']);
  assert.strictEqual(bag.disposed, true);
});

test('dispose 后 add 的 disposable 立即释放', () => {
  const released = [];
  const bag = new DisposableBag();
  bag.dispose();
  const a = fakeDisposable(released, 'a');
  bag.add(a);
  assert.strictEqual(a.disposed, true);
  assert.deepStrictEqual(released, ['a']);
});

test('重复 dispose 幂等，不会二次释放', () => {
  const released = [];
  const bag = new DisposableBag();
  const a = fakeDisposable(released, 'a');
  bag.add(a);
  bag.dispose();
  bag.dispose(); // 第二次不应再触发 a.dispose
  assert.deepStrictEqual(released, ['a']);
});

test('忽略非 disposable 参数不报错', () => {
  const bag = new DisposableBag();
  bag.add(null);
  bag.add(undefined);
  bag.add(42);
  bag.add({});
  bag.dispose();
});

test('add 返回原 disposable（链式友好）', () => {
  const bag = new DisposableBag();
  const a = fakeDisposable([], 'a');
  const ret = bag.add(a);
  assert.strictEqual(ret, a);
});

console.log('\ndisposableBag: ' + passed + ' 项全部通过 ✅');
