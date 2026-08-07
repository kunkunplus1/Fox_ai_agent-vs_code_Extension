'use strict';

/**
 * 回归测试：原生 function calling 的 schema 清洗 + 大 schema 截断。
 * 背景：MCP 工具（playwright / chrome-devtools 等）返回的 inputSchema 含
 * $ref / additionalProperties / 超深嵌套，DeepSeek 原生 function calling 直接 400。
 * 运行：node test/mcpSchema.js
 */

const Module = require('module');
const assert = require('assert');

/* ---------- mock vscode（index.js 顶层 require('vscode')） ---------- */
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

const { sanitizeSchema, toOpenAITools } = require('../src/tools/index');

let pass = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log('  ✓ ' + name);
  pass++;
}

// 1) 含 $ref 的节点被退化为宽松对象
(function () {
  const s = sanitizeSchema({
    type: 'object',
    properties: {
      target: { $ref: '#/$defs/ElementHandle', description: 'a handle' },
      url: { type: 'string' }
    },
    $defs: { ElementHandle: { type: 'object', properties: { id: { type: 'string' } } } }
  });
  ok('含 $ref 的子节点被替换为 {type:object}', s.properties.target.type === 'object');
  ok('其余属性保留', s.properties.url.type === 'string');
  ok('顶层 $defs 被剥离（不在顶层，也不会被当作节点下发）', !('$defs' in s));
})();

// 2) additionalProperties / patternProperties 等被剥离
(function () {
  const s = sanitizeSchema({
    type: 'object',
    additionalProperties: true,
    patternProperties: { '^x-': { type: 'string' } },
    properties: { a: { type: 'number' } }
  });
  ok('additionalProperties 被剥离', !('additionalProperties' in s));
  ok('patternProperties 被剥离', !('patternProperties' in s));
  ok('普通属性保留', s.properties.a.type === 'number');
})();

// 3) 超长描述被截断到 800
(function () {
  const big = 'x'.repeat(5000);
  const s = sanitizeSchema({ type: 'object', properties: { a: { type: 'string', description: big } } });
  ok('描述被截断到 800', s.properties.a.description.length === 800);
})();

// 4) 整体 schema 过大 → 退化为最小对象
(function () {
  const props = {};
  for (let i = 0; i < 300; i++) props['k' + i] = { type: 'string', description: 'y'.repeat(50) };
  const s = sanitizeSchema({ type: 'object', properties: props });
  ok('超大 schema 退化为 {type:object,properties:{}}', JSON.stringify(s) === JSON.stringify({ type: 'object', properties: {} }));
})();

// 5) 递归 schema 不爆栈（循环引用兜底）
(function () {
  const node = { type: 'object', properties: {} };
  node.properties.self = node;
  const s = sanitizeSchema(node);
  ok('循环引用被安全处理', s.properties.self.type === 'object');
})();

// 6) toOpenAITools 输出不含 $ref / additionalProperties
(function () {
  const tools = toOpenAITools();
  const serialized = JSON.stringify(tools);
  ok('toOpenAITools 输出无 $ref', !serialized.includes('"$ref"'));
  ok('toOpenAITools 输出无 additionalProperties', !serialized.includes('additionalProperties'));
  ok('toOpenAITools 输出无 $defs', !serialized.includes('$defs'));
})();

console.log('\n结果：' + pass + ' 通过，0 失败');
