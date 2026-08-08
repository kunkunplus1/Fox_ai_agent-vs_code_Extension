'use strict';

/**
 * 通用并发信号量（零依赖，可离线测试）。
 * 用于把某一类异步操作的「同时进行的请求数」压到 max，超出则排队等待，
 * 避免瞬间并发过多把内存 / CPU / 网络打爆。
 *
 * 典型用途：
 *   - LLM 请求限流（agent.js）：跨所有 session / 面板限制同时飞向模型的请求数。
 *   - MCP 远程工具调用限流（mcp.js）：限制同时进行的浏览器 / 网络类慢 IO 操作。
 *
 * 用法：
 *   const limiter = createLimiter(2);
 *   await limiter.run(() => someAsyncWork());
 * run 内部无论成功还是抛错，都会释放一个名额；异常会原样向上传播。
 */
function createLimiter(max) {
  const cap = Math.max(1, max | 0);
  let active = 0;
  const waiters = [];

  function acquire() {
    if (active < cap) {
      active++;
      return Promise.resolve();
    }
    // 超出容量：排队，等有人 release 后再被唤醒
    return new Promise((resolve) => waiters.push(resolve));
  }

  function release() {
    active = Math.max(0, active - 1);
    const next = waiters.shift();
    if (next) next();
  }

  async function run(fn) {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return {
    run,
    /** 当前正在进行的请求数（测试 / 观测用） */
    get active() {
      return active;
    },
    /** 正在排队的请求数 */
    get pending() {
      return waiters.length;
    }
  };
}

module.exports = { createLimiter };
