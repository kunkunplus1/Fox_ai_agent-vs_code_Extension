'use strict';

/*
 * 验证「项目任务清单」可删除：
 *  - remove_plan_task 工具能调用 PlanTaskStore.remove
 *  - 删除后列表不再包含该项
 */

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

// 在 require 业务模块前，把 'vscode' 替换成 mock
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req) {
  if (req === 'vscode') return req;
  return origResolve.apply(this, arguments);
};
require.cache.vscode = {
  id: 'vscode',
  exports: {
    workspace: { getConfiguration: () => ({ get: () => null }) },
    ConfigurationTarget: { Global: 1 }
  }
};

const { PlanTaskStore } = require('../src/planTasks');
const tools = require('../src/tools');

let pass = 0;
async function ok(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.error('  ✗ ' + name + ' -> ' + e.message); process.exitCode = 1; }
}

async function main() {
  // 1) 工具存在且可被查到
  await ok('remove_plan_task 工具已注册', () => {
    const t = tools.getTool('remove_plan_task');
    assert.ok(t, '找不到 remove_plan_task 工具');
    assert.strictEqual(t.kind, 'edit');
  });

  // 2) 工具能删除计划项
  await ok('remove_plan_task 删除后列表不含该项', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-rm-plan-'));
    const store = new PlanTaskStore(dir, {});
    const a = await store.create({ subject: '任务A' });
    const b = await store.create({ subject: '任务B' });
    assert.strictEqual(store.list().length, 2);

    const r = tools.getTool('remove_plan_task').run({ id: a.id }, { planTasks: store });
    assert.ok(/已删除/.test(r), '返回应提示已删除，实际：' + r);

    const ids = store.list().map((x) => x.id);
    assert.ok(!ids.includes(a.id), '任务A 应已被删除');
    assert.ok(ids.includes(b.id), '任务B 应还在');
    assert.strictEqual(store.list().length, 1);
  });

  // 3) 删除不存在的 id 给出友好提示
  await ok('删除不存在的 id 返回提示', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-rm-plan-'));
    const store = new PlanTaskStore(dir, {});
    const r = tools.getTool('remove_plan_task').run({ id: 'nope' }, { planTasks: store });
    assert.ok(/找不到/.test(r), '应提示找不到，实际：' + r);
  });

  console.log('\nremovePlanTask 测试：' + pass + ' 通过');
}

main().catch((e) => { console.error(e); process.exit(1); });
