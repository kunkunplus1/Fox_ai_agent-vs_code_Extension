'use strict';
// 回归测试：同一流式请求内多个 usage chunk 只触发一次 onUsage（最后一次累计值）。
// 背景：chat SSE 首/尾 chunk、Responses 工具循环多个 response.completed、Anthropic 每个 message_delta
// 都携带「截至当前」的累计 usage；旧代码逐 chunk 调用 onUsage，导致会话级缓存累计器把同一批
// cached 重复累加 → 会话累计命中率 >100%（用户实测 111%）。修复后整条流只消费最后一次 usage。

const http = require('http');
const assert = require('assert');
const client = require('../src/client');
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

function waitDone(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function run() {
  // ── 测试1：chat 流式，首 chunk 带 usage、尾 chunk 再带一次（同一请求重复）──
  const srv1 = await makeServer((req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"content":"你"},"finish_reason":null}],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":90}}}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":90}}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  let usages = [];
  const r1 = await new Promise((resolve, reject) => {
    client.streamChat({
      baseUrl: 'http://127.0.0.1:' + srv1.address().port,
      apiKey: 'x', model: 'm', messages: [{ role: 'user', content: 'hi' }],
      onUsage: (u) => usages.push(u),
      onDone: resolve, onError: reject
    });
  });
  srv1.close();
  ok('chat 流式：多个 usage chunk 只触发 1 次 onUsage', usages.length === 1);
  ok('chat 流式：取到的 usage 是最后一个（completion 10）', usages[0] && usages[0].completion_tokens === 10);
  ok('chat 流式：cached 为累计值 90', usages[0] && usages[0].prompt_tokens_details && usages[0].prompt_tokens_details.cached_tokens === 90);

  // ── 测试2：Responses 流式，工具循环多次 response.completed（每次都带同一累计 cached）──
  const srv2 = await makeServer((req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    // 第一次 completed：工具调用后（cached 累计 18300，input 只含新增量 725）
    res.write('data: {"type":"response.completed","response":{"usage":{"input_tokens":725,"output_tokens":60,"input_tokens_details":{"cached_tokens":18300}},"output":[{"type":"function_call","call_id":"call_1","name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}]}}\n\n');
    // 第二次 completed：最终（同 cached 累计值）
    res.write('data: {"type":"response.completed","response":{"usage":{"input_tokens":725,"output_tokens":95,"input_tokens_details":{"cached_tokens":18300}},"output":[{"type":"message","content":[{"type":"output_text","text":"读完了"}]}]}}\n\n');
    res.end();
  });
  let usages2 = [];
  const r2 = await new Promise((resolve, reject) => {
    client.streamResponses({
      baseUrl: 'http://127.0.0.1:' + srv2.address().port,
      apiKey: 'x', model: 'm', input: [{ role: 'user', content: '读' }],
      onUsage: (u) => usages2.push(u),
      onDone: resolve, onError: reject
    });
  });
  srv2.close();
  ok('Responses 流式：工具循环多个 completed 只触发 1 次 onUsage', usages2.length === 1);
  ok('Responses 流式：取到最后一次 usage（cached 18300）', usages2[0] && usages2[0].input_tokens_details && usages2[0].input_tokens_details.cached_tokens === 18300);

  // ── 测试3：Anthropic 流式，多个 message_delta 只触发一次（最后一次累计 usage）──
  const srv3 = await makeServer((req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":725,"output_tokens":1}}}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}\n\n');
    res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":725,"output_tokens":40,"cache_read_input_tokens":18300,"cache_creation_input_tokens":0}}\n\n');
    res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":725,"output_tokens":95,"cache_read_input_tokens":18300,"cache_creation_input_tokens":0}}\n\n');
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    res.end();
  });
  let usages3 = [];
  const r3 = await new Promise((resolve, reject) => {
    anthropic.streamChat({
      baseUrl: 'http://127.0.0.1:' + srv3.address().port,
      apiKey: 'x', model: 'claude', messages: [{ role: 'user', content: 'hi' }],
      onUsage: (u) => usages3.push(u),
      onDone: resolve, onError: reject
    });
  });
  srv3.close();
  ok('Anthropic 流式：多个 message_delta 只触发 1 次 onUsage', usages3.length === 1);
  ok('Anthropic 流式：取到最后一次 usage（cache_read 18300 / output 95）',
    usages3[0] && usages3[0].cache_read_input_tokens === 18300 && usages3[0].output_tokens === 95);

  // ── 测试4：会话累计口径（模拟 agent.js _accCache：每请求只累计一次）→ 不会 >100% ──
  const { extractCacheStats } = client;
  // 第一轮冷启动：creation 20000，0 命中
  const r1s = extractCacheStats({ input_tokens: 725, output_tokens: 95, cache_read_input_tokens: 0, cache_creation_input_tokens: 20000 });
  // 第二轮全命中：cached 18300
  const r2s = extractCacheStats({ input_tokens: 725, output_tokens: 95, cache_read_input_tokens: 18300, cache_creation_input_tokens: 0 });
  const acc = { cached: 0, total: 0 };
  acc.cached += r1s.cachedTokens + r2s.cachedTokens;
  acc.total += r1s.totalTokens + r2s.totalTokens;
  const sessionHitRate = acc.total > 0 ? acc.cached / acc.total : 0;
  ok('会话累计命中率 ≤100%（冷启动+命中轮）', sessionHitRate <= 1 && sessionHitRate > 0);
  ok('会话累计命中率合理（约 46%，冷启动摊薄）', Math.abs(sessionHitRate - 18300 / 39750) < 0.001);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });