'use strict';

/**
 * 离线冒烟测试：不依赖真实 VS Code，用假的 vscode 模块 + 本地 mock 服务端，
 * 验证 SSE 解析、工具调用拼装、文本协议解析、危险命令拦截、diff 计算。
 * 运行：node test/smoke.js
 */

const Module = require('module');
const http = require('http');
const assert = require('assert');

/* ---------- mock vscode ---------- */
const vscodeMock = {
  workspace: {
    workspaceFolders: null,
    getConfiguration: () => ({ get: (k, d) => d, update: async () => {} }),
    textDocuments: [],
    fs: {}
  },
  window: { activeTextEditor: null, activeTerminal: null, tabGroups: { all: [] } },
  languages: { getDiagnostics: () => [] },
  commands: { executeCommand: async () => {} },
  env: { clipboard: { readText: async () => '', writeText: async () => {} } },
  Uri: { file: (p) => ({ fsPath: p, toString: () => 'file://' + p }), joinPath: () => ({}) },
  Position: class {},
  Range: class {},
  Selection: class {},
  ThemeIcon: class {},
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  FileType: { File: 1, Directory: 2 },
  InlineCompletionItem: class {},
  ConfigurationTarget: { Global: 1 },
  TextEditorRevealType: { InCenter: 2 }
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const { streamChat } = require('../src/client');
const { AgentSession } = require('../src/agent');
const term = require('../src/tools/terminal');
const ws = require('../src/tools/workspace');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + ' → ' + e.message);
  }
}

/* ---------- mock 流式服务端 ---------- */
function sse(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = JSON.parse(body || '{}');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });

    if (payload.messages[0].content === 'TOOLCALL') {
      // 分片下发 tool_calls，模拟真实服务端行为
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }] });
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.js"}' } }] } }] });
      sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      sse(res, { choices: [{ delta: { reasoning_content: '让我想想' } }] });
      sse(res, { choices: [{ delta: { content: '你好' } }] });
      // 故意用 \r\n 分隔，测试兼容性
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '世界' } }] }) + '\r\n\r\n');
      sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

function once(content) {
  return new Promise((resolve, reject) => {
    streamChat({
      baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
      model: 'test',
      messages: [{ role: 'user', content }],
      onDone: resolve,
      onError: reject
    });
  });
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  console.log('\n[1] 流式解析');

  const plain = await once('HELLO');
  check('拼接 content（含 \\r\\n 分隔）', () => assert.strictEqual(plain.content, '你好世界'));
  check('捕获 reasoning_content', () => assert.strictEqual(plain.reasoning, '让我想想'));
  check('finish_reason 正确', () => assert.strictEqual(plain.finishReason, 'stop'));

  const tc = await once('TOOLCALL');
  check('tool_calls 分片拼装', () => {
    assert.strictEqual(tc.toolCalls.length, 1);
    assert.strictEqual(tc.toolCalls[0].name, 'read_file');
    assert.strictEqual(tc.toolCalls[0].arguments, '{"path":"a.js"}');
    assert.deepStrictEqual(JSON.parse(tc.toolCalls[0].arguments), { path: 'a.js' });
  });

  console.log('\n[2] 中断');
  await new Promise((resolve) => {
    const h = streamChat({
      baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
      model: 'test',
      messages: [{ role: 'user', content: 'HELLO' }],
      onDone: (r) => {
        check('abort 后回调 aborted=true', () => assert.strictEqual(r.aborted, true));
        resolve();
      },
      onError: () => resolve()
    });
    h.abort();
  });

  console.log('\n[3] 文本协议解析');
  const session = new AgentSession({ cfg: {}, messages: [], ui: {} });
  const text = `我先看看文件。

<fox:tool name="read_file">
{"path": "src/app.js", "start_line": 1}
</fox:tool>`;
  const calls = session.parseTextCalls(text);
  check('解析出工具名与参数', () => {
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].name, 'read_file');
    assert.deepStrictEqual(JSON.parse(calls[0].rawArgs), { path: 'src/app.js', start_line: 1 });
  });
  check('剥离工具块后保留正文', () =>
    assert.strictEqual(session.stripToolBlocks(text), '我先看看文件。'));
  check('未闭合标签也能兜住', () => {
    const c = session.parseTextCalls('<fox:tool name="list_dir">\n{"path":"."}');
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0].name, 'list_dir');
  });
  check('纯文本回答不会误判为工具', () =>
    assert.strictEqual(session.parseTextCalls('这里没有工具调用').length, 0));

  console.log('\n[4] 危险命令拦截');
  check('拦截 rm -rf /', () => assert.ok(term.isDangerous('rm -rf /')));
  check('拦截 mkfs', () => assert.ok(term.isDangerous('mkfs.ext4 /dev/sda1')));
  check('拦截 shutdown', () => assert.ok(term.isDangerous('shutdown -h now')));
  check('放行 npm test', () => assert.strictEqual(term.isDangerous('npm test'), null));
  check('放行 rm -rf node_modules', () =>
    assert.strictEqual(term.isDangerous('rm -rf node_modules'), null));
  check('自定义黑名单生效', () => assert.ok(term.isDangerous('git push --force', ['git push.*force'])));

  console.log('\n[5] diff 计算');
  const before = 'a\nb\nc\nd';
  const after = 'a\nB2\nc\nd\ne';
  const stat = ws.diffStat(before, after);
  check('增删行数统计', () => {
    assert.strictEqual(stat.added, 2);
    assert.strictEqual(stat.removed, 1);
  });
  const prev = ws.unifiedPreview(before, after);
  check('预览包含 +/- 标记', () => {
    assert.ok(prev.includes('- b'));
    assert.ok(prev.includes('+ B2'));
  });

  console.log('\n[6] ANSI 清洗');
  check('去掉颜色转义', () =>
    assert.strictEqual(term.stripAnsi('\u001b[31mERROR\u001b[0m: boom'), 'ERROR: boom'));

  server.close();
  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})();
