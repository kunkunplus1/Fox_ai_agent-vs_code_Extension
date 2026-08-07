'use strict';

/**
 * 自写 MCP 服务器（让狐狸 AI 自己给自己写工具）
 * ----------------------------------------------------------------------------
 * 让狐狸 AI 的智能体能够「自己编写 MCP 服务器」：按本扩展已支持的同一套格式
 * （foxAi.mcp.servers 里的 stdio 服务器定义）生成脚本、登记进设置并热加载，
 * 使其立刻出现在 /mcp 浮窗、可被调用。
 *
 * 关键点：
 *  - 生成的服务器是「纯 Node」实现的标准 Model Context Protocol（stdio / JSON-RPC 2.0），
 *    不依赖 @modelcontextprotocol/sdk，因此一定能跑起来（SDK 只用于狐狸 AI 这一侧的连接）。
 *  - 脚本统一放在 ~/.fox-ai/mcp-servers/<id>/server.js，并写一份 manifest.json，
 *    扩展启动时会自动发现并加载（无需手动改配置也能被识别）。
 *  - 登记进 foxAi.mcp.servers 的写法是 { id, transport:'stdio', command: node路径, args:[脚本路径] }，
 *    与本扩展接入的其它 MCP 服务器完全同构。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const CONFIG_TARGET = (function () {
  try {
    // 扩展运行时：用 vscode 的枚举值
    return require('vscode').ConfigurationTarget.Global;
  } catch (_) {
    return 1; // 非扩展环境（测试/CLI）：Global 的数值
  }
})();

/** 用户自写 MCP 服务器的统一存放根目录（可用 baseDir 覆盖，便于测试） */
function userMcpBaseDir(baseDir) {
  if (baseDir) return baseDir;
  return path.join(os.homedir(), '.fox-ai', 'mcp-servers');
}

/**
 * 解析用于启动 MCP 服务器脚本的 node 可执行文件路径。
 *
 * 关键陷阱：在 VS Code 扩展宿主里 `process.execPath` 指向 Code.exe（Electron 主程序），
 * 而不是 node；若用它来 spawn `server.js`，既无法以 node 脚本方式运行，又会触发
 * 安全检查（Code.exe 不在启动命令白名单）。因此必须探测真正的 node。
 *
 *  - 普通 node 运行（CLI / 测试）：直接返回 process.execPath。
 *  - Electron 宿主（Code.exe 等）：用 where/which 探测系统 node，兜底回退到 'node'（依赖 PATH）。
 */
function resolveNodeCommand() {
  const execPath = process.execPath || '';
  const base = path.basename(execPath).toLowerCase();
  if (base === 'node' || base === 'node.exe') return execPath;
  try {
    const cmd = process.platform === 'win32' ? 'where node' : 'which node';
    const out = cp.execSync(cmd, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && /node(\.exe)?$/i.test(path.basename(first))) return first;
  } catch (_) { /* 探测失败，使用兜底 */ }
  return 'node';
}

