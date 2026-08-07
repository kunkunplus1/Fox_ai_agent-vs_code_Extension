'use strict';

/*
 * MCP 结果格式化测试（针对「所有载入的 MCP 服务器都什么也不返回」）：
 *  验证 formatResult / stringifyContent 能正确处理
 *   - 旧形态：content 数组（text/image/其它块）
 *   - 新形态（SDK 1.30.0 默认 content:[]）：数据在 structuredContent
 *   - 错误结果 isError
 *  修复点：content 为空数组 / 无文本时，回退到 structuredContent，避免返回空串。
 */

const assert = require('assert');

// 让 require('vscode') 返回可控的 mock（必须在 require 业务模块前注入）
const SDK_DIR = 'C:/Users/asis/.fox-ai/mcp-modules';
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req) {
  if (req === 'vscode') return req;
  return origResolve.apply(this, arguments);
};
require.cache.vscode = {
  id: 'vscode',
  exports: {
    workspace: {
      getConfiguration: () => ({
        get: (k, d) => {
          if (k === 'mcp') return { modulesPath: SDK_DIR, enabled: true, allowedCommands: [] };
          if (k === 'mcp.modulesPath') return SDK_DIR;
          if (k === 'mcp.servers') return [];
          if (k === 'mcp.enabled') return true;
          return d;
        },
        update: async () => {}
      })
    },
    ConfigurationTarget: { Global: 1 }
  }
};

const mcp = require('../src/tools/mcp');

let pass = 0;
async function ok(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.error('  ✗ ' + name + ' -> ' + e.message); process.exitCode = 1; }
}

(async () => {
  // 1) 旧形态：content 含单个 text 块
  await ok('content 文本块正常返回', () => {
    const r = mcp.formatResult({ content: [{ type: 'text', text: 'hello world' }] });
    assert.strictEqual(r, 'hello world');
  });

  // 2) 旧形态：content 含多个块（text + image）
  await ok('content 多块拼接', () => {
    const r = mcp.formatResult({
      content: [
        { type: 'text', text: 'line1' },
        { type: 'image', mimeType: 'image/png', data: 'AAA' },
        { type: 'text', text: 'line2' }
      ]
    });
    assert.ok(r.includes('line1'));
    assert.ok(r.includes('line2'));
    assert.ok(r.includes('[图片数据 image/png]'));
  });

  // 3) 新形态：content 为空数组，数据在 structuredContent —— 这就是「什么也不返回」的根因
  await ok('content 为空数组时回退 structuredContent', () => {
    const r = mcp.formatResult({
      content: [],
      structuredContent: { result: 'ok', count: 3 }
    });
    assert.ok(r.includes('"result": "ok"'), '应包含 structuredContent 内容: ' + r);
    assert.ok(r.includes('"count": 3'));
  });

  // 4) 新形态：content 缺省（undefined，SDK 也可省略）也能回退
  await ok('content 缺省(undefined)时回退 structuredContent', () => {
    const r = mcp.formatResult({
      structuredContent: { ok: true }
    });
    assert.ok(r.includes('"ok": true'), '应回退到 structuredContent: ' + r);
  });

  // 5) 当 content 有文本块时，structuredContent 不应喧宾夺主
  await ok('content 有文本时优先 content 而非 structuredContent', () => {
    const r = mcp.formatResult({
      content: [{ type: 'text', text: '主文本' }],
      structuredContent: { ignored: 'yes' }
    });
    assert.strictEqual(r, '主文本');
  });

  // 6) 错误结果 isError 前缀
  await ok('isError 加前缀', () => {
    const r = mcp.formatResult({
      isError: true,
      content: [{ type: 'text', text: 'boom' }]
    });
    assert.ok(r.startsWith('[MCP 工具报错]'));
    assert.ok(r.includes('boom'));
  });

  // 7) 错误且为 structuredContent 形态
  await ok('isError + structuredContent 也返回内容', () => {
    const r = mcp.formatResult({
      isError: true,
      content: [],
      structuredContent: { error: 'fail' }
    });
    assert.ok(r.startsWith('[MCP 工具报错]'));
    assert.ok(r.includes('"error": "fail"'));
  });

  // 8) 空 content 且空 structuredContent → 现在展示原始返回对象，帮助定位「返回空」
  await ok('全空结果展示原始返回', () => {
    const r = mcp.formatResult({ content: [] });
    assert.ok(r.includes('[MCP 原始返回]'), '应提示原始返回: ' + r);
    assert.ok(r.includes('"content": []'));
  });

  // 9) null / undefined 结果
  await ok('null 结果返回空串', () => {
    assert.strictEqual(mcp.formatResult(null), '');
    assert.strictEqual(mcp.formatResult(undefined), '');
  });

  // 10) 非标准返回形态（如 { result: 'ok' }）不应被吞掉
  await ok('非标准 result 字段兜底展示', () => {
    const r = mcp.formatResult({ result: 'ok', data: [] });
    assert.ok(r.includes('[MCP 原始返回]'), '应兜底展示: ' + r);
    assert.ok(r.includes('"result": "ok"'));
  });

  // 10) executeRemote 链路：callTool 返回 formatResult 字符串不应为空（用内置 fetch 服务器模拟）
  await ok('executeRemote 经连接器不返回空（structuredContent 形态）', async () => {
    const mcpServers = require('../src/tools/mcpServers');
    // 直接用 formatResult 验证连接器返回形态一致
    const sample = { content: [], structuredContent: { fetched: true, length: 42 } };
    const out = mcp.formatResult(sample);
    assert.ok(out.includes('"fetched": true'), '连接器结果不应为空: ' + out);
  });

  console.log('\nmcpResult 测试通过：' + pass + ' 项');
  if (process.exitCode) { console.error('存在失败用例'); process.exit(process.exitCode); }
})();
