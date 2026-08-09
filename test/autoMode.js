'use strict';
// Auto Mode 单元测试（纯逻辑，无 vscode 依赖）
const assert = require('assert');
const { classify, invalidate, cacheSize, parseDecision, argHash, ruleFastPath, describeCall } = require('../src/autoMode');

let pass = 0;
function ok(name, cond) {
  assert.ok(cond, 'FAIL: ' + name);
  pass += 1;
  console.log('  ✓ ' + name);
}

// ---- ruleFastPath ----
ok('拒绝名单命中', ruleFastPath('run_command', { deny: ['run_command'] }).decision === 'deny');
ok('放行名单命中', ruleFastPath('write_file', { allow: ['write_file'] }).decision === 'allow');
ok('无名单返回 null', ruleFastPath('edit_file', {}) === null);

// ---- classify：名单快路径（不调 LLM）----
(async () => {
  invalidate();
  let llmCalls = 0;
  const llm = async () => { llmCalls += 1; return '{"decision":"allow","reason":"x"}'; };

  const a1 = await classify('run_command', 'exec', { command: 'ls' }, { config: { deny: ['run_command'] }, llm });
  ok('deny 名单 → deny', a1.decision === 'deny' && a1.fromRule === true);

  const a2 = await classify('write_file', 'write', { path: '/a' }, { config: { allow: ['write_file'] }, llm });
  ok('allow 名单 → allow', a2.decision === 'allow' && a2.fromRule === true);
  ok('名单命中不调 LLM', llmCalls === 0);

  // 无 llm 兜底 → ask
  const a3 = await classify('edit_file', 'edit', { path: '/a' }, { config: {} });
  ok('无 llm → ask', a3.decision === 'ask' && llmCalls === 0);

  // LLM 兜底：allow
  const a4 = await classify('edit_file', 'edit', { path: '/tmp/a.txt', content: 'hello' }, { config: {}, llm });
  ok('LLM 返回 allow', a4.decision === 'allow' && llmCalls === 1);
  ok('allow 带 fromLLM 标记', a4.fromLLM === true);

  // LLM 兜底：deny（含危险关键词）
  const a5 = await classify('run_command', 'exec', { command: 'rm -rf /' }, {
    config: {},
    llm: async () => '{"decision":"deny","reason":"破坏性命令"}'
  });
  ok('LLM 返回 deny', a5.decision === 'deny');

  // LLM 兜底：ask
  const a6 = await classify('run_command', 'exec', { command: 'npm test' }, {
    config: {},
    llm: async () => '{"decision":"ask","reason":"不确定"}'
  });
  ok('LLM 返回 ask', a6.decision === 'ask');

  // 缓存：相同 tool+args 第二次不调 LLM
  const before = llmCalls;
  const a7 = await classify('edit_file', 'edit', { path: '/tmp/a.txt', content: 'hello' }, { config: {}, llm });
  ok('缓存命中 → 不重复调 LLM', llmCalls === before && a7.fromCache === true && a7.decision === 'allow');

  // 缓存：不同参数 → 重新分类
  const a8 = await classify('edit_file', 'edit', { path: '/tmp/b.txt', content: 'world' }, { config: {}, llm });
  ok('不同参数 → 重新调 LLM', llmCalls === before + 1 && a8.fromCache !== true);

  ok('缓存内有条目', cacheSize() >= 2);

  // LLM 异常 → 保守 ask
  const a9 = await classify('write_file', 'write', { path: '/c' }, {
    config: {},
    llm: async () => { throw new Error('boom'); }
  });
  ok('LLM 异常 → ask', a9.decision === 'ask' && a9.fromLLM === false);
})().then(() => {
  // ---- parseDecision 容错 ----
  ok('解析纯 JSON', parseDecision('{"decision":"allow","reason":"r"}').decision === 'allow');
  ok('解析带噪声 JSON', parseDecision('话：{"decision":"deny","reason":"危险"} 结束').decision === 'deny');
  ok('无 JSON 走关键词 deny', parseDecision('我建议 deny 这个操作').decision === 'deny');
  ok('无 JSON 走关键词 allow', parseDecision('allow it').decision === 'allow');
  ok('空输入 → ask', parseDecision('').decision === 'ask');
  ok('非法 decision 字段 → ask', parseDecision('{"decision":"maybe"}').decision === 'ask');

  // ---- argHash 稳定 ----
  ok('argHash 同参稳定', argHash({ a: 1 }) === argHash({ a: 1 }));
  ok('argHash 异参不同', argHash({ a: 1 }) !== argHash({ a: 2 }));

  // ---- describeCall 截断 ----
  const d = describeCall('edit_file', 'edit', { path: '/x', content: 'A'.repeat(500), note: 'B'.repeat(500) });
  ok('describeCall 截断长字段', d.indexOf('A'.repeat(350)) === -1 && d.indexOf('B'.repeat(200)) === -1 && d.indexOf('"path":"/x"') > -1);

  // ---- 有界缓存 ----
  invalidate();
  ok('invalidate 清缓存', cacheSize() === 0);

  console.log('\n[autoMode] 通过 ' + pass + ' 项断言');
}).catch((e) => { console.error(e); process.exit(1); });
