'use strict';

/**
 * 韧性·超时熔断统一护栏（纯逻辑，可独立单测）
 *
 * - ToolTimeoutError：超时抛出的结构化错误，isTimeout=true 便于上层识别。
 * - withTimeout(promiseFactory, ms)：给任意「工厂函数返回 promise」套硬超时。
 *   ms<=0 时不限制（直接放行），保证默认关时零侵入。
 * - CircuitBreaker：按工具维护失败计数，连续失败达上限即「熔断」（跳过调用，
 *   提示换路）；冷却期后自动半开恢复。避免一个坏掉的工具被反复调用烧 Token / 卡死。
 *
 * 设计要点：所有逻辑不依赖 vscode / config，方便扩展外单测。
 */

class ToolTimeoutError extends Error {
  constructor(message, ms) {
    super(message);
    this.name = 'ToolTimeoutError';
    this.isTimeout = true;
    this.ms = ms;
  }
}

function withTimeout(promiseFactory, ms) {
  if (!ms || ms <= 0) {
    // 不限制：直接转发，避免哪怕一帧的额外开销
    return Promise.resolve().then(() => promiseFactory());
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ToolTimeoutError(`工具执行超时（>${ms}ms），请改用其它方式或把任务拆小。`, ms));
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    Promise.resolve().then(() => promiseFactory()).then(
      (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

class CircuitBreaker {
  /**
   * @param {number} maxFailures 连续失败达到此值即熔断
   * @param {number} resetMs 熔断后冷却时长，到点自动半开恢复
   */
  constructor(maxFailures = 3, resetMs = 60000) {
    this.max = Math.max(1, maxFailures | 0);
    this.resetMs = Math.max(1000, resetMs | 0);
    this.failures = 0;
    this.openedAt = 0;
    this._open = false;
  }

  isOpen(now = Date.now()) {
    if (!this._open) return false;
    if (now - this.openedAt >= this.resetMs) {
      // 冷却期到，半开恢复
      this._open = false;
      this.failures = 0;
      this.openedAt = 0;
      return false;
    }
    return true;
  }

  recordFailure(now = Date.now()) {
    this.failures += 1;
    if (this.failures >= this.max) {
      this._open = true;
      this.openedAt = now;
    }
  }

  recordSuccess() {
    this.failures = 0;
    this._open = false;
    this.openedAt = 0;
  }
}

module.exports = { ToolTimeoutError, withTimeout, CircuitBreaker };
