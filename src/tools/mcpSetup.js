'use strict';

/**
 * MCP 服务器配置应用（startup 与 UI 共用）
 * ----------------------------------------------------------------------------
 * 读取 foxAi.mcp.* 配置，拼接服务器列表（含 Playwright 快捷开关），
 * 调用 mcpServers.registerGenericMcpServers 完成注册 + 安全校验 + 缓存刷新。
 * 另外支持「发现并接入 VS Code 自身已配置的 MCP 服务器」：
 *   - 工作区 .vscode/mcp.json
 *   - 用户级 mcp.json（位于 VS Code user data 目录）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const mcpServers = require('./mcpServers');
const mcpAuthor = require('./mcpAuthor'); // 自写 MCP 服务器自动发现

/** 读取 foxAi.mcp 配置（非扩展环境返回空对象） */
function getMcpConfig() {
  try {
    const vscode = require('vscode');
    return vscode.workspace.getConfiguration('foxAi').get('mcp', {}) || {};
  } catch (_) {
    return {};
  }
}

/** 默认 MCP 依赖安装目录 */
function defaultModulesPath() {
  return path.join(os.homedir(), '.fox-ai', 'mcp-modules');
}

/** 依据配置拼出最终服务器列表（含 Playwright 快捷追加） */
function buildServers(cfg) {
  const servers = Array.isArray(cfg.servers) ? cfg.servers.slice() : [];
  if (cfg.playwright && cfg.playwright.enabled && !servers.some((s) => s && s.id === 'playwright')) {
    // 优先使用本地安装的 @playwright/mcp（与 setup-mcp.js 安装位置一致），避免全局 npm 路径混乱
    const modulesPath = cfg.modulesPath || defaultModulesPath();
    const localPw = fs.existsSync(path.join(modulesPath, 'node_modules', '@playwright', 'mcp', 'package.json'));
    if (localPw) {
      servers.push({ id: 'playwright', transport: 'stdio', command: 'npx', args: ['--prefix', modulesPath, '-y', '@playwright/mcp'] });
    } else {
      servers.push({ id: 'playwright', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp'] });
    }
  }
  // 历史遗留纠正：0.6.3/0.6.4 在扩展宿主里误把 Code.exe 当作启动命令写入配置，
  // 会被安全检查（启动命令白名单）拒绝。这里把明显是 Code/Electron 的命令纠正为真正的 node。
  const nodeCmd = mcpAuthor.resolveNodeCommand();
  for (const s of servers) {
    if (!s || s.transport === 'sse' || s.transport === 'http' || !s.command) continue;
    const b = String(s.command).trim().split(/[\s/\\]+/).pop().replace(/\.(exe|cmd|bat|ps1|sh|com)$/i, '').toLowerCase();
    if (b === 'code' || b === 'electron') s.command = nodeCmd;
  }
  return servers;
}

/** 由配置构造安全策略 */
function buildPolicy(cfg) {
  return {
    allowedCommands: cfg.allowedCommands || [],
    allowPrivateUrls: !!cfg.allowPrivateUrls,
    allowedEnv: cfg.allowedEnv || []
  };
}

/**
 * 应用配置里的全部 MCP 服务器。
 * @param {Object} [opts] { config?, policy?, createClient?, createTransport? }
 * @returns {Promise<Array>} 各服务器注册结果
 */
async function applyConfiguredServers(opts = {}) {
  const cfg = opts.config || getMcpConfig();
  if (!cfg.enabled) {
    // 总开关关闭：清空所有连接器，保持与开关语义一致
    await mcpServers.registerGenericMcpServers([], opts);
    return [];
  }
  const servers = buildServers(cfg);
  const policy = opts.policy || buildPolicy(cfg);
  // 自动发现用户自写的 MCP 服务器（~/.fox-ai/mcp-servers），按 id 去重合并，
  // 使 agent 自己写的服务器在扩展启动/重载时无需手动操作即被识别加载。
  try {
    const discovered = mcpAuthor.discoverUserMcpServers();
    for (const s of discovered) {
      if (!servers.some((x) => x && x.id === s.id)) servers.push(s);
    }
  } catch (_) { /* 发现失败不影响其余服务器 */ }
  return mcpServers.registerGenericMcpServers(servers, Object.assign({ policy }, opts));
}

module.exports = { getMcpConfig, buildServers, buildPolicy, applyConfiguredServers, discoverVSCodeServers, normalizeVSCodeServer, getKnownVSCodeMcpPaths, syncVSCodeServers, removeFromVSCodeMcpJson };

/* ============ VS Code 自带 MCP 配置发现 ============ */

/** 返回可能的「用户级 mcp.json」路径（VS Code user data 目录） */
function getUserMcpJsonPaths() {
  const paths = [];
  const appData = process.env.APPDATA;
  if (appData) {
    paths.push(path.join(appData, 'Code', 'User', 'mcp.json'));
    paths.push(path.join(appData, 'Code - Insiders', 'User', 'mcp.json'));
  }
  if (process.env.VSCODE_APPDATA) {
    paths.push(path.join(process.env.VSCODE_APPDATA, 'User', 'mcp.json'));
  }
  return paths;
}

/**
 * 把 VS Code 的一条服务器定义归一化为 fox-ai 的服务器定义。
 * VS Code 用 `type`（http/sse/stdio），fox-ai 用 `transport`；做一层映射。
 * @returns {Object|null}
 */
/**
 * 展开 VS Code mcp.json 里的变量占位符：
 *   ${workspaceFolder} -> 当前工作区根目录
 *   ${env:NAME}        -> 系统环境变量 NAME 的值
 * 不展开则这些占位符里的 { } 会触发 shell 元字符校验被拒绝，且引用系统变量的 env 不会生效。
 */
function expandVSCodeVars(str) {
  if (typeof str !== 'string') return str;
  let ws = '';
  try {
    const vscode = require('vscode');
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders[0]) ws = folders[0].uri.fsPath;
  } catch (_) { /* 非扩展环境：留空 */ }
  return str
    .replace(/\$\{workspaceFolder\}/g, ws)
    .replace(/\$\{env:([^}]+)\}/g, (_m, n) => process.env[n] || '');
}

