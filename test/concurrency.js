'use strict';

// 纯离线测试：并发信号量 createLimiter 的真实行为（agent.js / mcp.js 共用此模块）
const assert = require('assert');
const { createLimiter } = require('../src/concurrency');

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // 1) 并发上限：同时发起 6 个任务，容量 2，任意时刻 active 不得超过 2
  {
    const lim = createLimiter(2);
    let maxSeen = 0;
    const tasks = [];
    for (let i = 0; i < 6; i++) {
      tasks.push(
        lim.run(async () => {
          maxSeen = Math.max(maxSeen, lim.active);
          await delay(15);
          return i;
        })
      );
    }
    const results = await Promise.all(tasks);
    assert.strictEqual(maxSeen, 2, '并发不应超过容量 2，实际峰值=' + maxSeen);
    assert.deepStrictEqual(results.sort(), [0, 1, 2, 3, 4, 5], '所有任务都应完成且返回正确');
    assert.strictEqual(lim.active, 0, '全部结束后 active 应归零');
    assert.strictEqual(lim.pending, 0, '全部结束后 pending 应归零');
  }

  // 2) 排队顺序：超容量时任务应排队，先到先得（前 2 个先跑，后到的等待）
  {
    const lim = createLimiter(1);
    const order = [];
    const tasks = [];
    for (let i = 0; i < 3; i++) {
      tasks.push(
        lim.run(async () => {
          order.push('start' + i);
          await delay(10);
          order.push('end' + i);
          return i;
        })
      );
    }
    await Promise.all(tasks);
    assert.deepStrictEqual(order, ['start0', 'end0', 'start1', 'end1', 'start2', 'end2'], '串行时严格 FIFO');
  }

  // 3) 异常安全：任务抛错仍释放名额，后续任务能继续跑，异常向上传播
  {
    const lim = createLimiter(2);
    let threw = false;
    try {
      await lim.run(async () => {
        await delay(5);
        throw new Error('boom');
      });
    } catch (e) {
      threw = e.message === 'boom';
    }
    assert.ok(threw, '异常应原样向上传播');
    assert.strictEqual(lim.active, 0, '异常后名额必须释放');
    const ok = await lim.run(async () => 'recovered');
    assert.strictEqual(ok, 'recovered', '释放后新任务应正常执行');
  }

  // 4) 容量下限保护：max<1 时按 1 处理
  {
    const lim = createLimiter(0);
    let maxSeen = 0;
    await Promise.all([
      lim.run(async () => { maxSeen = Math.max(maxSeen, lim.active); await delay(10); }),
      lim.run(async () => { maxSeen = Math.max(maxSeen, lim.active); await delay(10); })
    ]);
    assert.strictEqual(maxSeen, 1, '容量 0 应被钳为 1，实际峰值=' + maxSeen);
  }

  console.log('concurrency: PASS (4 groups, all assertions passed)');
}

main().catch((e) => {
  console.error('concurrency: FAIL', e);
  process.exit(1);
});
