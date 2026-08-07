'use strict';
const { TaskManager, TASK_STATES } = require('../src/harness');

class FakeStorage {
  constructor() { this.map = new Map(); }
  get(k, d) { return this.map.has(k) ? this.map.get(k) : d; }
  async update(k, v) { this.map.set(k, v); }
}

(async () => {
  const assert = require('assert');
  const storage = new FakeStorage();
  const tm = new TaskManager({ storage });
  const t = await tm.createTask({ type: 'agent', title: '测试', sessionId: 's1' });
  console.log('created', t.id, t.sessionId);
  await tm.updateState(t.id, TASK_STATES.RUNNING);
  await tm.appendStep(t.id, { kind: 'tool', name: 'read_file' });
  await tm.appendStep(t.id, { kind: 'tool', name: 'write_file' });
  const list = await tm.listTasks();
  console.log('list', list.length, list[0] && list[0].state, 'stepsCount', list[0] && list[0].stepsCount);
  assert.strictEqual(list.length, 1, '应列出 1 个任务');
  assert.strictEqual(list[0].stepsCount, 2, '索引里应记录 stepsCount=2');
  const full = await tm.getTask(t.id);
  console.log('full steps', full.steps.length);
  assert.strictEqual(full.steps.length, 2, '完整任务应有 2 个步骤');

  // 模拟旧索引缺失 stepsCount：清空索引后重建，应能补回
  const idx = await tm._loadIndex();
  delete idx[t.id].stepsCount;
  await tm._saveIndex(idx);
  const list2 = await tm.listTasks();
  assert.strictEqual(list2[0].stepsCount, 2, '旧索引缺失 stepsCount 时应自动补回');
  console.log('tm_storage 测试通过');
})();
