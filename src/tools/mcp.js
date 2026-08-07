'use strict';

/**
 * MCP 连接器适配器骨架
 * ----------------------------------------------------------------------------
 * 目的：让 fox-ai 在保留本地 CLI 工具（read/edit/exec）的同时，能够接入
 *       Model Context Protocol (MCP) 服务器暴露的远程工具。
 *
 * 当前状态：纯骨架。本地 TOOLS 仍是主来源；MCP 工具默认处于「未启用」状态，
 *          不会出现在工具列表里，也不会参与调用。真实接入时只需：
 *            1) 安装 @modelcontextprotocol/sdk；
 *            2) 在下方 registerConnector() 里把 listTools / callTool 接到
 *               真实的 MCP Client（stdio / sse / websocket 等传输）；
 *            3) 在设置里打开 foxAi.mcp.enabled。
 *
 * 命名与优先级：
 *   - 默认「命名空间模式」：远程工具以 `mcp__<connectorId>__<toolName>` 暴露，
 *     与本地工具天然隔离，不可能重名，故不存在优先级之争。
 *   - 可选「扁平模式」：连接器声明 flat:true 时，远程工具以原名暴露；
 *     若与本地工具同名，按 foxAi.mcp.priority（local-first / remote-first）裁决。
 *     默认 local-first —— 即「CLI（本地）优先，MCP 兜底」，与你之前的理解一致。
 */

const CONNECTORS = new Map(); // id -> connector 运行时对象
let CACHED_TOOLS = []; // 已合并、供同步接口读取的远程工具快照

const fs = require('fs');
const path = require('path');
const os = require('os');

/** 写一条调试日志到 ~/.fox-ai/logs/mcp-<name>.log，失败静默忽略（避免污染 stdout） */
function writeMcpLog(name, lines) {
  try {
    const dir = path.join(os.homedir(), '.fox-ai', 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'mcp-' + name + '.log');
    const prefix = new Date().toISOString() + ' [pid:' + process.pid + '] ';
    const text = (Array.isArray(lines) ? lines : [String(lines)])
      .map((l) => prefix + (typeof l === 'string' ? l : JSON.stringify(l)))
      .join('\n') + '\n';
    fs.writeFileSync(file, text, { flag: 'a' });
  } catch (_) { /* 日志写入失败不得影响主流程 */ }
}

const DEFAULT_POLICY = {
  enabled: false, // 总开关，默认关闭
  priority: 'local-first', // 扁平模式下同名冲突裁决：local-first | remote-first
  autoInject: false // 是否把 MCP 工具自动注入模型工具列表。false = 仅允许用 /mcp 斜杠命令显式调用
};

function getPolicy() {
  // 测试钩子：允许在 node 环境覆盖策略（生产环境始终为 undefined）
  if (module.exports._policyOverride) return Object.assign({}, DEFAULT_POLICY, module.exports._policyOverride);
  let cfg = {};
  try {
    // vscode 在扩展运行时存在；纯 node 测试里 require 会抛错，忽略即可
    const vscode = require('vscode');
    cfg = vscode.workspace.getConfiguration('foxAi').get('mcp', {}) || {};
  } catch (_) {
    /* 测试/非扩展环境 */
  }
  return Object.assign({}, DEFAULT_POLICY, cfg);
}

/** 把 MCP 的 tool 声明映射为本地 kind，供审批策略/UI 使用 */
function mapKind(kind) {
  if (kind === 'destructive' || kind === 'write') return 'edit';
  if (kind === 'exec') return 'exec';
  return 'read';
}

/**
 * 注册一个 MCP 连接器。
 * @param {Object} connector
 *   id:        唯一标识（用于命名空间）
 *   transport: 'stdio' | 'sse' | 'websocket'（仅作元信息，真实传输由 callTool 实现）
 *   enabled:   是否启用该连接器（默认 true，受全局 enabled 开关约束）
 *   flat:      是否以原名扁平暴露（默认 false -> 命名空间模式）
 *   listTools: async () => [{ name, description, parameters, kind }]
 *   callTool:  async (toolName, args) => string | object
 */
