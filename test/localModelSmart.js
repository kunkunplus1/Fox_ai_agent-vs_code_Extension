'use strict';

/**
 * 本地模型「聪明化」回归测试（1.1.16）：
 *  - 系统提示词：本地走精简版（去掉重型工作准则 + MCP 自写指南），云端走完整版
 *  - 工具手册：本地只给 名称+描述+必填参数名，不堆完整 schema
 *  - 文本协议解析：兼容 <foxtool> / <function> / 裸 JSON 多格式，且按已知工具名过滤误判
 *
 * 通过 vscode 桩 + 子模块桩加载真实 agent.js / tools，验证真实代码逻辑。
 */

// ---- 1. 模块加载桩 ----
function makeProxy() {
  const fn = function () { return makeProxy(); };
  return new Proxy(fn, {
    get() { return makeProxy(); },
    apply() { return makeProxy(); },
    construct() { return makeProxy(); }
  });
}

const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return makeProxy();
  if (request.endsWith('extensionBridge')) return { allowedCommands: () => [], commandCatalog: () => [] };
  if (request.endsWith('reasoning')) return { buildReasoningParams: () => ({ promptHint: '' }) };
  if (request.endsWith('mcpAuthor')) return { MCP_AUTHORING_GUIDE: 'MCP_GUIDE_TEXT' };
  return origLoad.apply(this, arguments);
};

const agent = require('../src/agent');
const tools = require('../src/tools');

const MCP_GUIDE = 'MCP_GUIDE_TEXT';
const KNOWN = ['read_file', 'run_command', 'edit_file', 'web_search', 'current_time', 'write_file'];

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗', name); }
}

console.log('[localModelSmart] 1) 系统提示词本地精简');
const localPrompt = agent.buildSystemPrompt({ meta: { local: true }, systemPrompt: '' }, 'ENV', 'text', 'read something');
const cloudPrompt = agent.buildSystemPrompt({ meta: { local: false }, systemPrompt: '' }, 'ENV', 'text', 'read something');

check('本地提示含「精简版」准则', localPrompt.includes('工作准则（精简版'));
check('本地提示去掉了重型 MCP 自写指南', localPrompt.indexOf(MCP_GUIDE) === -1);
check('本地提示保留狐狸 AI 身份', localPrompt.includes('狐狸 AI'));
check('云端提示保留完整 MCP 自写指南', cloudPrompt.includes(MCP_GUIDE));
check('云端提示不含「精简版」', cloudPrompt.indexOf('精简版') === -1);
check('本地提示明显短于云端（省 token）', localPrompt.length < cloudPrompt.length * 0.8);

console.log('[localModelSmart] 2) 工具手册本地精简');
const localManual = tools.toTextManual('', { meta: { local: true } });
const cloudManual = tools.toTextManual('', { meta: { local: false } });
check('本地手册给出参数清单', localManual.includes('参数：'));
check('本地手册不堆完整 schema（无「// 必填」注释行）', !localManual.includes('// 必填'));
check('云端手册堆完整 schema（含「// 必填」）', cloudManual.includes('// 必填'));
check('本地手册短于云端', localManual.length < cloudManual.length * 0.7);

console.log('[localModelSmart] 3) 文本协议解析多格式 + 误判过滤');
// 1.1.23 起 parseTextCalls 是 textParser 模块函数（agent.js 原型方法已拆走）
const { parseTextCalls } = require('../src/textParser');
const parse = parseTextCalls;

// 3a. 传统 <foxtool>
let r = parse.call({}, '<foxtool name="read_file">{"path":"a.txt"}</foxtool>', KNOWN);
check('解析 <foxtool>', r.length === 1 && r[0].name === 'read_file');

// 3b. <function> 风格
r = parse.call({}, '<function name="run_command">{"cmd":"ls"}</function>', KNOWN);
check('解析 <function>', r.length === 1 && r[0].name === 'run_command');

// 3c. ```json 围栏 + {name, arguments}
r = parse.call({}, '好的，调用工具：\n```json\n{"name":"edit_file","arguments":{"path":"a","old_text":"x","new_text":"y"}}\n```', KNOWN);
check('解析 ```json 围栏', r.length === 1 && r[0].name === 'edit_file');

// 3d. 裸对象 {tool, parameters}
r = parse.call({}, '{"tool":"write_file","parameters":{"path":"b","content":"hi"}}', KNOWN);
check('解析裸对象 {tool,parameters}', r.length === 1 && r[0].name === 'write_file');

// 3e. 多个工具调用（限 5）
r = parse.call({}, '<foxtool name="read_file">{"path":"1"}</foxtool>\n<foxtool name="run_command">{"cmd":"2"}</foxtool>', KNOWN);
check('解析多个 <foxtool>', r.length === 2);

// 3f. 已知工具过滤：随机 JSON 被拒
r = parse.call({}, '{"foo":"bar","baz":1}', KNOWN);
check('随机 JSON 不被误判为工具', r.length === 0);

// 3g. 已知工具过滤：未知工具名被拒
r = parse.call({}, '<foxtool name="not_a_real_tool">{}</foxtool>', KNOWN);
check('未知工具名被过滤', r.length === 0);

// 3h. 截断兜底（缺闭合标签）
r = parse.call({}, '我先调用：<foxtool name="read_file">{"path":"a.txt"}', KNOWN);
check('截断兜底解析', r.length === 1 && r[0].name === 'read_file');

// 3i. 不传 knownTools 时不过滤（保持旧行为兼容）
r = parse.call({}, '{"tool":"write_file","parameters":{"path":"b"}}', null);
check('不传 knownTools 时不过滤', r.length === 1 && r[0].name === 'write_file');

console.log(`\n[localModelSmart] 通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
