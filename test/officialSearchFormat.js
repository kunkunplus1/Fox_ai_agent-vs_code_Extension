/**
 * 验证 DeepSeek Responses 官方联网的请求格式：
 *  - 进入「官方搜索」模式时，tools 必须是「官方 web_search + 除纯联网抓取类以外的全部本地能力工具」混合集
 *    （完整对象，不是字符串占位符）；1.1.19 起不再只发 web_search，1.1.30 起由写死白名单改为反向过滤，
 *    保证生图/识图/沙盒/技能/记忆/文件/终端/诊断等一切本地能力永不被剥（新增工具自动保留）。
 *  - 仅排除与官方 web_search 重复的纯联网抓取类本地工具（mcp__* / web_fetch / fetch-url / browser 等）。
 *  - 首轮强制 tool_choice 触发，后续轮放开（auto）；
 *  - 用户明确要本地工具时解除；非时效性不进入（1.1.17 起：非时效追问交还完整本地工具集，不再永久粘连）。
 * 纯函数离线测试，不触碰网络 / vscode。
 */
const assert = require('assert');
const Module = require('module');

/* ---------- mock vscode（与 smoke.js 一致） ---------- */
const vscodeMock = {
  workspace: {
    workspaceFolders: null,
    getConfiguration: () => ({ get: (k, d) => d, update: async () => {} }),
    textDocuments: [],
    fs: {}
  },
  window: { activeTextEditor: null, activeTerminal: null, tabGroups: { all: [] } },
  languages: { getDiagnostics: () => [] },
  commands: { executeCommand: async () => {} },
  env: { clipboard: { readText: async () => '', writeText: async () => {} } },
  Uri: { file: (p) => ({ fsPath: p, toString: () => 'file://' + p }), joinPath: () => ({}) },
  Position: class {},
  Range: class {},
  Selection: class {},
  ThemeIcon: class {},
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  FileType: { File: 1, Directory: 2 },
  InlineCompletionItem: class {},
  ConfigurationTarget: { Global: 1 },
  TextEditorRevealType: { InCenter: 2 }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const { computeOfficialSearch } = require('../src/agent');
const { toResponsesTools } = require('../src/client');

let pass = 0;
function check(name, cond) {
  assert.ok(cond, '❌ ' + name);
  console.log('✅ ' + name);
  pass++;
}

// 模拟 toOpenAITools(deepseek+responses) 的输出：含核心本地 file 工具 + 网络类本地工具（应被排除）
const mockTools = [
  { type: 'function', function: { name: 'read_file', description: '读', parameters: {} } },
  { type: 'function', function: { name: 'write_file', description: '写', parameters: {} } },
  { type: 'function', function: { name: 'run_command', description: '命令', parameters: {} } },
  { type: 'function', function: { name: 'mcp__fetch__fetch-url', description: '抓', parameters: {} } },
  { type: 'function', function: { name: 'create_plan_task', description: '计划', parameters: {} } }
];

// 1) 时效性首轮（无助手回复）：官方 web_search + 核心本地 file 工具，强制触发
{
  const payload = [{ role: 'user', content: '今天B站热门排行前三是什么？' }];
  const dec = computeOfficialSearch(payload, false, mockTools);
  check('timely-first: 进入官方搜索', dec !== null);
  check('timely-first: tools 含官方 web_search', dec.tools.some((t) => t.type === 'web_search'));
  check('timely-first: 合并核心本地文件工具 (read_file/write_file)',
    dec.tools.some((t) => (t.function && t.function.name) === 'read_file') &&
    dec.tools.some((t) => (t.function && t.function.name) === 'write_file'));
  check('timely-first: 排除网络类本地工具 (mcp__fetch 不在)',
    !dec.tools.some((t) => (t.function && t.function.name) === 'mcp__fetch__fetch-url'));
  check('timely-first: 首轮强制 tool_choice', JSON.stringify(dec.toolChoice) === JSON.stringify({ type: 'web_search' }));
  check('timely-first: 标记已启动', dec.started === true);
}

// 2) 时效性后续轮（已有助手回复、本次仍时效）：仍含 web_search + 本地 file 工具，但放开 tool_choice（=auto）
{
  const payload = [
    { role: 'user', content: '今天B站热门排行前三是什么？' },
    { role: 'assistant', content: '根据搜索结果…' },
    { role: 'user', content: '再帮我看看今天最新排行有没有变化' }
  ];
  const dec = computeOfficialSearch(payload, true, mockTools);
  check('timely-follow: 含官方 web_search', dec.tools.some((t) => t.type === 'web_search'));
  check('timely-follow: 仍合并核心本地文件工具 (read_file)',
    dec.tools.some((t) => (t.function && t.function.name) === 'read_file'));
  check('timely-follow: toolChoice 放开(=auto)', dec.toolChoice === undefined);
}

// 2.5) 时效性首轮：1.1.30 通用防掉工具——除纯联网抓取类外，其余本地能力工具一律保留
{
  const payload = [{ role: 'user', content: '今天最新的 AI 绘画趋势是什么，顺便帮我画一张' }];
  const tools = mockTools.concat([
    { type: 'function', function: { name: 'generate_image', description: '生图', parameters: {} } },
    { type: 'function', function: { name: 'identify_image', description: '识图', parameters: {} } },
    { type: 'function', function: { name: 'run_in_sandbox', description: '沙盒', parameters: {} } },
    { type: 'function', function: { name: 'future_capability_x', description: '未来新增能力', parameters: {} } }
  ]);
  const dec = computeOfficialSearch(payload, false, tools);
  check('genfix: 进入官方搜索', dec !== null);
  check('genfix: 生图工具 generate_image 不再被剥',
    dec.tools.some((t) => (t.function && t.function.name) === 'generate_image'));
  check('genfix: 识图工具 identify_image 保留',
    dec.tools.some((t) => (t.function && t.function.name) === 'identify_image'));
  check('genfix: 沙盒工具 run_in_sandbox 保留',
    dec.tools.some((t) => (t.function && t.function.name) === 'run_in_sandbox'));
  check('genfix: 未来新增的本地能力工具自动保留（不再依赖白名单）',
    dec.tools.some((t) => (t.function && t.function.name) === 'future_capability_x'));
  check('genfix: 仍排除网络类本地工具 (mcp__fetch 不在)',
    !dec.tools.some((t) => (t.function && t.function.name) === 'mcp__fetch__fetch-url'));
  check('genfix: 原生 web_search 仅注入一次（无重复）',
    dec.tools.filter((t) => t.type === 'web_search').length === 1);
}

// 3) 已启动会话 + 非时效性追问：1.1.17 修复后「解除官方搜索」，交还完整本地工具集（返回 null）
{
  const payload = [
    { role: 'user', content: '今天B站热门排行前三是什么？' },
    { role: 'assistant', content: 'xxx' },
    { role: 'user', content: '帮我写一段总结文案' }
  ];
  const dec = computeOfficialSearch(payload, true);
  check('continuity-release: 非时效追问恢复本地工具（返回 null）', dec === null);
}

// 4) 用户明确要本地工具：解除官方搜索（恢复本地工具，本函数返回 null 表示交给普通工具集）
{
  const payload = [
    { role: 'user', content: '今天B站热门排行前三是什么？' },
    { role: 'assistant', content: 'xxx' },
    { role: 'user', content: '算了，用本地工具自己抓吧' }
  ];
  const dec = computeOfficialSearch(payload, true);
  check('userWantsLocal: 解除官方搜索', dec === null);
}

// 5) 非时效性：不进入官方搜索
{
  const payload = [{ role: 'user', content: '帮我写一个快排函数' }];
  const dec = computeOfficialSearch(payload, false);
  check('non-timely: 不进入官方搜索', dec === null);
}

// 6) toResponsesTools：function 工具是完整对象（含 name/description/parameters），web_search 透传
{
  const converted = toResponsesTools([
    { type: 'function', function: { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
    { type: 'web_search' }
  ]);
  check('toResponsesTools: function 转为完整对象', converted[0].type === 'function' && converted[0].name === 'read_file' && typeof converted[0].parameters === 'object');
  check('toResponsesTools: web_search 透传为 {type:"web_search"}', converted[1].type === 'web_search' && Object.keys(converted[1]).length === 1);
  // 证明不是字符串占位符
  check('toResponsesTools: 没有任何元素是纯字符串', converted.every((t) => typeof t === 'object'));
}

console.log('\n全部通过：' + pass + ' 项 ✅');
