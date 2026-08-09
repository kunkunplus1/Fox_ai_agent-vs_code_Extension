'use strict';

/**
 * 离线测试：审批状态同步
 *  - autoApprove='read' 时 read 类工具自动通过
 *  - 需要人工审批的工具，用户决策后 agent.state 恢复为 running
 *  - UI 回调被调用后 step 状态从 running 更新为 ok/error
 * 运行：node test/approvalState.js
 */

const Module = require('module');
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
  const baseCfg = {
    agentEnabled: true,
    planAndExecute: { enabled: false },
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

  console.log('\n[1] read 类工具在 autoApprove=read 时自动通过');
  {
    const session = new AgentSession({
      cfg: baseCfg,
      messages: [],
      ui: { requestApproval: () => { throw new Error('不应弹审批'); } },
      harness: { taskManager: null, policy: null }
    });
    const d = await session.approve({ id: 't1', name: 'generate_image', kind: 'read', title: '生成图片', args: {} });
    check('read 工具自动返回 approve', () => assert.strictEqual(d, 'approve'));
    check('自动通过后状态仍为初始态（未弹审批）', () => assert.notStrictEqual(session.state, 'awaiting-approval'));
  }

  console.log('\n[2] exec 类工具需审批，决策后 state 恢复 running');
  {
    const states = [];
    const session = new AgentSession({
      cfg: baseCfg,
      messages: [],
      ui: {
        requestApproval: (req, cb) => {
          states.push(session.state);
          setImmediate(() => cb('approve'));
        },
        state: ({ state }) => states.push(state)
      },
      harness: { taskManager: null, policy: null }
    });
    const d = await session.approve({ id: 't2', name: 'use_skill', kind: 'exec', title: '激活技能', args: {} });
    check('exec 工具获得用户 approve', () => assert.strictEqual(d, 'approve'));
    check('审批期间曾进入 awaiting-approval', () => assert.ok(states.includes('awaiting-approval')));
    check('决策后 state 恢复为 running', () => assert.strictEqual(session.state, 'running'));
    check('决策后 emit 了 running 状态', () => assert.ok(states.includes('running')));
  }

  console.log('\n[3] 拒绝后 state 同样恢复 running');
  {
    const session = new AgentSession({
      cfg: baseCfg,
      messages: [],
      ui: {
        requestApproval: (req, cb) => setImmediate(() => cb('reject'))
      },
      harness: { taskManager: null, policy: null }
    });
    const d = await session.approve({ id: 't3', name: 'use_skill', kind: 'exec', title: '激活技能', args: {} });
    check('拒绝返回 reject', () => assert.strictEqual(d, 'reject'));
    check('拒绝后 state 恢复 running', () => assert.strictEqual(session.state, 'running'));
  }

  console.log('\n[4] chatView.requestApproval 包装回调会刷新 step 状态');
  {
    const posted = [];
    const fakeChatView = {
      approvalResolvers: new Map(),
      post: (m) => posted.push(m),
      buildUi: function () {
        return {
          requestApproval: (req, cb) => {
            posted.length = 0;
            // 这里模拟 chatView.js 里包装回调后的 requestApproval
            const wrappedCb = (decision) => {
              const status = decision === 'reject' || decision === 'reject-cancel' ? 'error' : 'ok';
              this.post({ type: 'step', id: 'ap-' + req.id, kind: 'approval', title: (decision === 'reject' ? '已拒绝：' : '已允许：') + (req.title || req.name), status });
              cb(decision);
            };
            this.approvalResolvers.set(req.id, wrappedCb);
            this.post({ type: 'approval', id: req.id, name: req.name, kind: req.kind, title: req.title });
            this.post({ type: 'step', id: 'ap-' + req.id, kind: 'approval', title: '等待审批：' + (req.title || req.name), status: 'running' });
          }
        };
      }
    };
    const ui = fakeChatView.buildUi();
    let cbDecision = null;
    ui.requestApproval({ id: 'x1', name: 'generate_image', kind: 'read', title: '生成图片' }, (d) => { cbDecision = d; });
    check('先发送 approval 消息', () => assert.strictEqual(posted[0].type, 'approval'));
    check('先发送 running 的 step', () => assert.strictEqual(posted[1].type, 'step') && assert.strictEqual(posted[1].status, 'running'));
    const resolver = fakeChatView.approvalResolvers.get('x1');
    resolver('approve');
    check('回调收到 approve', () => assert.strictEqual(cbDecision, 'approve'));
    check('随后发送 ok 的 step', () => assert.strictEqual(posted[2].type, 'step') && assert.strictEqual(posted[2].status, 'ok'));
    check('step 标题变为已允许', () => assert.ok(/已允许/.test(posted[2].title)));
  }

  console.log(`\napprovalState: 通过 ${pass} 项 ${fail ? `❌ 失败 ${fail} 项` : '✅'}\n`);
  process.exit(fail ? 1 : 0);
})();
