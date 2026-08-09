'use strict';

/**
 * test/checkpoints.js — 执行前快照与一键回滚（src/checkpoints.js）离线测试
 * 运行：node test/checkpoints.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CheckpointStore } = require('../src/checkpoints');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + ' → ' + (e && e.message));
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foxcp-'));
const wsRoot = path.join(tmp, 'ws');
const storeDir = path.join(tmp, 'store');
fs.mkdirSync(wsRoot, { recursive: true });

function newStore(id, extra) {
  return new CheckpointStore(Object.assign({ baseDir: storeDir, workspaceRoot: wsRoot, sessionId: id || 's1' }, extra || {}));
}
function wf(rel, content) {
  const p = path.join(wsRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}
function rd(rel) {
  const p = path.join(wsRoot, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

console.log('\n[checkpoints] 快照与回滚');

// ---------- 1. 快照记录 ----------
t('snapshot 记录写前内容并返回条目', () => {
  const s = newStore('t1');
  const e = s.snapshot('a.js', 'v1', { tool: 'edit_file' });
  assert.ok(e && e.id);
  assert.strictEqual(e.files.length, 1);
  assert.strictEqual(e.files[0].rel, 'a.js');
  assert.strictEqual(e.files[0].existed, true);
  assert.ok(e.files[0].hash);
});

t('文件不存在时 existed=false、hash=null', () => {
  const s = newStore('t2');
  const e = s.snapshot('new.js', null, { tool: 'write_file' });
  assert.strictEqual(e.files[0].existed, false);
  assert.strictEqual(e.files[0].hash, null);
});

t('相同内容复用同一 blob（去重）', () => {
  const s = newStore('t3');
  const e1 = s.snapshot('a.js', 'same', {});
  const e2 = s.snapshot('b.js', 'same', {});
  assert.strictEqual(e1.files[0].hash, e2.files[0].hash);
  const blobs = fs.readdirSync(path.join(storeDir, 'checkpoints', 't3', 'blobs'));
  assert.strictEqual(blobs.length, 1, '相同内容只应存一份 blob');
});

t('enabled=false 时不记录', () => {
  const s = newStore('t4', { enabled: false });
  assert.strictEqual(s.snapshot('a.js', 'x', {}), null);
  assert.strictEqual(s.entries.length, 0);
});

t('空路径被忽略', () => {
  const s = newStore('t5');
  assert.strictEqual(s.snapshot('', 'x', {}), null);
  assert.strictEqual(s.snapshot(null, 'x', {}), null);
});

// ---------- 2. 持久化 ----------
t('条目持久化，重建实例后仍可读', () => {
  const s = newStore('t6');
  s.snapshot('a.js', 'v1', { tool: 'edit_file' });
  s.snapshot('b.js', 'v2', { tool: 'edit_file' });
  const s2 = newStore('t6');
  assert.strictEqual(s2.entries.length, 2);
  assert.strictEqual(s2.entries[0].files[0].rel, 'a.js');
});

t('索引文件损坏时安全降级为空', () => {
  const dir = path.join(storeDir, 'checkpoints', 't7');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), '{{{ broken', 'utf8');
  const s = newStore('t7');
  assert.strictEqual(s.entries.length, 0);
});

t('不同 sessionId 互相隔离', () => {
  const a = newStore('sa');
  const b = newStore('sb');
  a.snapshot('a.js', 'x', {});
  assert.strictEqual(b.entries.length, 0);
});

// ---------- 3. 回滚：还原内容 ----------
t('回滚把文件还原成快照内容', () => {
  const s = newStore('r1');
  wf('code.js', '原始内容');
  s.snapshot('code.js', '原始内容', { tool: 'edit_file' });
  wf('code.js', '被改坏了');
  assert.strictEqual(rd('code.js'), '被改坏了');
  const r = s.rollbackTo(s.entries[0].id);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.restored, ['code.js']);
  assert.strictEqual(rd('code.js'), '原始内容');
});

t('回滚会删除快照时不存在的新建文件', () => {
  const s = newStore('r2');
  s.snapshot('brand-new.js', null, { tool: 'write_file' });
  wf('brand-new.js', '新文件内容');
  assert.strictEqual(rd('brand-new.js'), '新文件内容');
  const r = s.rollbackTo(s.entries[0].id);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.deleted, ['brand-new.js']);
  assert.strictEqual(rd('brand-new.js'), null);
});

t('多次改同一文件时，回滚到最早那次的内容', () => {
  const s = newStore('r3');
  wf('multi.js', 'v1');
  s.snapshot('multi.js', 'v1', {});
  wf('multi.js', 'v2');
  s.snapshot('multi.js', 'v2', {});
  wf('multi.js', 'v3');
  const r = s.rollbackTo(s.entries[0].id);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(rd('multi.js'), 'v1', '应回到最早快照，而非中间态');
});

t('回滚到中间检查点只影响其后的改动', () => {
  const s = newStore('r4');
  wf('x.js', 'x0');
  wf('y.js', 'y0');
  s.snapshot('x.js', 'x0', {}); // entry0
  wf('x.js', 'x1');
  const mid = s.snapshot('y.js', 'y0', {}); // entry1
  wf('y.js', 'y1');
  const r = s.rollbackTo(mid.id);
  assert.strictEqual(rd('y.js'), 'y0', 'y 应被还原');
  assert.strictEqual(rd('x.js'), 'x1', 'x 在检查点之前已改，不应被还原');
});

t('一次回滚可还原多个文件', () => {
  const s = newStore('r5');
  wf('m1.js', 'a');
  wf('m2.js', 'b');
  const first = s.snapshot('m1.js', 'a', {});
  s.snapshot('m2.js', 'b', {});
  wf('m1.js', 'A');
  wf('m2.js', 'B');
  const r = s.rollbackTo(first.id);
  assert.strictEqual(r.restored.length, 2);
  assert.strictEqual(rd('m1.js'), 'a');
  assert.strictEqual(rd('m2.js'), 'b');
});

t('dryRun 只预演不落盘', () => {
  const s = newStore('r6');
  wf('dry.js', '原始');
  s.snapshot('dry.js', '原始', {});
  wf('dry.js', '改动');
  const r = s.rollbackTo(s.entries[0].id, { dryRun: true });
  assert.deepStrictEqual(r.restored, ['dry.js']);
  assert.strictEqual(rd('dry.js'), '改动', 'dryRun 不应真的写文件');
  assert.strictEqual(s.entries.length, 1, 'dryRun 不应丢弃历史');
});

t('回滚后丢弃该检查点及之后的历史', () => {
  const s = newStore('r7');
  wf('h.js', 'v1');
  s.snapshot('h.js', 'v1', {});
  wf('h.js', 'v2');
  s.snapshot('h.js', 'v2', {});
  assert.strictEqual(s.entries.length, 2);
  s.rollbackTo(s.entries[0].id);
  assert.strictEqual(s.entries.length, 0);
});

t('回滚不存在的 id 返回错误而非抛异常', () => {
  const s = newStore('r8');
  const r = s.rollbackTo('nope');
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('找不到'));
});

t('undoLast 撤销最近一次改动', () => {
  const s = newStore('r9');
  wf('u.js', '好的代码');
  s.snapshot('u.js', '好的代码', {});
  wf('u.js', '坏的代码');
  const r = s.undoLast();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(rd('u.js'), '好的代码');
});

t('无检查点时 undoLast 返回错误', () => {
  const s = newStore('r10');
  const r = s.undoLast();
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('没有可回滚'));
});

t('blob 丢失时标记 failed 而不崩', () => {
  const s = newStore('r11');
  wf('lost.js', '内容');
  const e = s.snapshot('lost.js', '内容', {});
  fs.unlinkSync(path.join(storeDir, 'checkpoints', 'r11', 'blobs', e.files[0].hash));
  const r = s.rollbackTo(e.id);
  assert.strictEqual(r.ok, false);
  assert.ok(r.failed[0].includes('快照内容丢失'));
});

// ---------- 4. 手动检查点 ----------
t('createManual 记录多个文件当前内容', () => {
  const s = newStore('m1');
  wf('p1.js', 'AAA');
  wf('p2.js', 'BBB');
  const e = s.createManual('重构前', ['p1.js', 'p2.js']);
  assert.strictEqual(e.kind, 'manual');
  assert.strictEqual(e.label, '重构前');
  assert.strictEqual(e.files.length, 2);
  assert.ok(e.files.every((f) => f.existed));
});

t('手动检查点可回滚全部文件', () => {
  const s = newStore('m2');
  wf('q1.js', 'old1');
  wf('q2.js', 'old2');
  const e = s.createManual('里程碑', ['q1.js', 'q2.js']);
  wf('q1.js', 'new1');
  wf('q2.js', 'new2');
  s.rollbackTo(e.id);
  assert.strictEqual(rd('q1.js'), 'old1');
  assert.strictEqual(rd('q2.js'), 'old2');
});

t('createManual 对不存在的文件记 existed=false', () => {
  const s = newStore('m3');
  const e = s.createManual('x', ['ghost.js']);
  assert.strictEqual(e.files[0].existed, false);
});

// ---------- 5. 上限、GC、描述 ----------
t('超出 maxSnapshots 时丢弃最旧条目', () => {
  const s = newStore('g1', { maxSnapshots: 3 });
  for (let i = 0; i < 6; i++) s.snapshot('f' + i + '.js', 'c' + i, {});
  assert.strictEqual(s.entries.length, 3);
  assert.strictEqual(s.entries[0].files[0].rel, 'f3.js');
});

t('gc 清理无人引用的 blob', () => {
  const s = newStore('g2', { maxSnapshots: 1 });
  s.snapshot('a.js', 'contentA', {});
  s.snapshot('b.js', 'contentB', {});
  const before = fs.readdirSync(path.join(storeDir, 'checkpoints', 'g2', 'blobs')).length;
  assert.strictEqual(before, 2);
  const removed = s.gc();
  assert.strictEqual(removed, 1);
  assert.strictEqual(fs.readdirSync(path.join(storeDir, 'checkpoints', 'g2', 'blobs')).length, 1);
});

t('clear 清空全部', () => {
  const s = newStore('g3');
  s.snapshot('a.js', 'x', {});
  s.clear();
  assert.strictEqual(s.entries.length, 0);
  assert.strictEqual(newStore('g3').entries.length, 0);
});

t('list 最新在前且可限量', () => {
  const s = newStore('g4');
  s.snapshot('1.js', 'a', {});
  s.snapshot('2.js', 'b', {});
  s.snapshot('3.js', 'c', {});
  const l = s.list(2);
  assert.strictEqual(l.length, 2);
  assert.strictEqual(l[0].files[0].rel, '3.js');
});

t('describe 无数据时给出提示', () => {
  assert.ok(newStore('g5').describe().includes('暂无检查点'));
});

t('describe 列出条目与文件', () => {
  const s = newStore('g6');
  s.snapshot('src/app.js', 'x', { tool: 'edit_file', title: '修改 src/app.js' });
  const d = s.describe();
  assert.ok(d.includes('src/app.js'));
  assert.ok(d.includes('修改'));
});

t('绝对路径与相对路径指向同一文件', () => {
  const s = newStore('g7');
  wf('abs.js', 'v1');
  const e = s.snapshot(path.join(wsRoot, 'abs.js'), 'v1', {});
  assert.strictEqual(e.files[0].rel, 'abs.js');
  wf('abs.js', 'v2');
  s.rollbackTo(e.id);
  assert.strictEqual(rd('abs.js'), 'v1');
});

console.log(`\n[checkpoints] ${pass} 通过 / ${fail} 失败`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
