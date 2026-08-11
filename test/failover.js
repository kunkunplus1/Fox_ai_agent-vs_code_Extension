'use strict';

/**
 * 失败降级 / 自动 failover · 配置层 + 错误分类测试（1.1.20）：
 * 1) config.resolve 正确解析 foxAi.failover（默认关闭 / 启用 + 本地与云端混合 / maxRetries 截断）；
 * 2) Agent._errClass / _isFailoverError 正确归类触发错误。
 */

const Module = require('module');
const origLoad = Module._load;

const store = {};
function setStore(o) {
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, o);
}

const configObj = {
  get: (k, d) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d),
  update: async () => {},
  inspect: () => ({})
};
const vscodeMock = {
  workspace: { getConfiguration: () => configObj, workspaceFolders: [] },
  secrets: { get: async () => '', store: async () => {}, delete: async () => {} },
  window: {
    createOutputChannel: () => ({ append() {}, appendLine() {}, show() {} }),
    showErrorMessage() {}, showInformationMessage: async () => {}, showWarningMessage() {}
  },
  env: { machineId: 't', sessionId: 't', language: 'zh-cn' },
  Uri: { parse: (s) => ({ fsPath: s, toString: () => s }) },
  extensions: { getExtension: () => null, all: [] }
};
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const config = require('../src/config');
let Agent = null;
try {
  Agent = require('../src/agent');
} catch (e) {
  console.error('[failover] 加载 agent.js 失败（分类测试跳过）：', e && e.message);
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗', name); }
}

const ctx = { secrets: { get: async () => '' } };

(async () => {
  console.log('[failover] 1) 默认关闭');
  setStore({});
  let c = await config.resolve(ctx);
  check('默认 failover.enabled=false', c.failover.enabled === false);
  check('默认 triggers 含 timeout/connection/serverError',
    c.failover.triggers.has('timeout') && c.failover.triggers.has('connection') && c.failover.triggers.has('serverError'));
  check('默认 targets 为空', c.failover.targets.length === 0);

  console.log('[failover] 2) 启用 + 本地与云端混合配置');
  setStore({
    failover: {
      enabled: true,
      maxRetries: 5,
      targets: [
        { name: 'local', baseUrl: 'http://127.0.0.1:8080/v1/', model: 'qwen2.5:7b', local: true },
        { name: 'cloud', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-xxx', model: 'gpt-4o', local: false }
      ]
    }
  });
  c = await config.resolve(ctx);
  check('enabled=true', c.failover.enabled === true);
  check('targets 数量=2（受 maxRetries 截断）', c.failover.targets.length === 2);
  check('本地 target 不带 apiKey、去尾斜杠',
    c.failover.targets[0].apiKey === '' && c.failover.targets[0].baseUrl === 'http://127.0.0.1:8080/v1' && c.failover.targets[0].local === true);
  check('云端 target 带 apiKey',
    c.failover.targets[1].apiKey === 'sk-xxx' && c.failover.targets[1].local === false);
  check('name 回退默认「备用N」', c.failover.targets[0].name === 'local');

  console.log('[failover] 3) maxRetries 截断');
  setStore({
    failover: {
      enabled: true,
      maxRetries: 1,
      targets: [
        { baseUrl: 'http://a/v1', model: 'm1' },
        { baseUrl: 'http://b/v1', model: 'm2' },
        { baseUrl: 'http://c/v1', model: 'm3' }
      ]
    }
  });
  c = await config.resolve(ctx);
  check('maxRetries=1 → 仅前 1 个 target 生效', c.failover.targets.length === 1);
  check('无 name 时回退「备用1」', c.failover.targets[0].name === '备用1');

  console.log('[failover] 4) triggers 自定义');
  setStore({ failover: { enabled: true, triggers: ['timeout', 'emptyResponse'], targets: [{ baseUrl: 'http://a/v1', model: 'm' }] } });
  c = await config.resolve(ctx);
  check('自定义 triggers 生效（含 emptyResponse，不含 serverError）',
    c.failover.triggers.has('timeout') && c.failover.triggers.has('emptyResponse') && !c.failover.triggers.has('serverError'));

  if (Agent) {
    console.log('[failover] 5) 错误分类 _errClass / _isFailoverError');
    const AS = Agent.AgentSession;
    // 让测试上下文继承 AgentSession.prototype，使 _isFailoverError 内部能调到 this._errClass
    const fctx = Object.create(AS.prototype);
    fctx._failover = { enabled: true, triggers: new Set(['timeout', 'connection', 'serverError', 'rateLimit', 'emptyResponse']), targets: [] };
    const cls = (err) => fctx._errClass(err);
    check('timeout 分类', cls(new Error('request timeout ETIMEDOUT')) === 'timeout');
    check('connection 分类', cls(new Error('connect ECONNREFUSED 127.0.0.1:8080')) === 'connection');
    check('serverError 分类(503)', cls(new Error('503 Service Unavailable')) === 'serverError');
    check('serverError 分类(status>=500)', cls({ status: 502, message: 'bad gateway' }) === 'serverError');
    check('rateLimit 分类(429 status)', cls({ status: 429, message: 'Too Many Requests' }) === 'rateLimit');
    check('rateLimit 分类(文本)', cls(new Error('429 rate limit exceeded')) === 'rateLimit');
    check('other 分类(400 参数错)', cls(new Error('400 Bad Request invalid grammar')) === 'other');

    check('命中触发 → true', fctx._isFailoverError(new Error('timeout')) === true);
    check('other(400) → false（不切换）', fctx._isFailoverError(new Error('400 Bad Request')) === false);

    const offCtx = Object.create(AS.prototype);
    offCtx._failover = { enabled: false, triggers: new Set(['timeout']), targets: [] };
    check('未启用 → false', offCtx._isFailoverError(new Error('timeout')) === false);
  } else {
    console.log('  (跳过分类测试：agent 未加载)');
  }

  console.log(`\n[failover] 通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
