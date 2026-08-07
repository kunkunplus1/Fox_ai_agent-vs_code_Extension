'use strict';

/*
 * MCP Token 优化测试：
 *  - formatResult 对超长工具结果做智能头尾截断（T2）
 *  - trimHistory 把超出最近窗口的旧 role:'tool' 长结果压缩为元摘要（T3）
 */

const assert = require('assert');
const mcp = require('../src/tools/mcp');
const { trimHistory } = require('../src/messageSanitize');

let pass = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.error('  ✗ ' + name + ' -> ' + e.message); process.exitCode = 1; }
}

// ---------- T2: formatResult 智能截断 ----------
ok('短结果原样返回', () => {
  assert.strictEqual(mcp.formatResult({ content: [{ type: 'text', text: 'hi' }] }), 'hi');
  assert.strictEqual(mcp.formatResult(null), '');
});

ok('超长多行结果保留头尾并省略中间', () => {
  const long = Array.from({ length: 300 }, (_, i) => 'line' + i).join('\n');
  const r = mcp.formatResult({ content: [{ type: 'text', text: long }] });
  assert.ok(r.startsWith('line0'), '保留头部');
  assert.ok(r.includes('line299'), '保留尾部');
  assert.ok(r.includes('已省略'), '含省略标记');
  assert.ok(r.includes('重新调用'), '含精确查询提示');
  assert.ok(r.length < long.length, '整体应更短');
});

ok('超长单行结果从头截断', () => {
  const single = 'x'.repeat(5000);
  const r = mcp.formatResult({ content: [{ type: 'text', text: single }] });
  assert.ok(r.length < 5000 + 200, '应明显变短');
  assert.ok(r.includes('已截断'), '含截断标记');
});

ok('报错结果也被截断', () => {
  const r = mcp.formatResult({ isError: true, content: [{ type: 'text', text: 'x'.repeat(5000) }] });
  assert.ok(r.startsWith('[MCP 工具报错]'), '保留报错前缀');
  assert.ok(r.includes('已截断'), '报错内容也被截断');
});

ok('图片类内容不被破坏', () => {
  const r = mcp.formatResult({ content: [{ type: 'image', mimeType: 'image/png', data: 'AAA' }] });
  assert.ok(r.includes('[图片数据'), '仅描述，不被截断逻辑破坏');
});

// ---------- T3: trimHistory 旧工具结果摘要化 ----------
function makeConv(n) {
  const list = [];
  for (let i = 0; i < n; i++) {
    list.push({ role: 'user', content: 'q' + i });
    list.push({ role: 'assistant', content: 'a' + i, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'mcp__x__y', arguments: {} } }] });
    list.push({ role: 'tool', tool_call_id: 'c' + i, name: 'mcp__x__y', content: 'RESULT-' + i + '-' + 'z'.repeat(2000) });
  }
  return list;
}

ok('超出最近窗口的旧 tool 结果被摘要', () => {
  const msgs = makeConv(20); // 60 条
  const out = trimHistory(msgs, 'native', 1000, {});
  const tools = out.filter((m) => m.role === 'tool');
  const summarized = tools.filter((m) => m.content.startsWith('[历史工具结果摘要]'));
  assert.ok(summarized.length >= 15, '至少 15 个旧 tool 被摘要，实际 ' + summarized.length);
  const recent = out.slice(-12).filter((m) => m.role === 'tool');
  assert.ok(recent.length > 0 && recent.every((m) => !m.content.startsWith('[历史工具结果摘要]')), '最近窗口 tool 不摘要');
});

ok('摘要正确标记成功/失败', () => {
  const list = [];
  for (let i = 0; i < 10; i++) {
    list.push({ role: 'user', content: 'q' + i });
    list.push({ role: 'assistant', content: 'a' + i, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'mcp__x__y', arguments: {} } }] });
    list.push({ role: 'tool', tool_call_id: 'c' + i, name: 'mcp__x__y', content: (i === 0 ? '...status=error...' : 'ok') + 'z'.repeat(2000) });
  }
  const out = trimHistory(list, 'native', 1000, {});
  const summarized = out.filter((m) => m.role === 'tool' && m.content.startsWith('[历史工具结果摘要]'));
  assert.ok(summarized.some((m) => m.content.includes('失败')), '应有一个失败摘要');
  assert.ok(summarized.some((m) => m.content.includes('成功')), '应有成功摘要');
});

console.log('\nmcpTokenOpt 测试通过：' + pass);
process.exit(process.exitCode || 0);
