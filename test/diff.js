'use strict';

// diff 引擎单测：纯 Node、零依赖。
// 覆盖：diffStat 语义（顺序敏感 / modified 区分）、formatUnified 输出（hunk 头/行号/错位/截断）、
// 可配置维度（ignoreWhitespace / ignoreCase / ignoreBlankLines / context / wordDiff / maxLineLength）、
// CRLF 归一、空输入边界、性能（大文件小改动不降级且快 / 大范围改动走降级兜底）。
const assert = require('assert');
const diff = require('../src/diff');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  try { assert.ok(cond, name); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '') + ' -> ' + e.message); }
}
function eq(name, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ' -> 期望 ' + JSON.stringify(expected) + ' 实得 ' + JSON.stringify(actual)); }
}

console.log('[diff] 统计语义');
let s = diff.diffStat('a\nb\nc\n', 'a\nb\nc\n');
eq('相同文件：0 增删、全 unchanged、similarity=1', { added: s.added, removed: s.removed, modified: s.modified, unchanged: s.unchanged, similarity: s.similarity, degraded: s.degraded }, { added: 0, removed: 0, modified: 0, unchanged: 4, similarity: 1, degraded: false });
s = diff.diffStat('a\nb\nc\n', 'a\nB2\nc\n');
eq('修改 1 行：added/removed 兼容语义=1 且 modified=1', { added: s.added, removed: s.removed, modified: s.modified, unchanged: s.unchanged }, { added: 1, removed: 1, modified: 1, unchanged: 3 });
s = diff.diffStat('a\nc\n', 'a\nb\nc\n');
eq('纯插入 1 行', { added: s.added, removed: s.removed, modified: s.modified }, { added: 1, removed: 0, modified: 0 });
s = diff.diffStat('a\nb\nc\n', 'a\nc\n');
eq('纯删除 1 行', { added: s.added, removed: s.removed }, { added: 0, removed: 1 });
s = diff.diffStat('a\nb\nc\n', 'c\nb\na\n');
ok('顺序颠倒（旧多重集失效点）应检出变化', s.added >= 2 && s.removed >= 2, s);
s = diff.diffStat('x\ny\nz\n', '1\n2\n3\n');
eq('完全无关：全删全加', { added: s.added, removed: s.removed }, { added: 3, removed: 3 });

console.log('[diff] 可配置对比维度');
s = diff.diffStat('ABC\ndef\n', 'abc\ndef\n', { ignoreCase: true });
eq('ignoreCase：视为无变化', { added: s.added, unchanged: s.unchanged }, { added: 0, unchanged: 3 });
s = diff.diffStat('a  b\nc\n', 'a b\nc\n', { ignoreWhitespace: true });
eq('ignoreWhitespace：视为无变化', { added: s.added, unchanged: s.unchanged }, { added: 0, unchanged: 3 });
s = diff.diffStat('x\n\n\ny\n', 'x\n\nz\n', { ignoreBlankLines: true });
// 语义：空行彼此视为相等（不因"空行对内容行"差异误报）；
// 但空行行数差（a 2 空行 vs b 1 空行）与 y→z 的内容修改仍如实计数。
eq('ignoreBlankLines：空行不参与内容差异，但行数差与修改仍计', { added: s.added, removed: s.removed, modified: s.modified }, { added: 1, removed: 2, modified: 1 });
s = diff.diffStat('X1\nsame\nX2\n', 'x1\nsame\nx2\n', { ignoreCase: true });
eq('组合维度 after 侧也有用', { added: s.added }, { added: 0 });

