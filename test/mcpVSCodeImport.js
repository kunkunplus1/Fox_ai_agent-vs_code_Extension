'use strict';

/**
 * 测试 VS Code 原生 MCP 的「自动导入并接入」与「删除联动」。
 *  - syncVSCodeServers：把 VS Code mcp.json 里的服务器自动写进 foxAi.mcp.servers，
 *    标记 importedFromVSCode；验证新增 / 幂等 / 不覆盖同名 / 关开关。
 *  - removeFromVSCodeMcpJson：从 VS Code mcp.json 删除一条并自动备份；验证越界拒绝。
 * 运行：node test/mcpVSCodeImport.js
 */

const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// 隔离用户级 mcp.json：把 APPDATA 指向临时空目录，discover 只剩工作区来源
const APPDATA = path.join(os.tmpdir(), 'foxvsc_appdata_' + Date.now());
process.env.APPDATA = APPDATA;

const vscodeMock = {
  workspace: {
    workspaceFolders: null,
    getConfiguration: () => ({ get: (k, d) => d, update: async () => {} }),
    textDocuments: [],
    fs: {},
    onDidChangeConfiguration: () => ({ dispose() {} })
  },
  window: { activeTextEditor: null, activeTerminal: null, tabGroups: { all: [] }, showWarningMessage: async () => {} },
  languages: { getDiagnostics: () => [] },
  commands: { executeCommand: async () => {} },
  env: { clipboard: { readText: async () => '', writeText: async () => {} } },
  Uri: { file: (p) => ({ fsPath: p, toString: () => 'file://' + p }), joinPath: () => ({}) },
  Position: class {}, Range: class {}, Selection: class {}, ThemeIcon: class {},
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  FileType: { File: 1, Directory: 2 },
  InlineCompletionItem: class {},
  ConfigurationTarget: { Global: 1 },
  TextEditorRevealType: { InCenter: 2 }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const mcpSetup = require('../src/tools/mcpSetup');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message + '\n' + (e.stack || '')); }
}

function makeCfg(initial) {
  const store = Object.assign({}, initial);
  return {
    get(k, d) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d; },
    update(k, v) { store[k] = v; return Promise.resolve(); }
  };
}

function makeWs() {
  const dir = path.join(os.tmpdir(), 'foxvsc_ws_' + Date.now() + '_' + Math.floor(Math.random() * 1e6));
  fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.vscode', 'mcp.json'), JSON.stringify({
    servers: { 'my-srv': { command: 'npx', args: ['-y', 'some-pkg'], env: { FOO: 'bar' } } }
  }, null, 2));
  return dir;
}

// ---- syncVSCodeServers ----
const wsDir = makeWs();
vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: wsDir } }];

check('sync 自动导入新增（importedFromVSCode + 携带来源）', () => {
  const cfg = makeCfg({ 'mcp.servers': [] });
  const r = mcpSetup.syncVSCodeServers(cfg, { autoImport: true });
  assert.strictEqual(r.imported, true);
  const servers = cfg.get('mcp.servers', []);
  assert.strictEqual(servers.length, 1);
  const s = servers[0];
  assert.strictEqual(s.id, 'my-srv');
  assert.strictEqual(s.importedFromVSCode, true);
  assert.strictEqual(s.sourceName, 'my-srv');
  assert.ok(s.sourceFile && s.sourceFile.endsWith('mcp.json'));
  assert.strictEqual(s.enabled, true);
  assert.strictEqual(s.command, 'npx');
  assert.deepStrictEqual(s.args, ['-y', 'some-pkg']);
  assert.strictEqual(s.env.FOO, 'bar');
});

check('sync 幂等（二次不重复追加）', () => {
  const cfg = makeCfg({ 'mcp.servers': [] });
  mcpSetup.syncVSCodeServers(cfg, { autoImport: true });
  const r2 = mcpSetup.syncVSCodeServers(cfg, { autoImport: true });
  assert.strictEqual(r2.imported, false);
  assert.strictEqual(cfg.get('mcp.servers', []).length, 1);
});