function registerConnector(connector) {
  if (!connector || !connector.id) throw new Error('MCP 连接器缺少 id');
  if (typeof connector.listTools !== 'function') throw new Error('MCP 连接器缺少 listTools');
  if (typeof connector.callTool !== 'function') throw new Error('MCP 连接器缺少 callTool');
  CONNECTORS.set(connector.id, {
    id: connector.id,
    transport: connector.transport || 'stdio',
    enabled: connector.enabled !== false,
    flat: connector.flat === true,
    status: 'registered',
    error: null,
    listTools: connector.listTools,
    callTool: connector.callTool,
    _tools: null
  });
  CACHED_TOOLS = []; // 注册变更后使缓存失效
  return CONNECTORS.get(connector.id);
}

function unregisterConnector(id) {
  const ok = CONNECTORS.delete(id);
  CACHED_TOOLS = [];
  return ok;
}

function getConnectors() {
  return Array.from(CONNECTORS.values()).map((c) => ({
    id: c.id,
    transport: c.transport,
    enabled: c.enabled,
    flat: c.flat,
    status: c.status,
    error: c.error,
    toolCount: c._tools ? c._tools.length : 0
  }));
}

/**
 * 拉取所有已启用连接器的工具并刷新缓存。建议在会话启动时 / 连接器变化时调用。
 * 返回本次合并后的远程工具数组。
 */
async function refreshMcpTools() {
  const policy = getPolicy();
  const out = [];
  if (!policy.enabled) {
    CACHED_TOOLS = [];
    return CACHED_TOOLS;
  }
  for (const c of CONNECTORS.values()) {
    if (!c.enabled) {
      c.status = 'disabled';
      continue;
    }
    try {
      const list = (await c.listTools()) || [];
      c._tools = list.map((t) => ({
        remoteName: t.name,
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} },
        kind: mapKind(t.kind)
      }));
      c.status = 'connected';
      c.error = null;
      for (const t of c._tools) {
        out.push(
          c.flat
            ? {
                name: t.remoteName, // 扁平：原名（同名冲突由优先级裁决）
                kind: t.kind,
                title: () => `[MCP:${c.id}] ${t.remoteName}`,
                description: `[MCP ${c.id}] ${t.description}`,
                parameters: t.parameters,
                connectorId: c.id,
                remoteName: t.remoteName,
                mcp: true,
                flat: true
              }
            : {
                name: `mcp__${c.id}__${t.remoteName}`, // 命名空间：隔离
                kind: t.kind,
                title: () => `[MCP:${c.id}] ${t.remoteName}`,
                description: `[MCP ${c.id}] ${t.description}`,
                parameters: t.parameters,
                connectorId: c.id,
                remoteName: t.remoteName,
                mcp: true,
                flat: false
              }
        );
      }
    } catch (e) {
      c.status = 'error';
      c.error = e.message;
    }
  }
  CACHED_TOOLS = out;
  return CACHED_TOOLS;
}

/** 同步获取已缓存的远程工具（供 allTools / toOpenAITools 使用） */
function getCachedTools() {
  return CACHED_TOOLS;
}

/**
 * 按名称解析远程工具。
 * - 命名空间工具：直接匹配 `mcp__<id>__<name>`
 * - 扁平工具：匹配原名；若与本地同名，按 priority 裁决
 * @param {string} name
 * @param {boolean} localExists 同名的本地工具是否已存在
 * @returns 远程工具描述符或 null
 */
function resolveRemote(name, localExists) {
  const policy = getPolicy();
  // 命名空间形式
  if (name.startsWith('mcp__')) {
    return CACHED_TOOLS.find((t) => t.name === name) || null;
  }
  // 扁平形式：先找 remoteName === name 的扁平工具
  const flat = CACHED_TOOLS.find((t) => t.flat && t.remoteName === name);
  if (!flat) return null;
  if (localExists && policy.priority === 'local-first') return null; // 本地优先：遮蔽远程
  return flat;
}

