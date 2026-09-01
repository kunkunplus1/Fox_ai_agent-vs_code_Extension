'use strict';

/**
 * 回归测试：文本协议下，模型把 <fox:tool> 标签放在 reasoning 里（而非 content）时，
 * 客户端必须能正确解析并执行工具，不能当成「模型没有返回任何内容」直接结束。
 *
 * 对应现象：用户看到深度思考卡片里出现 <fox:tool>，随后系统提示「模型没有返回任何内容」，
 * 工具实际未被调用。
 */

const Module = require('module');
const http = require('http');
const assert = require('assert');

/* ---------- mock vscode ---------- */
const vscodeMock = {
  workspace: {
    workspaceFolders: null,
    getConfiguration: (ns) => ({
      get: (k, d) => {
        if (ns === 'foxAi') {
          if (k === 'mcp') return { enabled: true, autoInject: true, priority: 'local-first', servers: [] };
          if (k === 'agent.enabled') return true;
          if (k === 'agent.toolProtocol') return 'text';
          if (k === 'agent.maxSteps') return 5;
          if (k === 'agent.maxToolOutput') return 8000;
          if (k === 'agent.maxMessageBytes') return 1024 * 1024;
          if (k === 'agent.projectSkeleton') return false;
          if (k === 'knowledgeBase.enabled') return false;
          if (k === 'memory.enabled') return false;
          if (k === 'planTask.enabled') return false;
          if (k === 'review.enabled') return false;
          if (k === 'planAndExecute.enabled') return false;
          if (k === 'verify.enabled') return false;
          if (k === 'knowledgeBase.autoSummarize.enabled') return false;
          if (k === 'projectScan.cacheEnabled') return false;
          if (k === 'showContextUsage') return false;
          if (k === 'includeFileContext') return false;
          if (k === 'apiMode') return 'chat';
          if (k === 'visionMode') return 'off';
          if (k === 'vision.enabled') return false;
          if (k === 'model') return 'test-model';
          if (k === 'provider') return 'custom';
          if (k === 'baseUrl') return '';
          if (k === 'apiKey') return '';
          if (k === 'temperature') return 0;
          if (k === 'maxTokens') return 1024;
          if (k === 'timeout') return 30000;
          if (k === 'insecureHttpParser') return false;
          if (k === 'streamFormat') return 'openai';
          if (k === 'policy') return {};
          if (k === 'autoApprove') return 'read';
          if (k === 'blockedCommands') return [];
          if (k === 'contextWindow') return 0;
          if (k === 'nodePath') return '';
          if (k === 'workspace.allowOutsideReads') return true;
          if (k === 'workspace.outsideEditConfirm') return 'triple';
          if (k === 'webSearch.provider') return 'builtin';
          if (k === 'textOnlyModels') return [];
          if (k === 'keepImageTurns') return 1;
        }
        return d;
      },
      update: async () => {}
    }),
    textDocuments: [],
    fs: {}
  },
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
const { parseTextCalls } = require('../src/textParser');
const config = require('../src/config');
const mcp = require('../src/tools/mcp');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); process.exitCode = 1; }
}