/* ============ 纯 Node 的 MCP stdio 服务器模板 ============ */
// 协议要点：
//  - 从标准输入按行读取 JSON-RPC 请求；向标准输出按行写回 JSON-RPC 响应。
//  - 必须实现 initialize / tools/list / tools/call；可选 ping。
//  - 任何调试信息只能写 stderr，绝不能写 stdout（否则会污染协议）。
const MCP_TEMPLATE = `// 狐狸 AI 自写 MCP 服务器（stdio / 纯 Node，无需额外依赖）
// 协议：Model Context Protocol over stdio（JSON-RPC 2.0，每行一条 JSON 消息）
// 重要：只能往 stdout 写 JSON-RPC 响应；任何调试信息请用 process.stderr.write。
'use strict';
const SERVER_NAME = '__SERVER_NAME__';
const SERVER_VERSION = '1.0.0';

// ---- 工具定义（由 create_mcp_server 生成，可自由增删）----
const TOOLS = __TOOLS_ARRAY__;

let _buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  _buf += c;
  let i;
  while ((i = _buf.indexOf('\\n')) >= 0) {
    const line = _buf.slice(0, i).trim();
    _buf = _buf.slice(i + 1);
    if (line) handleLine(line);
  }
});
process.stdin.on('end', () => process.exit(0));

function send(o) {
  process.stdout.write(JSON.stringify(o) + '\\n');
}

async function handleLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (!msg || !msg.method) return;
  const id = msg.id; // 通知（notification）没有 id
  try {
    if (msg.method === 'initialize') {
      if (id !== undefined) send({ jsonrpc: '2.0', id, result: {
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      } });
      return;
    }
    if (msg.method === 'ping') {
      if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    if (msg.method === 'tools/list') {
      if (id !== undefined) send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map((t) => ({
        name: t.name, description: t.description, inputSchema: t.inputSchema
      })) } });
      return;
    }
    if (msg.method === 'tools/call') {
      const p = msg.params || {};
      const tool = TOOLS.find((t) => t.name === p.name);
      if (!tool) {
        if (id !== undefined) send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: '未知工具：' + p.name }] } });
        return;
      }
      try {
        const out = await tool.handler(p.arguments || {});
        let content;
        if (typeof out === 'string') content = [{ type: 'text', text: out }];
        else if (out && Array.isArray(out.content)) content = out.content;
        else content = [{ type: 'text', text: JSON.stringify(out) }];
        if (id !== undefined) send({ jsonrpc: '2.0', id, result: { content } });
      } catch (e) {
        if (id !== undefined) send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: '工具执行出错：' + (e && e.stack ? e.stack : String(e)) }] } });
      }
      return;
    }
    // 其它方法：若是请求则回 MethodNotFound；通知则忽略
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
  } catch (e) {
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e && e.message ? e.message : e) } });
  }
}
`;

