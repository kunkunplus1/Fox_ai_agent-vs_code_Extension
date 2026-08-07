'use strict';

/**
 * 离线测试：自动代码审查子代理（Code Review Sub-Agent）
 *  - reviewer.runReview 纯函数：接收 silentCall 返回审查文本；异常时 ok=false
 *  - AgentSession._runCodeReview：本轮有代码写操作时触发，emit('review') 并追加审查观察
 *  - 关闭 foxAi.review.enabled 时不触发
 * 运行：node test/codeReview.js
 */

const Module = require('module');
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

/* ---------- mock vscode ---------- */
const vscodeMock = {
  workspace: {
    workspaceFolders: null,
    getConfiguration: () => ({ get: (k, d) => d, update: async () => {} }),
    textDocuments: [],
    fs: {}
  },
  window: { activeTextEditor: null, activeTerminal: null, tabGroups: { all: [] } },
  languages: { getDiagnostics: () => [] },
  commands: { executeCommand: async () => {} },
  env: { clipboard: { readText: async () => '', writeText: async () => {} } },
  Uri: { file: (p) => ({ fsPath: p, toString: () => 'file://' + p }), joinPath: () => ({}) },
  Position: class {},
  Range: class {},
  Selection: class {},
  ThemeIcon: class {},
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  FileType: { File: 1, Directory: 2 },
  InlineCompletionItem: class {},
  ConfigurationTarget: { Global: 1 },
  TextEditorRevealType: { InCenter: 2 }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const { AgentSession } = require('../src/agent');
const { PlanTaskStore } = require('../src/planTasks');
const reviewer = require('../src/reviewer');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + ' → ' + e.message);
  }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-rev-'));
  const fakeTM = {
    createTask: async () => ({ id: 't', state: 'queued', steps: [] }),
    getTask: async () => null,
    updateState: async () => ({}),
    appendStep: async () => {}
  };
  const cfg = {
    agentEnabled: true,
    planAndExecute: { enabled: false },
    review: { enabled: true },
    toolProtocol: 'native',
    maxSteps: 25,
    temperature: 0.3,
    maxTokens: 2048,
    timeout: 30000,
    maxHistory: 20,
    contextWindow: 0,
    autoSummarize: { enabled: false },
    autoApprove: 'read',
    maxToolOutput: 8000,
    blockedCommands: [],
    insecureHttpParser: false,
    streamFormat: 'auto',
    forceNonStream: false,
    vision: 'auto',
    visionModels: [],
    textOnlyModels: [],
    keepImageTurns: 1,
    systemPrompt: '',
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'x',
    model: 'test',
    providerId: 'custom',
    meta: { local: true }
  };
  let reviews = [];
  const ui = {
    text: () => {}, reasoning: () => {}, toolPending: () => {}, toolStart: () => {},
    toolStream: () => {}, toolEnd: () => {}, requestApproval: (req, cb) => cb('approve'),
    state: () => {}, notice: () => {}, contextUsage: () => {}, finalText: () => {},
    planPending: () => {}, review: (p) => { reviews.push(p); }
  };

  console.log('\n[1] reviewer.runReview 纯函数');
  const r1 = await reviewer.runReview({
    silentCall: async () => ({ content: '## 🔴 严重问题\n- 未处理空值' }),
    cfg,
    changed: [{ name: 'edit_file', path: 'a.js', op: '修改', summary: 'old->new' }]
  });
  check('返回 ok=true', () => assert.strictEqual(r1.ok, true));
  check('返回审查文本', () => assert.ok(r1.text.includes('严重问题')));

  const r2 = await reviewer.runReview({
    silentCall: async () => { throw new Error('net down'); },
    cfg,
    changed: []
  });
  check('异常时 ok=false', () => assert.strictEqual(r2.ok, false));
  check('异常时保留 error', () => assert.ok(r2.error));

  console.log('\n[2] AgentSession 触发审查');
  const session = new AgentSession({
    cfg,
    messages: [{ role: 'user', content: '改 a.js' }],
    ui,
    harness: { taskManager: fakeTM, policy: null },
    planTasks: new PlanTaskStore(tmp, {})
  });
  session._pendingReview = [{ name: 'edit_file', path: 'a.js', op: '修改', summary: 'old->new' }];
  session._silentCall = async () => ({ content: '## 🔴 严重问题\n- 未处理空值' });
  await session._runCodeReview();
  check('emit review 被调用', () => assert.strictEqual(reviews.length, 1));
  check('review 含文件', () => assert.ok(reviews[0].files.includes('a.js')));
  check('review 含文本', () => assert.ok(reviews[0].text.includes('未处理空值')));
  check('审查意见作为观察追加到历史', () =>
    assert.ok(session.messages.some((m) => m.role === 'user' && /代码审查意见/.test(m.content))));
  check('本轮 pendingReview 已清空', () => assert.strictEqual(session._pendingReview.length, 0));

  console.log('\n[3] 关闭 review.enabled 不触发');
  reviews = [];
  const cfg2 = Object.assign({}, cfg, { review: { enabled: false } });
  const session2 = new AgentSession({
    cfg: cfg2,
    messages: [{ role: 'user', content: 'x' }],
    ui,
    harness: { taskManager: fakeTM, policy: null },
    planTasks: new PlanTaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'fox-rev2-')), {})
  });
  session2._pendingReview = [{ name: 'write_file', path: 'b.js', op: '新增/覆盖', summary: '...' }];
  session2._silentCall = async () => ({ content: 'x' });
  await session2._runCodeReview();
  check('关闭时未 emit review', () => assert.strictEqual(reviews.length, 0));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n结果：通过 ${pass} / 失败 ${fail}\n`);
  process.exit(fail ? 1 : 0);
})();
