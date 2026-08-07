'use strict';
// 韧性·超时熔断统一护栏 单元测试（纯逻辑，无 vscode 依赖）
const assert = require('assert');
const path = require('path');
const { withTimeout, CircuitBreaker, ToolTimeoutError } = require('../src/tools/timeoutGuard');

let pass = 0;
function ok(name, cond) {
  assert.ok(cond, 'FAIL: ' + name);
  pass += 1;
  console.log('  ✓ ' + name);
}

// ---- withTimeout ----
(async () => {
  // 不限制（ms<=0）直接放行
  ok('ms<=0 直接放行', await withTimeout(() => Promise.resolve('ok'), 0) === 'ok');

  // 正常完成不受超时影响
  ok('快速完成', await withTimeout(() => Promise.resolve(42), 1000) === 42);

  // 超时拒绝
  let threw = false;
  try {
    await withTimeout(() => new Promise((r) => setTimeout(r, 200)), 20);
  } catch (e) {
    threw = e instanceof ToolTimeoutError && e.isTimeout === true;
  }
  ok('超时抛 ToolTimeoutError', threw);

  // 拒绝错误透传（非超时）
  let passthrough = false;
  try {
    await withTimeout(() => Promise.reject(new Error('boom')), 1000);
  } catch (e) {
    passthrough = e.message === 'boom';
  }
  ok('非超时错误透传', passthrough);

  // ---- CircuitBreaker ----
  const cb = new CircuitBreaker(3, 60000);
  ok('初始关闭', cb.isOpen() === false);
  cb.recordSuccess();
  ok('成功保持关闭', cb.isOpen() === false);
  cb.recordFailure(); cb.recordFailure();
  ok('未达上限仍关闭', cb.isOpen() === false);
  cb.recordFailure();
  ok('达上限熔断', cb.isOpen() === true);
  cb.recordFailure();
  ok('熔断后继续开', cb.isOpen() === true);
  cb.recordSuccess();
  ok('成功后恢复', cb.isOpen() === false);

  // 冷却期恢复
  const cb2 = new CircuitBreaker(2, 5000);
  cb2.recordFailure(); cb2.recordFailure();
  ok('cb2 熔断', cb2.isOpen() === true);
  ok('冷却内仍开', cb2.isOpen(cb2.openedAt + 1000) === true);
  ok('冷却后自动半开恢复', cb2.isOpen(cb2.openedAt + 6000) === false);

  console.log('\n[timeoutGuard] 通过 ' + pass + ' 项断言');
})().catch((e) => { console.error(e); process.exit(1); });
