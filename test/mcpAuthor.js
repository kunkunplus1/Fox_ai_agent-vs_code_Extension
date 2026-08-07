'use strict';

/*
 * 自写 MCP 服务器测试：
 *  - buildServerSource 生成纯 Node 的 MCP stdio 脚本，node --check 通过
 *  - 生成的服务器真实跑起来后，能正确响应 initialize / tools/list / tools/call
 *  - registerUserServer 写脚本+清单，并把定义写进 foxAi.mcp.servers（mock 配置）
 *  - discoverUserMcpServers 能扫描出用户自写的服务器
 *  - （SDK 可达时）用真实 @modelcontextprotocol/sdk Client 连一遍，断言工具可调用
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

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

const mcpAuthor = require('../src/tools/mcpAuthor');
const mcp = require('../src/tools/mcp');

process.on('uncaughtException', (e) => { console.error('UNCAUGHT', (e && e.stack) || e); });
process.on('unhandledRejection', (e) => { console.error('UNHANDLED', (e && e.stack) || e); });
process.on('exit', (c) => { console.error('FINAL_EXIT code=', c, 'exitCode=', process.exitCode); });

let pass = 0;
async function ok(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.error('  ✗ ' + name + ' -> ' + e.message); process.exitCode = 1; }
}

const SAMPLE_TOOLS = [
  {
    name: 'hello',
    description: '示例：问候',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    handler: 'async (args) => { return "你好，" + (args.name || "世界"); }'
  },
  {
    name: 'add',
    description: '示例：相加',
    input_schema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
    handler: 'return String(Number(args.a) + Number(args.b));'
  }
];

function tmpDir() {
  const dir = path.join(os.tmpdir(), 'foxai-mcp-test-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 生成一个临时服务器文件并返回路径
function genServerFile(dir, id) {
  const src = mcpAuthor.buildServerSource(id, 'test server', SAMPLE_TOOLS);
  const p = path.join(dir, id + '.js');
  fs.writeFileSync(p, src, 'utf8');
  return p;
}

// 与生成的服务器做一轮 JSON-RPC 交互，返回按方法收集的响应
function speakWithServer(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, [scriptPath], { stdio: ['pipe', 'pipe', 'inherit'] });
    const responses = [];
    let buf = '';
    let sent = 0;
    // 避免子进程被 kill 时 stdin/stdout 流抛出未捕获 error 导致进程异常退出
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    const send = (obj) => { try { child.stdin.write(JSON.stringify(obj) + '\n'); sent++; } catch (_) {} };

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.result || msg.error) responses.push(msg);
        } catch (_) { /* 非 JSON 行忽略 */ }
      }
    });

    child.on('error', reject);
    // 依次发出 initialize / tools/list / tools/call
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hello', arguments: { name: '狐狸' } } });
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'add', arguments: { a: 2, b: 3 } } });

    const timer = setTimeout(() => {
      clearInterval(check);
      child.kill();
      resolve(responses);
    }, 4000);

    // 收到 4 条响应即结束
    const check = setInterval(() => {
      if (responses.length >= 4) {
        clearTimeout(timer);
        clearInterval(check);
        child.kill();
        resolve(responses);
      }
    }, 50);
  });
}

