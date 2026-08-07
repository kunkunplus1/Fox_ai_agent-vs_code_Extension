'use strict';

/*
 * Playwright MCP 连接器测试（用 mock SDK，不依赖真实 Playwright）：
 *  - 注册后命名空间工具 mcp__playwright__* 进入 allTools 并可被 execute 路由
 *  - callTool 结果被格式化（content[].text 拼接）
 *  - mapKind 对只读/写操作归类正确
 *  - 未安装 SDK 时优雅返回 { ok:false, reason }
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
  exports: { workspace: { getConfiguration: () => ({ get: () => null }) }, ConfigurationTarget: { Global: 1 } }
};

const mcp = require('../src/tools/mcp');
const tools = require('../src/tools');
const pw = require('../src/tools/playwrightConnector');

let pass = 0;
async function ok(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.error('  ✗ ' + name + ' -> ' + e.message); process.exitCode = 1; }
}

function mockClient() {
  const calls = [];
  return {
    _calls: calls,
    async listTools() {
      return {
        tools: [
          { name: 'browser_snapshot', description: 'accessibility snapshot', inputSchema: { type: 'object', properties: {} } },
          { name: 'browser_click', description: 'click an element', inputSchema: { type: 'object', properties: {} } },
          { name: 'browser_navigate', description: 'navigate to url', inputSchema: { type: 'object', properties: {} } }
        ]
      };
    },
    async callTool(payload) {
      calls.push(payload);
      return { content: [{ type: 'text', text: 'out:' + payload.name }] };
    }
  };
}

(async function run() {
  function clear() { for (const c of mcp.getConnectors()) mcp.unregisterConnector(c.id); }

  /* ===== 1) 注册后命名空间工具出现并可执行 ===== */
  await ok('Playwright 工具以 mcp__playwright__* 暴露并可被 execute 路由', async () => {
    clear();
    mcp._policyOverride = { enabled: true, priority: 'local-first' };
    const res = await pw.registerPlaywrightConnector({ createClient: mockClient });
    assert.ok(res.ok === true, '应注册成功: ' + JSON.stringify(res));

    const names = tools.allTools().map((t) => t.name);
    assert.ok(names.includes('mcp__playwright__browser_snapshot'), '应出现 mcp__playwright__browser_snapshot');
    assert.ok(names.includes('mcp__playwright__browser_click'), '应出现 mcp__playwright__browser_click');

    const out = await tools.execute('mcp__playwright__browser_snapshot', {}, {});
    assert.strictEqual(out, 'out:browser_snapshot', 'execute 应路由到 Playwright 连接器');
  });

  /* ===== 2) callTool 透传参数 ===== */
  await ok('callTool 透传 arguments 给底层客户端', async () => {
    clear();
    mcp._policyOverride = { enabled: true, priority: 'local-first' };
    const client = mockClient();
    await pw.registerPlaywrightConnector({ createClient: () => client });
    await tools.execute('mcp__playwright__browser_click', { element: '#a' }, {});
    assert.strictEqual(client._calls.length, 1, '底层应被调用一次');
    assert.deepStrictEqual(client._calls[0], { name: 'browser_click', arguments: { element: '#a' } });
  });

  /* ===== 3) mapKind 归类 ===== */
  await ok('mapKind 对快照/点击/导航归类正确', () => {
    assert.strictEqual(pw.mapKind('browser_snapshot'), 'read', 'snapshot 应为 read');
    assert.strictEqual(pw.mapKind('browser_click'), 'edit', 'click 应为 edit');
    assert.strictEqual(pw.mapKind('browser_navigate'), 'edit', 'navigate 应为 edit');
  });

  /* ===== 4) 未安装 SDK 时优雅降级 ===== */
  await ok('未注入 mock 且 SDK 缺失时返回 { ok:false }', async () => {
    clear();
    // 不传 createClient，且 @modelcontextprotocol/sdk 未安装 -> loadSdk 抛错
    const res = await pw.registerPlaywrightConnector();
    assert.ok(res.ok === false, '应返回 ok:false');
    assert.ok(typeof res.reason === 'string' && res.reason.length > 0, '应给出原因');
  });

  console.log(`\nPlaywright 连接器测试通过 ${pass} 项。`);
})();
