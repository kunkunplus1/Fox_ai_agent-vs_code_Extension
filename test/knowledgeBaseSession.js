'use strict';

/**
 * 离线测试：知识库-2 的会话隔离与单会话聚合
 * 运行：node test/knowledgeBaseSession.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

/* ---------- mock vscode ---------- */
let lastModal = null;
const vscodeMock = {
  workspace: {
    workspaceFolders: null,
    getConfiguration: () => ({
      get: (k, d) => {
        if (k === 'knowledgeBase') return {
          enabled: true,
          autoSummarize: { enabled: true, dir: kb2Dir },
          chunkSize: 200,
          topK: 10,
          bm25Enabled: true,
          maxChars: 8000
        };
        if (k === 'knowledgeBase.autoSummarize') return { enabled: true, dir: kb2Dir };
        if (k === 'memory.storagePath') return '';
        if (k === 'skills.storagePath') return '';
        if (k === 'planTasks.storagePath') return '';
        return d;
      },
      update: async () => {}
    }),
    textDocuments: [],
    fs: {}
  },
  window: {
    activeTextEditor: null,
    activeTerminal: null,
    tabGroups: { all: [] },
    showWarningMessage: async (msg, opts, ...buttons) => {
      lastModal = { msg, opts, buttons };
      return buttons.includes('允许') ? '允许' : '拒绝';
    }
  },
  languages: { getDiagnostics: () => [] },
  commands: { executeCommand: async () => {} },
  env: { clipboard: { readText: async () => '', writeText: async () => {} } },
  Uri: { file: (p) => ({ fsPath: p, toString: () => 'file://' + p }), joinPath: () => ({}) },
  Position: class {},
  Range: class {},
  Selection: class {},
  ThemeIcon: class {},
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  EventEmitter: class { event = () => {}; fire() {} }
};

const origRequire = Module._load;
Module._load = function (request, parent) {
  if (request === 'vscode') return vscodeMock;
  return origRequire.apply(this, arguments);
};

/* ---------- helpers ---------- */
async function check(name, fn) {
  try {
    await fn();
    console.log('  ✓', name);
  } catch (e) {
    console.log('  ✗', name);
    console.error(e.message);
    process.exitCode = 1;
  }
}

// mock chatNonStream，避免测试依赖真实本地服务（必须在 require knowledgeOrganizer 之前）
const client = require('../src/client');
const origChatNonStream = client.chatNonStream;
client.chatNonStream = async () => ({ content: '【摘要】测试摘要内容。' });

const kb = require('../src/knowledgeBase');
const org = require('../src/knowledgeOrganizer');

// 1.1.27：输出目录固定 ~/.fox-ai/knowledge(-2)——mock os.homedir 让固定目录落到临时区，避免污染真实用户目录
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-kb-session-'));
const realHomedir = os.homedir;
os.homedir = () => tmpDir;
const kb2Dir = path.join(tmpDir, '.fox-ai', 'knowledge-2');
fs.mkdirSync(kb2Dir, { recursive: true });

function reset() {
  kb.invalidate();
  kb.clearSessionAccess();
  lastModal = null;
  for (const f of fs.readdirSync(kb2Dir)) {
    fs.unlinkSync(path.join(kb2Dir, f));
  }
}

/* ---------- tests ---------- */
reset();

async function runTests() {

// 1. summarizeConversation 同一 session 聚合到一个文件
await check('同一 session 压缩后只产生一个摘要文件', async () => {
  reset();
  const sid = 'sess-abc';
  const ctxMock = { secrets: { get: async () => undefined } };
  await org.summarizeConversation(ctxMock, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' }
  ], { sessionId: sid, dir: kb2Dir });
  await org.summarizeConversation(ctxMock, [
    { role: 'user', content: 'world' },
    { role: 'assistant', content: 'earth' }
  ], { sessionId: sid, dir: kb2Dir });
  const files = fs.readdirSync(kb2Dir).filter((f) => f.endsWith('.md'));
  assert.strictEqual(files.length, 1, '应该只有一个文件');
  assert.ok(files[0].startsWith('sess-abc-summary.md'), '文件名应带 sessionId');
  const text = fs.readFileSync(path.join(kb2Dir, files[0]), 'utf8');
  assert.ok(text.includes('测试摘要'), '应包含压缩结果');
  assert.ok((text.match(/对话压缩摘要/g) || []).length >= 2, '应有两个批次摘要');
});