/** 把用户提供的 handler（可能只是函数体）包装成合法的函数表达式 */
function wrapHandler(raw) {
  const h = String(raw == null ? '' : raw).trim();
  if (!h) throw new Error('handler 不能为空');
  // 已是完整函数表达式： (args)=>... / function(...){} / async ...
  if (/^(\(|\/\*|function|async\s)/.test(h)) return h;
  // 含语句块/分号/return -> 当成函数体包进 async 函数
  if (/[;{}\n]/.test(h) || /\breturn\b/.test(h)) {
    return 'async (args) => {\n' + h + '\n}';
  }
  // 否则视为纯表达式
  return 'async (args) => ( ' + h + ' )';
}

/** 把一个工具定义规范化 */
function normalizeTool(t) {
  if (!t || typeof t !== 'object') throw new Error('工具定义必须是对象');
  const name = String(t.name || '').trim();
  if (!name) throw new Error('工具 name 不能为空');
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('工具 name 只能含字母/数字/-/_：' + name);
  let inputSchema = t.input_schema || t.inputSchema || { type: 'object', properties: {} };
  if (typeof inputSchema === 'string') {
    try { inputSchema = JSON.parse(inputSchema); } catch (e) { throw new Error('input_schema 不是合法 JSON：' + e.message); }
  }
  if (!inputSchema || typeof inputSchema !== 'object') inputSchema = { type: 'object', properties: {} };
  const handler = wrapHandler(t.handler);
  return { name, description: String(t.description || ''), inputSchema, handler };
}

/**
 * 根据结构化 tools 生成完整的 MCP 服务器源码（纯 Node）。
 * @param {string} name 服务器 id
 * @param {string} description 描述
 * @param {Array} toolsInput 工具定义数组
 * @returns {string} 完整 JS 源码
 */
function buildServerSource(name, description, toolsInput) {
  if (!Array.isArray(toolsInput) || !toolsInput.length) throw new Error('tools 必须是一个非空数组');
  const tools = toolsInput.map(normalizeTool);
  const arrLiteral = '[\n' + tools.map((t) => {
    return '  {\n' +
      '    name: ' + JSON.stringify(t.name) + ',\n' +
      '    description: ' + JSON.stringify(t.description) + ',\n' +
      '    inputSchema: ' + JSON.stringify(t.inputSchema) + ',\n' +
      '    handler: ' + t.handler + '\n' +
      '  }';
  }).join(',\n') + '\n]';
  return MCP_TEMPLATE
    .replace('__SERVER_NAME__', name)
    .replace('__TOOLS_ARRAY__', arrLiteral);
}

/* ============ 登记（写文件 + 写配置 + 热注册） ============ */

/**
 * 把用户自写的 MCP 服务器落到磁盘并登记进 foxAi.mcp.servers，然后热注册使其立即生效。
 * @param {Object} opts
 *   context   : vscode.ExtensionContext（用于确定用户目录，可选）
 *   cfg       : vscode.WorkspaceConfiguration（带 get/update，可选；缺失则不写配置）
 *   name      : 服务器 id（字母/数字/-/_）
 *   description: 描述
 *   script    : 完整服务器源码（提供则忽略 tools）
 *   tools     : 结构化工具数组（与 script 二选一）
 *   scriptPath: 已用 write_file 写好的脚本绝对路径（提供则直接登记该文件）
 *   enabled   : 是否启用，默认 true
 *   baseDir   : 覆盖存放根目录（测试用）
 * @returns {Promise<{ok:boolean, id?:string, path?:string, manifest?:string, configNote?:string, live?:object, error?:string}>}
 */
async function registerUserServer(opts) {
  opts = opts || {};
  const name = String(opts.name || '').trim();
  if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) {
    return { ok: false, error: 'name 必须是字母/数字/-/_ 组成的有效 id' };
  }

  const baseDir = userMcpBaseDir(opts.baseDir);
  const serverDir = path.join(baseDir, name);
  fs.mkdirSync(serverDir, { recursive: true });

  let serverPath = opts.scriptPath || path.join(serverDir, 'server.js');
  let source = opts.script || null;

  if (!source) {
    if (Array.isArray(opts.tools) && opts.tools.length) {
      try {
        source = buildServerSource(name, opts.description, opts.tools);
      } catch (e) {
        return { ok: false, error: '生成脚本失败：' + e.message };
      }
    } else if (opts.scriptPath) {
      // 使用已存在脚本：确认文件可读即可
      try {
        fs.accessSync(opts.scriptPath, fs.constants.R_OK);
      } catch (e) {
        return { ok: false, error: 'script_path 指定的文件不存在或不可读：' + opts.scriptPath };
      }
      source = null;
    } else {
      return { ok: false, error: '请提供 script（完整源码）或 tools（结构化工具列表）或 script_path（已写好的脚本路径）' };
    }
  }

  // 写脚本 + 语法校验
  if (source) {
    try {
      fs.writeFileSync(serverPath, source, 'utf8');
    } catch (e) {
      return { ok: false, error: '写入脚本失败：' + e.message, path: serverPath };
    }
    try {
      cp.execSync('"' + process.execPath + '" --check "' + serverPath + '"', { windowsHide: true, stdio: 'pipe' });
    } catch (e) {
      return {
        ok: false,
        error: '脚本语法检查未通过：\n' + (e.stderr ? e.stderr.toString() : e.message),
        path: serverPath
      };
    }
  }

  // 写清单供自动发现
  const manifest = {
    id: name,
    description: opts.description || '',
    script: serverPath,
    transport: 'stdio',
    enabled: opts.enabled !== false
  };
  const manifestPath = path.join(serverDir, 'manifest.json');
  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  } catch (_) { /* 清单写入失败不致命，配置里仍会登记 */ }

  // 更新配置 foxAi.mcp.servers + 确保总开关开启
  let configNote = '';
  let live = null;
  const cfg = opts.cfg;
  if (cfg && typeof cfg.update === 'function' && typeof cfg.get === 'function') {
    const servers = (cfg.get('mcp.servers', []) || []).slice();
    const def = {
      id: name,
      transport: 'stdio',
      command: resolveNodeCommand(),
      args: [serverPath],
      enabled: opts.enabled !== false
    };
    if (opts.env && typeof opts.env === 'object' && Object.keys(opts.env).length) {
      def.env = opts.env;
      def.trustedEnv = opts.trustedEnv || Object.keys(opts.env);
    }
    const idx = servers.findIndex((s) => s && s.id === name);
    if (idx >= 0) servers[idx] = def; else servers.push(def);
    try {
      await cfg.update('mcp.servers', servers, CONFIG_TARGET);
      if (!cfg.get('mcp.enabled', false)) {
        await cfg.update('mcp.enabled', true, CONFIG_TARGET);
      }
      configNote = '已写入设置 foxAi.mcp.servers（并确认 foxAi.mcp.enabled=true）。';
    } catch (e) {
      configNote = '（配置写入失败：' + e.message + '）';
    }

    // 立即热注册（复用本扩展的通用 MCP 连接器）
    try {
      const mcpServers = require('./mcpServers');
      const policy = (cfg.get('mcp', {}) || {});
      live = await mcpServers.registerGenericServer(def, { policy });
    } catch (e) {
      live = { ok: false, error: '热注册失败（配置已保存，重载扩展后通常仍会生效）：' + e.message };
    }
  } else {
    configNote = '（非扩展环境，未写配置；仅生成了脚本与清单）';
  }

  return { ok: true, id: name, path: serverPath, manifest: manifestPath, configNote, live };
}

