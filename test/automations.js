'use strict';

// 本地自动化单测：纯 Node、零 vscode 依赖，覆盖 cron/store/scheduler/webhook 红线。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const autom = require('../src/automations');

let pass = 0, fail = 0;
function ok(name, cond) {
  try { assert.ok(cond, name); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ' -> ' + e.message); }
}

console.log('自动化: cron 匹配');
const d = (min, h, day, mon, dow) => { const x = new Date(2026, 0, 4, 9, 30, 0); x.setMinutes(min); x.setHours(h); x.setDate(day); x.setMonth(mon - 1); x.setDay ? x.setDay(dow) : null; x.setFullYear(2026); if (typeof dow === 'number') { /* setDay not standard; override */ } return x; };
// 用标准 Date 构造：2026-01-04 是周日(dow=0), 09:30
const base = new Date(2026, 0, 4, 9, 30, 0); // Sun Jan 4 2026 09:30
ok('每分都匹配 * * * * *', autom.matchCron('* * * * *', base) === true);
ok('指定分钟命中 30 * * * *', autom.matchCron('30 * * * *', base) === true);
ok('指定分钟未命中 31 * * * *', autom.matchCron('31 * * * *', base) === false);
ok('小时命中 30 9 * * *', autom.matchCron('30 9 * * *', base) === true);
ok('小时未命中 30 10 * * *', autom.matchCron('30 10 * * *', base) === false);
ok('日命中 30 9 4 * *', autom.matchCron('30 9 4 * *', base) === true);
ok('月命中 30 9 4 1 *', autom.matchCron('30 9 4 1 *', base) === true);
ok('月未命中 30 9 4 2 *', autom.matchCron('30 9 4 2 *', base) === false);
ok('周命中 30 9 * * 0', autom.matchCron('30 9 * * 0', base) === true);
ok('周未命中 30 9 * * 1', autom.matchCron('30 9 * * 1', base) === false);
ok('步长 0/15 命中 30', autom.matchCron('0/15 * * * *', new Date(2026, 0, 4, 9, 30, 0)) === true);
ok('步长 0/15 未命中 31', autom.matchCron('0/15 * * * *', new Date(2026, 0, 4, 9, 31, 0)) === false);
ok('列表 30,45 命中 30', autom.matchCron('30,45 * * * *', new Date(2026, 0, 4, 9, 30, 0)) === true);
ok('非法字段数返回 false', autom.matchCron('* * *', base) === false);

console.log('自动化: 存储');
const tmp = path.join(os.tmpdir(), 'fox-ai-auto-test-' + Date.now() + '.json');
const store = new autom.AutomationStore(tmp);
ok('初始为空', store.list().length === 0);
const a1 = { id: 'a1', name: '每日摘要', enabled: true, prompt: '总结今日改动', schedule: { type: 'cron', expr: '0 9 * * *' } };
store.upsert(a1);
ok('upsert 后含 1 条', store.list().length === 1);
ok('get 命中', store.get('a1').name === '每日摘要');
ok('落盘', JSON.parse(fs.readFileSync(tmp, 'utf8')).length === 1);
store.upsert(Object.assign({}, a1, { name: '每日摘要改' }));
ok('upsert 覆盖同 id', store.list().length === 1 && store.get('a1').name === '每日摘要改');
store.upsert({ id: 'a2', name: 'b', enabled: false, prompt: 'x', schedule: { type: 'interval', ms: 1000 } });
ok('enabledList 只含启用项', store.enabledList().length === 1 && store.enabledList()[0].id === 'a1');
ok('remove 生效', store.remove('a1') === true && store.get('a1') === null);
fs.unlinkSync(tmp);

console.log('自动化: 调度器');
let fired = 0;
const sstore = new autom.AutomationStore(tmp);
sstore.upsert({ id: 'iv', name: 'i', enabled: true, prompt: 'p', schedule: { type: 'interval', ms: 20 } });
const sched = new autom.AutomationScheduler(sstore, () => { fired++; });
sched.start();
setTimeout(() => {
  sched.stop();
  ok('interval 调度触发 onFire', fired >= 1);

  console.log('自动化: webhook 红线');
  let dispatched = null;
  const h = (body, secret, allowedIds) => autom.handleWebhook({ body, secret, allowedIds, dispatch: (id, args) => { dispatched = { id, args }; return 'run-123'; } });
  let r = h(JSON.stringify({ id: 'a1', args: { x: 1 } }));
  ok('合法请求回执 ok+runId', r.statusCode === 200 && r.body.ok === true && r.body.runId === 'run-123');
  ok('dispatch 被调用(id+args)', dispatched && dispatched.id === 'a1' && dispatched.args.x === 1);
  r = h(JSON.stringify({ id: 'unknown' }), null, ['a1']);
  ok('未知 id 返回 404', r.statusCode === 404 && r.body.ok === false);
  r = h(JSON.stringify({ id: 'a1' }), 'topsecret', ['a1']);
  ok('错误 secret 返回 403', r.statusCode === 403);
  r = h('not json', null, ['a1']);
  ok('坏 JSON 返回 400', r.statusCode === 400);
  // 红线：响应体绝不含“内部”字样
  r = h(JSON.stringify({ id: 'a1' }));
  ok('响应只回执、无内部内容', JSON.stringify(r.body).indexOf('knowledge') === -1 && JSON.stringify(r.body).indexOf('memory') === -1);

  console.log('\n自动化测试: ' + pass + ' 通过, ' + fail + ' 失败');
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  process.exit(fail ? 1 : 0);
}, 120);
