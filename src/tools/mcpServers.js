'use strict';

/**
 * 通用 MCP 服务器连接器
 * ----------------------------------------------------------------------------
 * 让 fox-ai 能接入**任意**标准 Model Context Protocol 服务器（stdio 或 sse），
 * 无需为每个服务器写单独的代码。只需在配置 `foxAi.mcp.servers` 里加一条：
 *
 *   { "id": "filesystem", "command": "npx",
 *     "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"] }
 *
 * 或 SSE 形式：
 *   { "id": "remote", "transport": "sse", "url": "http://localhost:8000/sse" }
 *
 * 工具会以 `mcp__<id>__<toolName>` 命名空间进入智能体可用列表；同名工具天然隔离。
 * 依赖 @modelcontextprotocol/sdk（未装时注册会优雅返回 {ok:false,reason}）。
 */

const mcp = require('./mcp');
const sec = require('./mcpSecurity');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

/**
 * 把 `npx -y @scope/pkg ...` 解析成本地已装包的入口，用 node 直接执行。
 * 解决 Windows 上 `npx --prefix <dir> @scope/pkg` 无法定位 bin 的问题。
 */
function resolveNpxPackage(command, args, modulesPath) {
  if (command !== 'npx' || !Array.isArray(args) || args.length < 1) return null;
  let i = 0;
  while (i < args.length) {
    const a = String(args[i]);
    // 跳过 npx 自身选项；注意 --prefix/-p/--call/--package 这类需要额外跳过一个值
    if (a === '--prefix' || a === '-p' || a === '--call' || a === '--package') {
      i += 2;
      continue;
    }
    if (a.startsWith('-')) { i++; continue; }
    break;
  }
  if (i >= args.length) return null;
  const pkg = String(args[i]);
  // 只处理明显的 npm 包名（带 @ 作用域或含 /）；bin 名/路径交给 npx 自己处理
  if (!pkg.startsWith('@') && !pkg.includes('/')) return null;

  const candidates = [];
  if (modulesPath) candidates.push(path.join(modulesPath, 'node_modules', pkg));
  try {
    const globalRoot = cp.execSync('npm', ['root', '-g'], { encoding: 'utf8', windowsHide: true }).trim();
    candidates.push(path.join(globalRoot, pkg));
  } catch (_) {}
  candidates.push(path.join(os.homedir(), '.fox-ai', 'mcp-modules', 'node_modules', pkg));

  for (const dir of candidates) {
    const pkgJsonPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;
    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      let entry = null;
      if (pkgJson.bin) {
        if (typeof pkgJson.bin === 'string') entry = pkgJson.bin;
        else { const bins = Object.values(pkgJson.bin); if (bins.length) entry = bins[0]; }
      }
      if (!entry && pkgJson.main) entry = pkgJson.main;
      if (!entry) entry = 'index.js';
      const entryPath = path.resolve(dir, entry);
      if (fs.existsSync(entryPath)) {
        return { command: 'node', args: [entryPath, ...args.slice(i + 1)] };
      }
    } catch (_) {}
  }
  return null;
}

/**
 * 注册单个 MCP 服务器。
 * @param {Object} def { id, transport?:'stdio'|'sse', command?, args?, url?, headers?, env?, enabled?, flat? }
 * @param {Object} opts 测试注入：createClient / createTransport；以及 policy（安全策略）
 * @returns {Promise<{ok:boolean, status?:string, error?:string, reason?:string}>}
 */
