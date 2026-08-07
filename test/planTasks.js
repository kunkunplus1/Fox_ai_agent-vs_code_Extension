'use strict';

const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

/* ---------- mock vscode ---------- */
const vscodeMock = {
  workspace: {
    workspaceFolders: null,
    getConfiguration: () => ({ get: (k, d) => d, update: async () => {} }),
    textDocuments: []
  },
  window: {},
  commands: { executeCommand: async () => {} },
  env: { clipboard: { readText: async () => '', writeText: async () => {} } },
  Uri: { file: (p) => ({ fsPath: p }), joinPath: () => ({}) },
  ConfigurationTarget: { Global: 1 }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const { PlanTaskStore, STATUS } = require('../src/planTasks');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓', name);
  } catch (e) {
    failed++;
    console.error('  ✗', name, '\n   ', e.message);
  }
}

const base = path.join(os.tmpdir(), 'fox-plan-tasks-test-' + Date.now());
fs.mkdirSync(base, { recursive: true });
const file = path.join(base, 'plan-tasks.json');
const store = new PlanTaskStore(base, { file });

check('初始为空', () => assert.strictEqual(store.list().length, 0));

(async () => {
  const item = await store.create({ subject: '搭建插件骨架', description: '创建 package.json 与入口文件', status: 'pending' });
  check('create 返回 id 与字段', () => {
    assert.ok(item.id);
    assert.strictEqual(item.subject, '搭建插件骨架');
    assert.strictEqual(item.description, '创建 package.json 与入口文件');
    assert.strictEqual(item.status, STATUS.PENDING);
  });

  check('list 返回 1 项', () => assert.strictEqual(store.list().length, 1));

  const updated = store.update(item.id, { status: STATUS.IN_PROGRESS });
  check('update 状态为 in_progress', () => {
    assert.ok(updated);
    assert.strictEqual(updated.status, STATUS.IN_PROGRESS);
    assert.strictEqual(updated.completedAt, null);
  });

  store.setStatus(item.id, STATUS.COMPLETED);
  check('setStatus completed 后 completedAt 非空', () => {
    const cur = store.list()[0];
    assert.strictEqual(cur.status, STATUS.COMPLETED);
    assert.ok(cur.completedAt);
  });

  check('nextStatus 循环', () => {
    store.nextStatus(item.id);
    assert.strictEqual(store.list()[0].status, STATUS.PENDING);
    store.nextStatus(item.id);
    assert.strictEqual(store.list()[0].status, STATUS.IN_PROGRESS);
  });

  check('renderForPrompt 非空且含任务', () => {
    const text = store.renderForPrompt();
    assert.ok(text.includes('搭建插件骨架'));
    assert.ok(text.includes('create_plan_task'));
  });

  const second = await store.create({ rawContext: '写一个很长的需求：我们要实现一个可以自动总结任务目标的清单组件，并且支持配置使用哪个 AI 来总结', status: 'pending' });
  check('无 subject 时回退 rawContext 切片', () => {
    assert.ok(second.subject.length > 0);
    assert.ok(second.description.length > 0);
  });

  check('remove 生效', () => {
    assert.ok(store.remove(second.id));
    assert.strictEqual(store.list().length, 1);
  });

  check('文件已持久化', () => {
    assert.ok(fs.existsSync(file));
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(data.items.length, 1);
  });

  console.log(`\nplanTasks 测试：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
