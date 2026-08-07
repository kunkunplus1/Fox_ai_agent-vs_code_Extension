'use strict';

// 验证流式输出修复：SSE、gzip、JSON Lines、重定向
const assert = require('assert');
const http = require('http');
const zlib = require('zlib');
const { streamChat, requestJson } = require('../src/client');

let server;
let port;
let requestLog = [];

function sendJson(res, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
}

function sendSse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const ev of events) res.write('data: ' + ev + '\n\n');
  res.end();
}

function sendGzipSse(res, events) {
  const payload = events.map((ev) => 'data: ' + ev + '\n\n').join('');
  const zipped = zlib.gzipSync(Buffer.from(payload, 'utf8'));
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Encoding': 'gzip', 'Content-Length': zipped.length });
  res.end(zipped);
}

function sendNdjson(res, lines) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  for (const line of lines) res.write(JSON.stringify(line) + '\n');
  res.end();
}

function buildHandler() {
  return (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requestLog.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      if (req.url === '/chat/completions') {
        const b = body ? JSON.parse(body) : {};
        const delta = { id: 'chatcmpl-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '狐' }, finish_reason: null }] };
        const done = { id: 'chatcmpl-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
        if (b.stream === false) {
          sendJson(res, { choices: [{ message: { content: '狐狸 AI' } }] });
          return;
        }
        if (b.model === 'gzip-test') {
          const d = { choices: [{ delta: { content: '压' } }] };
          sendGzipSse(res, [JSON.stringify(d), '[DONE]']);
          return;
        }
        if (b.model === 'jsonl-test') {
          sendNdjson(res, [{ choices: [{ delta: { content: '行' } }] }, { choices: [{ delta: { content: '1' } }] }]);
          return;
        }
        sendSse(res, [JSON.stringify(delta), JSON.stringify(done), '[DONE]']);
      } else if (req.url === '/redirect' || req.url === '/redirect/chat/completions') {
        res.writeHead(302, { Location: '/chat/completions' });
        res.end();
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
  };
}

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer(buildHandler());
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
}

function stopServer() {
  return new Promise((resolve) => server.close(resolve));
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  ✓', name);
    passed++;
  } catch (e) {
    console.log('  ✗', name, '\n    ', (e && e.message) || String(e));
    failed++;
  }
}

async function run() {
  await startServer();
  const base = `http://127.0.0.1:${port}`;

  // 1. 普通 SSE
  await new Promise((resolve) => {
    const deltas = [];
    streamChat({
      baseUrl: base,
      apiKey: '',
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (t) => deltas.push(t),
      onDone: (r) => {
        check('SSE 能收到流式增量', () => assert.strictEqual(deltas.join(''), '狐'));
        check('SSE finishReason 为 stop', () => assert.strictEqual(r.finishReason, 'stop'));
        resolve();
      },
      onError: (e) => {
        check('SSE 不应报错', () => assert.fail(e && e.message));
        resolve();
      }
    });
  });

  // 2. gzip SSE
  await new Promise((resolve) => {
    const deltas = [];
    streamChat({
      baseUrl: base,
      apiKey: '',
      model: 'gzip-test',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (t) => deltas.push(t),
      onDone: (r) => {
        check('gzip SSE 能正确解压并解析', () => assert.strictEqual(deltas.join(''), '压'));
        resolve();
      },
      onError: (e) => {
        check('gzip SSE 不应报错', () => assert.fail(e && e.message));
        resolve();
      }
    });
  });

  // 3. JSON Lines
  await new Promise((resolve) => {
    const deltas = [];
    streamChat({
      baseUrl: base,
      apiKey: '',
      model: 'jsonl-test',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (t) => deltas.push(t),
      onDone: (r) => {
        check('JSON Lines 流式能收到多行内容', () => assert.strictEqual(deltas.join(''), '行1'));
        resolve();
      },
      onError: (e) => {
        check('JSON Lines 不应报错', () => assert.fail(e && e.message));
        resolve();
      }
    });
  });

  // 4. 重定向
  requestLog = [];
  await new Promise((resolve) => {
    streamChat({
      baseUrl: base + '/redirect',
      apiKey: '',
      model: 'redirect-test',
      messages: [{ role: 'user', content: 'hi' }],
      onDone: (r) => {
        check('重定向后仍能正常拿到内容', () => assert.strictEqual(r.content, '狐'));
        check('重定向请求数正确', () => assert.strictEqual(requestLog.filter((x) => x.url === '/chat/completions').length, 1));
        resolve();
      },
      onError: (e) => {
        check('重定向不应报错', () => assert.fail(e && e.message));
        resolve();
      }
    });
  });

  // 5. 非流式 JSON fallback
  const nonStream = await requestJson(base + '/chat/completions', {
    method: 'POST',
    body: { model: 'test', messages: [{ role: 'user', content: 'hi' }], stream: false }
  });
  check('非流式请求返回 JSON', () => assert.strictEqual(nonStream.choices[0].message.content, '狐狸 AI'));

  await stopServer();
  console.log(`\n结果：通过 ${passed} / 失败 ${failed}`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