async function registerGenericServer(def, opts = {}) {
  const id = def && def.id;
  if (!id) return { ok: false, reason: 'MCP 服务器缺少 id' };

  // 安全校验：命令白名单 / SSRF / 敏感环境变量（未注入 policy 时读配置）
  const policy = opts.policy || (function () {
    try {
      const vscode = require('vscode');
      const cfg = vscode.workspace.getConfiguration('foxAi').get('mcp', {}) || {};
      return {
        allowedCommands: cfg.allowedCommands || [],
        allowPrivateUrls: !!cfg.allowPrivateUrls
      };
    } catch (_) { return {}; }
  })();
  const verdict = sec.validateServerDef(def, policy);
  if (!verdict.ok) {
    return { ok: false, reason: '安全检查未通过：' + verdict.errors.join('；') };
  }

  const transport = def.transport || 'stdio';
  // 读取 modulesPath，用于把 npx 包名解析成本地入口
  let modulesPath = null;
  try {
    const vscode = require('vscode');
    modulesPath = vscode.workspace.getConfiguration('foxAi').get('mcp.modulesPath');
  } catch (_) {}
  if (!modulesPath) modulesPath = path.join(os.homedir(), '.fox-ai', 'mcp-modules');

  // 过滤敏感环境变量，避免把本机密钥泄露给子进程。
  // 信任来源：① foxAi.mcp.allowedEnv 显式白名单；② 服务器定义里用 trustedEnv 标记的 key
  //   （catalog 安装 / VS Code 导入 / UI 添加时写入，代表用户明确要传给该服务器的变量）。
  // 未标记 trustedEnv 的「手动 settings」敏感 env 会被默认剥离（符合说明书「敏感变量默认会被过滤」）。
  const trustedEnvKeys = (policy.allowedEnv || []).slice();
  if (Array.isArray(def.trustedEnv)) {
    for (const k of def.trustedEnv) {
      if (!trustedEnvKeys.some((t) => String(t).toLowerCase() === String(k).toLowerCase())) trustedEnvKeys.push(k);
    }
  }
  const env = Object.assign({}, process.env, sec.filterEnv(def.env || {}, trustedEnvKeys));

  // 未注入 mock 且 SDK 不存在 -> 优雅跳过
  if (!opts.createClient && !opts.createTransport) {
    try { mcp.loadSdk(); } catch (e) { return { ok: false, reason: e.message }; }
  }

  let client = null;
  async function ensureClient() {
    if (client) return client;
    if (opts.createClient) { client = opts.createClient(); return client; }
    const { Client, StdioClientTransport, SSEClientTransport, StreamableHTTPClientTransport } = mcp.loadSdk();
    let transportObj;
    if (transport === 'sse') {
      if (!def.url) throw new Error('sse 传输需要 url');
      const headers = def.headers || {};
      transportObj = opts.createTransport
        ? opts.createTransport()
        : new SSEClientTransport(new URL(def.url), Object.keys(headers).length ? { requestInit: { headers } } : undefined);
    } else if (transport === 'http') {
      // VS Code 的 type:"http" 服务器：Streamable HTTP（2025-03 规范）
      if (!def.url) throw new Error('http 传输需要 url');
      const headers = def.headers || {};
      if (!StreamableHTTPClientTransport) throw new Error('当前 @modelcontextprotocol/sdk 版本不支持 Streamable HTTP 传输');
      transportObj = opts.createTransport
        ? opts.createTransport()
        : new StreamableHTTPClientTransport(new URL(def.url), Object.keys(headers).length ? { requestInit: { headers } } : undefined);
    } else {
      let command = def.command || 'npx';
      let args = def.args || [];
      const resolved = resolveNpxPackage(command, args, modulesPath);
      if (resolved) { command = resolved.command; args = resolved.args; }
      transportObj = opts.createTransport
        ? opts.createTransport()
        : new StdioClientTransport({ command, args, env });
    }
    // requestTimeout 调大：抓取类 MCP（如 stealth-fetch 整页缓存需读完大页）首抓常 > 默认 60s，
    // 否则宿主会先报 -32001 Request timed out。180s 覆盖服务器 timeout(≤60s)+3 余量。
    client = new Client({ name: 'fox-ai', version: '0.2.0' }, { requestTimeout: 180000 });
    await client.connect(transportObj);
    return client;
  }

  const connector = {
    id,
    transport,
    enabled: def.enabled !== false,
    flat: def.flat === true,
    status: 'connecting',
    error: null,
    listTools: async () => {
      const c = await ensureClient();
      const res = await c.listTools();
      return (res.tools || []).map((t) => ({
        name: t.name,
        description: t.description || '',
        parameters: t.inputSchema || { type: 'object', properties: {} },
        kind: mcp.inferKind(t.name, t.description)
      }));
    },
    callTool: async (name, arguments_) => {
      const c = await ensureClient();
      const res = await c.callTool({ name, arguments: arguments_ || {} }, { timeout: 180000 });
      return mcp.formatResult(res);
    }
  };

  mcp.registerConnector(connector);

  // 立刻尝试拉起一次，暴露状态（失败也不影响扩展其余功能）
  try {
    await connector.listTools();
    connector.status = 'connected';
  } catch (e) {
    connector.status = 'error';
    connector.error = e.message;
  }
  await mcp.refreshMcpTools();
  return { ok: connector.status === 'connected', status: connector.status, error: connector.error };
}

/**
 * 批量注册多个 MCP 服务器（来自配置数组）。先清空旧连接器，再逐个注册，最后刷新缓存。
 * @param {Array} defs 服务器定义数组
 * @param {Object} opts 测试注入
 */
async function registerGenericMcpServers(defs, opts = {}) {
  // 清空已注册连接器，避免配置变更时残留/重复
  for (const c of mcp.getConnectors()) mcp.unregisterConnector(c.id);
  const results = [];
  for (const def of defs || []) {
    try {
      const r = await registerGenericServer(def, opts);
      results.push(Object.assign({ id: def.id }, r));
    } catch (e) {
      results.push({ id: def.id, ok: false, reason: e.message });
    }
  }
  await mcp.refreshMcpTools();
  return results;
}

module.exports = { registerGenericServer, registerGenericMcpServers };
