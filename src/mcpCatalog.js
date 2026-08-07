'use strict';

/**
 * 内置 MCP 服务器目录（一键下载并接入）
 * ----------------------------------------------------------------------------
 * 每条记录描述一个「官方/知名」MCP 服务器：
 *   - id / name / desc  界面展示
 *   - transport          固定为 stdio（目录里的服务器都是本地进程型）
 *   - command / args     启动命令（${workspaceFolder} 会在安装时替换为当前工作区根目录）
 *   - install            { type:'npm', pkg } 安装元信息，用于「下载」步骤
 *   - needsEnv           [{ key, label, secret }] 安装前需要向用户索取的环境变量
 *   - note               安全/作用域提示
 *
 * 完整的 command/args/install 仅由扩展端（foxAi.installCatalogServer）消费，
 * 界面只展示 list() 返回的精简字段，避免暴露过多实现细节。
 */

const CATALOG = [
  {
    id: 'filesystem',
    name: '文件系统',
    desc: '读取 / 列出 / 搜索本地目录与文件。作用域默认限定在当前工作区根目录。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '${workspaceFolder}'],
    install: { type: 'npm', pkg: '@modelcontextprotocol/server-filesystem' },
    note: 'AI 只能访问 ${workspaceFolder} 之内，无法越界读写其它目录。'
  },
  {
    id: 'github',
    name: 'GitHub',
    desc: '搜索仓库、读取 Issue/PR、管理文件等 GitHub 操作。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    install: { type: 'npm', pkg: '@modelcontextprotocol/server-github' },
    needsEnv: [
      { key: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub Personal Access Token（需 repo 权限）', secret: true }
    ],
    note: '需要具有 repo 权限的 PAT；仅在本地进程中使用，不会外传。'
  },
  {
    id: 'git',
    name: 'Git',
    desc: '在当前仓库执行 git 操作：状态、日志等。',
    transport: 'stdio',
    command: 'node',
    args: ['${builtin:git}'],
    install: { type: 'builtin' },
    note: '纯 Node 内置实现，依赖系统已安装的 git，无需下载依赖。'
  },
  {
    id: 'fetch',
    name: 'Fetch（网页抓取）',
    desc: '把网页 / JSON 端点内容抓取成 LLM 友好的文本。',
    transport: 'stdio',
    command: 'node',
    args: ['${builtin:fetch}'],
    install: { type: 'builtin' },
    note: '纯 Node 内置实现，无需下载依赖。'
  },
  {
    id: 'stealth-fetch',
    name: 'Stealth Fetch（伪装抓取）',
    desc: '用 curl_cffi 模拟 Chrome/Edge 的 TLS 指纹 + 支持 Cookie，绕过常见反爬（B站、小红书等）。首次安装自动创建 Python 虚拟环境并安装 curl_cffi（带进度条）。零 mcp 依赖、手写 MCP 协议，安装快、失败面小。',
    transport: 'stdio',
    command: 'python',
    args: ['${stealthServerPy}'],
    install: { type: 'python' },
    needsEnv: [
      { key: 'STEALTH_FETCH_COOKIE', label: 'Cookie 字符串（可选，用于需登录的站点，格式 k=v; k2=v2）', secret: true }
    ],
    note: '自动配置 Python 环境（无需手动装 Python）；抓取时模拟真实浏览器指纹，比内置 Fetch 更不易被反爬拦截。'
  },
  {
    id: 'memory',
    name: 'Memory（知识记忆）',
    desc: '基于文件的持久化知识图谱，让 AI 跨会话记住事实。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    install: { type: 'npm', pkg: '@modelcontextprotocol/server-memory' }
  },
  {
    id: 'sequentialthinking',
    name: 'Sequential Thinking（逐步推理）',
    desc: '提供「结构化逐步思考」工具，适合复杂多步推理任务。',
    transport: 'stdio',
    command: 'node',
    args: ['${builtin:sequentialthinking}'],
    install: { type: 'builtin' },
    note: '纯 Node 内置实现，无需下载依赖。'
  },
  {
    id: 'time',
    name: 'Time（时间）',
    desc: '获取当前时间、时区信息。',
    transport: 'stdio',
    command: 'node',
    args: ['${builtin:time}'],
    install: { type: 'builtin' },
    note: '纯 Node 内置实现，无需下载依赖。'
  },
  {
    id: 'mock',
    name: 'Mock（调试定位）',
    desc: '固定返回 Hello，用于快速确认 MCP 调用链路是否通畅。',
    transport: 'stdio',
    command: 'node',
    args: ['${builtin:mock}'],
    install: { type: 'builtin' },
    note: '调试专用：若调用后仍无返回，问题在 Agent 解析层；若有返回，问题在服务端数据获取或格式化。'
  },
  {
    id: 'brave-search',
    name: 'Brave 搜索',
    desc: '通过 Brave Search API 做网络搜索。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    install: { type: 'npm', pkg: '@modelcontextprotocol/server-brave-search' },
    needsEnv: [
      { key: 'BRAVE_API_KEY', label: 'Brave Search API Key', secret: true }
    ],
    note: '需要 Brave Search API Key。'
  },
  {
    id: 'playwright',
    name: 'Playwright（浏览器自动化）',
    desc: '用真实 Chromium 驱动网页：打开页面、点击、填表、截图、抓取数据。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp'],
    install: { type: 'npm', pkg: '@playwright/mcp' },
    note: '依赖已预装在本地模块目录；Chromium 浏览器已就绪，开箱即用。'
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer（网页自动化）',
    desc: '用无头 Chrome 做网页抓取与自动化操作。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    install: { type: 'npm', pkg: '@modelcontextprotocol/server-puppeteer' },
    note: '会自动下载 Chromium（若未安装），首次运行可能较慢。'
  }
];

/** 界面用精简列表（不含 command/args/install 等实现细节） */
function list() {
  return CATALOG.map((c) => ({
    id: c.id,
    name: c.name,
    desc: c.desc,
    note: c.note || '',
    needsEnv: (c.needsEnv || []).map((e) => e.key)
  }));
}

/** 按 id 取完整条目（供安装流程使用） */
function find(id) {
  return CATALOG.find((c) => c.id === id) || null;
}

module.exports = { CATALOG, list, find };
