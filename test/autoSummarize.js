'use strict';

/**
 * 离线测试：上下文超限自动压缩触发逻辑
 * 运行：node test/autoSummarize.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

/* ---------- mock vscode ---------- */
const vscodeMock = {
  workspace: {
    workspaceFolders: null,
    getConfiguration: () => ({
      get: (k, d) => {
        if (k === 'knowledgeBase.autoSummarize') return { enabled: true, threshold: 0.6, keepRecent: 6, dir: '' };
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

let summarized = null;
let invalidated = false;
const kbOrgMock = {
  summarizeConversation: async (context, messages, opts) => {
    summarized = messages;
    if (opts && opts.onLog) opts.onLog('mock summarize');
    return path.join(os.tmpdir(), 'fox-auto-summary-test.md');
  }
};
const kbMock = {
  invalidate: () => { invalidated = true; },
  isEnabled: () => false,
  retrieve: () => '',
  augmentSystemPrompt: (base) => base
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  if (request === './knowledgeOrganizer') return kbOrgMock;
  if (request === './knowledgeBase') return kbMock;
  return origLoad.apply(this, arguments);
};

const { AgentSession } = require('../src/agent');

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

function makeMessages(n, contentLen) {
  const out = [];
  const filler = 'x'.repeat(contentLen);
  for (let i = 0; i < n; i++) {
    out.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg${i} ${filler}` });
  }
  return out;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-auto-'));
  const context = { globalStorageUri: { fsPath: tmp } };

  // 1) 配置了 contextWindow，消息数 8 条（可压缩 2 条 < 4），但单条/累积内容足够大，
  //    usage 超过 0.6 阈值 → 应触发压缩（修复前因 compressible<4 直接 return 不会触发）。
  {
    summarized = null;
    invalidated = false;
    const messages = makeMessages(8, 6000);
    const cfg = {
      contextWindow: 1000,
      autoSummarize: { enabled: true, threshold: 0.6, keepRecent: 6 },
      agentEnabled: true,
      planAndExecute: { enabled: false },
      toolProtocol: 'native',
      maxSteps: 25,
      temperature: 0.3,
      maxTokens: 2048,
      timeout: 30000,
      maxHistory: 20,
      maxToolOutput: 8000,
      maxMessageBytes: 1024 * 1024,
      systemPrompt: ''
    };
    let usageAfter = null;
    const agent = new AgentSession({ context, cfg, messages, ui: { contextUsage: (d) => { usageAfter = d; } } });
    await agent._maybeAutoCompress('test', '');
    check('usage 超阈值时，即使可压缩消息少于 4 条也触发压缩', () => assert.ok(summarized !== null && summarized.length === 2));
    check('压缩后 invalidate 知识库缓存', () => assert.strictEqual(invalidated, true));
    check('messages 被就地裁剪为 6 条', () => assert.strictEqual(messages.length, 6));
    check('压缩后 emit contextUsage 刷新面板', () => assert.ok(usageAfter && usageAfter.raw && usageAfter.raw.historyLength === 6));
  }

  // 2) 未超阈值时不触发压缩
  {
    summarized = null;
    invalidated = false;
    const messages = makeMessages(8, 10);
    const cfg = {
      contextWindow: 100000,
      autoSummarize: { enabled: true, threshold: 0.9, keepRecent: 6 },
      agentEnabled: true,
      planAndExecute: { enabled: false },
      toolProtocol: 'native',
      maxSteps: 25,
      temperature: 0.3,
      maxTokens: 2048,
      timeout: 30000,
      maxHistory: 20,
      maxToolOutput: 8000,
      maxMessageBytes: 1024 * 1024,
      systemPrompt: ''
    };
    const agent = new AgentSession({ context, cfg, messages: messages.slice(), ui: {} });
    await agent._maybeAutoCompress('test', '');
    check('未超阈值时不触发压缩', () => assert.strictEqual(summarized, null));
  }

  // 3) 未配置 contextWindow 时，按轮数触发（可压缩 >= 6）
  {
    summarized = null;
    invalidated = false;
    const messages = makeMessages(14, 10);
    const cfg = {
      contextWindow: 0,
      autoSummarize: { enabled: true, threshold: 0.6, keepRecent: 6 },
      agentEnabled: true,
      planAndExecute: { enabled: false },
      toolProtocol: 'native',
      maxSteps: 25,
      temperature: 0.3,
      maxTokens: 2048,
      timeout: 30000,
      maxHistory: 20,
      maxToolOutput: 8000,
      maxMessageBytes: 1024 * 1024,
      systemPrompt: ''
    };
    const agent = new AgentSession({ context, cfg, messages, ui: {} });
    await agent._maybeAutoCompress('test', '');
    check('未配 contextWindow 且可压缩 >= 6 时按轮数触发', () => assert.ok(summarized !== null && summarized.length === 8));
  }

  // 4) 未配置 contextWindow 且可压缩 < 6 时不触发
  {
    summarized = null;
    invalidated = false;
    const messages = makeMessages(10, 10);
    const cfg = {
      contextWindow: 0,
      autoSummarize: { enabled: true, threshold: 0.6, keepRecent: 6 },
      agentEnabled: true,
      planAndExecute: { enabled: false },
      toolProtocol: 'native',
      maxSteps: 25,
      temperature: 0.3,
      maxTokens: 2048,
      timeout: 30000,
      maxHistory: 20,
      maxToolOutput: 8000,
      maxMessageBytes: 1024 * 1024,
      systemPrompt: ''
    };
    const agent = new AgentSession({ context, cfg, messages: messages.slice(), ui: {} });
    await agent._maybeAutoCompress('test', '');
    check('未配 contextWindow 且可压缩 < 6 时不触发', () => assert.strictEqual(summarized, null));
  }

  // 5) 关闭 autoSummarize 时不触发
  {
    summarized = null;
    invalidated = false;
    const messages = makeMessages(8, 6000);
    const cfg = {
      contextWindow: 1000,
      autoSummarize: { enabled: false, threshold: 0.6, keepRecent: 6 },
      agentEnabled: true,
      planAndExecute: { enabled: false },
      toolProtocol: 'native',
      maxSteps: 25,
      temperature: 0.3,
      maxTokens: 2048,
      timeout: 30000,
      maxHistory: 20,
      maxToolOutput: 8000,
      maxMessageBytes: 1024 * 1024,
      systemPrompt: ''
    };
    const agent = new AgentSession({ context, cfg, messages: messages.slice(), ui: {} });
    await agent._maybeAutoCompress('test', '');
    check('autoSummarize 关闭时不触发', () => assert.strictEqual(summarized, null));
  }

  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
