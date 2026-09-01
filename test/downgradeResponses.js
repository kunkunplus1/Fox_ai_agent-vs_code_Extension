'use strict';

/**
 * 回归测试：Responses 协议下原生 tools 被 400 拒绝后，
 * 必须降级到 text 协议（仍保留工具说明），而不是无工具的 chat。
 * 运行：node test/downgradeResponses.js
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

// run() 内部会重新 config.resolve 刷新配置，必须让刷新后的值仍是 responses，
// 否则 mock 默认 apiMode=chat 会覆盖测试设置。
const originalResolve = config.resolve;
config.resolve = async (ctx) => {
  const cfg = await originalResolve(ctx);
  cfg.apiMode = 'responses';
  cfg.agentEnabled = true;
  cfg.visionMode = 'off';
  cfg.visionConfig = { enabled: false };
  return cfg;
};

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); }
}

(async () => {
  // 统计：带 tools 的请求（原生模式）返回 400；不带 tools 的返回 responses 格式文本
  let native400Count = 0;
  let lastInstructions = '';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch (_) {}
      lastInstructions = payload.instructions || '';
      if (Array.isArray(payload.tools) && payload.tools.length) {
        native400Count++;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Responses API does not accept this tools schema' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '收到，我可以帮你。' }] }]
      }));
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
  cfg.provider = 'openai';       // 非 deepseek：避免 isDeepResp 强制 native 禁降级；云厂商才走原生
  cfg.meta = { local: false, textOnly: false };  // 清掉默认 llamacpp 的 meta.local=true
  cfg.apiMode = 'responses';     // 关键：Responses 协议
  cfg.forceNonStream = true;
  cfg.visionMode = 'off';
  cfg.visionConfig = { enabled: false };
  cfg.agentEnabled = true;
  cfg.maxSteps = 5;

  const session = new AgentSession({ context: ctx, cfg, messages: [], ui: {} });

  console.log('\n[Responses 协议降级]');

  const r1 = await session.run();
  check('第一轮正常结束', () => assert.strictEqual(r1.finished, true));
  check('Responses 400 后降级到 text（不是 chat）', () => assert.strictEqual(session.protocol, 'text'));
  check('降级后 _forceText 置位', () => assert.strictEqual(session._forceText, true));
  check('降级后 instructions 仍包含文本化工具说明', () => assert.ok(lastInstructions.includes('【调用工具的方式】') && lastInstructions.includes('【可用工具】')));
  check('第一轮恰好发生 1 次原生 400', () => assert.strictEqual(native400Count, 1));

  const afterFirst = native400Count;
  const r2 = await session.run();
  check('第二轮正常结束', () => assert.strictEqual(r2.finished, true));
  check('第二轮协议仍为 text', () => assert.strictEqual(session.protocol, 'text'));
  check('第二轮没有新增原生 400', () => assert.strictEqual(native400Count, afterFirst));
  check('第二轮 instructions 仍包含文本化工具说明', () => assert.ok(lastInstructions.includes('【调用工具的方式】')));

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
