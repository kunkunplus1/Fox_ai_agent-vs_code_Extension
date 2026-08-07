'use strict';

/**
 * 离线测试：工具返回的状态摘要 + 失败反思（ReAct 稳定性）
 *  - pushToolResult 成功分支带 [观察摘要] status=ok
 *  - pushToolResult 失败分支带 [观察摘要] status=error + [反思] 建议
 *  - 文本协议同样包裹
 *  - _inferFailSuggest 按报错关键字推断失败原因与建议
 * 运行：node test/toolObserve.js
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-obs-'));
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
  const ui = {
    text: () => {}, reasoning: () => {}, toolPending: () => {}, toolStart: () => {},
    toolStream: () => {}, toolEnd: () => {}, requestApproval: (req, cb) => cb('approve'),
    state: () => {}, notice: () => {}, contextUsage: () => {}, finalText: () => {},
    planPending: () => {}, review: () => {}
  };

  const session = new AgentSession({
    cfg,
    messages: [{ role: 'user', content: 'hi' }],
    ui,
    harness: { taskManager: fakeTM, policy: null },
    planTasks: new PlanTaskStore(tmp, {})
  });

  console.log('\n[1] pushToolResult 状态摘要（native 协议）');
  session.protocol = 'native';
  session.messages = [];
  session.pushToolResult('c1', 'read_file', 'line1\nline2', false);
  check('成功结果含 status=ok', () => assert.ok(session.messages[0].content.includes('status=ok')));
  check('成功结果含 [观察摘要]', () => assert.ok(session.messages[0].content.includes('[观察摘要]')));

  session.messages = [];
  session.pushToolResult('c2', 'run_command', 'boom', true, { reason: '找不到命令', suggest: '用 which 找' });
  check('失败结果含 status=error', () => assert.ok(session.messages[0].content.includes('status=error')));
  check('失败结果含 [观察摘要] 与原因', () => assert.ok(session.messages[0].content.includes('找不到命令')));
  check('失败结果含 [反思] 与建议', () =>
    assert.ok(session.messages[0].content.includes('[反思]') && session.messages[0].content.includes('用 which 找')));

  console.log('\n[2] pushToolResult 文本协议');
  session.protocol = 'text';
  session.messages = [];
  session.pushToolResult('c3', 'read_file', 'data', false);
  check('文本协议包成 user 消息', () => assert.strictEqual(session.messages[0].role, 'user'));
  check('文本协议含 [观察摘要]', () => assert.ok(session.messages[0].content.includes('[观察摘要]')));

  console.log('\n[3] _inferFailSuggest 推断失败原因');
  check('ENOENT → 路径不存在', () => assert.ok(session._inferFailSuggest('edit_file', 'ENOENT: no such file').includes('路径')));
  check('EPERM → 权限', () => assert.ok(session._inferFailSuggest('write_file', 'EACCES permission denied').includes('权限')));
  check('syntax → 参数/格式', () =>
    assert.ok(/参数|格式/.test(session._inferFailSuggest('run_command', 'SyntaxError: invalid json'))));
  check('timeout → 超时', () => assert.ok(session._inferFailSuggest('run_command', 'ETIMEDOUT').includes('超时')));
  check('未知 → 通用反思', () => assert.ok(session._inferFailSuggest('run_command', 'weird').includes('反思')));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n结果：通过 ${pass} / 失败 ${fail}\n`);
  process.exit(fail ? 1 : 0);
})();
