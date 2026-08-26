'use strict';
// 流式透传探测：本地假 SSE 服务分别模拟 chat / responses / anthropic 三种协议的流式响应，
// 验证各协议的 onDelta 是否「逐段实时」触发（流式行为），而不是只在 finish 一次性吐出。
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
      send({ choices: [{ delta: { content: '，' } }] });
      send({ choices: [{ delta: {} }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
    } else if (url.includes('/responses')) {
      send({ type: 'response.output_text.delta', delta: '你' });
      send({ type: 'response.output_text.delta', delta: '好' });
      send({ type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 }, status: 'completed' } });
      res.end('data: [DONE]\n\n');
    } else if (url.includes('/v1/messages')) {
      send({ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 } } });
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } });
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } });
      send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 100, output_tokens: 5 } });
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
    fn({
      baseUrl: 'http://127.0.0.1:18765',
      apiKey: 'x',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      streamFormat: 'sse',
      onDelta: (t) => { deltas.push(t); },
      onReasoning: () => {},
      onDone: (r) => {
        const elapsed = Date.now() - startedAt;
        const joined = deltas.join('');
        console.log(`[${label}] delta分段=${deltas.length} 时间=${elapsed}ms 内容="${joined}" 逐段实时? ${deltas.length >= 2 && joined === '你好，' ? '✅流式' : '❌非流式(一次吐出或缺失)'}`);
        resolve();
      },
      onError: (e) => { console.log(`[${label}] ERR ${e.message}`); resolve(); }
    });
  });
}

makeServer();
srv.listen(18765, () => {
  const c = require('../src/client');
  const anth = require('../src/anthropic');
  (async () => {
    await run('chat     ', (o) => c.streamChat(Object.assign({}, o, { streamFormat: 'sse' })));
    await run('responses', (o) => c.streamResponses(Object.assign({}, o, { streamFormat: 'sse' })));
    await run('anthropic', (o) => anth.streamChat(Object.assign({}, o, { anthropicBase: 'http://127.0.0.1:18765', anthropicPath: '/v1/messages' })));
    srv.close();
    console.log('--- probe done ---');
  })();
});