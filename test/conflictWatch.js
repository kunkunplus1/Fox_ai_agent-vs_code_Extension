'use strict';

// 冲突感知单测：纯 Node、零 vscode 依赖，覆盖快照/比对/刷新/边界。
const assert = require('assert');
const cw = require('../src/conflictWatch');

let pass = 0, fail = 0;
function ok(name, cond) {
  try { assert.ok(cond, name); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ' -> ' + e.message); }
}

console.log('冲突感知: 基础比对');
ok('无快照不误报', cw.check('/a', 100, 10).conflict === false);
cw.recordRead('/a', 100, 10);
ok('同状态不报冲突', cw.check('/a', 100, 10).conflict === false);
ok('mtime 更新报冲突', cw.check('/a', 200, 10).conflict === true);
ok('冲突回带快照', (() => { const v = cw.check('/a', 200, 10); return v.conflict && v.snapshot.mtime === 100 && v.current.mtime === 200; })());
ok('同 mtime 但 size 变也报冲突', cw.check('/a', 100, 20).conflict === true);

console.log('冲突感知: 写入刷新');
cw.noteWrite('/a', 200, 20);
ok('noteWrite 后新状态不报冲突', cw.check('/a', 200, 20).conflict === false);
ok('noteWrite 后仍比旧状态冲突', cw.check('/a', 300, 20).conflict === true);

console.log('冲突感知: 边界与清理');
ok('path 为空不报错', cw.check('', 1, 1).conflict === false);
cw.recordRead('', 1, 1); // 不应抛错
cw.invalidate();
ok('invalidate 后无快照', cw.check('/a', 200, 10).conflict === false);

console.log('冲突感知: 有界缓存');
cw.invalidate();
const N = cw.MAX_CACHE + 50;
for (let i = 0; i < N; i++) cw.recordRead('/f' + i, i, i);
ok('缓存不超过上限', cw.cacheSize() <= cw.MAX_CACHE);
ok('最早写入被淘汰（/f0 不再有快照）', cw.check('/f0', 999, 999).conflict === false);
ok('较晚写入仍在（/f' + (N - 1) + ' 有快照）', cw.check('/f' + (N - 1), 5, 5).conflict === false);

console.log('\n冲突感知测试: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
