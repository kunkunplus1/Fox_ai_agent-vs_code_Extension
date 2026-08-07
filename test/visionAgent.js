'use strict';

/**
 * 回归测试：Agent 层多模态识图中转
 * - _callSecondaryVision 不引用未定义的 client
 * - 第二轮对话无新图时，不再重复识别历史图片
 */

const Module = require('module');
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

/* ---------- mock client ---------- */
let clientCalls = [];
const clientMock = {
  chatNonStream: async (opts) => {
    clientCalls.push({ fn: 'chatNonStream', model: opts.model });
    return { content: '一张截图，显示聊天界面' };
  },
  chatNonStreamResponses: async (opts) => {
    clientCalls.push({ fn: 'chatNonStreamResponses', model: opts.model });
    return { content: '一张截图，显示聊天界面' };
  },
  chatOnce: async () => ({ content: '' }),
  streamResponses: async () => {}
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  if (request === './client' || request === 'C:/Users/asis/WorkBuddy/2026-08-02-16-40-18/fox-ai/src/client.js') return clientMock;
  return origLoad.apply(this, arguments);
};

const { AgentSession } = require('../src/agent');
const config = require('../src/config');

const originalResolve = config.resolve;
config.resolve = async (ctx) => {
  const cfg = await originalResolve(ctx);
  cfg.apiMode = 'chat';
  cfg.agentEnabled = false; // 关闭自动工具，避免干扰
  cfg.visionMode = 'off';
  return cfg;
};

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); }
}

(async () => {
  const ctx = {
    secrets: { get: async () => '', store: async () => {}, delete: async () => {} },
    globalStorageUri: { fsPath: require('os').tmpdir() + '/foxai-test' }
  };
  const cfg = await config.resolve(ctx);
  cfg.baseUrl = 'http://127.0.0.1:1/v1';
  cfg.model = 'deepseek-v4-flash';
  cfg.forceNonStream = true;
  cfg.visionMode = 'off';
  cfg.visionConfig = {
    enabled: true,
    provider: 'openai',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'x',
    model: 'doubao-vision-pro',
    apiMode: 'chat',
    maxTokens: 512,
    timeout: 5000
  };

  console.log('\n[Agent 多模态识图]');

  // 测试1：_callSecondaryVision 不抛 client is not defined
  clientCalls = [];
  const session1 = new AgentSession({ context: ctx, cfg, messages: [], ui: {} });
  const desc1 = await session1._callSecondaryVision('data:image/png;base64,AAAA');
  check('_callSecondaryVision 返回描述', () => assert.ok(desc1.includes('截图')));
  check('_callSecondaryVision 调用 chatNonStream', () => assert.strictEqual(clientCalls.length, 1) && assert.strictEqual(clientCalls[0].fn, 'chatNonStream'));

  // 测试2：Responses 视觉模型调用 chatNonStreamResponses
  cfg.visionConfig.apiMode = 'responses';
  clientCalls = [];
  const session2 = new AgentSession({ context: ctx, cfg, messages: [], ui: {} });
  const desc2 = await session2._callSecondaryVision('data:image/png;base64,AAAA');
  check('Responses 视觉模型调用 chatNonStreamResponses', () => assert.strictEqual(clientCalls.length, 1) && assert.strictEqual(clientCalls[0].fn, 'chatNonStreamResponses'));

  // 测试3：历史图片只被识别一次
  cfg.visionConfig.apiMode = 'chat';
  clientCalls = [];
  const notices = [];
  const session3 = new AgentSession({
    context: ctx,
    cfg,
    messages: [],
    ui: {}
  });
  const origEmit = session3.emit.bind(session3);
  session3.emit = function (type, payload) {
    if (type === 'notice' && payload && payload.text) notices.push(payload.text);
    return origEmit(type, payload);
  };

  // 第一轮：用户发图
  session3.messages.push({
    role: 'user',
    content: [
      { type: 'text', text: '这是什么' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
    ]
  });

  await session3.prepareHistory();
  check('第一轮识别了 1 张图', () => assert.strictEqual(clientCalls.length, 1));
  check('第一轮发出识别通知', () => assert.ok(notices.some((t) => t.includes('已用第二个多模态模型识别 1 张图片'))));
  check('历史消息中的图片已被替换为文字描述', () => {
    const last = session3.messages[session3.messages.length - 1];
    assert.ok(Array.isArray(last.content));
    assert.ok(!last.content.some((p) => p.type === 'image_url' || p.type === 'input_image'));
    assert.ok(last.content.some((p) => p.type === 'text' && p.text.includes('图片描述')));
  });

  // 第二轮：用户只发文字
  notices.length = 0;
  session3.messages.push({ role: 'user', content: '然后呢' });
  clientCalls = [];
  await session3.prepareHistory();
  check('第二轮没有新图，不再调用视觉模型', () => assert.strictEqual(clientCalls.length, 0));
  check('第二轮不再提示识别图片', () => assert.ok(!notices.some((t) => t.includes('已用第二个多模态模型识别'))));

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
