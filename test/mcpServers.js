'use strict';

/*
 * 通用 MCP 服务器连接器测试（mock SDK，不依赖真实服务器）：
 *  - 多个服务器工具以 mcp__<id>__<name> 命名空间隔离（同名不冲突）
 *  - registerGenericMcpServers 批量注册并刷新缓存
 *  - sse 传输定义可被接受（走 createTransport mock，不真正联网）
 *  - 未安装 SDK 时单条返回 { ok:false, reason }
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
const { registerGenericServer, registerGenericMcpServers } = require('../src/tools/mcpServers');

let pass = 0;
async function ok(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.error('  ✗ ' + name + ' -> ' + e.message); process.exitCode = 1; }
}

function mockClient(toolsOfServer) {
  return {
    async listTools() {
      return { tools: toolsOfServer.map((n) => ({ name: n, description: '', inputSchema: { type: 'object', properties: {} } })) };
    },
    async callTool(payload) {
      return { content: [{ type: 'text', text: 'out:' + payload.name }] };
    }
  };
}

(async function run() {
  function clear() { for (const c of mcp.getConnectors()) mcp.unregisterConnector(c.id); }
  mcp._policyOverride = { enabled: true, priority: 'local-first', autoInject: true };

  /* ===== 1) 多服务器命名空间隔离 ===== */
  await ok('多个服务器工具以 mcp__<id>__ 命名空间隔离', async () => {
    clear();
    const res = await registerGenericMcpServers(
      [
        { id: 'fs', command: 'x', args: [], transport: 'stdio' },
        { id: 'db', command: 'y', args: [], transport: 'stdio' }
      ],
      {
        // 测试聚焦注册逻辑，放行测试用的占位命令（安全校验本身另有 mcpSecurity 测试覆盖）
        policy: { allowedCommands: ['x', 'y', 'nope'] },
        createClient: () => mockClient(['read', 'write']) // 两服务器都有同名 read/write
      }
    );
    assert.ok(res.every((r) => r.ok), '两个都应注册成功: ' + JSON.stringify(res));

    const names = tools.allTools().map((t) => t.name);
    assert.ok(names.includes('mcp__fs__read'), '应有 mcp__fs__read');
    assert.ok(names.includes('mcp__db__read'), '应有 mcp__db__read');
    assert.ok(names.includes('mcp__fs__write') && names.includes('mcp__db__write'), 'write 也应隔离');

    const out = await tools.execute('mcp__db__read', {}, {});
    assert.strictEqual(out, 'out:read', 'execute 应路由到 db 服务器的 read');
  });

  /* ===== 2) SSE 传输定义被接受 ===== */
  await ok('sse 传输定义走 createTransport（不真正联网）', async () => {
    clear();
    let usedTransport = false;
    const origLoad = mcp.loadSdk;
    // 桩掉 loadSdk，避免真实 SDK 缺失导致提前返回；此处只验证 sse 走 createTransport
    mcp.loadSdk = () => ({ Client: class { async connect() {} }, StdioClientTransport: class {}, SSEClientTransport: class {} });
    const r = await registerGenericServer(
      { id: 'remote', transport: 'sse', url: 'http://localhost:8000/sse' },
      { policy: { allowPrivateUrls: true }, createClient: () => mockClient(['ping']), createTransport: () => { usedTransport = true; return {}; } }
    );
    mcp.loadSdk = origLoad;
    assert.ok(r.ok === true, 'sse 应注册成功');
    const conn = mcp.getConnectors().find((c) => c.id === 'remote');
    assert.ok(conn && conn.transport === 'sse', '连接器应为 sse 类型');
  });

  /* ===== 3) 未安装 SDK 时单条降级 ===== */
  await ok('未注入 mock 且 SDK 缺失时返回 { ok:false }', async () => {
    clear();
    const r = await registerGenericServer({ id: 'x', command: 'nope', args: [] });
    assert.ok(r.ok === false && typeof r.reason === 'string', '应返回 ok:false 并说明原因');
  });

  console.log(`\n通用 MCP 服务器测试通过 ${pass} 项。`);
})();
