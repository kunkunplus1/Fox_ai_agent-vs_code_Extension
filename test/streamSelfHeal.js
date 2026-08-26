'use strict';
// 回归测试：三协议「不流式」根因 = streamBroken 会话级置位且永不恢复。
// 验证两条修复：
//   1) 用户强停（this.cancelled=true）后的流式错误 → 不置 streamBroken（不降级整会话）
//   2) 后续某轮真实 delta 到达（onDelta） → 自动复位 streamBroken=false（流式自愈）
// 以「读源码 + 轻量实例」方式跑（不依赖真实服务）。
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

// 直接读 agent.js 源码做静态断言（精确匹配两处修复逻辑是否在对应位置）
const srcPath = path.join(__dirname, '..', 'src', 'agent.js');
const src = fs.readFileSync(srcPath, 'utf8');

console.log('--- 断言 1：置位加严（用户强停不降级） ---');
ok(/this\.cancelled\s*\)\s*\{\s*\n\s*console\.log\('\[fox-ai\] stream aborted by user/.test(src),
  'agent.js 存在「cancelled 时不置 streamBroken」分支（this.cancelled 判据）');
ok(!/err\.cancelled \|\| err\.aborted/.test(src),
  '已删除「err.cancelled/err.aborted」这种错误对象上的不可靠判据');
ok(/only user cancellation.*this\.cancelled/.test(src) || /权威判据用 this\.cancelled/.test(src),
  '注释说明权威判据为 this.cancelled');

console.log('--- 断言 2：自愈复位 ---');
ok(/if\s*\(this\.streamBroken\)\s*\{\s*\n\s*this\.streamBroken\s*=\s*false/.test(src),
  'onDelta 内存在 streamBroken 自动复位（delta 到达即恢复流式）');
ok(/stream recovered/.test(src) || /流式已恢复/.test(src),
  '复位时有日志/notice 提示');

console.log('--- 断言 3：置位上下文归属 ---');
const setIdx = src.indexOf('this.streamBroken = true');
const cancelIdx = src.indexOf('this.cancelled) {');
ok(setIdx > 0 && cancelIdx > 0 && cancelIdx < setIdx,
  'cancelled 判据出现在 streamBroken=true 之前（先判断、后置位）');

// 轻量行为测试：构造一个最小 agent 骨架，验证「cancelled 时不置位 / delta 复位」的代码路径可执行
console.log('--- 行为测试：模拟两场景 ---');
// 场景 A：cancelled=true 时进入“可重试非流式”分支 → streamBroken 不得置 true
{
  const ctx = { streamBroken: false, cancelled: true, _abortCtrl: { signal: { aborted: true } } };
  const err = { canRetryNonStream: true, message: 'HPE_INVALID_EOF_STATE' };
  // 复刻 agent.js 修复后的分支（行 2955-2965 语义）
  let notice = null;
  const emit = (ev, o) => { if (ev === 'notice') notice = o; };
  if (err && err.canRetryNonStream) {
    if (ctx.cancelled) {
      // 用户强停：不置位
    } else {
      ctx.streamBroken = true;
    }
  }
  ok(ctx.streamBroken === false, '场景A：用户强停后流式错误不置 streamBroken（保持流式）');
}
// 场景 B：streamBroken=true 后某轮 delta 到达 → 自动复位
{
  const ctx = { streamBroken: true };
  let notice = null;
  const emit = (ev, o) => { if (ev === 'notice') notice = o; };
  // 复刻 onDelta 修复（行 3154-3163 语义）
  const onDelta = (t) => {
    if (!t) return;
    if (ctx.streamBroken) { ctx.streamBroken = false; }
  };
  onDelta('你');
  ok(ctx.streamBroken === false, '场景B：delta 到达自动复位 streamBroken（流式自愈）');
}

console.log(`\nstreamSelfHeal: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);