check('sync 不覆盖同名非 imported 条目', () => {
  const cfg = makeCfg({ 'mcp.servers': [{ id: 'my-srv', command: 'custom', importedFromVSCode: false }] });
  const r = mcpSetup.syncVSCodeServers(cfg, { autoImport: true });
  assert.strictEqual(r.imported, false);
  const servers = cfg.get('mcp.servers', []);
  assert.strictEqual(servers.length, 1);
  assert.strictEqual(servers[0].command, 'custom');
  assert.strictEqual(servers[0].importedFromVSCode, false);
});

check('sync autoImport=false 不追加', () => {
  const cfg = makeCfg({ 'mcp.servers': [] });
  const r = mcpSetup.syncVSCodeServers(cfg, { autoImport: false });
  assert.strictEqual(r.imported, false);
  assert.strictEqual(cfg.get('mcp.servers', []).length, 0);
});

// ---- removeFromVSCodeMcpJson ----
check('remove 删除并自动备份 .foxbak', () => {
  const dir = path.join(os.tmpdir(), 'foxvsc_rm_' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ servers: { foo: { command: 'npx', args: [] }, keep: {} } }, null, 2));
  const ok = mcpSetup.removeFromVSCodeMcpJson(file, 'foo', [file]);
  assert.strictEqual(ok, true);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(!('foo' in json.servers), 'foo 应被删除');
  assert.ok('keep' in json.servers, 'keep 应保留');
  assert.ok(fs.existsSync(file + '.foxbak'), '应生成备份');
});

check('remove 越界拒绝（不在允许列表）', () => {
  const dir = path.join(os.tmpdir(), 'foxvsc_rm2_' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ servers: { foo: {} } }, null, 2));
  const evil = path.join(os.tmpdir(), 'foxvsc_evil_' + Date.now(), 'mcp.json');
  const ok = mcpSetup.removeFromVSCodeMcpJson(evil, 'foo', [file]);
  assert.strictEqual(ok, false);
});

check('remove 不存在的 name 返回 false', () => {
  const dir = path.join(os.tmpdir(), 'foxvsc_rm3_' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ servers: { foo: {} } }, null, 2));
  const ok = mcpSetup.removeFromVSCodeMcpJson(file, 'nope', [file]);
  assert.strictEqual(ok, false);
});

// ---- 用户级 mcp.json（APPDATA 路径）来源也要携带 sourceFile，否则删除联动会失败 ----
check('用户级 mcp.json 来源携带 sourceFile（修复：删除联动可达）', () => {
  // 构造一个用户级目录：<appdata>/Code/User/mcp.json
  const userApp = path.join(os.tmpdir(), 'foxvsc_userapp_' + Date.now());
  const userMcp = path.join(userApp, 'Code', 'User', 'mcp.json');
  fs.mkdirSync(path.dirname(userMcp), { recursive: true });
  fs.writeFileSync(userMcp, JSON.stringify({ servers: { usrv: { command: 'npx', args: ['-y', 'u-pkg'] } } }, null, 2));
  const savedWs = vscodeMock.workspace.workspaceFolders;
  const savedApp = process.env.APPDATA;
  vscodeMock.workspace.workspaceFolders = null; // 隔离工作区来源
  process.env.APPDATA = userApp;
  try {
    const disc = mcpSetup.discoverVSCodeServers();
    const found = disc.find((d) => d.sourceName === 'usrv');
    assert.ok(found, '应发现用户级 usrv');
    assert.strictEqual(found.sourceFile, userMcp, '用户级来源必须携带 sourceFile');
    // 自动导入后，删除联动应能真正清掉 VS Code 用户级 mcp.json 条目
    const cfg2 = makeCfg({ 'mcp.servers': [] });
    mcpSetup.syncVSCodeServers(cfg2, { autoImport: true });
    const imported = cfg2.get('mcp.servers', [])[0];
    assert.strictEqual(imported.sourceFile, userMcp, '导入条目 sourceFile 应与发现一致');
    const rmOk = mcpSetup.removeFromVSCodeMcpJson(imported.sourceFile, imported.sourceName);
    assert.strictEqual(rmOk, true, '删除联动应成功（此前因 sourceFile 为 null 会失败）');
    const after = JSON.parse(fs.readFileSync(userMcp, 'utf8'));
    assert.ok(!('usrv' in after.servers), '用户级条目应被删掉');
  } finally {
    vscodeMock.workspace.workspaceFolders = savedWs;
    process.env.APPDATA = savedApp;
  }
});

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
