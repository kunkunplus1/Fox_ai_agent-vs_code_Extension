'use strict';

/**
 * 回归测试：内置 Fetch 服务器应把 HTML 页面提取为「正文纯文本」，而非把整页原始 HTML
 * （含 <head>/<script>/<style>）直接丢给模型，再被 4000 字上限截断在 <head> 部分。
 *
 * 对应现象（0.8.12 日志）：mcp-format.log 显示 fetch 返回 out len=4048 且 head 是
 * <!doctype html>...<head>...，正文在 <body> 后面永远到不了模型手里，模型说「返回的是
 * HTML 页面但被截断、正文没显示全」。
 *
 * 同时验证：follow 3xx 重定向（否则 .md 版被重定向到首页就丢了内容）。
 */

const Module = require('module');
// 最小 vscode mock（mcpAuthor 可能间接 require vscode）
const vscodeMock = new Proxy({}, { get: () => new Proxy(function () {}, { get: () => new Proxy(function () {}, { get: () => undefined }), apply: () => undefined }) });
const origLoad = Module._load;
Module._load = function (request) { if (request === 'vscode') return vscodeMock; return origLoad.apply(this, arguments); };

const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const mcpAuthor = require('../src/tools/mcpAuthor');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); process.exitCode = 1; }
}

const SAMPLE_HTML = '<!doctype html><html lang="zh-cn"><head><title>Responses API | DeepSeek</title>'
  + '<style>.nav{color:red}</style><script>console.log("x")</script></head>'
  + '<body><div class="nav">菜单</div><h1>API 文档标题</h1>'
  + '<p>这是正文第一段，包含 <code>code</code> 与链接 <a href="#">a</a>。</p>'
  + '<ul><li>项一</li><li>项二</li></ul></body></html>';

function rpcCall(serverPath, params) {
  return new Promise((resolve, reject) => {
    const cp = spawn('node', [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    let done = false;
    cp.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === 1 && msg.result && msg.result.protocolVersion) {
          cp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fetch-url', arguments: params } }) + '\n');
        } else if (msg.id === 2 && !done) {
          done = true; cp.kill(); resolve(msg);
        }
      }
    });
    cp.on('error', reject);
    cp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
    setTimeout(() => { if (!done) { done = true; cp.kill(); reject(new Error('rpc timeout')); } }, 20000);
  });
}

