'use strict';

/*
 * 离线集成测试：验证 Harness 的任务会话关联与 AgentSession 热恢复续跑。
 * - TaskManager.createTask 写入 sessionId，failed 任务进入可恢复列表
 * - 第一次 run 因模型错误 FAILED；第二次 run(resumeTaskId) 复用同一任务，步骤继续追加，最终 COMPLETED
 * 运行：node test/resume.js
 */

const Module = require('module');
const http = require('http');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

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

const { TaskManager, TASK_STATES } = require('../src/harness');
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
function checkAsync(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++;
      console.log('  ✓ ' + name);
    })
    .catch((e) => {
      fail++;
      console.log('  ✗ ' + name + ' → ' + e.message);
    });
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxresume-'));
  const tm = new TaskManager({ dir: tmpDir });

  console.log('\n[1] TaskManager 会话关联');
  const t = await tm.createTask({ type: 'agent', title: '测试任务', sessionId: 'sess_abc' });
  check('createTask 写入 sessionId', () => assert.strictEqual(t.sessionId, 'sess_abc'));
  const reload = await tm.getTask(t.id);
  check('持久化后仍有 sessionId', () => assert.strictEqual(reload.sessionId, 'sess_abc'));
  await tm.updateState(t.id, TASK_STATES.FAILED);
  const resumable = await tm.listResumable();
  check('failed 任务进入可恢复列表', () => assert.ok(resumable.some((x) => x.id === t.id)));
  await tm.deleteTask(t.id);

  console.log('\n[2] AgentSession 热恢复续跑');
  // 1.1.25 网络退避重试：单次 500 会被自动重试吞掉 → 必须「持续 500」直到本轮耗尽重试（3 次）
  // 才真正 FAILED。failCount 设为 100（远超所有请求消耗：每次请求 1 原始 + 3 重试，且第一轮可能多次请求），
  // 确保第一次 run 的所有请求全 500 耗尽 → FAILED；第二次 run 时 failCount 已归 0 → 收到 'done'。
  let failCount = 100;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (failCount > 0) {
        failCount--;
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('boom');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
          model: 'test'
        })
      );
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const cfg = {
    baseUrl: 'http://127.0.0.1:' + port + '/v1',
    model: 'test',
    apiKey: 'x',
    systemPrompt: '你是一位测试助手。',
    agentEnabled: true,
    toolProtocol: 'native',
    maxSteps: 5,
    temperature: 0.3,
    maxTokens: 100,
    timeout: 5000,
    forceNonStream: true,
    insecureHttpParser: false,
    vision: 'auto',
    visionModels: [],
    textOnlyModels: [],
    keepImageTurns: 1,
    maxToolOutput: 8000,
    blockedCommands: [],
    autoApprove: 'all',
    maxHistory: 20
  };
  const ui = {
    text() {},
    reasoning() {},
    toolStart() {},
    toolStream() {},
    toolEnd() {},
    requestApproval: (r, cb) => cb('approve'),
    state() {},
    notice() {},
    finalText() {}
  };

  // 第一次 run：模型报错 → 任务 FAILED
  const messages1 = [{ role: 'user', content: '请完成任务 A' }];
  const s1 = new AgentSession({
    cfg,
    messages: messages1,
    ui,
    harness: { taskManager: tm },
    sessionId: 'sess_run'
  });
  let firstId = null;
  try {
    await s1.run();
  } catch (_) {
    /* 预期抛错 */
  }
  // 第一次 run 已 FAILED：显式把服务端置为「成功」，第二次续跑必然收到 'done'（不再 500）
  failCount = 0;
  const tasks1 = await tm.listTasks();
  const t1 = tasks1.find((x) => x.sessionId === 'sess_run');
  check('第一次 run 产生任务且为 FAILED', () => {
    assert.ok(t1, '应存在任务');
    assert.strictEqual(t1.state, TASK_STATES.FAILED);
  });
  const full1 = await tm.getTask(t1.id);
  check('失败步骤被记录', () => assert.ok(full1.steps.some((s) => s.kind === 'error')));
  firstId = t1.id;

  // 第二次 run：续跑，复用原任务
  const messages2 = [{ role: 'user', content: '请完成任务 A' }];
  const s2 = new AgentSession({
    cfg,
    messages: messages2,
    ui,
    harness: { taskManager: tm },
    sessionId: 'sess_run',
    resumeTaskId: firstId
  });
  await s2.run();
  const t2 = await tm.getTask(firstId);
  check('续跑复用同一任务（不新建）', () => assert.strictEqual(t2.id, firstId));
  check('续跑后任务变为 COMPLETED', () => assert.strictEqual(t2.state, TASK_STATES.COMPLETED));
  check('续跑步骤包含 resume 标记', () => assert.ok(t2.steps.some((s) => s.kind === 'resume')));
  check('步骤数在失败基础上继续追加', () => assert.ok(t2.steps.length > full1.steps.length));

  server.close();
  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})();