(async () => {
  // 1) 生成脚本语法正确
  await ok('buildServerSource 生成脚本可通过 node --check', () => {
    const dir = tmpDir();
    const p = genServerFile(dir, 'srv1');
    cp.execSync('"' + process.execPath + '" --check "' + p + '"', { windowsHide: true, stdio: 'pipe' });
  });

  // 2) 生成的服务器真实跑通 MCP 协议
  await ok('生成服务器正确响应 initialize/tools/list/tools/call', async () => {
    const dir = tmpDir();
    const p = genServerFile(dir, 'srv2');
    const res = await speakWithServer(p);
    assert.strictEqual(res.length, 4, '应收到 4 条响应，实际 ' + res.length);

    const init = res.find((r) => r.id === 1);
    assert.ok(init && init.result && init.result.serverInfo && init.result.serverInfo.name === 'srv2', 'initialize 返回 serverInfo.name=srv2');
    assert.ok(init.result.capabilities && init.result.capabilities.tools, 'initialize 声明 tools 能力');

    const list = res.find((r) => r.id === 2);
    assert.ok(list && list.result && Array.isArray(list.result.tools), 'tools/list 返回 tools 数组');
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepStrictEqual(names, ['add', 'hello'], '工具名应为 add/hello');
    assert.ok(list.result.tools.every((t) => t.inputSchema), '每个工具都有 inputSchema');

    const call1 = res.find((r) => r.id === 3);
    assert.ok(call1.result && call1.result.content && call1.result.content[0].text === '你好，狐狸', 'hello 工具返回正确文本');

    const call2 = res.find((r) => r.id === 4);
    assert.ok(call2.result && call2.result.content && call2.result.content[0].text === '5', 'add 工具返回 5');
  });

  // 3) registerUserServer 写文件 + 写配置（mock cfg）
  await ok('registerUserServer 写脚本/清单并写入 foxAi.mcp.servers', async () => {
    const dir = tmpDir();
    let updated = null;
    const cfg = {
      get: (k, d) => (k === 'mcp.servers' ? (updated && updated.servers) || [] : d),
      update: async (k, v) => { if (k === 'mcp.servers') updated = { servers: v }; }
    };
    const res = await mcpAuthor.registerUserServer({
      cfg,
      name: 'my-srv',
      description: '我的服务器',
      tools: SAMPLE_TOOLS,
      baseDir: dir
    });
    assert.ok(res.ok, 'registerUserServer 应成功：' + (res.error || ''));
    assert.ok(fs.existsSync(res.path), '脚本应已写出：' + res.path);
    assert.ok(fs.existsSync(res.manifest), '清单应已写出：' + res.manifest);
    cp.execSync('"' + process.execPath + '" --check "' + res.path + '"', { windowsHide: true, stdio: 'pipe' });
    assert.ok(updated && Array.isArray(updated.servers), '应调用 cfg.update 写入 mcp.servers');
    const def = updated.servers.find((s) => s.id === 'my-srv');
    assert.ok(def, '配置中应包含 my-srv');
    assert.strictEqual(def.transport, 'stdio');
    assert.strictEqual(def.command, process.execPath);
    assert.deepStrictEqual(def.args, [res.path]);
    // 清单内容正确
    const man = JSON.parse(fs.readFileSync(res.manifest, 'utf8'));
    assert.strictEqual(man.id, 'my-srv');
    assert.strictEqual(man.script, res.path);
  });

  // 4) discoverUserMcpServers 扫描发现
  await ok('discoverUserMcpServers 扫描出用户自写服务器', async () => {
    const dir = tmpDir();
    // 先登记一个
    await mcpAuthor.registerUserServer({ name: 'disc-srv', description: 'd', tools: SAMPLE_TOOLS, baseDir: dir });
    const found = mcpAuthor.discoverUserMcpServers(dir);
    const hit = found.find((s) => s.id === 'disc-srv');
    assert.ok(hit, '应能发现 disc-srv');
    assert.strictEqual(hit.transport, 'stdio');
    assert.strictEqual(hit.source, 'user-mcp');
    assert.ok(fs.existsSync(hit.args[0]), '发现的脚本路径应存在');
  });

  // 5) （SDK 可达时）用真实 @modelcontextprotocol/sdk Client 连一遍（用完显式关闭，避免遗留子进程）
  let sdkAvailable = true;
  let sdk;
  try { sdk = mcp.loadSdk(); } catch (e) { sdkAvailable = false; }
  await ok('真实 SDK Client 连接自写服务器并调用工具' + (sdkAvailable ? '' : '（SKIP: SDK 不可达）'), async () => {
    if (!sdkAvailable) { console.log('    · SDK 在测试环境不可达，跳过真实连接（不影响结论）'); return; }
    const dir = tmpDir();
    const p = genServerFile(dir, 'sdk-srv');
    const { Client, StdioClientTransport } = sdk;
    const transport = new StdioClientTransport({ command: process.execPath, args: [p], env: process.env });
    const client = new Client({ name: 'fox-ai', version: '0.2.0' });
    await client.connect(transport);
    try {
      const list = await client.listTools();
      const names = (list.tools || []).map((t) => t.name).sort();
      assert.deepStrictEqual(names, ['add', 'hello'], 'Client 看到的工具应为 add/hello');
      assert.ok(list.tools.every((t) => t.inputSchema), '每个工具都应有 inputSchema');
      const res = await client.callTool({ name: 'hello', arguments: { name: '狐狸' } });
      const text = mcp.formatResult(res);
      assert.ok(String(text).includes('你好，狐狸'), 'callTool 返回应包含问候：' + text);
    } finally {
      await client.close();
    }
  });

  console.log('\nmcpAuthor 测试通过：' + pass);
  process.exit(process.exitCode || 0);
})();
