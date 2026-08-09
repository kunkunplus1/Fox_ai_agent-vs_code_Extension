'use strict';

/**
 * test/memoryTopics.js — 结构化跨会话记忆（src/memoryTopics.js）离线测试
 * 运行：node test/memoryTopics.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mt = require('../src/memoryTopics');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + ' → ' + (e && e.message));
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foxmem-'));
let n = 0;
function newMem(extra) {
  return new mt.TopicMemory(Object.assign({ baseDir: path.join(tmp, 'm' + n++) }, extra || {}));
}

console.log('\n[memoryTopics] 结构化跨会话记忆');

// ---------- 1. 主题路由 ----------
t('规范类文本路由到 project-conventions', () => {
  assert.strictEqual(mt.routeTopic('本项目所有函数必须写中文注释，这是规范'), 'project-conventions');
});

t('bug 类文本路由到 debugging-lessons', () => {
  assert.strictEqual(mt.routeTopic('这个报错的根因是 zod 版本冲突，修复方式是钉死 v3'), 'debugging-lessons');
});

t('偏好类文本路由到 user-preferences', () => {
  assert.strictEqual(mt.routeTopic('我喜欢简洁的回答，不要长篇大论'), 'user-preferences');
});

t('架构类文本路由到 architecture-decisions', () => {
  assert.strictEqual(mt.routeTopic('决定采用 monorepo 架构，模块按业务域拆分'), 'architecture-decisions');
});

t('流程类文本路由到 workflows', () => {
  assert.strictEqual(mt.routeTopic('部署步骤：先跑测试，再打包，最后发布'), 'workflows');
});

t('无明显特征的文本落到 general', () => {
  assert.strictEqual(mt.routeTopic('今天天气不错哈哈哈'), 'general');
});

t('显式 hint 覆盖自动路由', () => {
  assert.strictEqual(mt.routeTopic('随便一句话', 'workflows'), 'workflows');
});

t('非法 hint 被忽略，回落自动路由', () => {
  assert.strictEqual(mt.routeTopic('这个 bug 的根因是空指针', 'not-a-topic'), 'debugging-lessons');
});

// ---------- 2. 相似度与去重 ----------
t('完全相同文本相似度为 1', () => {
  assert.strictEqual(mt.similarity('abc定义', 'abc定义'), 1);
});

t('近似文本相似度高', () => {
  assert.ok(mt.similarity('必须使用中文注释', '必须使用中文注释哦') > 0.7);
});

t('无关文本相似度低', () => {
  assert.ok(mt.similarity('数据库连接池配置', '前端按钮颜色调整') < 0.3);
});

// ---------- 3. 写入与读取 ----------
t('write 落盘并可读回', () => {
  const m = newMem();
  const r = m.write('本项目必须用 ESLint 校验规范');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.topic, 'project-conventions');
  assert.strictEqual(r.duplicated, false);
  assert.deepStrictEqual(m.read('project-conventions').length, 1);
});

t('近重复写入被跳过', () => {
  const m = newMem();
  m.write('必须用 ESLint 校验代码规范');
  const r = m.write('必须用 ESLint 校验代码规范。');
  assert.strictEqual(r.duplicated, true);
  assert.strictEqual(m.read('project-conventions').length, 1);
});

t('不同内容分别入库', () => {
  const m = newMem();
  m.write('提交前必须跑测试，这是项目规范');
  m.write('数据库迁移必须写回滚脚本，属于项目规范');
  assert.strictEqual(m.read('project-conventions').length, 2);
});

t('空/过短文本不写入', () => {
  const m = newMem();
  assert.strictEqual(m.write('').ok, false);
  assert.strictEqual(m.write('ab').ok, false);
  assert.strictEqual(m.totalCount, 0);
});

t('enabled=false 时不写入', () => {
  const m = newMem({ enabled: false });
  assert.strictEqual(m.write('本项目必须写中文注释规范').ok, false);
  assert.strictEqual(m.totalCount, 0);
});

t('指定 topic 强制归类', () => {
  const m = newMem();
  m.write('随便一句普通的话内容', { topic: 'workflows' });
  assert.strictEqual(m.read('workflows').length, 1);
});

t('写入带来源标注', () => {
  const m = newMem();
  m.write('部署流程要先跑测试', { source: '自动沉淀' });
  assert.ok(m.read('workflows')[0].includes('自动沉淀'));
});

t('主题文件是可读 Markdown', () => {
  const m = newMem();
  m.write('必须遵守命名规范');
  const f = path.join(m.topicDir, 'project-conventions.md');
  const txt = fs.readFileSync(f, 'utf8');
  assert.ok(txt.startsWith('# 项目约定'));
  assert.ok(txt.includes('- 必须遵守命名规范'));
});

t('remove 删除指定条目', () => {
  const m = newMem();
  m.write('规范一：必须写注释');
  m.write('规范二：必须写测试');
  assert.strictEqual(m.remove('project-conventions', '规范一：必须写注释'), true);
  const left = m.read('project-conventions');
  assert.strictEqual(left.length, 1);
  assert.ok(left[0].includes('规范二'));
});

t('remove 不存在的条目返回 false', () => {
  const m = newMem();
  m.write('某条规范内容');
  assert.strictEqual(m.remove('project-conventions', '不存在的内容'), false);
});

// ---------- 4. 索引 ----------
t('writeIndex 生成 MEMORY.md', () => {
  const m = newMem();
  m.write('必须写中文注释，这是规范');
  m.write('我喜欢简洁的回答风格');
  const txt = fs.readFileSync(m.indexFile, 'utf8');
  assert.ok(txt.includes('# 长期记忆索引'));
  assert.ok(txt.includes('项目约定'));
  assert.ok(txt.includes('用户偏好'));
  assert.ok(txt.includes('共 2 条记忆'));
});

t('索引不列出空主题', () => {
  const m = newMem();
  m.write('必须写中文注释，这是规范');
  const txt = fs.readFileSync(m.indexFile, 'utf8');
  assert.ok(!txt.includes('架构决策'));
});

t('listTopics 返回条目数', () => {
  const m = newMem();
  m.write('必须写中文注释，这是规范');
  const list = m.listTopics();
  const pc = list.find((x) => x.slug === 'project-conventions');
  assert.strictEqual(pc.count, 1);
});

t('renderTopicIndex 生成目录文本', () => {
  const m = newMem();
  m.write('必须写中文注释，这是规范');
  const s = m.renderTopicIndex();
  assert.ok(s.includes('记忆主题目录'));
  assert.ok(s.includes('project-conventions'));
});

t('无记忆时 renderTopicIndex 为空串', () => {
  assert.strictEqual(newMem().renderTopicIndex(), '');
});

// ---------- 5. 按需加载 ----------
t('loadRelevant 只注入相关主题', () => {
  const m = newMem();
  m.write('数据库迁移必须写回滚脚本，属于项目规范');
  m.write('这个报错的根因是端口被占用，修复方式是换端口');
  m.write('决定采用微服务架构，模块按域拆分');
  const r = m.loadRelevant('数据库迁移怎么做');
  assert.ok(r.text.includes('回滚脚本'), '应命中数据库相关记忆');
  assert.ok(r.items > 0);
});

t('loadRelevant 控制主题数量', () => {
  const m = newMem();
  m.write('必须写中文注释规范');
  m.write('报错根因是空指针，修复了');
  m.write('决定采用 monorepo 架构方案');
  m.write('部署流程先测试后发布');
  m.write('我喜欢简洁风格的回答');
  const r = m.loadRelevant('随便问点什么', { maxTopics: 2 });
  assert.ok(r.topics.length <= 2, '实际 ' + r.topics.length);
});

t('loadRelevant 遵守字符预算', () => {
  const m = newMem();
  for (let i = 0; i < 40; i++) m.write('项目规范第 ' + i + ' 条：必须遵守某种约定内容填充填充填充');
  const r = m.loadRelevant('规范', { budget: 300 });
  assert.ok(r.text.length <= 500, '实际长度 ' + r.text.length);
  assert.ok(r.items > 0);
});

t('loadRelevant 新记忆优先', () => {
  const m = newMem();
  m.write('规范：旧的约定内容 AAA 必须遵守');
  m.write('规范：新的约定内容 BBB 必须遵守');
  const r = m.loadRelevant('规范', { budget: 200 });
  const idxNew = r.text.indexOf('BBB');
  const idxOld = r.text.indexOf('AAA');
  assert.ok(idxNew >= 0 && (idxOld < 0 || idxNew < idxOld), '新记忆应排在前面');
});

t('无记忆时 loadRelevant 返回空', () => {
  const r = newMem().loadRelevant('任何问题');
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.items, 0);
});

t('enabled=false 时 loadRelevant 返回空', () => {
  const m = newMem({ enabled: false });
  assert.strictEqual(m.loadRelevant('x').text, '');
});

t('always 参数强制包含指定主题', () => {
  const m = newMem();
  m.write('我喜欢简洁的回答风格偏好');
  m.write('部署流程先测试后发布上线');
  const r = m.loadRelevant('完全无关的量子物理问题', { maxTopics: 1, always: ['workflows'] });
  assert.ok(r.topics.includes('workflows'));
});

// ---------- 6. 自动沉淀 ----------
t('harvest 抓「记住」句式', () => {
  const items = mt.harvest([{ role: 'user', content: '记住：这个项目的端口固定用 8899' }]);
  assert.strictEqual(items.length, 1);
  assert.ok(items[0].text.includes('8899'));
});

t('harvest 抓「以后都」句式', () => {
  const items = mt.harvest([{ role: 'user', content: '以后都用 pnpm 安装依赖，别用 npm' }]);
  assert.ok(items.length >= 1);
});

t('harvest 抓「不要」句式', () => {
  const items = mt.harvest([{ role: 'user', content: '不要在提交里带 console.log' }]);
  assert.ok(items.length >= 1);
  assert.ok(items[0].text.includes('console.log'));
});

t('harvest 抓用户纠正', () => {
  const items = mt.harvest([{ role: 'user', content: '不对，应该改的是 src/agent.js 不是 chatView.js' }]);
  assert.ok(items.length >= 1);
});

t('harvest 忽略 assistant 消息', () => {
  const items = mt.harvest([{ role: 'assistant', content: '记住：我会这样做' }]);
  assert.strictEqual(items.length, 0);
});

t('harvest 忽略闲聊短语', () => {
  const items = mt.harvest([
    { role: 'user', content: '好的' },
    { role: 'user', content: '继续' },
    { role: 'user', content: 'ok' }
  ]);
  assert.strictEqual(items.length, 0);
});

t('harvest 忽略系统注入消息', () => {
  const items = mt.harvest([{ role: 'user', content: '[系统] 用户已确认计划，请必须继续执行' }]);
  assert.strictEqual(items.length, 0);
});

t('harvest 去重近似句', () => {
  const items = mt.harvest([
    { role: 'user', content: '记住：端口用 8899' },
    { role: 'user', content: '记住：端口用 8899。' }
  ]);
  assert.strictEqual(items.length, 1);
});

t('harvest 支持数组型 content（多模态消息）', () => {
  const items = mt.harvest([{ role: 'user', content: [{ type: 'text', text: '记住：构建前必须清缓存' }] }]);
  assert.ok(items.length >= 1);
});

t('harvest 限制条数', () => {
  const msgs = [];
  for (let i = 0; i < 20; i++) msgs.push({ role: 'user', content: '记住：第 ' + i + ' 条不同的约定内容' });
  assert.ok(mt.harvest(msgs, { maxItems: 5 }).length <= 5);
});

t('autoHarvest 把抽取结果写入主题', () => {
  const m = newMem();
  const r = m.autoHarvest([
    { role: 'user', content: '记住：本项目必须用 pnpm，这是规范' },
    { role: 'user', content: '这个 bug 的根因是缓存没清，以后先清缓存' }
  ]);
  assert.ok(r.candidates >= 2);
  assert.ok(r.written >= 2);
  assert.ok(m.totalCount >= 2);
});

t('autoHarvest 重复运行不产生重复条目', () => {
  const m = newMem();
  const msgs = [{ role: 'user', content: '记住：端口固定 8899 不要改' }];
  m.autoHarvest(msgs);
  const before = m.totalCount;
  const r2 = m.autoHarvest(msgs);
  assert.strictEqual(m.totalCount, before);
  assert.ok(r2.skipped >= 1);
});

t('autoHarvest 无候选时安全返回', () => {
  const m = newMem();
  const r = m.autoHarvest([{ role: 'user', content: '好的' }]);
  assert.strictEqual(r.written, 0);
  assert.strictEqual(r.candidates, 0);
});

t('autoHarvest 空输入不报错', () => {
  const m = newMem();
  assert.strictEqual(m.autoHarvest(null).written, 0);
  assert.strictEqual(m.autoHarvest([]).written, 0);
});

// ---------- 7. 持久性 ----------
t('新实例能读到已有记忆（跨会话）', () => {
  const base = path.join(tmp, 'persist');
  const a = new mt.TopicMemory({ baseDir: base });
  a.write('跨会话必须记住的项目规范内容');
  const b = new mt.TopicMemory({ baseDir: base });
  assert.strictEqual(b.read('project-conventions').length, 1);
  assert.strictEqual(b.totalCount, 1);
});

t('clear 清空全部记忆', () => {
  const m = newMem();
  m.write('某条项目规范');
  m.clear();
  assert.strictEqual(m.totalCount, 0);
});

t('手动编辑主题文件后能被读到', () => {
  const m = newMem();
  m.write('第一条规范内容');
  fs.appendFileSync(path.join(m.topicDir, 'project-conventions.md'), '- 手写的第二条规范\n', 'utf8');
  const items = m.read('project-conventions');
  assert.strictEqual(items.length, 2);
  assert.ok(items[1].includes('手写的第二条'));
});

console.log(`\n[memoryTopics] ${pass} 通过 / ${fail} 失败`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
