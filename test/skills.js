'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UserSkillStore } = require('../src/skills');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + '：' + e.message);
  }
}

function tmpDir() {
  const d = path.join(os.tmpdir(), 'fox-skill-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

console.log('[1] 创建与列表');
const base = tmpDir();
const store = new UserSkillStore(base);
check('空列表', () => assert.strictEqual(store.list().length, 0));
check('create 成功', () => {
  const r = store.create({ name: 'deploy-check', description: '部署前检查', whenToUse: '上线前', body: '# 部署检查\n1. 构建\n2. 测试' });
  assert.ok(r.ok, '应创建成功：' + r.errors.join('; '));
  assert.ok(fs.existsSync(r.path), 'SKILL.md 应已写入：' + r.path);
});
check('create 后列表出现', () => assert.strictEqual(store.list().length, 1));
check('meta 字段解析', () => {
  const m = store.list()[0];
  assert.strictEqual(m.name, 'deploy-check');
  assert.strictEqual(m.description, '部署前检查');
  assert.strictEqual(m.whenToUse, '上线前');
  assert.strictEqual(m.hasScript, false);
  assert.strictEqual(m.interactive, false);
});
check('get 返回内容', () => assert.ok(store.get('deploy-check').includes('部署检查')));

console.log('[2] 名称清洗');
check('非法名被清洗', () => {
  const r = store.create({ name: 'My Skill!', body: 'x' });
  assert.ok(r.ok);
  assert.strictEqual(path.basename(path.dirname(r.path)), 'my-skill');
  assert.ok(fs.existsSync(r.path));
});

console.log('[3] 校验拦截');
check('空 body 被拒', () => {
  const r = store.create({ name: 'bad', body: '' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.length);
});
check('空名被拒', () => {
  const r = store.create({ name: '', body: 'x' });
  assert.strictEqual(r.ok, false);
});

console.log('[4] 脚本 node --check');
check('合法脚本通过', () => {
  const r = store.create({ name: 'with-script', body: 'run', script: 'console.log("hi");' });
  assert.ok(r.ok, '应通过：' + r.errors.join('; '));
  assert.ok(store.list().find((x) => x.name === 'with-script').hasScript);
});
check('语法错误脚本被拒', () => {
  const r = store.create({ name: 'bad-script', body: 'run', script: 'const x = ;' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.join('').includes('语法'));
});

console.log('[5] activate 与 renderForPrompt');
check('activate 注入指导', () => {
  const r = store.activate('deploy-check', '请检查');
  assert.ok(r.ok);
  assert.ok(r.guidance.includes('部署检查'));
});
check('activate 未知技能', () => {
  const r = store.activate('nope');
  assert.strictEqual(r.ok, false);
});
check('renderForPrompt 含技能', () => {
  const t = store.renderForPrompt();
  assert.ok(t.includes('deploy-check'));
});

console.log('[6] remove');
check('删除技能', () => {
  assert.ok(store.remove('deploy-check'));
  assert.strictEqual(store.get('deploy-check'), null);
});

console.log('[7] 脚本执行');
check('activate 执行 run.js 并返回输出', () => {
  const r = store.activate('with-script');
  assert.ok(r.ok);
  assert.ok(r.output.includes('hi'));
  assert.strictEqual(r.interactive, false);
});

console.log('[8] 交互式技能');
let interactivePath = '';
check('创建交互式技能', () => {
  const r = store.create({
    name: 'guess-game',
    description: '猜数字游戏',
    body: '让用户在终端输入猜测，然后读取终端输出判断大小。',
    script: 'const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout }); rl.question("?", () => rl.close());',
    interactive: true
  });
  assert.ok(r.ok, '应创建成功：' + r.errors.join('; '));
  interactivePath = r.path;
});
check('交互式 meta 标记正确', () => {
  const m = store.list().find((x) => x.name === 'guess-game');
  assert.ok(m);
  assert.strictEqual(m.interactive, true);
  assert.strictEqual(m.hasScript, true);
});
check('activate 不执行交互式脚本（避免阻塞 stdin）', () => {
  const r = store.activate('guess-game');
  assert.ok(r.ok);
  assert.strictEqual(r.interactive, true);
  assert.strictEqual(r.hasScript, true);
  assert.ok(!r.output.includes('[脚本执行出错]'), '交互式技能不应在 activate 里执行脚本并报错');
});

console.log('[9] 重复创建拦截（防 use_skill→create_skill 死循环）');
check('已存在技能默认拒绝重复创建', () => {
  const d = tmpDir();
  const s = new UserSkillStore(d);
  const first = s.create({ name: 'dup-test', body: '原始指导内容，足够长以便后续改写时差异明显。' });
  assert.ok(first.ok, '首次应创建成功：' + first.errors.join('; '));
  const second = s.create({ name: 'dup-test', body: '一套完全不同的重写指导内容，差异远超百分之二十阈值。' });
  assert.strictEqual(second.ok, false, '同名技能不应被再次创建');
  assert.ok(second.errors.join('').includes('已存在'), '拒绝信息应说明已存在');
});
check('显式 overwrite:true 允许覆盖更新', () => {
  const d = tmpDir();
  const s = new UserSkillStore(d);
  s.create({ name: 'dup-ov', body: 'v1' });
  const upd = s.create({ name: 'dup-ov', body: 'v2 更新版指导', overwrite: true });
  assert.ok(upd.ok, 'overwrite:true 应允许更新：' + upd.errors.join('; '));
  assert.ok(s.get('dup-ov').includes('v2'), '文件应被覆盖为新内容');
});

console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