console.log('[diff] formatUnified 输出');
let u = diff.formatUnified('a\nb\nc\nd\ne\nf\ng\n', 'a\nb\nX\nY\ne\nf\ng\n', 40);
let lines = u.split('\n');
ok('带 hunk 头', lines[0].startsWith('@@ -'), lines[0]);
eq('中段改 2 行：2 del + 2 add', { del: lines.filter((x) => x.startsWith('-')).length, add: lines.filter((x) => x.startsWith('+')).length }, { del: 2, add: 2 });
ok('包含上下文行 e', lines.some((x) => /│ e$/.test(x)));
// 插入行后 ctx 错位标注「原→新」
u = diff.formatUnified('a\nb\nc\nd\n', 'a\nb\nb2\nc\nd\n', 40);
ok('插入后 ctx 行号错位标注', /3→4│ c/.test(u), u.split('\n').join(' | '));
// 分散改动切分多个 hunk
u = diff.formatUnified('k1\nx\nk2\nk3\nk4\nk5\nk6\nk7\ny\nk8\n', 'k1\nX\nk2\nk3\nk4\nk5\nk6\nk7\nY\nk8\n', 40, { context: 1 });
const hunkCount = u.split('\n').filter((l) => l.startsWith('@@')).length;
ok('两处远距离改动切为 2 个 hunk（实际 ' + hunkCount + ' 个）', hunkCount === 2, u);
// 截断
u = diff.formatUnified('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n', '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n', 4);
ok('maxLines 截断且尾部提示', u.split('\n').length <= 5 && /还有 \d+ 行/.test(u), u);
// CRLF 归一（历史兼容重点：CRLF vs LF 不得逐行误判）
s = diff.diffStat('a\r\nb\r\nc\r\n', 'a\nb\nc\n');
eq('CRLF→LF 归一后 0 变化', { added: s.added, removed: s.removed }, { added: 0, removed: 0 });
// 空输入
s = diff.diffStat('', '');
eq('空 vs 空：0 变化', { added: s.added, removed: s.removed, degraded: s.degraded }, { added: 0, removed: 0, degraded: false });
s = diff.diffStat('', 'a\nb\n');
eq('空 vs 有内容：全新增', { added: s.added, removed: s.removed }, { added: 2, removed: 0 });
// 超长行截断
const longA = 'x'.repeat(2000) + '\ny\n';
const longB = 'x'.repeat(2000) + 'z\ny\n';
u = diff.formatUnified(longA, longB, 40);
ok('超长行按 maxLineLength 截断（无 2000 字整行入预览）', u.split('\n').every((l) => l.length < 500), u.length);
u = diff.formatUnified(longA, longB, 40, { maxLineLength: 80 });
ok('maxLineLength 可配置为 80', u.split('\n').every((l) => l.length < 120), u.length);

console.log('[diff] wordDiff 行内词级标记');
u = diff.formatUnified('function add(a, b) { return a + b; }\n', 'function add(a, b) { return a * b; }\n', 40, { wordDiff: true });
ok('删除侧含 [-..-]', u.includes('[-+-]'), u);
ok('新增侧含 {+..+}', u.includes('{+*+}'), u);
u = diff.formatUnified('const done = !ok;\n', 'const done = ok;\n', 40, { wordDiff: true });
ok('词级 diff 保留行内空白与上下文', u.includes('const done = [-!-]ok;'), u);
// 默认（wordDiff=false）不带标记
u = diff.formatUnified('function add(a, b) { return a + b; }\n', 'function add(a, b) { return a * b; }\n', 40);
ok('默认无词级标记（兼容旧输出）', !u.includes('{+') && !u.includes('[-'), u);

console.log('[diff] 性能与降级');
// 大文件小改动：不降级、行对齐正确、快
const bigC = Array.from({ length: 8000 }, (_, i) => 'line' + i).join('\n');
const bigD = bigC.split('\n');
bigD[500] = 'CHANGED-A';
bigD[3000] = 'CHANGED-B';
bigD[7000] = 'CHANGED-C';
let t0 = Date.now();
s = diff.diffStat(bigC, bigD.join('\n'));
let ms = Date.now() - t0;
eq('8000 行改 3 行：不降级 + 精确统计', { added: s.added, removed: s.removed, modified: s.modified, degraded: s.degraded }, { added: 3, removed: 3, modified: 3, degraded: false });
ok('8000 行改 3 行耗时 < 300ms（实测 ' + ms + 'ms）', ms < 300);
// 大范围交错改动：走降级兜底也不崩、够快
const bigA2 = Array.from({ length: 8000 }, (_, i) => 'line' + i).join('\n');
const bigB2 = Array.from({ length: 8000 }, (_, i) => (i % 2 ? 'line' + i : 'CHANGED' + i)).join('\n');
t0 = Date.now();
s = diff.diffStat(bigA2, bigB2);
ms = Date.now() - t0;
ok('8000 行交错改：降级兜底 + <2s（实测 ' + ms + 'ms degraded=' + s.degraded + '）', ms < 2000 && s.added > 0);
// 降级输出也走 formatUnified（不崩）
u = diff.formatUnified(bigA2, bigB2, 40);
ok('降级时 formatUnified 正常输出', u.length > 0);

console.log('\n[diff] ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