(async () => {
  console.log('\n[htmlToText 纯函数]');
  const DOC_HTML = '<!doctype html><html><head><title>x</title></head><body>'
    + '<nav class="navbar"><a href="#">快速开始</a><a href="#">首次调用 API</a><a href="#">API 指南</a></nav>'
    + '<aside class="sidebar"><a href="#">思考模式</a><a href="#">多轮对话</a></aside>'
    + '<main><h1>Responses API</h1><p>这里是核心参数说明。</p><pre><code>data: {...}</code></pre></main>'
    + '<footer>版权所有</footer></body></html>';
  const text = mcpAuthor.htmlToText(SAMPLE_HTML);
  check('不含 script/style/head 标签', () => { assert.ok(!/script/i.test(text) && !/style/i.test(text) && !/<\s*head/i.test(text)); });
  check('提取出正文标题与段落', () => { assert.ok(text.includes('API 文档标题') && text.includes('这是正文第一段')); });
  check('块级标签转换行', () => { assert.ok(text.includes('\n')); });
  check('保留 code/链接内联文本', () => { assert.ok(text.includes('code') && text.includes('a')); });
  check('实体解码 &amp; -> & , &lt; -> <', () => {
    const t2 = mcpAuthor.htmlToText('<body><p>A &amp; B &lt;c&gt;</p></body>');
    assert.ok(t2.includes('A & B') && t2.includes('<c>'));
  });
  const docText = mcpAuthor.htmlToText(DOC_HTML);
  check('排除左侧导航 <nav>', () => { assert.ok(!docText.includes('快速开始') && !docText.includes('首次调用 API')); });
  check('排除侧栏 <aside>', () => { assert.ok(!docText.includes('思考模式') && !docText.includes('多轮对话')); });
  check('保留 <main> 正文标题与段落', () => { assert.ok(docText.includes('Responses API') && docText.includes('核心参数说明')); });
  check('保留代码块示例 data: {...}', () => { assert.ok(docText.includes('data: {...}')); });

  console.log('\n[paginateText 分批]');
  const PT = Array.from({ length: 20 }, (_, i) => '行' + (i + 1)).join('\n');
  check('默认按 maxLen 字符截断并提示分批', () => {
    const r = mcpAuthor.paginateText(PT, { maxLen: 10 });
    assert.ok(r.includes('内容已截断'), '应提示可改用 startLine 分批');
  });
  check('lineCount 只取指定行数并提示还有', () => {
    const r = mcpAuthor.paginateText(PT, { lineCount: 5, startLine: 0 });
    const got = r.split('\n').filter((x) => x.startsWith('行')).length;
    assert.strictEqual(got, 5, '应只取 5 行');
    assert.ok(r.includes('还有 15 行未显示'), '应提示还有更多');
  });
  check('lineCount+startLine 取中段并给续取起点', () => {
    const r = mcpAuthor.paginateText(PT, { lineCount: 3, startLine: 5 });
    const got = r.split('\n').filter((x) => x.startsWith('行'));
    assert.deepStrictEqual(got, ['行6', '行7', '行8']);
    assert.ok(r.includes('设置 startLine=8'), '提示续取起点');
  });
  check('最后一批无“还有”提示', () => {
    const r = mcpAuthor.paginateText(PT, { lineCount: 5, startLine: 15 });
    assert.ok(!r.includes('还有'), '末尾批次不应提示还有更多');
    assert.ok(r.includes('行20'), '应包含最后一行');
  });

  console.log('\n[端到端：真实生成的 fetch 服务器]');
  const tmpServer = path.join(os.tmpdir(), 'foxai-fetch-test-' + Date.now() + '.js');
  fs.writeFileSync(tmpServer, mcpAuthor.buildBuiltinServer('fetch'));
  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(SAMPLE_HTML);
  });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = httpServer.address().port;
  try {
    const msg = await rpcCall(tmpServer, { url: 'http://127.0.0.1:' + port + '/' });
    const out = msg && msg.result && msg.result.content && msg.result.content[0] && msg.result.content[0].text;
    check('fetch 返回正文而非原始 HTML', () => {
      assert.ok(out, '应返回文本');
      assert.ok(!/<script/i.test(out), '不应含 <script>');
      assert.ok(out.includes('API 文档标题'), '应含正文标题');
    });
  } catch (e) {
    check('端到端 fetch 调用', () => { throw e; });
  } finally {
    httpServer.close();
    try { fs.unlinkSync(tmpServer); } catch (_) {}
  }

  console.log('\n[端到端：分批获取（startLine/lineCount）]');
  const tmpServer2 = path.join(os.tmpdir(), 'foxai-fetch-test2-' + Date.now() + '.js');
  fs.writeFileSync(tmpServer2, mcpAuthor.buildBuiltinServer('fetch'));
  const longText = Array.from({ length: 30 }, (_, i) => 'L' + (i + 1)).join('\n');
  const textSrv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(longText);
  });
  await new Promise((r) => textSrv.listen(0, '127.0.0.1', r));
  const turl = 'http://127.0.0.1:' + textSrv.address().port + '/';
  try {
    const m1 = await rpcCall(tmpServer2, { url: turl, lineCount: 10, startLine: 0 });
    const o1 = m1.result.content[0].text;
    check('e2e 第一批取 10 行并提示还有', () => {
      assert.strictEqual(o1.split('\n').filter((l) => l.startsWith('L')).length, 10);
      assert.ok(o1.includes('还有 20 行未显示'));
    });
    const m2 = await rpcCall(tmpServer2, { url: turl, lineCount: 10, startLine: 10 });
    const o2 = m2.result.content[0].text;
    check('e2e 第二批续取 L11~L20', () => {
      assert.ok(o2.includes('L11') && o2.includes('L20'));
      assert.ok(o2.includes('还有 10 行未显示'));
    });
    const m3 = await rpcCall(tmpServer2, { url: turl, lineCount: 10, startLine: 20 });
    const o3 = m3.result.content[0].text;
    check('e2e 末批到 L30 且无“还有”提示', () => {
      assert.ok(o3.includes('L30'));
      assert.ok(!o3.includes('还有'), '末尾批次不应提示还有更多');
    });
  } catch (e) {
    check('端到端分批获取', () => { throw e; });
  } finally {
    textSrv.close();
    try { fs.unlinkSync(tmpServer2); } catch (_) {}
  }

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
