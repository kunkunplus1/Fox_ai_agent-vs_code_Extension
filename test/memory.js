'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MemoryStore } = require('../src/memory');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-mem-'));
const file = path.join(tmp, 'memory', 'memory.json');

let pass = 0;
function ok(name, cond) {
  assert.ok(cond, '❌ ' + name);
  console.log('  ✓ ' + name);
  pass++;
}

// 1) 空记忆
let s = new MemoryStore(tmp);
ok('初始无记忆', s.all().length === 0);
ok('空记忆 render 为空串', s.renderForPrompt() === '');

// 2) 新增 + 持久化
const a = s.add({ text: '用户偏好用中文注释', tags: '偏好,前端', category: 'preference' });
ok('add 返回条目', a && a.id);
ok('add 后计数+1', s.all().length === 1);
ok('tags 被解析成数组', Array.isArray(a.tags) && a.tags.length === 2);
ok('文件已落盘', fs.existsSync(file));
ok('重新读取仍有一条', new MemoryStore(tmp).all().length === 1);

// 3) 检索
ok('按关键字命中', s.search('中文注释').length === 1);
ok('按标签命中', s.search('前端').length === 1);
ok('无关关键字返回空', s.search('不存在的东西').length === 0);

// 4) 更新 + 删除
s.add({ text: '第二条记忆：用 pnpm', category: 'project' });
ok('add 后计数+1（共2）', s.all().length === 2);
const firstId = a.id;
ok('update 成功', s.update(firstId, '用户偏好：注释用中文'));
ok('内容已更新', s.all().find((x) => x.id === firstId).text === '用户偏好：注释用中文');
ok('remove 成功', s.remove(firstId));
ok('remove 后计数-1', s.all().length === 1);

// 5) renderForPrompt 注入格式
const r = s.renderForPrompt();
ok('render 含标题', r.includes('长期记忆'));
ok('render 含记忆内容', r.includes('用 pnpm'));

// 6) 空内容不保存
const empty = s.add({ text: '   ' });
ok('空白内容不保存', empty === null);

console.log(`\n结果：通过 ${pass} / 失败 0`);