function normalizeVSCodeServer(name, def, sourceFile) {
  if (!def || typeof def !== 'object') return null;
  const type = String(def.type || (def.command ? 'stdio' : 'http')).toLowerCase();
  const out = { id: 'vscode:' + name, source: 'vscode', label: name, transport: type, sourceFile: sourceFile || null, sourceName: name };
  if (type === 'stdio') {
    out.command = expandVSCodeVars(def.command || 'npx');
    out.args = Array.isArray(def.args) ? def.args.map(expandVSCodeVars) : (def.args ? [String(def.args)] : []);
    if (def.env && typeof def.env === 'object') {
      const env = {};
      for (const k of Object.keys(def.env)) env[k] = expandVSCodeVars(def.env[k]);
      out.env = env;
      out.trustedEnv = Object.keys(env); // VS Code 配置里显式写的 env 视为已授权，信任传入
    }
  } else if (type === 'sse' || type === 'http') {
    out.url = expandVSCodeVars(def.url || '');
    if (def.headers && typeof def.headers === 'object') out.headers = def.headers;
    if (!out.url) return null; // http/sse 必须有 url
  } else {
    return null; // 不认识的传输类型
  }
  return out;
}

/**
 * 发现 VS Code 已配置的全部 MCP 服务器（工作区 + 用户级）。
 * @returns {Array} fox-ai 服务器定义数组（去重，id 前缀 vscode:）
 */
function discoverVSCodeServers() {
  const found = [];
  const seen = new Set();
  const add = (s) => { if (s && !seen.has(s.id)) { seen.add(s.id); found.push(s); } };

  // 1) 工作区 .vscode/mcp.json
  try {
    const vscode = require('vscode');
    const folders = vscode.workspace.workspaceFolders || [];
    for (const f of folders) {
      const p = path.join(f.uri.fsPath, '.vscode', 'mcp.json');
      try {
        if (fs.existsSync(p)) {
          const json = JSON.parse(fs.readFileSync(p, 'utf8'));
          const servers = json && json.servers;
          if (servers && typeof servers === 'object') {
            for (const name of Object.keys(servers)) add(normalizeVSCodeServer(name, servers[name], p));
          }
        }
      } catch (_) { /* 解析失败忽略该文件 */ }
    }
  } catch (_) { /* 非扩展环境忽略 */ }

  // 2) 用户级 mcp.json
  for (const p of getUserMcpJsonPaths()) {
    try {
      if (fs.existsSync(p)) {
        const json = JSON.parse(fs.readFileSync(p, 'utf8'));
        const servers = json && json.servers;
        if (servers && typeof servers === 'object') {
          for (const name of Object.keys(servers)) add(normalizeVSCodeServer(name, servers[name], p));
        }
      }
    } catch (_) { /* 解析失败忽略 */ }
  }

  return found;
}

