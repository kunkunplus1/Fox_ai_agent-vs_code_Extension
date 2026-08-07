'use strict';

/*
 * MCP 连接器适配器骨架测试：
 *  - 命名空间模式：远程工具以 mcp__<id>__<name> 暴露并能被路由执行
 *  - 全局开关关闭时，不加载任何远程工具
 *  - 扁平模式 + 优先级：local-first / remote-first 对同名工具的裁决
 */

const assert = require('assert');

// 在 require 业务模块前，把 'vscode' 替换成 mock（与 tokenOptimization.js 同款）
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
    ConfigurationTarget: { Global: 1 }
  }
};

const mcp = require('../src/tools/mcp');
const tools = require('../src/tools');

let pass = 0;
async function ok(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.error('  ✗ ' + name + ' -> ' + e.message); process.exitCode = 1; }
}

function reset() {
  mcp._policyOverride = undefined;
  // 清空已注册连接器（通过内部 Map 无法直接清空，靠 unregister 逐一处理）
}

// 注册一个 demo 连接器（默认命名空间模式）
function regDemo(opts) {
  return mcp.registerConnector(Object.assign({
    id: 'demo',
    transport: 'stdio',
    listTools: async () => [
      { name: 'ping', description: 'ping', parameters: { type: 'object', properties: {} }, kind: 'read' }
    ],
    callTool: async (n, a) => 'pong:' + n
  }, opts || {}));
}

