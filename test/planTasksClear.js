'use strict';

/**
 * 离线测试：项目任务清单一键清理已完成任务
 * 运行：node test/planTasksClear.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
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
  ConfigurationTarget: { Global: 1 }
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const { PlanTaskStore } = require('../src/planTasks');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    fail++;
    console.error('  \u2717 ' + name);
    console.error('    ' + e.message);
  }
}

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-plan-tasks-'));

  try {
    console.log('测试 PlanTaskStore.clearCompleted');

    const store = new PlanTaskStore(tmpDir);

    const p1 = await store.create({ subject: '任务 A', description: '待完成', status: 'pending' });
    const p2 = await store.create({ subject: '任务 B', description: '进行中', status: 'in_progress' });
    const p3 = await store.create({ subject: '任务 C', description: '已完成', status: 'completed' });
    const p4 = await store.create({ subject: '任务 D', description: '也已完成', status: 'completed' });

    check('初始列表有 4 条任务', () => assert.strictEqual(store.list().length, 4));
    check('已完成任务有 2 条', () => assert.strictEqual(store.list().filter((x) => x.status === 'completed').length, 2));

    const removed = store.clearCompleted();

    check('clearCompleted 返回 2', () => assert.strictEqual(removed, 2));
    check('清理后剩余 2 条任务', () => assert.strictEqual(store.list().length, 2));
    check('剩余任务不包含 completed', () => assert.ok(!store.list().some((x) => x.status === 'completed')));
    check('pending / in_progress 任务仍保留', () => {
      const ids = store.list().map((x) => x.id).sort();
      assert.deepStrictEqual(ids, [p1.id, p2.id].sort());
    });

    // 持久化检查
    const file = path.join(tmpDir, 'plan-tasks.json');
    check('plan-tasks.json 已落盘', () => assert.ok(fs.existsSync(file)));

    const reloaded = new PlanTaskStore(tmpDir);
    check('重新加载后仍只有 2 条任务', () => assert.strictEqual(reloaded.list().length, 2));
    check('重新加载后无 completed', () => assert.ok(!reloaded.list().some((x) => x.status === 'completed')));

    check('再次清理返回 0', () => assert.strictEqual(reloaded.clearCompleted(), 0));
    check('再次清理后任务数不变', () => assert.strictEqual(reloaded.list().length, 2));

    console.log('');
    console.log(`结果：${pass} 通过，${fail} 失败`);
    process.exit(fail ? 1 : 0);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

run();