// 2. listKnowledgeFiles 只返回当前 session
await check('listKnowledgeFiles 只返回当前 session 的摘要', () => {
  reset();
  fs.writeFileSync(path.join(kb2Dir, 'sess-a-summary.md'), '# A\n', 'utf8');
  fs.writeFileSync(path.join(kb2Dir, 'sess-b-summary.md'), '# B\n', 'utf8');
  fs.writeFileSync(path.join(kb2Dir, 'plain.md'), '# plain\n', 'utf8');
  const files = kb.listKnowledgeFiles('sess-a').map((f) => path.basename(f.file));
  assert.ok(files.includes('sess-a-summary.md'), '应包含当前 session');
  assert.ok(!files.includes('sess-b-summary.md'), '不应包含其他 session');
  assert.ok(!files.includes('plain.md'), '非 session 摘要不应被扫描');
});

// 3. retrieve 只检索当前 session
await check('retrieve 只检索当前 session 的摘要', () => {
  reset();
  fs.writeFileSync(path.join(kb2Dir, 'sess-a-summary.md'), '# 会话A\n用户问：苹果多少钱一斤？\n', 'utf8');
  fs.writeFileSync(path.join(kb2Dir, 'sess-b-summary.md'), '# 会话B\n用户问：香蕉怎么保存？\n', 'utf8');
  const ctxA = kb.retrieve('苹果', 1000, 'sess-a');
  const ctxB = kb.retrieve('香蕉', 1000, 'sess-b');
  assert.ok(ctxA.includes('苹果'), 'session A 应检索到自己的内容');
  assert.ok(!ctxA.includes('香蕉'), 'session A 不应检索到 session B');
  assert.ok(ctxB.includes('香蕉'), 'session B 应检索到自己的内容');
  assert.ok(!ctxB.includes('苹果'), 'session B 不应检索到 session A');
});

// 4. 跨会话授权
await check('requestSessionAccess 授权后可检索其他 session', async () => {
  reset();
  fs.writeFileSync(path.join(kb2Dir, 'sess-a-summary.md'), '# 会话A\n苹果价格\n', 'utf8');
  fs.writeFileSync(path.join(kb2Dir, 'sess-b-summary.md'), '# 会话B\n香蕉保存\n', 'utf8');
  const before = kb.retrieve('香蕉', 1000, 'sess-a');
  assert.ok(!before.includes('香蕉'), '授权前 session A 看不到 session B');

  const res = await kb.requestSessionAccess('sess-b', 'sess-a');
  assert.strictEqual(res.allowed, true, '应允许授权');
  assert.strictEqual(res.sessionId, 'sess-b', '返回正确的 sessionId');

  const after = kb.retrieve('香蕉', 1000, 'sess-a');
  assert.ok(after.includes('香蕉'), '授权后 session A 可检索到 session B');
});

// 5. 当前 session 始终可见，无需授权
await check('当前 session 无需授权即可检索', () => {
  reset();
  fs.writeFileSync(path.join(kb2Dir, 'sess-me-summary.md'), '# 我\n当前会话内容\n', 'utf8');
  const ctx = kb.retrieve('当前会话', 1000, 'sess-me');
  assert.ok(ctx.includes('当前会话'), '当前 session 内容可直接检索');
});

// 6. 没有 sessionId 时不扫描任何会话摘要（保护隐私）
await check('未提供 sessionId 时不扫描会话摘要', () => {
  reset();
  fs.writeFileSync(path.join(kb2Dir, 'sess-a-summary.md'), '# 会话A\n内容\n', 'utf8');
  const files = kb.listKnowledgeFiles();
  assert.ok(!files.some((f) => f.source.startsWith('sess-')), '未提供 sessionId 时不返回任何会话摘要');
});

} // runTests

runTests().then(() => {
  reset();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  client.chatNonStream = origChatNonStream;
  console.log('结果：通过', process.exitCode ? '?' : '6', '/ 失败', process.exitCode ? '1' : '0');
}).catch((e) => {
  console.error(e);
  client.chatNonStream = origChatNonStream;
  process.exitCode = 1;
});
