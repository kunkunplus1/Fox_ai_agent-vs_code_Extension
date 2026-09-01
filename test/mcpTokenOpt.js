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
  // MCP_RESULT_MAX_CHARS=16000：样本必须超阈值才会触发截断（旧样本 5000 字不够长）
  const single = 'x'.repeat(20000);
  const r = mcp.formatResult({ content: [{ type: 'text', text: single }] });
  assert.ok(r.length < 20000 + 200, '应明显变短');
  assert.ok(r.includes('已截断'), '含截断标记');
});

ok('报错结果也被截断', () => {
  const r = mcp.formatResult({ isError: true, content: [{ type: 'text', text: 'x'.repeat(20000) }] });
  assert.ok(r.startsWith('[MCP 工具报错]'), '保留报错前缀');
  assert.ok(r.includes('已截断'), '报错内容也被截断');
});

ok('图片类内容不被破坏', () => {
  const r = mcp.formatResult({ content: [{ type: 'image', mimeType: 'image/png', data: 'AAA' }] });
  assert.ok(r.includes('[图片数据'), '仅描述，不被截断逻辑破坏');
});

// ---------- T3: trimHistory 对旧工具结果的处理 ----------
// 1.1.18 起铁律：**摘要化已移除**（改写历史中间 → 前缀缓存断裂 → 命中率 60% 主因）。
// 现在是 append-only：旧 tool 结果只做「确定性截断/丢弃」，绝不改写成一行摘要。
// 本测试锁住这条铁律——若未来有人把摘要化加回来，这里会红。
function makeConv(n) {
  const list = [];
  for (let i = 0; i < n; i++) {
    list.push({ role: 'user', content: 'q' + i });
    list.push({ role: 'assistant', content: 'a' + i, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'mcp__x__y', arguments: {} } }] });
    list.push({ role: 'tool', tool_call_id: 'c' + i, name: 'mcp__x__y', content: 'RESULT-' + i + '-' + 'z'.repeat(2000) });
  }
  return list;
}

ok('旧 tool 结果绝不被摘要化改写（append-only 铁律）', () => {
  const msgs = makeConv(20); // 60 条，窗口 maxHistory*2=2000 条，远未触发窗口截断
  const out = trimHistory(msgs, 'native', 1000, {});
  const tools = out.filter((m) => m.role === 'tool');
  // 完整保留：20 条全在（20 << 2000 窗口），且内容仍是原始 RESULT- 前缀，无一被改写
  assert.strictEqual(tools.length, 20, '窗口内 tool 全部保留，实际 ' + tools.length);
  assert.ok(tools.every((m) => m.content.startsWith('RESULT-')), 'tool 内容未被改写（无 [历史工具结果摘要] 等注入）');
  assert.ok(tools.every((m) => !m.content.includes('[历史工具结果摘要]')), '不允许出现摘要标记');
});

ok('窗口外旧 tool 结果被丢弃而非摘要（前缀稳定）', () => {
  const msgs = makeConv(60); // 180 条，窗口 20*2=40 条
  const out = trimHistory(msgs, 'native', 20, {});
  const tools = out.filter((m) => m.role === 'tool');
  assert.ok(tools.length <= 40, '保留的 tool 不超过窗口，实际 ' + tools.length);
  assert.ok(tools.every((m) => m.content.startsWith('RESULT-')), '保留的都是原始内容，无摘要改写');
  // tool_calls 与 tool 结果配对完整（无孤立 tool）
  const ids = new Set(tools.map((t) => t.tool_call_id));
  for (const m of out) {
    if (m.role === 'assistant' && m.tool_calls) {
      assert.ok(m.tool_calls.every((t) => ids.has(t.id)), 'assistant.tool_calls 都有对应 tool 结果');
    }
  }
});

console.log('\nmcpTokenOpt 测试通过：' + pass);
process.exit(process.exitCode || 0);