/* ============ 内置（builtin）MCP 服务器目录 ============ */

/**
 * 官方/知名 MCP 服务器里有些没有稳定的 npm 包（如 time/sqlite/git/fetch），
 * 或者社区包依赖 native 模块在 Windows 上编译失败。这里用「自写 MCP」能力
 * 给它们生成纯 Node 实现，一键安装时无需下载即可直接运行。
 */
const BUILTIN_CATALOG = {
  time: {
    name: 'Time（时间）',
    description: '获取当前时间、时区信息',
    tools: [
      {
        name: 'get-current-time',
        description: '获取当前时间，默认识别为 Asia/Shanghai，也可指定其它时区。',
        inputSchema: {
          type: 'object',
          properties: {
            timezone: { type: 'string', description: '时区名称，例如 Asia/Shanghai、UTC、America/New_York。默认 Asia/Shanghai。' }
          }
        },
        handler: async (args) => {
          const tz = String(args.timezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai';
          try {
            const s = new Date().toLocaleString('zh-CN', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
            return '当前时间（' + tz + '）：' + s;
          } catch (e) {
            return '时区错误：' + String(e && e.message ? e.message : e);
          }
        }
      }
    ]
  },
  fetch: {
    name: 'Fetch（网页抓取）',
    description: '用 Node 内置 http/https 抓取网页或 API 的文本内容。',
    tools: [
      {
        name: 'fetch-url',
        description: '抓取网页或 API 的纯文本正文，自动去除导航/侧栏等噪声（HTML 会提取为可读文本）。内容很长会被截断，可分批获取：用 startLine（从 0 计的行号）与 lineCount（行数）只取其中一段，返回末尾会提示是否还有更多。',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '要抓取的 HTTP/HTTPS URL' },
            maxLength: { type: 'number', description: '未指定 lineCount 时的最大返回字符数，默认 16000，最大 80000' },
            startLine: { type: 'number', description: '分批起点：从这一行开始取（0 基，默认 0）' },
            lineCount: { type: 'number', description: '分批行数：只取这么多行；不填则按 maxLength 字符截断' }
          },
          required: ['url']
        },
        handler: async (args) => {
          const writeLog = (label, data) => {
            try {
              const fs = require('fs');
              const path = require('path');
              const os = require('os');
              const dir = path.join(os.homedir(), '.fox-ai', 'logs');
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              const file = path.join(dir, 'mcp-fetch-server.log');
              const line = new Date().toISOString() + ' [pid:' + process.pid + '] ' + label + ' ' + (typeof data === 'string' ? data : JSON.stringify(data)) + '\n';
              fs.writeFileSync(file, line, { flag: 'a' });
            } catch (_) { /* 日志失败不得影响主流程 */ }
          };
          writeLog('fetch-url entry', args);
          const url = String(args.url || '').trim();
          if (!url) {
            writeLog('fetch-url exit', 'url 不能为空');
            return 'url 不能为空';
          }
          const maxLen = Math.max(1000, Math.min(Number(args.maxLength) || 16000, 80000));
          const startLine = Math.max(0, Math.floor(Number(args.startLine) || 0));
          const lineCount = args.lineCount != null ? Math.max(1, Math.floor(Number(args.lineCount))) : null;
          // HTML -> 正文纯文本（优先 <main>/<article>，剥离导航/侧栏/页眉/页脚；内联，序列化到 server.js 后仍能独立运行）
          const htmlToText = (html) => {
            html = html.replace(/<(script|style|svg|noscript)[\s\S]*?<\/\1>/gi, ' ')
              .replace(/<!--[\s\S]*?-->/g, ' ');
            const mainM = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
            let region = mainM ? mainM[1] : (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [null, html])[1];
            region = region.replace(/<(nav|aside|header|footer)[\s\S]*?<\/\1>/gi, ' ');
            region = region.replace(/<\s*(br|p|div|li|tr|th|td|h[1-6]|section|pre|ul|ol|blockquote)[^>]*>/gi, '\n');
            region = region.replace(/<[^>]+>/g, '');
            const ents = { '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&amp;': '&' };
            region = region.replace(/&(nbsp|lt|gt|quot|apos|amp|#39|#x27);/gi, (x) => ents[x.toLowerCase()] || x);
            region = region.replace(/[ \t\r]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
            return region;
          };
          // 单次请求；遇 3xx 返回 {redirect}，错误返回 {error}
          const fetchOne = (u) => new Promise((resolve) => {
            const mod = u.startsWith('https:') ? require('https') : require('http');
            const req = mod.get(u, { headers: { 'User-Agent': 'fox-ai-fetch/1.0' }, timeout: 15000 }, (res) => {
              if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                resolve({ redirect: new URL(res.headers.location, u).href });
                return;
              }
              if (res.statusCode < 200 || res.statusCode >= 300) {
                resolve({ error: 'HTTP ' + res.statusCode });
                return;
              }
              let data = '';
              res.setEncoding('utf8');
              res.on('data', (c) => { data += c; });
              res.on('end', () => {
                const ct = (res.headers['content-type'] || '').toLowerCase();
                let text = data;
                if (ct.indexOf('text/html') >= 0 || /^<!doctype html/i.test(data.trim()) || /<html[\s>]/i.test(data.slice(0, 500))) {
                  text = htmlToText(data);
                }
                resolve({ text });
              });
            });
            req.on('error', (e) => resolve({ error: '请求失败：' + e.message }));
            req.on('timeout', () => { req.destroy(); resolve({ error: '请求超时（15 秒）' }); });
          });
          let cur = url;
          let result = null;
          for (let i = 0; i < 5; i++) {
            const r = await fetchOne(cur);
            if (r.redirect) { cur = r.redirect; continue; }
            if (r.error) { writeLog('fetch-url exit', r.error); return r.error; }
            result = r.text;
            break;
          }
          if (result === null) { writeLog('fetch-url exit', '重定向过多'); return '重定向次数过多，无法获取内容'; }
          const lines = result.split('\n');
          let out;
          let more = false;
          if (lineCount != null) {
            out = lines.slice(startLine, startLine + lineCount).join('\n');
            more = startLine + lineCount < lines.length;
          } else {
            out = result.slice(0, maxLen);
            more = result.length > maxLen;
          }
          if (more) {
            if (lineCount != null) {
              out += '\n\n[还有 ' + (lines.length - (startLine + lineCount)) + ' 行未显示，设置 startLine=' + (startLine + lineCount) + ' 继续获取（lineCount 可调每批行数）]';
            } else {
              out += '\n\n[内容已截断，可设置 startLine 从指定行继续获取，或减小 maxLength 分批读取]';
            }
          }
          writeLog('fetch-url exit', { length: out.length, startLine, lineCount, maxLen });
          return out;
        }
      }
    ]
  },
  mock: {
    name: 'Mock（调试）',
    description: '极速定位 MCP 链路：返回固定内容，验证工具调用是否通畅。',
    tools: [
      {
        name: 'hello',
        description: '返回固定问候语并回显参数。若调用后仍看不到内容，问题在 Agent 解析层；若能看到，问题在服务端数据获取或格式化。',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', description: '名字（可选）' } }
        },
        handler: async (args) => {
          const writeLog = (label, data) => {
            try {
              const fs = require('fs');
              const path = require('path');
              const os = require('os');
              const dir = path.join(os.homedir(), '.fox-ai', 'logs');
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              const file = path.join(dir, 'mcp-mock-server.log');
              const line = new Date().toISOString() + ' [pid:' + process.pid + '] ' + label + ' ' + (typeof data === 'string' ? data : JSON.stringify(data)) + '\n';
              fs.writeFileSync(file, line, { flag: 'a' });
            } catch (_) { /* 日志失败不得影响主流程 */ }
          };
          writeLog('hello entry', args);
          const result = 'Hello from fox-ai mock server! received=' + JSON.stringify(args || {});
          writeLog('hello exit', result);
          return result;
        }
      }
    ]
  },
  git: {
    name: 'Git',
    description: '在当前工作区仓库执行常用 git 命令。',
    tools: [
      {
        name: 'git-status',
        description: '查看当前仓库 git 工作区状态。',
        inputSchema: { type: 'object', properties: {} },
        handler: async (args) => {
          const cp = require('child_process');
          const cwd = process.env.FOX_AI_WORKSPACE_FOLDER || process.cwd();
          try {
            const out = cp.execSync('git status --short', { cwd, encoding: 'utf8', timeout: 10000, windowsHide: true });
            return out.trim() || '工作区干净';
          } catch (e) {
            return 'git 命令失败：' + (e.stderr ? e.stderr.toString() : String(e && e.message ? e.message : e));
          }
        }
      },
      {
        name: 'git-log',
        description: '查看最近提交日志。',
        inputSchema: { type: 'object', properties: { count: { type: 'number', description: '返回条数，默认 10' } } },
        handler: async (args) => {
          const cp = require('child_process');
          const cwd = process.env.FOX_AI_WORKSPACE_FOLDER || process.cwd();
          try {
            return cp.execSync('git log -n ' + (Math.max(1, Math.min(Number(args.count) || 10, 100))) + ' --oneline', { cwd, encoding: 'utf8', timeout: 10000, windowsHide: true });
          } catch (e) {
            return 'git 命令失败：' + (e.stderr ? e.stderr.toString() : String(e && e.message ? e.message : e));
          }
        }
      }
    ]
  },
  sequentialthinking: {
    name: 'Sequential Thinking（逐步推理）',
    description: '提供结构化的逐步思考工具，适合复杂多步推理任务。',
    tools: [
      {
        name: 'sequentialthinking',
        description: '用于结构化、逐步思考的工具：把每一步思考显式记录下来，帮助在复杂任务中逐步收敛到结论。推理本身由调用方完成，本工具仅用于维护思考链状态并给出提示。',
        inputSchema: {
          type: 'object',
          properties: {
            thought: { type: 'string', description: '当前这一步的思考内容。' },
            nextThoughtNeeded: { type: 'boolean', description: '是否还需要继续思考（true 表示还要继续下一步）。' },
            thoughtNumber: { type: 'integer', description: '当前思考序号，从 1 开始。' },
            totalThoughts: { type: 'integer', description: '预估的总思考步数，可在过程中调大。' },
            isRevision: { type: 'boolean', description: '是否是对之前某一步的修订。' },
            revisesThought: { type: 'integer', description: '若 isRevision 为 true，指明修订的是第几步。' },
            branchFromThought: { type: 'integer', description: '若分支，指明从哪一步分出。' },
            branchId: { type: 'string', description: '分支标识（可选）。' }
          },
          required: ['thought', 'nextThoughtNeeded', 'thoughtNumber', 'totalThoughts']
        },
        handler: async (args) => {
          const thought = String(args.thought || '');
          const thoughtNumber = Number(args.thoughtNumber) || 0;
          const totalThoughts = Number(args.totalThoughts) || 0;
          const nextNeeded = args.nextThoughtNeeded === true || args.nextThoughtNeeded === 'true';
          const isRevision = args.isRevision === true || args.isRevision === 'true';
          let summary = '已记录第 ' + thoughtNumber + ' 步思考（共预估 ' + totalThoughts + ' 步）。\n';
          if (isRevision) {
            const rev = Number(args.revisesThought) || 0;
            summary += '（这是对第 ' + rev + ' 步的修订）\n';
          }
          if (args.branchFromThought !== undefined && args.branchFromThought !== null && args.branchFromThought !== '') {
            const b = Number(args.branchFromThought) || 0;
            const bid = String(args.branchId || '');
            summary += '（从第 ' + b + ' 步分支出新思路' + (bid ? '：' + bid : '') + '）\n';
          }
          summary += 'nextThoughtNeeded=' + nextNeeded + '。';
          if (!nextNeeded) summary += ' 思考链已结束，可据此得出结论。';
          else if (thoughtNumber >= totalThoughts) summary += ' 注意：已达到预估步数，若仍需继续请调大 totalThoughts。';
          return summary;
        }
      }
    ]
  }
};

