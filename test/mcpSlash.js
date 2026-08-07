'use strict';

/*
 * /mcp 斜杠命令参数适配测试（无需真实 MCP 服务器）：
 *  - 合法 JSON 参数直接解析
 *  - key:value 模式解析
 *  - 单一字符串属性自动映射
 *  - 多字段结构化 schema 返回 null（应由调用方提示 JSON 格式）
 *  - schema 归一化支持 parameters / inputSchema / schema
 */

const assert = require('assert');

const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req) {
  if (req === 'vscode') return req;
  return origResolve.apply(this, arguments);
};
require.cache.vscode = {
  id: 'vscode',
  exports: {
    workspace: { getConfiguration: () => ({ get: () => null }) },
    ConfigurationTarget: { Global: 1 },
    window: { createOutputChannel: () => ({}) }
  }
};

const { ChatViewProvider } = require('../src/chatView');
const proto = ChatViewProvider.prototype;

let pass = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.error('  ✗ ' + name + ' -> ' + e.message); process.exitCode = 1; }
}

ok('JSON 参数直接解析', () => {
  const r = proto._coerceMcpArgs('{"x":1}', { type: 'object', properties: { x: { type: 'number' } } });
  assert.deepStrictEqual(r, { x: 1 });
});

ok('key:value 模式解析', () => {
  const r = proto._coerceMcpArgs('url: https://example.com', {
    type: 'object',
    properties: { url: { type: 'string' } }
  });
  assert.deepStrictEqual(r, { url: 'https://example.com' });
});

ok('单一 required 字符串属性自动映射', () => {
  const r = proto._coerceMcpArgs('hello world', {
    type: 'object',
    properties: { thought: { type: 'string' } },
    required: ['thought']
  });
  assert.deepStrictEqual(r, { thought: 'hello world' });
});

ok('单一字符串属性自动映射（非 required）', () => {
  const r = proto._coerceMcpArgs('/path/to/file', {
    type: 'object',
    properties: { path: { type: 'string' }, count: { type: 'number' } }
  });
  assert.deepStrictEqual(r, { path: '/path/to/file' });
});

ok('多字段结构化 schema + 纯文本 -> 返回 null（不兜底 input）', () => {
  const r = proto._coerceMcpArgs('测试文本', {
    type: 'object',
    properties: {
      thought: { type: 'string' },
      thoughtNumber: { type: 'number' },
      totalThoughts: { type: 'number' },
      nextThoughtNeeded: { type: 'boolean' }
    },
    required: ['thought', 'thoughtNumber', 'totalThoughts', 'nextThoughtNeeded']
  });
  assert.strictEqual(r, null);
});

ok('schema 归一化支持 inputSchema 字段', () => {
  const schema = proto._normalizeMcpSchema({
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q']
    }
  });
  assert.deepStrictEqual(schema.required, ['q']);
  assert.ok(schema.properties.q);
});

ok('schema 归一化支持 schema 字段', () => {
  const schema = proto._normalizeMcpSchema({
    schema: { type: 'object', properties: { q: { type: 'string' } } }
  });
  assert.ok(schema.properties.q);
});

ok('示例参数生成符合 schema 类型', () => {
  const ex = proto._buildMcpParamExample({
    type: 'object',
    properties: {
      thought: { type: 'string' },
      thoughtNumber: { type: 'number' },
      nextThoughtNeeded: { type: 'boolean' }
    },
    required: ['thought', 'thoughtNumber', 'nextThoughtNeeded']
  });
  assert.strictEqual(ex.thought, '...');
  assert.strictEqual(ex.thoughtNumber, 1);
  assert.strictEqual(ex.nextThoughtNeeded, true);
});

console.log(`\n/mcp 斜杠参数测试通过 ${pass} 项。`);