(async function run() {
  // 每个用例前清空已注册连接器，避免跨用例状态污染
  function clearConnectors() {
    for (const c of mcp.getConnectors()) mcp.unregisterConnector(c.id);
  }

  /* ===== 1) 全局开关关闭：不加载远程工具 ===== */
  await ok('关闭 mcp.enabled 时 allTools 不含远程工具', async () => {
    clearConnectors();
    mcp._policyOverride = { enabled: false, priority: 'local-first' };
    regDemo();
    await mcp.refreshMcpTools();
    const names = tools.allTools().map((t) => t.name);
    assert.ok(!names.includes('mcp__demo__ping'), '不应出现 mcp__demo__ping');
    assert.strictEqual(mcp.getCachedTools().length, 0);
  });

  /* ===== 2) 开启后：命名空间工具出现并可执行 ===== */
  await ok('开启后命名空间工具进入 allTools 并能被 execute 路由', async () => {
    clearConnectors();
    mcp._policyOverride = { enabled: true, priority: 'local-first', autoInject: true };
    regDemo();
    await mcp.refreshMcpTools();
    const names = tools.allTools().map((t) => t.name);
    assert.ok(names.includes('mcp__demo__ping'), '应出现 mcp__demo__ping');

    const t = tools.getTool('mcp__demo__ping');
    assert.ok(t && t.mcp === true, 'getTool 应返回 mcp 工具描述符');
    assert.strictEqual(t.kind, 'read');

    const out = await tools.execute('mcp__demo__ping', {}, {});
    assert.strictEqual(out, 'pong:ping', 'execute 应路由到连接器 callTool');
  });

  /* ===== 3) 扁平 + local-first：本地工具遮蔽同名远程 ===== */
  await ok('扁平模式 local-first：本地同名工具优先', async () => {
    clearConnectors();
    mcp._policyOverride = { enabled: true, priority: 'local-first' };
    mcp.registerConnector({
      id: 'flat1',
      transport: 'sse',
      flat: true,
      listTools: async () => [
        { name: 'read_file', description: '远程读', parameters: { type: 'object', properties: {} }, kind: 'read' }
      ],
      callTool: async (n) => 'remote:' + n
    });
    await mcp.refreshMcpTools();

    const t = tools.getTool('read_file');
    assert.ok(t && t.mcp !== true, 'local-first 下 read_file 应为本地工具');
    assert.strictEqual(typeof t.run, 'function', '本地工具应有 run');
  });

  /* ===== 4) 扁平 + remote-first：远程覆盖本地 ===== */
  await ok('扁平模式 remote-first：远程同名工具优先', async () => {
    clearConnectors();
    mcp._policyOverride = { enabled: true, priority: 'remote-first' };
    mcp.registerConnector({
      id: 'flat2',
      transport: 'sse',
      flat: true,
      listTools: async () => [
        { name: 'read_file', description: '远程读', parameters: { type: 'object', properties: {} }, kind: 'read' }
      ],
      callTool: async (n) => 'remote:' + n
    });
    await mcp.refreshMcpTools();

    const t = tools.getTool('read_file');
    assert.ok(t && t.mcp === true, 'remote-first 下 read_file 应为远程工具');
    const out = await tools.execute('read_file', {}, {});
    assert.strictEqual(out, 'remote:read_file', '应路由到远程 callTool');
  });

  /* ===== 5) 连接器状态与注销 ===== */
  await ok('getConnectors 反映状态，unregister 生效', async () => {
    clearConnectors();
    mcp._policyOverride = { enabled: true, priority: 'local-first' };
    regDemo();
    await mcp.refreshMcpTools();
    const c = mcp.getConnectors().find((x) => x.id === 'demo');
    assert.ok(c && c.status === 'connected', 'demo 应 connected');
    mcp.unregisterConnector('demo');
    assert.ok(!mcp.getConnectors().find((x) => x.id === 'demo'), '注销后不存在');
  });

  /* ===== 6) autoInject 默认关闭：allTools 不含远程工具（仅 /mcp 显式调用） ===== */
  await ok('autoInject=false 时 allTools 不含远程工具，但 execute 仍可路由', async () => {
    clearConnectors();
    mcp._policyOverride = { enabled: true, priority: 'local-first', autoInject: false };
    regDemo();
    await mcp.refreshMcpTools();
    const names = tools.allTools().map((t) => t.name);
    assert.ok(!names.includes('mcp__demo__ping'), '默认不应在 allTools 出现 mcp 工具');
    // 显式 /mcp 调用走 getTool/resolveRemote，仍能路由到连接器
    const out = await tools.execute('mcp__demo__ping', {}, {});
    assert.strictEqual(out, 'pong:ping', 'execute 仍能路由到连接器 callTool');
  });

  /* ===== 7) /mcp 命令解析 ===== */
  await ok('/mcp 解析：server.tool + JSON 参数', async () => {
    const r = mcp.parseMcpCommand('/mcp playwright.navigate {"url":"https://x.com"}');
    assert.strictEqual(r.serverId, 'playwright');
    assert.strictEqual(r.toolName, 'navigate');
    assert.deepStrictEqual(r.args, { url: 'https://x.com' });
  });
  await ok('/mcp 解析：server tool + JSON 参数', async () => {
    const r = mcp.parseMcpCommand('/mcp filesystem read_file {"path":"/a"}');
    assert.strictEqual(r.serverId, 'filesystem');
    assert.strictEqual(r.toolName, 'read_file');
    assert.deepStrictEqual(r.args, { path: '/a' });
  });
  await ok('/mcp 解析：仅服务器 id -> help+serverId', async () => {
    const r = mcp.parseMcpCommand('/mcp playwright');
    assert.strictEqual(r.help, true);
    assert.strictEqual(r.serverId, 'playwright');
  });
  await ok('/mcp 解析：纯 /mcp 或前后空白 -> help', async () => {
    assert.strictEqual(mcp.parseMcpCommand('/mcp').help, true);
    assert.strictEqual(mcp.parseMcpCommand('   /mcp   ').help, true);
  });
  await ok('/mcp 解析：非 JSON 纯文本参数 -> 保留 argStr，args 为 null', async () => {
    const r = mcp.parseMcpCommand('/mcp a b notjson');
    assert.strictEqual(r.serverId, 'a');
    assert.strictEqual(r.toolName, 'b');
    assert.strictEqual(r.argStr, 'notjson');
    assert.strictEqual(r.args, null);
  });
  await ok('/mcp 解析：JSON 参数仍正常解析', async () => {
    const r = mcp.parseMcpCommand('/mcp a b {"x":1}');
    assert.deepStrictEqual(r.args, { x: 1 });
    assert.strictEqual(r.argStr, '{"x":1}');
  });
  await ok('/mcp 解析：缺服务器 id（以点开头）-> error', async () => {
    const r = mcp.parseMcpCommand('/mcp .tool');
    assert.ok(r.error, '应报缺少服务器 id');
  });

  console.log(`\nMCP 骨架测试通过 ${pass} 项。`);
})();