/**
 * 获取内置 MCP 服务器定义（供 catalog 使用）。
 * @param {string} id 内置服务器 id（time/fetch/git）
 * @returns {{name:string, description:string, tools:Array}|null}
 */
function getBuiltinSpec(id) {
  return BUILTIN_CATALOG[id] || null;
}

/**
 * 为指定内置 id 生成完整的服务器源码。
 * @param {string} id
 * @returns {string|null}
 */
function buildBuiltinServer(id) {
  const spec = getBuiltinSpec(id);
  if (!spec) return null;
  return buildServerSource(id, spec.description, spec.tools);
}

/* ============ 自动发现（启动加载用户自写的服务器） ============ */

/**
 * 扫描 ~/.fox-ai/mcp-servers 下每个子目录的 manifest.json，返回 fox-ai 服务器定义。
 * 供扩展启动时合并进 foxAi.mcp.servers，使 agent 自写的服务器无需手动操作即被识别。
 * @param {string} [baseDir] 覆盖根目录（测试用）
 * @returns {Array} 服务器定义数组（含 source:'user-mcp'）
 */
function discoverUserMcpServers(baseDir) {
  const root = userMcpBaseDir(baseDir);
  const out = [];
  const seen = new Set();
  if (!fs.existsSync(root)) return out;
  let entries;
  try { entries = fs.readdirSync(root); } catch (_) { return out; }
  for (const name of entries) {
    const dir = path.join(root, name);
    let stat;
    try { stat = fs.statSync(dir); } catch (_) { continue; }
    if (!stat.isDirectory()) continue;
    const manifestPath = path.join(dir, 'manifest.json');
    let m = null;
    if (fs.existsSync(manifestPath)) {
      try { m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) { m = null; }
    }
    if (!m) continue;
    const id = m.id || name;
    if (seen.has(id)) continue;
    const script = m.script || path.join(dir, 'server.js');
    if (!fs.existsSync(script)) continue;
    seen.add(id);
    out.push({
      id,
      transport: 'stdio',
      command: resolveNodeCommand(),
      args: [script],
      enabled: m.enabled !== false,
      source: 'user-mcp',
      description: m.description || ''
    });
  }
  return out;
}

