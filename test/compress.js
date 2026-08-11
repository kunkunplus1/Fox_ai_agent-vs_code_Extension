'use strict';

/**
 * 离线测试：上下文压缩的类型感知预处理
 * 运行：node test/compress.js
 */

const assert = require('assert');
const { typeAwarePrepare, compressToolResult } = require('../src/compress');

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

console.log('compress:');

check('短 read_file 保留原文不膨胀', () => {
  const text = 'function foo() {}\nfunction bar() {}\nconst x = 1;';
  const compact = compressToolResult('read_file', text);
  assert.strictEqual(compact, text);
});

check('长 read_file 真正压缩', () => {
  const lines = [];
  for (let i = 0; i < 200; i++) {
    if (i % 10 === 0) lines.push(`function func${i}() { return ${i}; }`);
    else lines.push(`  // line ${i} padding padding padding`);
  }
  const text = lines.join('\n');
  const compact = compressToolResult('read_file', text);
  assert.ok(compact.length < text.length * 0.7, '压缩率应 >30%');
});

check('长 read_file 符号定义不重复导致膨胀', () => {
  // 60 行以内全是符号定义，head 已覆盖全部，不应再追加 sig
  const lines = [];
  for (let i = 0; i < 50; i++) lines.push(`function f${i}() {}`);
  const text = lines.join('\n');
  const compact = compressToolResult('read_file', text);
  // 结果应远短于 "head + 所有符号再重复一遍"
  assert.ok(compact.length < text.length * 1.1, '不应因重复符号而大幅膨胀');
});

check('cmd 输出去 ANSI 并去重空行', () => {
  const text = '\x1b[31merror\x1b[0m\n\n\nok\n\n\nok';
  const compact = compressToolResult('run_command', text);
  assert.ok(!compact.includes('\x1b['), '应去掉 ANSI');
  assert.ok(!compact.includes('\n\n\n'), '应合并连续空行');
});

check('短 diff 保留原文', () => {
  const text = '+a\n-b\n+c';
  const compact = compressToolResult('apply_patch', text);
  assert.strictEqual(compact, text);
});

check('长 diff 生成统计摘要', () => {
  const text = '--- a.js\n+++ b.js\n' + Array.from({ length: 200 }, (_, i) => `+line ${i}`).join('\n');
  const compact = compressToolResult('apply_patch', text);
  assert.ok(compact.includes('+200'), '应统计新增行数');
  assert.ok(compact.length < text.length * 0.3, '应大幅压缩');
});

check('薄工具结果整体不膨胀', () => {
  const thin = 'a'.repeat(319);
  const r = typeAwarePrepare([{ role: 'user', content: '[工具 read_file 的结果]\n' + thin }]);
  assert.ok(r.stats.preparedChars <= r.stats.rawChars, '不应膨胀');
});

check('混合大段内容整体压缩', () => {
  const longRead = Array.from({ length: 200 }, (_, i) =>
    i % 10 === 0 ? `function func${i}() { return ${i}; }` : `  // line ${i} padding padding padding`
  ).join('\n');
  const longCmd = 'line\n'.repeat(200);
  const messages = [
    { role: 'user', content: '[工具 read_file 的结果]\n' + longRead },
    { role: 'user', content: '[工具 run_command 的结果]\n' + longCmd },
    { role: 'assistant', reasoning: 'x'.repeat(1000), content: '结论：继续推进。' }
  ];
  const r = typeAwarePrepare(messages);
  assert.ok(r.stats.preparedChars < r.stats.rawChars * 0.8, '大段混合应压缩');
});

check('深度思考只保留结论尾部', () => {
  const r = typeAwarePrepare([{ role: 'assistant', reasoning: '前'.repeat(800) + '后'.repeat(100), content: '结论' }]);
  // 最前面的 700 个「前」应被截掉，只保留尾部 600 字（500 前 + 100 后）
  assert.ok(!r.prepared.includes('前'.repeat(700)), '应截断 reasoning 前部');
  assert.ok(r.prepared.includes('后'.repeat(100)), '应保留 reasoning 尾部');
});

console.log('\ncompress: 通过 ' + passed + ' 项 ✅');