/**
 * 返回所有「已知」的 VS Code mcp.json 路径（用于写入/删除时的越界防护）。
 * 包含：用户级路径 + 当前工作区的 .vscode/mcp.json。
 */
function getKnownVSCodeMcpPaths() {
  const paths = (getUserMcpJsonPaths() || []).slice();
  try {
    const vscode = require('vscode');
    for (const f of (vscode.workspace.workspaceFolders || [])) {
      paths.push(path.join(f.uri.fsPath, '.vscode', 'mcp.json'));
    }
  } catch (_) { /* 非扩展环境忽略 */ }
  return paths;
}

/**
 * 把 VS Code 原生 mcp.json 里配置的服务器「自动导入并接入」狐狸 AI。
 * 对于 VS Code 有、而 foxAi.mcp.servers 里没有对应条目的服务器，自动创建一份
 * （标记 importedFromVSCode + sourceFile/sourceName），让狐狸 AI 接管（spawn 自己的实例、
 * 智能体可调用、可在面板管理）。已存在的（用户手动或非 imported）不会覆盖。
 * @param {object} cfg vscode.WorkspaceConfiguration（针对 'foxAi' 命名空间）
 * @param {object} opts { autoImport: boolean }
 * @returns {{ imported: boolean, servers: Array, vscode: Array }}
 */
function syncVSCodeServers(cfg, opts) {
  const autoImport = !opts || opts.autoImport !== false;
  const vsServers = discoverVSCodeServers();
  const foxServers = (cfg.get('mcp.servers', []) || []).slice();
  if (!autoImport) return { imported: false, servers: foxServers, vscode: vsServers };
  let changed = false;
  const existingIds = new Set(foxServers.map((s) => s && s.id));
  const importedKeys = new Set(
    foxServers.filter((s) => s && s.importedFromVSCode)
      .map((s) => (s.sourceFile || '') + '#' + (s.sourceName || ''))
  );
  for (const vs of vsServers) {
    const key = (vs.sourceFile || '') + '#' + (vs.sourceName || '');
    if (existingIds.has(vs.sourceName)) continue; // 已有同名条目（用户手动或非 imported），不覆盖
    if (importedKeys.has(key)) continue;          // 已导入过，不重复
    const def = {
      id: vs.sourceName,
      transport: vs.transport,
      command: vs.command,
      args: vs.args,
      env: vs.env,
      trustedEnv: vs.trustedEnv,
      url: vs.url,
      headers: vs.headers,
      enabled: true,
      importedFromVSCode: true,
      sourceName: vs.sourceName,
      sourceFile: vs.sourceFile
    };
    foxServers.push(def);
    existingIds.add(def.id);
    importedKeys.add(key);
    changed = true;
  }
  if (changed) {
    try {
      const vscode = require('vscode');
      cfg.update('mcp.servers', foxServers, vscode.ConfigurationTarget.Global);
    } catch (_) { /* 写回失败不影响展示 */ }
  }
  return { imported: changed, servers: foxServers, vscode: vsServers };
}

/**
 * 从 VS Code 的 mcp.json 删除一条服务器（联动删除用）。
 * 仅允许写入 getKnownVSCodeMcpPaths() 内的文件，写回前自动备份为 <file>.foxbak。
 * @param {string} sourceFile mcp.json 路径
 * @param {string} sourceName VS Code 里的服务器名（servers 对象的 key）
 * @param {string[]} [allowedPaths] 测试可注入允许列表
 * @returns {boolean} 是否成功删除
 */
function removeFromVSCodeMcpJson(sourceFile, sourceName, allowedPaths) {
  if (!sourceFile || !sourceName) return false;
  const allowed = new Set(allowedPaths && allowedPaths.length ? allowedPaths : getKnownVSCodeMcpPaths());
  if (!allowed.has(sourceFile)) return false;        // 越界防护：只允许已知 mcp.json
  if (!fs.existsSync(sourceFile)) return false;
  let json;
  try { json = JSON.parse(fs.readFileSync(sourceFile, 'utf8')); } catch (e) { return false; }
  const servers = json && json.servers;
  if (!servers || typeof servers !== 'object' || !(sourceName in servers)) return false;
  delete servers[sourceName];
  try { fs.copyFileSync(sourceFile, sourceFile + '.foxbak'); } catch (_) { /* 备份失败不阻断主流程 */ }
  try { fs.writeFileSync(sourceFile, JSON.stringify(json, null, 2), 'utf8'); } catch (e) { return false; }
  return true;
}