/* ============ 注入系统提示词的知识块（让 agent 了解自己支持的格式） ============ */

const MCP_AUTHORING_GUIDE =
`【自写 MCP 服务器（让你自己写的工具被狐狸 AI 加载并起作用）】
狐狸 AI 支持「自己给自己写 MCP 服务器」：你编写的服务器会用与本扩展已接入的 MCP（sequentialthinking、playwright 等）完全相同的格式被识别和启用。
- 本质：一个 Node 脚本，通过标准输入/输出与狐狸 AI 通信，实现 Model Context Protocol（JSON-RPC 2.0，每行一条 JSON 消息）。纯 Node 即可，无需安装额外依赖。
- 怎么登记：调用 create_mcp_server 工具。它会把脚本写到 ~/.fox-ai/mcp-servers/<id>/server.js，写一条定义进设置 foxAi.mcp.servers，并在当前会话热注册使其立即生效（随后会出现在 /mcp 浮窗）。即使不登记，扩展启动时也会自动发现该目录下的服务器。
- 必须实现的三类请求：
    * initialize -> 返回 { protocolVersion, capabilities:{ tools:{} }, serverInfo:{ name, version } }
    * tools/list -> 返回 { tools:[{ name, description, inputSchema }] }（注意字段是 inputSchema，不是 inputSchema 的别称）
    * tools/call -> 收到 { name, arguments }，返回 { content:[{ type:"text", text:"..." }] }；出错时返回 { isError:true, content:[...] }
- 两种写法（任选其一）：
    1) 结构化（推荐，保证可用）：create_mcp_server 传 tools 数组，每项 { name, description, input_schema(JS 对象或 JSON 字符串), handler(完整函数表达式，如 async (args)=>{ return String(args.q); }) }，狐狸 AI 会按标准协议生成脚本。
    2) 完全自定义：你用 write_file 自己写好脚本（参考下方模板），再调用 create_mcp_server 传入 script（完整源码）或 script_path（已写路径）。
- 调用方式：写好后，在对话里用 /mcp <id> <toolName> [参数] 使用；把设置 foxAi.mcp.autoInject 设为 true 后，工具会自动进入你的可用工具列表、由你自行决定调用。
- 前提：狐狸 AI 侧需已安装 @modelcontextprotocol/sdk 且 foxAi.mcp.enabled=true（MCP 总开关）。
- 标准模板（复制后只改 TOOLS 即可，注意 stdout 只能写协议、调试用 stderr）：
` + '```js\n' + MCP_TEMPLATE
  .replace(/__SERVER_NAME__/g, 'my-server')
  .replace(/__TOOLS_ARRAY__/g, `[
  {
    name: 'hello',
    description: '示例工具：回显问候',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: '名字' } }, required: ['name'] },
    handler: async (args) => { return '你好，' + (args.name || '世界'); }
  }
]`) + '\n```';

