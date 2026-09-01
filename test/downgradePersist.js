'use strict';

/**
 * 回归测试：原生工具协议被服务端 400 拒绝后，降级到文本协议必须「跨轮持久化」，
 * 不能每轮都先 400 再重试（用户日志里每轮两次 callModel 的根因）。
 * 同时验证：降级后仍能正常结束一轮对话。
 * 运行：node test/downgradePersist.js
 */

const Module = require('module');
const http = require('http');
const assert = require('assert');

/* ---------- mock vscode ---------- */
const vscodeMock = {
  workspace: { workspaceFolders: null, getConfiguration: () => ({ get: (k, d) => d, update: async () => {} }), textDocuments: [], fs: {} },
  window: { activeTextEditor: null, activeTerminal: null, tabGroups: { all: [] } },
  languages: { getDiagnostics: () => [] },
  commands: { executeCommand: async () => {} },
  env: { clipboard: { readText: async () => '', writeText: async () => {} } },
  Uri: { file: (p) => ({ fsPath: p, toString: () => 'file://' + p }), joinPath: () => ({}) },
  Position: class {}, Range: class {}, Selection: class {}, ThemeIcon: class {},
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  FileType: { File: 1, Directory: 2 }, InlineCompletionItem: class {},
  ConfigurationTarget: { Global: 1 }, TextEditorRevealType: { InCenter: 2 }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const { AgentSession } = require('../src/agent');
const config = require('../src/config');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); }
}

(async () => {
  // 统计被 400 拒绝的次数：只要请求体里带 tools（原生模式）就 400
  let native400Count = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch (_) {}
      if (Array.isArray(payload.tools) && payload.tools.length) {
        // 模拟 DeepSeek 原生 function calling 拒收 MCP 大 schema
        native400Count++;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: '400 请求被拒：参数不合法（tools）' } }));
        return;
      }
      // 文本模式（无 tools）：返回一句普通文本，结束对话
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好的，已处理完成。' } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const ctx = {
    secrets: { get: async () => '', store: async () => {}, delete: async () => {} },
    globalStorageUri: { fsPath: require('os').tmpdir() + '/foxai-test' }
  };
  const cfg = await config.resolve(ctx);
  cfg.baseUrl = 'http://127.0.0.1:' + port + '/v1';
  cfg.model = 'deepseek-v4-flash';
  cfg.provider = 'deepseek';     // 必须是 deepseek：modelSupportsNativeTools 对云厂商才返回 native（llamacpp 等本地默认 text）
  cfg.meta = { local: false, textOnly: false };   // 必须清掉默认 llamacpp 的 meta.local=true，否则被强制 text
  cfg.apiMode = 'chat';
  cfg.forceNonStream = true;     // 走非流式，简化断言
  cfg.visionMode = 'off';
  cfg.visionConfig = { enabled: false };
  cfg.agentEnabled = true;
  cfg.maxSteps = 5;

  const session = new AgentSession({ context: ctx, cfg, messages: [], ui: {} });

  console.log('\n[降级持久化]');

  // 第一轮：原生 400 → 降级文本 → 成功
  const r1 = await session.run();
  check('第一轮正常结束', () => assert.strictEqual(r1.finished, true));
  check('第一轮后协议已切到文本', () => assert.strictEqual(session.protocol, 'text'));
  check('第一轮后 _forceText 置位（跨轮持久化）', () => assert.strictEqual(session._forceText, true));

  const afterFirst = native400Count;
  check('第一轮恰好发生 1 次原生 400', () => assert.strictEqual(afterFirst, 1));

  // 第二轮：协议应保持文本，不再触发原生 400
  const r2 = await session.run();
  check('第二轮正常结束', () => assert.strictEqual(r2.finished, true));
  check('第二轮协议仍为文本', () => assert.strictEqual(session.protocol, 'text'));
  check('第二轮没有新增原生 400（降级持久化生效）', () => assert.strictEqual(native400Count, afterFirst));

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
