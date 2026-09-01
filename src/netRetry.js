/**
 * 网络重试策略模块（agent.js 巨石拆分第二刀，对齐 dsh llm-retry）。
 * 纯函数：可取消等待 / 指数退避 / 网络错误判定，供 agent 与 CLI 复用。
 */

/** 可取消等待：传入取消信号，等待期间被 abort 返回 false。 */
async function sleep(ms, abortCtrl) {
  if (abortCtrl && abortCtrl.signal && abortCtrl.signal.aborted) return false;
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (abortCtrl && abortCtrl.signal) { try { abortCtrl.signal.removeEventListener('abort', onAbort); } catch (_) {} } done = true; resolve(true); }, ms);
    const onAbort = () => { if (done) return; clearTimeout(t); resolve(false); };
    if (abortCtrl && abortCtrl.signal) abortCtrl.signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 网络错误指数退避：initial 500ms，翻倍，上限 10s，±20% jitter（对齐 dsh retryPolicy）。 */
function networkRetryDelay(attempt, retryAfterMs) {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, 15000); // 尊重服务端 Retry-After，封顶 15s
  const exponent = Math.min(attempt - 1, 6);
  const base = Math.min(500 * Math.pow(2, exponent), 10000);
  const jitter = 0.8 + 0.4 * Math.random(); // 0.8~1.2
  return Math.round(base * jitter);
}

/** 是否网络类错误（可安全退避重试）：超时/断连/5xx/限流。参数协商类（grammar/图/思考）不算。 */
function isNetworkError(err) {
  if (!err) return false;
  const code = String(err.code || '');
  if (code === 'RATE_LIMIT' || code === 'HTTP_5XX' || code === 'NETWORK') return true;
  if (err.network === true) return true;
  const m = String(err.message || '');
  if (/timeout|etimedout|econnreset|econnrefused|socket hang up|ECONN|ENOTFOUND|请求超时|连接被重置|连不上|限流|429|5\d\d/i.test(m)) return true;
  return false;
}

module.exports = { sleep, networkRetryDelay, isNetworkError };
