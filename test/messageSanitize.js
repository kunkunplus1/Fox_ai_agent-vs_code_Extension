'use strict';

// 验证对话历史清洗：native 丢弃孤立 tool、text 协议转换 tool→user、截断不切断 tool 块
const assert = require('assert');
const { trimHistory } = require('../src/messageSanitize');

let passed = 0;
function check(name, fn) {
  try { fn(); console.log('PASS', name); passed++; }
  catch (e) { console.error('FAIL', name, '->', e.message); process.exitCode = 1; }
}

// 1) native：合法 tool 对话应原样保留
check('native 保留合法 tool 对话', () => {
  const msgs = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'data' },
    { role: 'assistant', content: 'done' }
  ];
  const out = trimHistory(msgs, 'native', 20);
  assert.strictEqual(out.length, 4);
  assert.strictEqual(out[2].role, 'tool');
});

// 2) native：孤立 tool 消息（前面最近 assistant 不含匹配 id）应被丢弃
check('native 丢弃孤立 tool 消息', () => {
  const msgs = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok' },
    { role: 'tool', tool_call_id: 'orphan', name: 'x', content: 'ghost' },
    { role: 'assistant', content: 'after' }
  ];
  const out = trimHistory(msgs, 'native', 20);
  assert.ok(!out.some((m) => m.role === 'tool'), '不应有 tool 消息残留');
});

// 3) native：assistant(tool_calls) 没有对应 tool 结果 → 删除 tool_calls
check('native 清理无结果的 tool_calls', () => {
  const msgs = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'thinking', tool_calls: [{ id: 'cX', type: 'function', function: { name: 'run_command', arguments: '{}' } }] },
    { role: 'assistant', content: 'final' }
  ];
  const out = trimHistory(msgs, 'native', 20);
  const a = out.find((m) => m.role === 'assistant' && m.content === 'thinking');
  assert.ok(a && !a.tool_calls, '无结果的 tool_calls 应被删除');
});

// 4) text 协议：残留 tool 消息应转为 user 文本，assistant.tool_calls 应剥离
check('text 协议把 tool 转 user', () => {
  const msgs = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'data' }
  ];
  const out = trimHistory(msgs, 'text', 20);
  assert.ok(!out.some((m) => m.role === 'tool'), 'text 协议不应有 tool 消息');
  assert.ok(!out.some((m) => m.role === 'assistant' && m.tool_calls), 'text 协议不应有 tool_calls');
  const u = out.find((m) => m.role === 'user' && /工具 read_file 的结果/.test(m.content));
  assert.ok(u, '应生成工具结果 user 文本');
});

// 5) 截断不切断 tool 块：保留区起点若在 tool 中间，应回退到所属 assistant
check('截断保留完整 tool 块', () => {
  const msgs = [];
  for (let i = 0; i < 30; i++) msgs.push({ role: 'user', content: 'msg' + i });
  msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c9', type: 'function', function: { name: 'x', arguments: '{}' } }] });
  msgs.push({ role: 'tool', tool_call_id: 'c9', name: 'x', content: 'r' });
  const out = trimHistory(msgs, 'native', 20);
  const hasAssistant = out.some((m) => m.role === 'assistant' && m.tool_calls);
  const hasTool = out.some((m) => m.role === 'tool');
  assert.ok(hasAssistant === hasTool, 'assistant 与 tool 应同时存在或同时不存在');
});

// 6) 混合：native 历史里夹一个孤儿 tool（被 user 隔开的 tool）应被丢弃，但合法 tool 保留
check('混合保留合法并丢弃孤儿', () => {
  const msgs = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'ok' },
    { role: 'user', content: 'b' },
    { role: 'tool', tool_call_id: 'ghost', name: 'x', content: 'orphan' },
    { role: 'assistant', content: 'end' }
  ];
  const out = trimHistory(msgs, 'native', 20);
  assert.strictEqual(out.filter((m) => m.role === 'tool').length, 1, '应只保留 1 条合法 tool');
  assert.ok(out.some((m) => m.role === 'tool' && m.tool_call_id === 'c1'), '合法 tool 应保留');
});

console.log(`\n${passed} 组通过`);