(async () => {
  // 注册一个 demo MCP 连接器，工具返回固定字符串
  for (const c of mcp.getConnectors()) mcp.unregisterConnector(c.id);
  mcp.registerConnector({
    id: 'demo',
    transport: 'stdio',
    listTools: async () => [
      { name: 'ping', description: 'ping', parameters: { type: 'object', properties: {} }, kind: 'read' }
    ],
    callTool: async (n, a) => 'pong:' + n
  });
  await mcp.refreshMcpTools();

  let callCount = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      callCount++;
      const payload = JSON.parse(body || '{}');
      // 第一次请求：模型把工具标签放在 reasoning 里，content 为空
      if (callCount === 1) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              reasoning: '<fox:tool name="mcp__demo__ping">{}</fox:tool>'
            }
          }]
        }));
        return;
      }
      // 第二次请求：已拿到工具结果，给出最终回答
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '工具已执行' } }]
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const ctx = {
    secrets: { get: async () => '', store: async () => {}, delete: async () => {} },
    globalStorageUri: { fsPath: require('os').tmpdir() + '/foxai-test-' + Date.now() }
  };
  const cfg = await config.resolve(ctx);
  cfg.baseUrl = 'http://127.0.0.1:' + port + '/v1';
  cfg.model = 'test-model';
  cfg.apiMode = 'chat';
  cfg.forceNonStream = true;
  cfg.visionMode = 'off';
  cfg.visionConfig = { enabled: false };
  cfg.agentEnabled = true;
  cfg.maxSteps = 5;
  cfg.toolProtocol = 'text'; // 强制文本协议

  const session = new AgentSession({ context: ctx, cfg, messages: [], ui: {} });

  console.log('\n[文本协议工具名正则覆盖真实 MCP 命名空间]');
  check('可解析含连字符的 MCP 工具名', () => {
    const calls = parseTextCalls('<fox:tool name="mcp__fetch__fetch-url">{}</fox:tool>');
    assert.strictEqual(calls.length, 1, '应解析到 1 个调用');
    assert.strictEqual(calls[0].name, 'mcp__fetch__fetch-url');
  });
  check('可解析含点/斜杠/大写的 VS Code 原生 MCP 工具名', () => {
    const calls = parseTextCalls('<fox:tool name="mcp__io.github.ChromeDevTools/chrome-devtools-mcp__new_page">{"url":"x"}</fox:tool>');
    assert.strictEqual(calls.length, 1, '应解析到 1 个调用');
    assert.strictEqual(calls[0].name, 'mcp__io.github.ChromeDevTools/chrome-devtools-mcp__new_page');
  });
  check('可解析嵌在自然语言中的工具标签（前有大写正文）', () => {
    const text = 'fetch 没返回，我换 Playwright： <fox:tool name="mcp__playwright__browser_navigate"> {"url":"https://x"} </fox:tool> 用户想抓取页面';
    const calls = parseTextCalls(text);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].name, 'mcp__playwright__browser_navigate');
  });

  console.log('\n[1.1.39 闭合标签感知 / 溢出回传 / 记忆别名]');
  check('参数 JSON 内嵌 </foxtool> 字面量不被提前截断', () => {
    const text = '<foxtool name="write_file">{"path":"a.html","content":"<div></foxtool>尾巴"}</foxtool>';
    const calls = parseTextCalls(text, session._toolNameSet());
    assert.strictEqual(calls.length, 1, '应恰好解析到 1 个调用，实际 ' + calls.length);
    assert.strictEqual(calls[0].name, 'write_file');
    assert.ok(calls[0].rawArgs.includes('</foxtool>尾巴'), '参数 body 应完整含内嵌闭合标签，实际：' + calls[0].rawArgs);
  });
  check('参数 JSON 内嵌 HTML 标签（<b>）不被过激截断', () => {
    const text = '<foxtool name="edit_file">{"path":"x.md","content":"<b>粗体</b>"}</foxtool>';
    const calls = parseTextCalls(text, session._toolNameSet());
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].rawArgs.includes('<b>粗体</b>'), '参数应完整保留 HTML：' + calls[0].rawArgs);
  });
  check('单轮超过 5 个工具调用时标记 _truncated', () => {
    // 用不同名工具避免触发同名去重；第 6 个应触发截断标记
    const names = ['read_file', 'write_file', 'edit_file', 'list_dir', 'search_text', 'open_file'];
    let text = '';
    for (let i = 0; i < names.length; i++) text += `<foxtool name="${names[i]}">{"path":"f${i}.txt"}</foxtool>\n`;
    const calls = parseTextCalls(text, session._toolNameSet());
    assert.strictEqual(calls.length, 5, '应只取前 5 个，实际 ' + calls.length);
    assert.strictEqual(calls._truncated, true, '应标记截断');
  });
  check('get_memory 别名 recall_memory 可被工具注册表解析', () => {
    const toolsMod = require('../src/tools');
    const t = toolsMod.getTool('recall_memory');
    assert.ok(t, 'getTool(recall_memory) 应命中');
    assert.strictEqual(t.name, 'get_memory', '别名应解析到 get_memory');
  });

  console.log('\n[文本协议 reasoning 工具标签]');

  const r = await session.run();
  check('会话正常结束', () => assert.strictEqual(r.finished, true));
  // 1.1.14 统一空轮契约：text 协议下模型输出纯正文（无工具块）时，
  // 有正文先展示 → 空轮计数+1 → 回灌「继续/输出工具块」确认 → 模型再次纯正文 → 空轮达到上限 → 收尾。
  // 1.1.26 韧性加固：空轮上限 2 → 3（EMPTY_TURN_MAX），即给 2 次分级 nudge 机会再收尾。
  // 所以「工具调用(请求1) + 工具结果后最终回答(请求2) + 空轮 nudge1(请求3) + nudge2(请求4)」= 4 次请求。
  check('工具被调用且最终正文经空轮确认收尾（4 次模型请求）', () => assert.strictEqual(callCount, 4, '应发生 工具调用→正文→空轮 nudge×2 共 4 次请求，实际 ' + callCount));
  check('最终文本包含正确结论', () => assert.ok(String(r.text).includes('工具已执行'), '最终文本：' + r.text));

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  server.close();
  process.exit(fail ? 1 : 0);
})();
