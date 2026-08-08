'use strict';

/**
 * 离线测试：余额/限流自动终止 + 审查子代理可被取消中止。
 * - isQuotaError 识别 402/403/429 / 中文额度不足 / insufficient balance
 * - AgentSession.cancel() 中止 _abortCtrl，_silentCall 在取消后抛 Cancelled
 * - requestJson / chatNonStream 透传 signal，abort 后立即 reject
 * 运行：node test/quotaAbort.js
 */

const Module = require('module');
const http = require('http');
const assert = require('assert');

/* ---------- mock vscode ---------- */
const vscodeMock = {
  workspace: { workspaceFolders: null, getConfiguration: () => ({ get: (k, d) => d, update: async () => {} }), textDocuments: [], fs: {} },
  window: { activeTextEditor: null, activeTerminal: null, tabGroups: { all: [] } },
  languages: { getDiagnostics: () => [] },
  commands: { executeCommand: async () => {} },
  env: { clipboard: { readText: async () => '', writeText: async () => {} } },
  Uri: { file: (p) => ({ fsPath: p, toString: () => 'file://' + p }), joinPath: () => ({}) },
  Position: class {}, Range: class {}, Selection: class {}, ThemeIcon: class {},
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  FileType: { File: 1, Directory: 2 }, InlineCompletionItem: class {},
  ConfigurationTarget: { Global: 1 }, TextEditorRevealType: { InCenter: 2 }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const client = require('../src/client');
const { AgentSession, QuotaError, isQuotaError, Cancelled } = require('../src/agent');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' :: ' + (e && e.message)); }
}

async function main() {
  // 1) QuotaError 自身
  const qe = new QuotaError('余额不足');
  await check('QuotaError 是 Error 子类且 isQuota=true', () => {
    assert.ok(qe instanceof Error);
    assert.strictEqual(qe.isQuota, true);
  });

  // 2) isQuotaError 识别
  await check('isQuotaError 识别 insufficient balance', () => assert.ok(isQuotaError(new Error('insufficient balance'))));
  await check('isQuotaError 识别中文“额度不足”', () => assert.ok(isQuotaError(new Error('你的额度不足了'))));
  await check('isQuotaError 识别英文 quota / credit', () => {
    assert.ok(isQuotaError(new Error('your quota is exhausted')));
    assert.ok(isQuotaError(new Error('out of credit')));
  });
  await check('isQuotaError 识别 402/403/429 状态码', () => {
    assert.ok(isQuotaError(Object.assign(new Error('x'), { status: 402 })));
    assert.ok(isQuotaError(Object.assign(new Error('x'), { status: 403 })));
    assert.ok(isQuotaError(Object.assign(new Error('x'), { status: 429 })));
    assert.ok(!isQuotaError(Object.assign(new Error('x'), { status: 500 })));
  });
  await check('isQuotaError 不误判普通错误', () => assert.ok(!isQuotaError(new Error('connection reset by peer'))));

  // 3) AgentSession 取消链路
  const s = new AgentSession({
    cfg: { baseUrl: 'http://x', apiKey: 'k', model: 'm', temperature: 0, maxTokens: 0, timeout: 1000, insecureHttpParser: false, visionMode: 'off' },
    ui: {}, messages: [], alwaysAllow: new Set(),
    harness: { taskManager: { updateState: async () => {}, appendStep: async () => {} } },
    planTasks: {}, sessionId: 's1'
  });
  await check('cancel() 置 cancelled 并中止 _abortCtrl', () => {
    s.cancel();
    assert.strictEqual(s.cancelled, true);
    assert.ok(s._abortCtrl && s._abortCtrl.signal.aborted === true);
  });
  await check('_silentCall 在 cancelled 时立即抛 Cancelled（不再发请求）', async () => {
    let threw = false;
    try { await s._silentCall([{ role: 'user', content: 'hi' }]); } catch (e) { threw = (e instanceof Cancelled); }
    assert.ok(threw, '应抛出 Cancelled');
  });

  // 4) requestJson / chatNonStream 的 signal 中止（本地 server 延迟响应）
  const server = http.createServer((req, res) => { setTimeout(() => { res.writeHead(200); res.end('{}'); }, 3000); });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;

  await check('requestJson 在 signal.abort 后立即 reject', async () => {
    const ctrl = new AbortController();
    const p = client.requestJson(base + '/x', { method: 'GET', apiKey: 'k', signal: ctrl.signal });
    ctrl.abort();
    let rejected = false;
    try { await p; } catch (_) { rejected = true; }
    assert.ok(rejected, '应被中止');
  });
  await check('chatNonStream 透传 signal 可中止', async () => {
    const ctrl = new AbortController();
    const p = client.chatNonStream({ baseUrl: base, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], signal: ctrl.signal });
    ctrl.abort();
    let rejected = false;
    try { await p; } catch (_) { rejected = true; }
    assert.ok(rejected, '应被中止');
  });

  setTimeout(() => server.close(), 3200);
}

main().then(() => {
  console.log('\n配额/中止测试：通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error('测试异常:', e); process.exit(1); });