/** 执行远程工具调用，返回字符串结果（与本地 execute 输出形态一致） */
async function executeRemote(tool, args, ctx) {
  const c = CONNECTORS.get(tool.connectorId);
  if (!c) throw new Error(`MCP 连接器 ${tool.connectorId} 未注册`);
  const callKey = `${tool.connectorId}::${tool.remoteName}`;
  writeMcpLog('execute', [`>> executeRemote ${callKey}`, `args=${JSON.stringify(args || {})}`]);
  let result;
  try {
    result = await c.callTool(tool.remoteName, args || {});
  } catch (err) {
    writeMcpLog('execute', [`<< executeRemote ${callKey} ERROR`, String(err && err.message ? err.message : err)]);
    throw err;
  }
  writeMcpLog('execute', [`<< executeRemote ${callKey} OK`, `type=${typeof result}`, `value=${typeof result === 'string' ? result.slice(0, 500) : JSON.stringify(result).slice(0, 500)}`]);
  return typeof result === 'string' ? result : JSON.stringify(result);
}

/* ============ 通用辅助：被 playwrightConnector / mcpServers 复用 ============ */

/** 默认 MCP 依赖安装目录（与 setup-mcp.js / extension.js 保持一致） */
function defaultModulesPath() {
  return path.join(os.homedir(), '.fox-ai', 'mcp-modules');
}

/** 探测 @modelcontextprotocol/sdk 是否可用（兼容新旧版 cjs 导出路径） */
function loadSdk() {
  // 允许用户通过 foxAi.mcp.modulesPath 指定自定义安装目录；未指定时回退到默认目录
  const customPaths = [];
  try {
    const vscode = require('vscode');
    const modulesPath = vscode.workspace.getConfiguration('foxAi').get('mcp.modulesPath');
    if (modulesPath) {
      customPaths.push(modulesPath, path.join(modulesPath, 'node_modules'));
    }
  } catch (_) { /* 非扩展环境（测试）忽略 */ }
  // 无论是否配置，都默认包含 ~/.fox-ai/mcp-modules，避免安装后未写回设置就找不到 SDK
  const fallback = path.join(defaultModulesPath(), 'node_modules');
  if (!customPaths.includes(fallback)) customPaths.push(fallback);

  function tryRequire(c) {
    if (customPaths.length) {
      try { return require(require.resolve(c, { paths: customPaths })); } catch (_) { /* 继续 */ }
    }
    try { return require(c); } catch (_) { /* 继续 */ }
    return null;
  }

  // 新版 SDK 把 Client 与各传输分别拆到 client 主入口和独立子文件
  const clientMod =
    tryRequire('@modelcontextprotocol/sdk/client/index.js') ||
    tryRequire('@modelcontextprotocol/sdk/client') ||
    tryRequire('@modelcontextprotocol/sdk');
  const stdioMod = tryRequire('@modelcontextprotocol/sdk/client/stdio.js');
  const sseMod = tryRequire('@modelcontextprotocol/sdk/client/sse.js');
  const httpMod = tryRequire('@modelcontextprotocol/sdk/client/streamableHttp.js');

  if (!clientMod) throw new Error('未安装 @modelcontextprotocol/sdk');

  const Client = clientMod.Client || (clientMod.client && clientMod.client.Client);
  const StdioClientTransport =
    (stdioMod && stdioMod.StdioClientTransport) ||
    clientMod.StdioClientTransport ||
    (clientMod.client && clientMod.client.StdioClientTransport);
  const SSEClientTransport =
    (sseMod && sseMod.SSEClientTransport) ||
    clientMod.SSEClientTransport ||
    (clientMod.client && clientMod.client.SSEClientTransport);
  const StreamableHTTPClientTransport =
    (httpMod && httpMod.StreamableHTTPClientTransport) ||
    clientMod.StreamableHTTPClientTransport ||
    (clientMod.client && clientMod.client.StreamableHTTPClientTransport);

  if (!Client) throw new Error('@modelcontextprotocol/sdk 版本不兼容，缺少 Client');
  return { Client, StdioClientTransport, SSEClientTransport, StreamableHTTPClientTransport };
}

