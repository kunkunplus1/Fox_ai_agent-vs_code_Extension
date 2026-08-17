'use strict';

/**
 * 分层上下文（L1/L2/L3）单测：
 *  - buildBatchModeHint：L3 批处理指令检测（/fix_all、/review、#fix 等）
 *  - renderFileTreeText：L1 精简文件树文本
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// mock vscode（agent.js 顶部 require vscode）
const vscodeMock = {
  workspace: { workspaceFolders: null, getConfiguration: () => ({ get: (k, d) => d, update: async () => {}, inspect: () => null }), textDocuments: [], fs: {} },
  window: { activeTextEditor: null, activeTerminal: null, tabGroups: { all: [] } },
  languages: { getDiagnostics: () => [] },
  commands: { executeCommand: async () => {} },
  env: { clipboard: { readText: async () => '', writeText: async () => {} } },
  Uri: { file: (p) => ({ fsPath: p, toString: () => 'file://' + p }), joinPath: () => ({}), parse: (s) => ({ fsPath: s, toString: () => s }) },
  Position: class {}, Range: class {}, Selection: class {}, ThemeIcon: class {},
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  FileType: { File: 1, Directory: 2, Unknown: 3 },
  InlineCompletionItem: class {}, ConfigurationTarget: { Global: 1 }, TextEditorRevealType: { InCenter: 2 }, WorkspaceEdit: class {}
};
const origLoad = Module._load;
Module._load = function (request) { if (request === 'vscode') return vscodeMock; return origLoad.apply(this, arguments); };

const { buildBatchModeHint } = require('../src/agent');
const { renderFileTreeText } = require('../src/projectScan');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); }
}

check('buildBatchModeHint: /fix_all 命中', () => assert.ok(buildBatchModeHint('/fix_all 帮我把整个项目报错修掉').includes('批处理模式')));
check('buildBatchModeHint: /review 命中', () => assert.ok(buildBatchModeHint('/review').includes('批处理模式')));
check('buildBatchModeHint: #fix 命中', () => assert.ok(buildBatchModeHint('#fix').includes('批处理模式')));
check('buildBatchModeHint: 提示含「文件尾部」', () => assert.ok(buildBatchModeHint('/fix_all').includes('文件【尾部】')));
check('buildBatchModeHint: 普通问题不命中', () => assert.strictEqual(buildBatchModeHint('你好'), ''));
check('buildBatchModeHint: 普通改文件不命中', () => assert.strictEqual(buildBatchModeHint('帮我改一下 utils.js 的 formatDate'), ''));
check('buildBatchModeHint: 空串不命中', () => assert.strictEqual(buildBatchModeHint(''), ''));

check('renderFileTreeText 输出目录与文件层级、跳过 node_modules', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-l1-'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.mkdirSync(path.join(tmp, 'node_modules'));
  fs.writeFileSync(path.join(tmp, 'src', 'app.js'), 'x');
  fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
  const tree = renderFileTreeText(tmp, 2, 120);
  assert.ok(tree.includes('src/'), '应含 src 目录，实际：' + tree);
  assert.ok(tree.includes('app.js'), '应含 app.js 文件，实际：' + tree);
  assert.ok(!tree.includes('node_modules'), '应跳过 node_modules，实际：' + tree);
  fs.rmSync(tmp, { recursive: true, force: true });
});

console.log('\n[layeredContext] 通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
