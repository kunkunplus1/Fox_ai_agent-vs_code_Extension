'use strict';

/**
 * 离线测试：规划确认模式（Plan-and-Execute）
 *  - present_plan / revise_plan 工具已注册且为 read 类型
 *  - 模型提交计划后 run() 暂停并返回 reason:'plan-pending'，不执行任何写/命令
 *  - approvePlan() 推送确认消息并续跑，最终执行完成
 *  - 执行中调用 revise_plan 会再次进入 plan-pending（revised=true）
 * 运行：node test/planConfirm.js
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

const tools = require('../src/tools');
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-plan-'));
  const planTasks = new PlanTaskStore(tmp, {});

  // 假任务管理器：记录状态，不落盘
  const fakeTM = {
    createTask: async (o) => ({ id: 'task_test', state: 'queued', steps: [], ...o }),
    getTask: async () => null,
    updateState: async () => ({}),
    appendStep: async () => {}
  };

  const cfg = {
    agentEnabled: true,
    planAndExecute: { enabled: true },
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

  let planPendingPayload = null;
  const ui = {
    planPending: (p) => { planPendingPayload = p; },
    text: () => {}, reasoning: () => {}, toolPending: () => {},
    toolStart: () => {}, toolStream: () => {}, toolEnd: () => {},
    requestApproval: (req, cb) => cb('approve'),
    state: () => {}, notice: () => {}, contextUsage: () => {}, finalText: () => {}
  };

  console.log('\n[1] 工具注册');
  const present = tools.getTool('present_plan');
  const revise = tools.getTool('revise_plan');
  check('present_plan 已注册', () => assert.ok(present));
  check('present_plan 为 read 类型（自动批准）', () => assert.strictEqual(present.kind, 'read'));
  check('revise_plan 已注册', () => assert.ok(revise));
  check('revise_plan 必填 reason', () =>
    assert.ok(revise.parameters.required && revise.parameters.required.includes('reason')));

  console.log('\n[2] 提交计划后暂停');
  const session = new AgentSession({
    cfg,
    messages: [{ role: 'user', content: '帮我给 a.js 加一个 hello 函数并跑测试' }],
    ui,
    harness: { taskManager: fakeTM, policy: null },
    planTasks
  });
  // 所有写类操作自动批准，避免卡在审批
  session.approve = async () => 'approve';

  let turn = 0;
  session.callModel = async () => {
    if (turn === 0) {
      turn++;
      return {
        content: '这是我的执行计划：',
        reasoning: '',
        toolCalls: [
          { id: 'c1', name: 'create_plan_task', arguments: JSON.stringify({ subject: '读取 a.js', description: 'read a.js' }) },
          { id: 'c2', name: 'create_plan_task', arguments: JSON.stringify({ subject: '新增 hello 函数', description: 'edit a.js' }) },
          { id: 'c3', name: 'present_plan', arguments: '{}' }
        ]
      };
    }
    if (turn === 1) {
      turn++;
      return {
        content: '',
        reasoning: '',
        toolCalls: [
          { id: 'r1', name: 'revise_plan', arguments: JSON.stringify({ reason: '发现还需要先装依赖' }) }
        ]
      };
    }
    return { content: '计划已执行完毕，已新增 hello 函数并跑通测试。', reasoning: '', toolCalls: [] };
  };

  const r1 = await session.run();
  check('run 返回 plan-pending', () => assert.strictEqual(r1.reason, 'plan-pending'));
  check('emit planPending 携带 2 项计划', () =>
    assert.ok(planPendingPayload && planPendingPayload.plan.length === 2));
  check('planTasks 已写入 2 项', () => assert.strictEqual(session.planTasks.list().length, 2));
  check('提交计划期间不执行写/命令（无 task step）', () =>
    assert.strictEqual(session.task.steps.length, 0));

  console.log('\n[3] 确认后执行，执行中修订再次暂停');
  const r2 = await session.approvePlan();
  check('确认后若模型修订计划，再次返回 plan-pending', () => assert.strictEqual(r2.reason, 'plan-pending'));
  check('第二次暂停标记为 revised=true', () => assert.strictEqual(planPendingPayload.revised, true));

  const r3 = await session.approvePlan();
  check('再次确认后执行完成', () => assert.strictEqual(r3.finished, true));
  check('确认消息进入对话历史', () =>
    assert.ok(session.messages.some((m) => m.role === 'user' && /用户已确认计划/.test(m.content))));

  console.log('\n[4] 关闭规划确认模式时不强制暂停');
  const cfg2 = Object.assign({}, cfg, { planAndExecute: { enabled: false } });
  const session2 = new AgentSession({
    cfg: cfg2,
    messages: [{ role: 'user', content: '直接帮我改 a.js' }],
    ui,
    harness: { taskManager: fakeTM, policy: null },
    planTasks: new PlanTaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'fox-plan2-')), {})
  });
  session2.approve = async () => 'approve';
  let turn2 = 0;
  session2.callModel = async () => {
    if (turn2 === 0) {
      turn2++;
      return { content: '', reasoning: '', toolCalls: [{ id: 'p1', name: 'present_plan', arguments: '{}' }] };
    }
    return { content: '完成', reasoning: '', toolCalls: [] };
  };
  const r4 = await session2.run();
  check('关闭模式下 present_plan 不触发暂停', () => assert.notStrictEqual(r4.reason, 'plan-pending'));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n结果：通过 ${pass} / 失败 ${fail}\n`);
  process.exit(fail ? 1 : 0);
})();
