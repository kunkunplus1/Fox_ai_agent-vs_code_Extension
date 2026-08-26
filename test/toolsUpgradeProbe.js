'use strict';
/**
 * toolsUpgradeProbe.js — 1.1.17 三组工具升级验证探针
 * 1) run_command 支持 bg=true 异步（不依赖子代理）
 * 2) 文件搜索量加大（find_files 默认 200/上限 2000、search_text 默认 80/上限 500）+ 定位提示
 * 3) get_tools 返回已加载 MCP 工具清单
 */

const Module = require('module');
const path = require('path');

const FOX_SRC = path.resolve(__dirname, '..', 'src');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra ? ' — ' + extra : '')); }
}

// ---- 假 vscode ----
const fakeUris = [];
for (let i = 0; i < 250; i++) fakeUris.push({ fsPath: 'C:/fake/ws/file' + i + '.txt', toString: () => 'uri' + i });
const mockVscode = {
  workspace: {
    getConfiguration: () => ({ get: (_k, d) => d }),
    findFiles: (_pattern, _exclude, max) => Promise.resolve(fakeUris.slice(0, max)),
    fs: { stat: () => Promise.resolve({ size: 100, mtime: Date.now() }), readFile: () => Promise.resolve(Buffer.from('hello\nworld\n')) },
    workspaceFolders: [{ uri: { fsPath: 'C:/fake/ws' } }]
  },
  Uri: { file: (p) => ({ fsPath: p }) },
  window: { createTerminal: () => ({ show() {}, sendText() {}, shellIntegration: null }), activeTerminal: null },
  env: { clipboard: { readText: () => Promise.resolve(''), writeText: () => Promise.resolve() } },
  commands: { executeCommand: () => Promise.resolve() },
  languages: { getDiagnostics: () => [] },
  ThemeIcon: class { constructor(i) { this.id = i; } }
};

// ---- 拦截 mcp 模块：get_tools 能看到已加载 MCP 工具 ----
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return mockVscode;
  if (request === './mcp' || request === '../tools/mcp') {
    return {
      getCachedTools: () => [
        { name: 'mcp__fetch__fetch_url', description: '抓取 URL 内容', inputSchema: { properties: { url: { type: 'string' } } } },
        { name: 'mcp__playwright__open_page', description: '打开网页', inputSchema: { properties: { url: { type: 'string' } } } }
      ],
      getPolicy: () => ({ autoInject: true, priority: 'local-first', enabled: true }),
      resolveRemote: () => null
    };
  }
  return origLoad.apply(this, arguments);
};

async function main() {
  const toolsIndex = require(path.join(FOX_SRC, 'tools', 'index.js'));
  const terminal = require(path.join(FOX_SRC, 'tools', 'terminal.js'));
  const workspace = require(path.join(FOX_SRC, 'tools', 'workspace.js'));

  console.log('\n== 1) run_command 异步 bg 支持 ==');
  const rcDef = toolsIndex.TOOLS.find((t) => t.name === 'run_command');
  ok('run_command 定义含 bg 参数', !!(rcDef && rcDef.parameters && rcDef.parameters.properties && rcDef.parameters.properties.bg && rcDef.parameters.properties.bg.type === 'boolean'));
  ok('run_command 描述提到后台', /bg|后台/.test(rcDef && rcDef.description || ''));
  ok('terminal 导出异步命令入口', typeof terminal.asyncCommandJobs === 'function' && typeof terminal.asyncJobLoad === 'function' && typeof terminal.asyncJobsList === 'function');
  const listText = terminal.asyncCommandJobs({ action: 'list' });
  ok('空列表给出指引', /后台命令任务|暂无/.test(listText), listText.slice(0, 60));

  console.log('\n== 2) 文件搜索量加大 + 定位提示 ==');
  const ffDef = toolsIndex.TOOLS.find((t) => t.name === 'find_files');
  ok('find_files max_results 描述含新默认 200', /200|2000/.test(ffDef && ffDef.parameters && ffDef.parameters.properties && ffDef.parameters.properties.max_results.description || ''), (ffDef && ffDef.parameters && ffDef.parameters.properties.max_results.description || '').slice(0, 80));
  const stDef = toolsIndex.TOOLS.find((t) => t.name === 'search_text');
  ok('search_text max_results 描述含新默认 80', /80|500/.test(stDef && stDef.parameters && stDef.parameters.properties && stDef.parameters.properties.max_results.description || ''), (stDef && stDef.parameters && stDef.parameters.properties.max_results.description || '').slice(0, 80));
  const ffOut = await workspace.findFiles({ pattern: '**/*.txt' });
  ok('find_files 默认最大 200（250 条里取 200）', /文件（200 个）/.test(ffOut), ffOut.slice(0, 60));
  ok('find_files 含定位提示', /定位提示/.test(ffOut), ffOut.slice(-80));
  const stOut = await workspace.searchText({ query: 'hello' });
  ok('search_text 含定位提示', /定位提示/.test(stOut), stOut.slice(-80));

  console.log('\n== 3) get_tools 含已加载 MCP 工具 ==');
  const gtDef = toolsIndex.TOOLS.find((t) => t.name === 'get_tools');
  ok('get_tools 描述提到 MCP', /MCP|mcp/.test(gtDef && gtDef.description || ''), (gtDef && gtDef.description || '').slice(0, 80));
  const gtOut = gtDef.run({ query: '' });
  ok('get_tools 返回含「已加载 MCP 工具」段', /已加载 MCP 工具/.test(gtOut), gtOut.slice(0, 120));
  ok('MCP 工具名出现', /mcp__fetch__fetch_url/.test(gtOut), gtOut.slice(0, 120));
  const gtMcpOnly = gtDef.run({ query: 'mcp' });
  ok('query=mcp 单独检索出 MCP 工具', /mcp__playwright__open_page/.test(gtMcpOnly), gtMcpOnly.slice(0, 120));

  console.log('\n结果：通过 ' + pass + '，失败 ' + fail);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('探针崩溃：', e); process.exit(1); });