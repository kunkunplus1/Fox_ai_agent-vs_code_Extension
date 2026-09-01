'use strict';
// 探针2：验证命令行写文件 → diff 记录链路（模拟 agent.js 4501-4525 逻辑）
const crypto = require('crypto');
function fp(s) { return crypto.createHash('sha1').update(String(s || ''), 'utf8').digest('hex').slice(0, 8); }

// 模拟文件系统（before/after）
const disk = { 'note.md': 'hello world\nline2\n' };

function simulate(cmdStr) {
  const pendingReview = [];
  let output = '$ ' + cmdStr + '\n[spawn · 成功]\n(已执行)';

  // 模拟 _isCmdFileWrite
  const isWrite = /\b(echo|printf)\b[\s\S]*(>>?)\s*[\w\\/.\-]+\.\w{1,10}/.test(cmdStr) ||
    /\bsed\s+(-[a-z]*i[a-z]*)\b/.test(cmdStr);
  if (!isWrite) return { recorded: false, pendingReview };

  // 模拟执行后磁盘变化
  const target = 'note.md';
  disk[target] = 'hello world\nline2\n# appended by cmd\n';

  // 记录 diff（模拟 agent.js 4507-4516）
  const before = 'hello world\nline2\n';
  const after = disk[target];
  const diffStat = { added: 1, removed: 0 };
  const summary = '修改 ' + target + '（+' + diffStat.added + ' -' + diffStat.removed + '）：\n- # appended by cmd';
  pendingReview.push({ name: 'run_command', op: '命令行写文件', path: target, summary });
  output += '\n[观察] 检测到该命令可能修改了文件「' + target + '」。命令行改文件同样会进入改动记录与代码审查...';

  return { recorded: pendingReview.length > 0, summary, hasObserve: output.includes('[观察]') };
}

// 场景1：echo 重定向改文件 → 应记录
const r1 = simulate('echo "# appended by cmd" >> note.md');
console.log('场景1 echo>>改文件:', r1.recorded ? '✓ 记录 diff' : '✗ 未记录', '| 审查摘要:', r1.summary ? '✓' : '✗', '| 观察提示:', r1.hasObserve ? '✓' : '✗');

// 场景2：纯读命令 → 不应记录
const r2 = simulate('cat note.md');
console.log('场景2 cat读文件:', r2.recorded ? '✗ 误记录' : '✓ 不记录');

// 场景3：sed -i 改文件 → 应记录
const r3 = simulate('sed -i s/foo/bar/g note.md');
console.log('场景3 sed -i改文件:', r3.recorded ? '✓ 记录 diff' : '✗ 未记录');

console.log('\n链路验证完成');