/** 把任意 MCP 工具名/描述映射到本地 kind（read/edit），供审批策略/UI 使用 */
function inferKind(name, description) {
  const w = (name || '').toLowerCase();
  const d = (description || '').toLowerCase();
  if (/(^|[_-])(write|create|add|edit|update|modify|delete|remove|run|execute|send|post|put|patch|submit|upload|download|click|fill|press|type|drag|check|uncheck|select|hover|navigate|move|rename|kill|stop|start|deploy|build|install)/.test(w)) return 'edit';
  if (/(^|[_-])(read|get|list|find|search|query|fetch|show|view|snapshot|screenshot|tree|accessibility|describe|info|status|open)/.test(w)) return 'read';
  if (/(write|create|edit|delete|update|run|execute|send|destructive|mutat)/.test(d)) return 'edit';
  return 'read';
}

const MCP_RESULT_MAX_CHARS = 16000;

/**
 * 工具结果「智能截断」：防止大文件 / 长日志 / 长网页把上下文撑爆（Token 吞噬兽的主要来源）。
 * - 短结果原样返回；
 * - 超长多行结果：保留头 50 行 + 尾 30 行，中间用省略标记代替（比单纯从头硬截断更实用）；
 * - 超长单行结果：从头截断到阈值；
 * - 末尾附「请精确查询」提示，引导 agent 二次精确调用而非一次塞满。
 * 仅作用于文本，不影响图像类内容标记。
 */
function smartTruncate(text, maxChars) {
  if (!text) return text;
  const lines = text.split('\n');
  const MAX_LINES = 120;
  // 行数过多（长代码 / 长日志 / 长目录树）：头 50 行 + 尾 30 行，中间省略（不依赖字符阈值）
  if (lines.length > MAX_LINES) {
    const head = lines.slice(0, 50).join('\n');
    const tail = lines.slice(-30).join('\n');
    const omitted = lines.length - 80;
    return head + '\n...（已省略 ' + omitted + ' 行，原 ' + lines.length + ' 行）...\n' + tail
      + '\n\n[工具结果已按需截断：如需完整内容，请用更精确的参数或指定行号重新调用该工具]';
  }
  // 行数不多但字符超阈值（如超长单行 / 少行大文本）：从头截断
  if (text.length > maxChars) {
    return text.slice(0, maxChars)
      + '\n…（内容已截断，原 ' + text.length + ' 字）'
      + '\n[如需完整内容请用更精确的参数或指定行号重新调用该工具]';
  }
  return text;
}

/** 把 MCP callTool 返回结果格式化为字符串（与本地工具输出形态一致），并对超长结果做智能截断 */
function formatResult(res, opts) {
  opts = opts || {};
  const maxChars = opts.maxChars || MCP_RESULT_MAX_CHARS;
  if (!res) {
    writeMcpLog('format', ['out: empty (falsy res)']);
    return '';
  }
  writeMcpLog('format', [`in res.isError=${!!res.isError}`, `has content=${Array.isArray(res.content)} len=${Array.isArray(res.content) ? res.content.length : 'n/a'}`, `has structuredContent=${!!res.structuredContent}`]);
  let raw = res.isError
    ? '[MCP 工具报错] ' + stringifyContent(res.content, res.structuredContent)
    : stringifyContent(res.content, res.structuredContent);
  // 兜底：若 content/structuredContent 都为空，但 res 整体还有字段（如 result/text 等常见错误写法），
  // 把整个对象序列化展示，避免「返回空」的观感并帮助定位服务端格式问题。
  if (!raw || !String(raw).trim()) {
    try {
      const whole = JSON.stringify(res, null, 2);
      if (whole && whole !== '{}' && whole !== '[]') raw = '[MCP 原始返回]\n' + whole.slice(0, 2000);
    } catch (_) {}
  }
  const out = smartTruncate(raw, maxChars);
  writeMcpLog('format', [`out len=${out.length}`, `head=${out.slice(0, 200)}`]);
  return out;
}

