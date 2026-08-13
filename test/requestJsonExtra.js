'use strict';

/**
 * requestJson 必须透传调用方传入的 extra 自定义 HTTP 头（1.1.32 修复）。
 * 之前 imageGen.js 给万相原生 API 传 { 'X-DashScope-Async': 'enable' }，
 * 但 requestJson 既没解构 extra、也没交给 buildHeaders，导致该头被丢弃，
 * 百炼把请求当同步处理而报 "current user api does not support synchronous calls"。
 *
 * 本测试起一个本地 HTTP 服务，验证：
 *  1) extra 里的自定义头确实到达服务端；
 *  2) 默认头（Content-Type / Accept）与 Authorization 仍正常；
 *  3) 重定向时 extra 头仍被保留。
 * 不发任何外部网络请求。
 */

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

const http = require('http');
const { requestJson } = require('../src/client');

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => handler(req, res, srv));
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  // 1) 基础透传：自定义头到达
  let srv = await startServer((req, res) => {
    const body = [];
    req.on('data', (c) => body.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, headers: req.headers, body: Buffer.concat(body).toString() }));
    });
  });
  const port = srv.address().port;
  const base = 'http://127.0.0.1:' + port;

  const r1 = await requestJson(base + '/x', {
    method: 'POST', apiKey: 'sk-test', body: { a: 1 },
    extra: { 'X-DashScope-Async': 'enable', 'X-Custom': 'yes' }
  });
  check('自定义头 X-DashScope-Async 透传', r1.headers['x-dashscope-async'] === 'enable');
  check('自定义头 X-Custom 透传', r1.headers['x-custom'] === 'yes');
  check('默认 Content-Type 保留', (r1.headers['content-type'] || '').includes('application/json'));
  check('Authorization 保留', r1.headers['authorization'] === 'Bearer sk-test');
  check('请求体正确发送', JSON.parse(r1.body).a === 1);

  // 2) 无 extra 时不报错，也不污染默认头
  const r2 = await requestJson(base + '/y', { method: 'GET' });
  check('无 extra 时正常返回', r2.method === 'GET');
  check('无 extra 时不产生 X-DashScope-Async', !('x-dashscope-async' in r2.headers));

  // 3) 重定向时 extra 头保留（模拟 302 跳转到 /final）
  let srv2 = await startServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: 'http://127.0.0.1:' + srv2.address().port + '/final' });
      res.end();
      return;
    }
    const body = [];
    req.on('data', (c) => body.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ headers: req.headers }));
    });
  });
  const port2 = srv2.address().port;
  const r3 = await requestJson('http://127.0.0.1:' + port2 + '/start', {
    method: 'POST', apiKey: 'sk-2', body: { b: 2 },
    extra: { 'X-DashScope-Async': 'enable' }
  });
  check('重定向后 X-DashScope-Async 仍保留', r3.headers['x-dashscope-async'] === 'enable');
  check('重定向后 Authorization 仍保留', r3.headers['authorization'] === 'Bearer sk-2');

  srv.close();
  srv2.close();

  console.log('\nrequestJson extra 透传测试：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
