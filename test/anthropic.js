'use strict';
// 测试 Anthropic Claude 适配层（src/anthropic.js）：
// - OpenAI 格式 messages ↔ Anthropic Messages 互译（toAnthropic / fromAnthropic）
// - 非流式 /messages 端到端解析
// - SSE 流式（text_delta / tool_use 块）聚合（经 chatOnce 包装）
// 通过本地假 HTTP server 端到端验证，无需 vscode 环境。

const http = require('http');
const assert = require('assert');
const anthropic = require('../src/anthropic');

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

function makeServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => handler(req, res, body));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const SAMPLE_MESSAGES = [
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '读一下 a.txt' },
  { role: 'assistant', content: '', reasoning: '需要先读文件再回答。', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
  { role: 'tool', tool_call_id: 'call_1', content: '文件内容: hello' },
  { role: 'assistant', content: '已读完' }
];

async function run() {
  // ── 测试 1：toAnthropic 互译 ──
  console.log('测试1：toAnthropic 格式转换');
  const a = anthropic.toAnthropic(SAMPLE_MESSAGES);
  ok('system 被提取到顶层', a.system === '你是助手');
  ok('user 消息保留', a.messages[0].role === 'user' && a.messages[0].content === '读一下 a.txt');
  const asst = a.messages.find((m) => m.role === 'assistant');
  const toolUse = asst.content.find((b) => b.type === 'tool_use');
  ok('assistant tool_calls → tool_use 块', !!toolUse && toolUse.name === 'read_file');
  ok('tool_use input 正确解析', JSON.stringify(toolUse.input) === '{"path":"a.txt"}');
  const toolUser = a.messages.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content[0] && m.content[0].type === 'tool_result');
  ok('tool 结果 → tool_result 块', !!toolUser && toolUser.content[0].tool_use_id === 'call_1');
  ok('tool_result 内容正确', toolUser.content[0].content === '文件内容: hello');

  // ── 测试 2：fromAnthropic 解析 ──
  console.log('测试2：fromAnthropic 响应解析');
  const f = anthropic.fromAnthropic({
    content: [
      { type: 'thinking', thinking: '让我想想' },
      { type: 'text', text: '结论是 ok' },
      { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'b.txt' } }
    ],
    stop_reason: 'tool_use'
  });
  ok('text → content', f.content === '结论是 ok');
  ok('thinking → reasoning', f.reasoning === '让我想想');
  ok('tool_use → toolCalls', f.toolCalls.length === 1 && f.toolCalls[0].name === 'read_file' && f.toolCalls[0].id === 't1');
  ok('stop_reason=tool_use → finishReason=tool_calls', f.finishReason === 'tool_calls');

  // ── 测试 3：chatNonStream 端到端（非流式 JSON）──
  console.log('测试3：chatNonStream 非流式端到端');
  let gotBody = null;
  let gotHeaders = null;
  let srv = await makeServer((req, res, body) => {
    gotBody = JSON.parse(body);
    gotHeaders = req.headers;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      content: [{ type: 'text', text: '已读完' }],
      stop_reason: 'end_turn'
    }));
  });
  const port = srv.address().port;
  const r3 = await anthropic.chatNonStream({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: '', model: 'claude-sonnet-4-20250514', messages: SAMPLE_MESSAGES, tools: [], timeout: 5000
  });
  ok('非流式 content 正确', r3.content === '已读完');
  ok('非流式 finishReason=stop', r3.finishReason === 'stop');
  ok('请求体含 system 字段（走 Anthropic 格式，带 cache_control 块）', Array.isArray(gotBody.system) && gotBody.system[0].type === 'text' && gotBody.system[0].text === '你是助手' && gotBody.system[0].cache_control);
  ok('请求体 messages 为 Anthropic 数组', Array.isArray(gotBody.messages) && gotBody.messages.length === 4);
  ok('非流式请求带 anthropic-version 头（bug#2 修复：此前复用 OpenAI 的 Bearer 头，Claude 非流式会 401）', gotHeaders['anthropic-version'] === '2023-06-01');
  srv.close();

  // ── 测试 4：streamChat 端到端（SSE 流式，经 chatOnce 包装）──
  console.log('测试4：streamChat SSE 流式端到端');
  srv = await makeServer((req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.write('event: message_start\ndata: {}\n\n');
    res.write('event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"你好"}}\n\n');
    res.write('event: content_block_start\ndata: {"delta":{"type":"tool_use","id":"t2","name":"read_file"}}\n\n');
    res.write('event: content_block_delta\ndata: {"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"c.txt\\"}"}}\n\n');
    res.write('event: content_block_stop\ndata: {}\n\n');
    res.write('event: message_delta\ndata: {"delta":{"stop_reason":"tool_use"}}\n\n');
    res.write('event: message_stop\ndata: {}\n\n');
    res.end();
  });
  const port2 = srv.address().port;
  const r4 = await new Promise((resolve, reject) => {
    const { promise } = anthropic.chatOnce({
      baseUrl: `http://127.0.0.1:${port2}/v1`,
      apiKey: '', model: 'claude-sonnet-4-20250514', messages: SAMPLE_MESSAGES, tools: [], timeout: 5000
    });
    promise.then(resolve, reject);
  });
  ok('流式 content 聚合正确', r4.content === '你好');
  ok('流式 tool_use 聚合为 toolCalls', r4.toolCalls.length === 1 && r4.toolCalls[0].name === 'read_file');
  ok('流式 finishReason=tool_calls', r4.finishReason === 'tool_calls');
  srv.close();

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  if (fail) process.exit(1);
}

run().catch((e) => { console.error('测试异常：', e); process.exit(1); });
