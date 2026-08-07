'use strict';
// 测试 OpenAI Responses API 支持（/v1/responses）：
// - messages → input / system → instructions 转换
// - tools 扁平化
// - 非流式 output 解析
// - 流式 SSE 事件（output_text.delta / function_call_arguments.delta / completed）聚合
// 通过本地假 HTTP server 端到端验证，无需 vscode 环境。

const http = require('http');
const assert = require('assert');
const client = require('../src/client');

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
  // ── 测试 1：非流式端到端（content + toolCalls 解析）──
  console.log('测试1：chatNonStreamResponses 非流式解析');
  let lastBody = null;
  let srv = await makeServer((req, res, body) => {
    lastBody = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      output: [
        { type: 'message', content: [{ type: 'output_text', text: '已完成' }] },
        { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' }
      ]
    }));
  });
  const port = srv.address().port;
  const r1 = await client.chatNonStreamResponses({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: '', model: 'gpt-4o-mini', messages: SAMPLE_MESSAGES, tools: [], timeout: 5000
  });
  ok('非流式 content 正确', r1.content === '已完成');
  ok('非流式 toolCalls 含 read_file', r1.toolCalls.length === 1 && r1.toolCalls[0].name === 'read_file' && r1.toolCalls[0].id === 'c1');
  ok('非流式 finishReason=tool_calls', r1.finishReason === 'tool_calls');
  ok('system 抽到 instructions', lastBody.instructions === '你是助手');
  ok('input 不含 system 角色', !lastBody.input.some((i) => i.role === 'system'));
  ok('input 含 user/tool 配对', lastBody.input.some((i) => i.role === 'user' && i.content[0].text === '读一下 a.txt'));
  ok('input 含 function_call_output 回传', lastBody.input.some((i) => i.type === 'function_call_output' && i.call_id === 'call_1' && i.output === '文件内容: hello'));
  // 工具调用必须是「顶层独立 function_call item」，不能包进 assistant.content（DeepSeek 严格校验）
  const fcItem = lastBody.input.find((i) => i.type === 'function_call' && i.call_id === 'call_1');
  ok('input 的 function_call 为顶层独立 item', !!fcItem && fcItem.name === 'read_file' && fcItem.arguments === '{"path":"a.txt"}');
  ok('input 不含包着 function_call 的 assistant.content 数组', !lastBody.input.some((i) => i.role === 'assistant' && Array.isArray(i.content) && i.content.some((c) => c.type === 'function_call')));
  // 思考模式（DeepSeek）要求多轮回传 reasoning：assistant 消息带 reasoning 时要发成 reasoning item
  const rItem = lastBody.input.find((i) => i.type === 'reasoning' && Array.isArray(i.content) && i.content[0] && i.content[0].text === '需要先读文件再回答。');
  ok('input 含 reasoning 回传 item（思考模式兼容）', !!rItem);
  srv.close();

  // ── 测试 2：流式纯文本增量聚合 ──
  console.log('测试2：streamResponses 流式文本增量');
  srv = await makeServer((req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.write('data: {"type":"response.output_text.delta","delta":"hel"}\n\n');
    res.write('data: {"type":"response.output_text.delta","delta":"lo"}\n\n');
    res.write('data: {"type":"response.completed"}\n\n');
    res.end();
  });
  const port2 = srv.address().port;
  const deltas = [];
  const r2 = await new Promise((resolve, reject) => {
    client.streamResponses({
      baseUrl: `http://127.0.0.1:${port2}/v1`, apiKey: '', model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }], timeout: 5000,
      onDelta: (t) => deltas.push(t),
      onDone: resolve, onError: reject
    });
  });
  ok('流式文本聚合正确', r2.content === 'hello');
  ok('流式两次 onDelta', deltas.length === 2 && deltas.join('') === 'hello');
  ok('流式 finishReason=stop', r2.finishReason === 'stop');
  ok('流式无工具', r2.toolCalls.length === 0);
  srv.close();

  // ── 测试 3：流式工具调用增量聚合 ──
  console.log('测试3：streamResponses 流式工具调用');
  srv = await makeServer((req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.write('data: {"type":"response.output_item.added","item_id":"i1","item":{"type":"function_call","call_id":"c1","name":"read_file"}}\n\n');
    res.write('data: {"type":"response.function_call_arguments.delta","item_id":"i1","delta":"{\\"path\\":\\"a.txt\\"}"}\n\n');
    res.write('data: {"type":"response.output_item.done","item_id":"i1","item":{"type":"function_call","call_id":"c1","name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}\n\n');
    res.write('data: {"type":"response.completed"}\n\n');
    res.end();
  });
  const port3 = srv.address().port;
  const r3 = await new Promise((resolve, reject) => {
    client.streamResponses({
      baseUrl: `http://127.0.0.1:${port3}/v1`, apiKey: '', model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: '读 a.txt' }], timeout: 5000,
      onDone: resolve, onError: reject
    });
  });
  ok('流式工具名正确', r3.toolCalls.length === 1 && r3.toolCalls[0].name === 'read_file');
  ok('流式工具参数聚合正确', r3.toolCalls[0].arguments === '{"path":"a.txt"}');
  ok('流式工具 id 正确', r3.toolCalls[0].id === 'c1');
  srv.close();

  // ── 测试 4：推理增量（reasoning）──
  console.log('测试4：streamResponses 推理增量');
  srv = await makeServer((req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.write('data: {"type":"response.reasoning_text.delta","delta":"思考"}\n\n');
    res.write('data: {"type":"response.output_text.delta","delta":"答案"}\n\n');
    res.write('data: {"type":"response.completed"}\n\n');
    res.end();
  });
  const port4 = srv.address().port;
  const r4 = await new Promise((resolve, reject) => {
    client.streamResponses({
      baseUrl: `http://127.0.0.1:${port4}/v1`, apiKey: '', model: 'o3-mini',
      messages: [{ role: 'user', content: '算一下' }], timeout: 5000,
      onDone: resolve, onError: reject
    });
  });
  ok('推理增量聚合', r4.reasoning === '思考');
  ok('文本与推理分开', r4.content === '答案' && r4.reasoning === '思考');
  srv.close();

  // ── 测试 5：user 消息含图片 → 转成 Responses 的 input_image（修复 vision 静默丢图）──
  console.log('测试5：responses 模式图片转换 input_image');
  let lastBody5 = null;
  srv = await makeServer((req, res, body) => {
    lastBody5 = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '看到了' }] }] }));
  });
  const port5 = srv.address().port;
  await client.chatNonStreamResponses({
    baseUrl: `http://127.0.0.1:${port5}/v1`, apiKey: '', model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: [
      { type: 'text', text: '这是什么' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB', detail: 'auto' } }
    ] }],
    tools: [], timeout: 5000
  });
  const userItem5 = lastBody5.input.find((i) => i.role === 'user');
  ok('含 input_image item', !!userItem5 && userItem5.content.some((c) => c.type === 'input_image'));
  const img5 = userItem5 && userItem5.content.find((c) => c.type === 'input_image');
  ok('input_image 的 image_url 为顶层字符串（非嵌套）', !!img5 && img5.image_url === 'data:image/png;base64,AAAB');
  ok('input_image 保留 detail', !!img5 && img5.detail === 'auto');
  ok('文本 part 仍转为 input_text', !!userItem5 && userItem5.content.some((c) => c.type === 'input_text' && c.text === '这是什么'));
  // 对照：纯文本 user 不应混入 input_image
  const txtOnly = [{ role: 'user', content: '纯文本' }];
  srv.close();

  // ── 测试 6：流式 response.incomplete 收尾（max_output_tokens 截断）──
  console.log('测试6：streamResponses incomplete 收尾');
  srv = await makeServer((req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.write('data: {"type":"response.output_text.delta","delta":"部分"}\n\n');
    res.write('data: {"type":"response.incomplete"}\n\n');
    res.end();
  });
  const port6 = srv.address().port;
  const r6 = await new Promise((resolve, reject) => {
    client.streamResponses({
      baseUrl: `http://127.0.0.1:${port6}/v1`, apiKey: '', model: 'gpt-4o-mini',
      messages: txtOnly, timeout: 5000,
      onDone: resolve, onError: reject
    });
  });
  ok('incomplete 仍收尾且内容完整', r6.content === '部分');
  ok('incomplete finishReason=incomplete', r6.finishReason === 'incomplete');
  srv.close();

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('测试异常:', e); process.exit(1); });
