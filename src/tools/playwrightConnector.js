'use strict';

/**
 * Playwright MCP 连接器（便捷封装）
 * ----------------------------------------------------------------------------
 * 这是「通用 MCP 连接器」的一个特例：把官方 @playwright/mcp 服务器用默认命令
 * 挂到 fox-ai 骨架，使其工具以 `mcp__playwright__<name>` 暴露。
 *
 * 真正通用的接入请看 `src/tools/mcpServers.js` + 配置 `foxAi.mcp.servers`：
 * 以后加任何标准 MCP 服务器都只需在配置里加一行，无需新代码。
 *
 * 依赖（用户侧自行安装，未装时本连接器自动跳过，不影响其它功能）：
 *   npm i @modelcontextprotocol/sdk
 *   npm i -g @playwright/mcp   （或 npx -y @playwright/mcp，且需 npx playwright install 下载浏览器）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const mcp = require('./mcp');
const { registerGenericServer } = require('./mcpServers');

// 向后兼容：保留原导出名，内部委托给通用实现
const mapKind = mcp.inferKind;
const formatResult = mcp.formatResult;
const loadSdk = mcp.loadSdk;

/** 与 setup-mcp.js 保持一致的默认依赖目录 */
function defaultModulesPath() {
  return path.join(os.homedir(), '.fox-ai', 'mcp-modules');
}

function getPlaywrightDefaults() {
  let modulesPath;
  try {
    const vscode = require('vscode');
    modulesPath = vscode.workspace.getConfiguration('foxAi').get('mcp.modulesPath') || defaultModulesPath();
  } catch (_) {
    modulesPath = defaultModulesPath();
  }
  const localPw = fs.existsSync(path.join(modulesPath, 'node_modules', '@playwright', 'mcp', 'package.json'));
  return localPw
    ? { command: 'npx', args: ['--prefix', modulesPath, '-y', '@playwright/mcp'], env: null }
    : { command: 'npx', args: ['-y', '@playwright/mcp'], env: null };
}

const DEFAULTS = getPlaywrightDefaults();

/**
 * 注册 Playwright 连接器（便捷入口）。
 * @param {Object} opts 同 mcpServers.registerGenericServer 的 opts（支持 createClient/createTransport mock）
 */
async function registerPlaywrightConnector(opts = {}) {
  return registerGenericServer(
    {
      id: 'playwright',
      transport: 'stdio',
      command: opts.command || DEFAULTS.command,
      args: opts.args || DEFAULTS.args.slice(),
      env: opts.env || DEFAULTS.env,
      flat: false
    },
    opts
  );
}

async function unregisterPlaywrightConnector() {
  mcp.unregisterConnector('playwright');
}

module.exports = { registerPlaywrightConnector, unregisterPlaywrightConnector, mapKind, formatResult, loadSdk };