/**
 * 把 HTML 提取为正文纯文本（去 script/style/head 噪声，块级标签转换行，解码常见实体）。
 * 与 fetch 内置服务器 handler 内联版本实现保持一致，供单测与内置服务器复用。
 */
function htmlToText(html) {
  html = html.replace(/<(script|style|svg|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const mainM = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  let region = mainM ? mainM[1] : (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [null, html])[1];
  region = region.replace(/<(nav|aside|header|footer)[\s\S]*?<\/\1>/gi, ' ');
  region = region.replace(/<\s*(br|p|div|li|tr|th|td|h[1-6]|section|pre|ul|ol|blockquote)[^>]*>/gi, '\n');
  region = region.replace(/<[^>]+>/g, '');
  const ents = { '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&amp;': '&' };
  region = region.replace(/&(nbsp|lt|gt|quot|apos|amp|#39|#x27);/gi, (x) => ents[x.toLowerCase()] || x);
  region = region.replace(/[ \t\r]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return region;
}

/**
 * 把工具结果按「行分批」或「字符截断」整理成可返回文本。
 * - 指定 lineCount：只取 [startLine, startLine+lineCount) 这几行，末尾提示是否还有更多（供 agent 续取）。
 * - 未指定 lineCount：按 maxLen 字符截断，末尾提示可改用 startLine 分批。
 * 与 fetch 内置服务器 handler 内联版本逻辑保持一致，供单测复用。
 */
function paginateText(result, opts) {
  opts = opts || {};
  const maxLen = opts.maxLen || 16000;
  const startLine = Math.max(0, Math.floor(opts.startLine || 0));
  const lineCount = opts.lineCount != null ? Math.max(1, Math.floor(opts.lineCount)) : null;
  const text = String(result);
  const lines = text.split('\n');
  let out;
  let more;
  if (lineCount != null) {
    out = lines.slice(startLine, startLine + lineCount).join('\n');
    more = startLine + lineCount < lines.length;
  } else {
    out = text.slice(0, maxLen);
    more = text.length > maxLen;
  }
  if (more) {
    if (lineCount != null) {
      out += '\n\n[还有 ' + (lines.length - (startLine + lineCount)) + ' 行未显示，设置 startLine=' + (startLine + lineCount) + ' 继续获取（lineCount 可调每批行数）]';
    } else {
      out += '\n\n[内容已截断，可设置 startLine 从指定行继续获取，或减小 maxLength 分批读取]';
    }
  }
  return out;
}

module.exports = {
  MCP_TEMPLATE,
  htmlToText,
  paginateText,
  MCP_AUTHORING_GUIDE,
  userMcpBaseDir,
  resolveNodeCommand,
  buildServerSource,
  normalizeTool,
  wrapHandler,
  registerUserServer,
  discoverUserMcpServers,
  BUILTIN_CATALOG,
  getBuiltinSpec,
  buildBuiltinServer
};
