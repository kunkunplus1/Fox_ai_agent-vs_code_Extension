'use strict';
// 流式透传探测（真实入口版）：用与 agent 相同的契约测三协议是否「逐段实时」。
// 事实（client.js:987-998）：chatOnce/anthropic.chatOnce 会覆盖 options.onDone/onError 为自身
// resolve/reject 并返回 { promise, handle } —— 所以必须用 ret.promise 判定结束，不能靠 onDone。
// 裸 streamChat/streamResponses（agent 对 responses 走 wrapStream(streamResponses)）则用 onDone。
const http = require('http');

let srv;
function makeServer() {
  srv = http.createServer((req, res) => {
    const url = req.url || '';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    if (url.includes('/chat/completions')) {
      send({ choices: [{ delta: { role: 'assistant' } }] });
      send({ choices: [{ delta: { content: '你' } }] });
      send({ choices: [{ delta: { content: '好' } }] });
      send({ choices: [{ delta: {} }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
    } else if (url.includes('/responses')) {
      send({ type: 'response.output_text.delta', delta: '你' });
      send({ type: 'response.output_text.delta', delta: '好' });
      send({ type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 }, status: 'completed' } });
      res.end('data: [DONE]\n\n');
    } else if (url.includes('/v1/messages')) {
      // Anthropic 规范流：带 event: 行
      res.write('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 } } }) + '\n\n');
      res.write('event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + '\n\n');
      res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } }) + '\n\n');
      res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } }) + '\n\n');
      res.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 100, output_tokens: 5 } }) + '\n\n');
      res.write('event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n');
      res.end();
    } else {
      res.end();
    }
  });
}

function run(label, fn) {
  return new Promise((resolve) => {
    const deltas = [];
    const startedAt = Date.now();
    const report = () => {
      const elapsed = Date.now() - startedAt;
      const joined = deltas.join('');
      console.log(`[${label}] 分段=${deltas.length} 时间=${elapsed}ms 内容="${joined}" ${deltas.length >= 2 && joined === '你好' ? '✅流式' : '❌非流式'}`);
      resolve();
    };
    const opts = {
      baseUrl: 'http://127.0.0.1:18766',
      apiKey: 'x',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      streamFormat: 'sse',
      onDelta: (t) => { deltas.push(t); },
      onReasoning: () => {},
      // 在 fn(opts) 调用前就绑定结束回调（本地假服务瞬间结束，晚了会漏）
      onDone: report,
      onError: (e) => { console.log(`[${label}] ERR ${e.message}`); resolve(); }
    };
    const ret = fn(opts);
    if (ret && typeof ret.promise === 'object') {
      // b.once() 契约：chatOnce/anthropic.chatOnce 会覆盖 onDone/onError 为自身 resolve/reject；
      // 但 promise settle 才真正代表结束，仍以 ret.promise 为准（onDone 也触发了的话 report 幂等）。
      ret.promise.then(report).catch((e) => { console.log(`[${label}] ERR ${e.message}`); resolve(); });
    }
    // 裸 streamX（streamResponses/streamChat/anthropic.streamChat）无 promise，靠 onDone（已在上面注册）
  });
}

makeServer();
srv.listen(18766, () => {
  const c = require('../src/client');
  const anth = require('../src/anthropic');
  (async () => {
    await run('chatOnce ', (o) => c.chatOnce(Object.assign({}, o, { streamFormat: 'sse' })));
    await run('respStrm ', (o) => c.streamResponses(Object.assign({}, o, { streamFormat: 'sse' })));
    await run('anthOnce ', (o) => anth.chatOnce(Object.assign({}, o, { anthropicBase: 'http://127.0.0.1:18766', anthropicPath: '/v1/messages' })));
    srv.close();
    console.log('--- once probe done ---');
  })();
});