/**
 * 把 MCP 结果内容格式化为可读字符串。
 * 兼容两种返回形态：
 *  - 旧形态：content 数组（type:'text'/'image'/其它块）—— 优先使用，文本块直接展示。
 *  - 新形态（SDK 1.30.0 起常见）：content 为空数组、实际数据在 structuredContent 里。
 *    当 content 没有任何文本块时，回退到 structuredContent 的 JSON 字符串化，避免「什么也不返回」。
 * @param {Array|string|object} content  res.content
 * @param {object} [structuredContent]   res.structuredContent
 */
function stringifyContent(content, structuredContent) {
  // 1) content 有文本块时优先展示
  if (Array.isArray(content) && content.length > 0) {
    const mapped = content
      .map((c) => {
        if (c.type === 'text') return c.text || '';
        if (c.type === 'image') return `[图片数据 ${c.mimeType || ''}]`;
        return JSON.stringify(c);
      })
      .join('\n');
    if (mapped.trim()) return mapped;
  }
  // 2) content 为空 / 无文本时，回退到 structuredContent（SDK 1.30.0 默认 content:[]）
  if (structuredContent && typeof structuredContent === 'object') {
    try {
      return JSON.stringify(structuredContent, null, 2);
    } catch (_e) {
      return String(structuredContent);
    }
  }
  // 3) 兜底：content 为字符串 / 单对象 / 纯数组
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => JSON.stringify(c)).join('\n');
  if (content) return JSON.stringify(content);
  return '';
}

/**
 * 解析 `/mcp` 斜杠命令。
 * 支持两种写法：
 *   /mcp <serverId>.<toolName> [JSON参数]
 *   /mcp <serverId> <toolName> [JSON参数]
 * 仅给服务器（/mcp <serverId>）则约定为「列出该服务器工具」，返回 { help:true, serverId }。
 * 完全不带参数（/mcp）返回 { help:true }。
 * @param {string} raw 原始输入（含或不包含前导 /mcp 均可）
 * @returns {{serverId?:string, toolName?:string, args?:object, argStr?:string, help?:boolean, serverId?:string, error?:string}}
 */
function parseMcpCommand(raw) {
  const text = String(raw == null ? '' : raw)
    .trim()
    .replace(/^\/mcp\s*/i, '');
  if (!text) return { help: true };

  const firstSpace = text.indexOf(' ');
  const head = firstSpace >= 0 ? text.slice(0, firstSpace) : text;
  const rest = firstSpace >= 0 ? text.slice(firstSpace + 1) : '';

  let serverId = null;
  let toolName = null;
  let argStr = '';

  if (head.includes('.')) {
    const idx = head.indexOf('.');
    serverId = head.slice(0, idx);
    toolName = head.slice(idx + 1);
    argStr = rest;
  } else {
    serverId = head;
    const sp = rest.indexOf(' ');
    if (sp >= 0) {
      toolName = rest.slice(0, sp);
      argStr = rest.slice(sp + 1);
    } else {
      toolName = rest;
      argStr = '';
    }
  }

  // 缺少服务器 id（如 ".tool" 这种以点开头的写法）-> 报错
  if (!serverId) return { error: '缺少服务器 id' };
  // 只提供了服务器 id（没有工具名）-> 约定为「列出该服务器工具」
  if (!toolName) return { help: true, serverId };

  const trimmed = argStr.trim();
  if (!trimmed) return { serverId, toolName, args: {}, argStr: '' };

  // 优先尝试 JSON；失败时保留原始字符串，由调用方根据工具 schema 做适配
  try {
    return { serverId, toolName, args: JSON.parse(trimmed), argStr: trimmed };
  } catch (_) {
    return { serverId, toolName, args: null, argStr: trimmed };
  }
}

module.exports = {
  registerConnector,
  unregisterConnector,
  getConnectors,
  refreshMcpTools,
  getCachedTools,
  resolveRemote,
  executeRemote,
  getPolicy,
  loadSdk,
  inferKind,
  formatResult,
  stringifyContent,
  parseMcpCommand,
  _policyOverride: undefined
};
