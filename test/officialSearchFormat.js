/**
 * 验证 DeepSeek Responses 官方联网的请求格式：
 *  - 进入「仅官方搜索」模式时，tools 必须是 [{type:'web_search'}]（完整对象，不是字符串占位符）；
 *  - 绝不混入本地 function 工具（否则模型会挑 fetch/MCP 绕圈 → 大陆网络抓不到 → 断掉）；
 *  - 首轮强制 tool_choice 触发，后续轮放开（auto）；
 *  - 用户明确要本地工具时解除；非时效性不进入。
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

// 1) 时效性首轮（无助手回复）：只给官方 web_search，强制触发
{
  const payload = [{ role: 'user', content: '今天B站热门排行前三是什么？' }];
  const dec = computeOfficialSearch(payload, false);
  check('timely-first: 进入官方搜索', dec !== null);
  check('timely-first: tools 仅含 web_search', JSON.stringify(dec.tools) === JSON.stringify([{ type: 'web_search' }]));
  check('timely-first: 首轮强制 tool_choice', JSON.stringify(dec.toolChoice) === JSON.stringify({ type: 'web_search' }));
  check('timely-first: 标记已启动', dec.started === true);
}

// 2) 时效性后续轮（已有助手回复）：仍只给 web_search，但放开 tool_choice（=auto）
{
  const payload = [
    { role: 'user', content: '今天B站热门排行前三是什么？' },
    { role: 'assistant', content: '根据搜索结果…' },
    { role: 'user', content: '再帮我确认下第二个' }
  ];
  const dec = computeOfficialSearch(payload, true);
  check('timely-follow: 仍只给 web_search', JSON.stringify(dec.tools) === JSON.stringify([{ type: 'web_search' }]));
  check('timely-follow: toolChoice 放开(=auto)', dec.toolChoice === undefined);
}

// 3) 已启动会话 + 非时效性追问：保持连续（不退回本地工具）
{
  const payload = [
    { role: 'user', content: '今天B站热门排行前三是什么？' },
    { role: 'assistant', content: 'xxx' },
    { role: 'user', content: '帮我写一段总结文案' }
  ];
  const dec = computeOfficialSearch(payload, true);
  check('continuity: 非时效追问仍保持 web_search', dec !== null && JSON.stringify(dec.tools) === JSON.stringify([{ type: 'web_search' }]));
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
