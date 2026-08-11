'use strict';

/**
 * grammar 探测模块测试（1.1.19）。
 * 通过注入假 requestImpl（不发真实网络请求）验证三种结局：
 *   1) 服务端支持 → 秒回 200 → supported=true
 *   2) 服务端挂起 → 超时 → supported=false（reason=timeout-hang）
 *   3) 服务端显式拒绝（400/grammar 报错）→ supported=false
 *   4) 空响应 → supported=false
 * 另测：grammarMode 三态映射、endpointFor 拼接、缓存只探一次。
 */

const grammarProbe = require('../src/grammarProbe');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗', name); }
}

// 构造一个可定制的假请求实现：根据 url/body 决定返回或抛错
function fakeRequest({ mode, errorMsg }) {
  return async function (url, opts) {
    // 断言探测确实带了 grammar（区分于普通对话请求）
    const body = opts && opts.body;
    if (!body || body.grammar !== grammarProbe.PROBE_GRAMMAR) {
      throw new Error('probe must send PROBE_GRAMMAR');
    }
    if (mode === 'ok') return { choices: [{ message: { content: 'ok' } }] };
    if (mode === 'empty') return {};
    if (mode === 'reject') {
      const e = new Error(errorMsg || '400 Bad Request: grammar not supported');
      e.status = 400;
      throw e;
    }
    if (mode === 'timeout') {
      const e = new Error(errorMsg || '请求超时');
      e.code = 'ETIMEDOUT';
      throw e;
    }
    throw new Error('unknown fake mode');
  };
}

(async () => {
  // 每次用例前清空缓存
  grammarProbe.resetProbeCache();

  console.log('[grammarProbe] 1) 服务端支持 grammar → supported=true');
  {
    let calls = 0;
    const impl = fakeRequest({ mode: 'ok' });
    const wrapped = async (u, o) => { calls++; return impl(u, o); };
    const r = await grammarProbe.grammarSupported({ baseUrl: 'http://127.0.0.1:8080/v1', requestImpl: wrapped });
    check('supported = true', r.supported === true);
    check('source = probe', r.source === 'probe');
    check('durationMs 为数字', typeof r.durationMs === 'number');
  }

  console.log('[grammarProbe] 2) 服务端挂起（超时）→ supported=false, reason=timeout-hang');
  {
    grammarProbe.resetProbeCache();
    const r = await grammarProbe.grammarSupported({ baseUrl: 'http://127.0.0.1:8080/v1', requestImpl: fakeRequest({ mode: 'timeout' }) });
    check('supported = false', r.supported === false);
    check('reason = timeout-hang', r.reason === 'timeout-hang');
  }

  console.log('[grammarProbe] 3) 服务端显式拒绝（400）→ supported=false');
  {
    grammarProbe.resetProbeCache();
    const r = await grammarProbe.grammarSupported({ baseUrl: 'http://127.0.0.1:8080/v1', requestImpl: fakeRequest({ mode: 'reject', errorMsg: '400 grammar param unsupported' }) });
    check('supported = false', r.supported === false);
    check('reason 含拒绝信息', /grammar/.test(r.reason || ''));
  }

  console.log('[grammarProbe] 4) 空响应 → supported=false');
  {
    grammarProbe.resetProbeCache();
    const r = await grammarProbe.grammarSupported({ baseUrl: 'http://127.0.0.1:8080/v1', requestImpl: fakeRequest({ mode: 'empty' }) });
    check('supported = false', r.supported === false);
    check('reason = empty-or-unexpected-response', r.reason === 'empty-or-unexpected-response');
  }

  console.log('[grammarProbe] 5) 缓存：同 baseUrl 只探测一次');
  {
    grammarProbe.resetProbeCache();
    let calls = 0;
    const wrapped = async (u, o) => { calls++; return fakeRequest({ mode: 'ok' })(u, o); };
    await grammarProbe.grammarSupported({ baseUrl: 'http://127.0.0.1:8080/v1', requestImpl: wrapped });
    await grammarProbe.grammarSupported({ baseUrl: 'http://127.0.0.1:8080/v1', requestImpl: wrapped });
    await grammarProbe.grammarSupported({ baseUrl: 'http://127.0.0.1:8080/v1', requestImpl: wrapped });
    check('三次请求只探测了一次', calls === 1);
  }

  console.log('[grammarProbe] 6) 不同 baseUrl 各自探测');
  {
    grammarProbe.resetProbeCache();
    let calls = 0;
    const wrapped = async (u, o) => { calls++; return fakeRequest({ mode: 'ok' })(u, o); };
    await grammarProbe.grammarSupported({ baseUrl: 'http://127.0.0.1:8080/v1', requestImpl: wrapped });
    await grammarProbe.grammarSupported({ baseUrl: 'http://127.0.0.1:1234/v1', requestImpl: wrapped });
    check('两个不同端点各探一次（共 2 次）', calls === 2);
  }

  console.log('[grammarProbe] 7) endpointFor 拼接规则');
  {
    check('带 /v1 后缀不重复加', grammarProbe.endpointFor('http://127.0.0.1:8080/v1') === 'http://127.0.0.1:8080/v1/chat/completions');
    check('带尾部 / 被去掉', grammarProbe.endpointFor('http://127.0.0.1:8080/v1/') === 'http://127.0.0.1:8080/v1/chat/completions');
    check('无后缀补 /chat/completions', grammarProbe.endpointFor('http://127.0.0.1:8080') === 'http://127.0.0.1:8080/chat/completions');
  }

  console.log('[grammarProbe] 8) grammarMode 三态映射');
  {
    check("false → 'off'", grammarProbe.grammarMode(false) === 'off');
    check("'off' → 'off'", grammarProbe.grammarMode('off') === 'off');
    check("true → 'force'", grammarProbe.grammarMode(true) === 'force');
    check("'on' → 'force'", grammarProbe.grammarMode('on') === 'force');
    check("'auto' → 'auto'", grammarProbe.grammarMode('auto') === 'auto');
    check('undefined → auto（默认）', grammarProbe.grammarMode(undefined) === 'auto');
    check("'' → auto", grammarProbe.grammarMode('') === 'auto');
  }

  console.log(`\n[grammarProbe] 通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})();
