'use strict';

/**
 * 验证：
 *   #203  context.js 必须导出 getDebugConsole / getForwardedPorts（否则工具调用报 is not a function）
 *   #204  mcpSetup.discoverVSCodeServers 能解析 VS Code 原生 mcp.json，让 🦊 面板能看到它们
 */

const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- 必须先 mock vscode，再 require 任何 fox-ai 模块 ---
const vscodeMock = {
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: (k, d) => d, update: async () => {} }),
    textDocuments: [],
    fs: {}
  },
  window: { activeTextEditor: null, activeTerminal: null, tabGroups: { all: [] } },
  languages: { getDiagnostics: () => [] },
  debug: { activeDebugSession: null },
  commands: { executeCommand: async () => {} },
  env: { clipboard: { readText: async () => '', writeText: async () => {} } },
  Uri: { file: (p) => ({ fsPath: p, toString: () => 'file://' + p }), joinPath: () => ({}) },
  Position: class {},
  Range: class {},
  Selection: class {},
  ThemeIcon: class {},
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  FileType: { File: 1, Directory: 2 },
  ConfigurationTarget: { Global: 1 },
  TextEditorRevealType: { InCenter: 2 }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const ctx = require('../src/tools/context');
const mcpSetup = require('../src/tools/mcpSetup');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name); }
}

// --- #203：context 工具导出（修复导出遗漏） ---
check('getDebugConsole 已导出（修复 #203）', typeof ctx.getDebugConsole === 'function');
check('getForwardedPorts 已导出（修复 #203）', typeof ctx.getForwardedPorts === 'function');
check('getDiagnostics 仍正确导出', typeof ctx.getDiagnostics === 'function');
check('getEditorContext 仍正确导出', typeof ctx.getEditorContext === 'function');

// --- #204：discoverVSCodeServers 解析用户级 mcp.json ---
const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-appdata-'));
const userMcpDir = path.join(tmpAppData, 'Code', 'User');
fs.mkdirSync(userMcpDir, { recursive: true });
fs.writeFileSync(
  path.join(userMcpDir, 'mcp.json'),
  JSON.stringify({
    servers: {
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/x'] },
      seq: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] }
    }
  })
);
const prevAppData = process.env.APPDATA;
process.env.APPDATA = tmpAppData;
try {
  const found = mcpSetup.discoverVSCodeServers();
  const ids = found.map((s) => s.id);
  check('发现 vscode:filesystem', ids.includes('vscode:filesystem'));
  check('发现 vscode:seq', ids.includes('vscode:seq'));
  const fsSrv = found.find((s) => s.id === 'vscode:filesystem');
  check('filesystem 归一化为 stdio 且带命令', !!fsSrv && fsSrv.transport === 'stdio' && /server-filesystem/.test((fsSrv.args || []).join(' ')));
  const seqSrv = found.find((s) => s.id === 'vscode:seq');
  check('seq 归一化为 stdio', !!seqSrv && seqSrv.transport === 'stdio');
} finally {
  process.env.APPDATA = prevAppData;
  fs.rmSync(tmpAppData, { recursive: true, force: true });
}

console.log('\nVS Code MCP / context 工具测试：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
