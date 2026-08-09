'use strict';

/**
 * 离线测试：上下文面板「距离压缩」元数据计算（contextUsage.buildCompressMeta）
 * 运行：node test/compressMeta.js
 */

const assert = require('assert');
const cu = require('../src/contextUsage');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name + '\n    ' + (e && e.message));
    process.exit(1);
  }
}

console.log('compressMeta:');

// 1. 未配置时默认值：阈值 0.75，keepRecent 6
check('默认阈值 0.75 / keepRecent 6', () => {
  const m = cu.buildCompressMeta({}, 0);
  assert.strictEqual(m.threshold, 0.75);
  assert.strictEqual(m.keepRecent, 6);
  assert.strictEqual(m.enabled, false);
  assert.strictEqual(m.messageCount, 0);
  assert.strictEqual(m.compressible, -6);
});

// 2. 配置生效：阈值 0.9，keepRecent 4，开启
check('读取配置 threshold/keepRecent/enabled', () => {
  const m = cu.buildCompressMeta({ enabled: true, threshold: 0.9, keepRecent: 4 }, 10);
  assert.strictEqual(m.enabled, true);
  assert.strictEqual(m.threshold, 0.9);
  assert.strictEqual(m.keepRecent, 4);
  assert.strictEqual(m.messageCount, 10);
  assert.strictEqual(m.compressible, 6);
});

// 3. keepRecent 下限保护：<=2 时强制为 2
check('keepRecent 下限 2', () => {
  const m = cu.buildCompressMeta({ keepRecent: 1 }, 5);
  assert.strictEqual(m.keepRecent, 2);
  assert.strictEqual(m.compressible, 3);
});

// 4. 边界：消息数恰为 keepRecent → compressible = 0（无可压缩对话）
check('compressible 下限 0', () => {
  const m = cu.buildCompressMeta({ threshold: 0.8, keepRecent: 6 }, 6);
  assert.strictEqual(m.compressible, 0);
});

// 5. as 为 null / 非对象不崩
check('as=null 不抛错', () => {
  const m = cu.buildCompressMeta(null, 3);
  assert.ok(m && typeof m.threshold === 'number');
  assert.strictEqual(m.compressible, -3);
});

// 6. 阈值非法（<=0）回落默认
check('threshold<=0 回落 0.75', () => {
  const m = cu.buildCompressMeta({ threshold: 0 }, 0);
  assert.strictEqual(m.threshold, 0.75);
});

console.log('\ncompressMeta: 通过 ' + passed + ' 项 ✅');
