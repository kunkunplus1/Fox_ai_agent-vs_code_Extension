'use strict';

/**
 * 本地弱模型辅助模式 · 单元/集成测试（1.1.17）：
 *  - weakModel.validateToolArgs：类型/必填/枚举/未知参数 校验
 *  - weakModel.buildAnchor：核心任务锚点截断
 *  - buildSystemPrompt：弱模型文本分支【不再】注入「⚓ 核心任务」锚点（已移入动态附录，保 system 静态以最大化前缀缓存命中率）
 *  - toTextManual 本地分支：Enum 取值限制标注
 *  - TEXT_TOOL_GRAMMAR：约束解码语法结构正确
 */

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
const weakModel = require('../src/weakModel');

const demoTool = {
  name: 'demo',
  parameters: {
    properties: {
      path: { type: 'string' },
      count: { type: 'integer' },
      flag: { type: 'boolean' },
      mode: { type: 'string', enum: ['a', 'b'] }
    },
    required: ['path', 'mode']
  }
};

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗', name); }
}

console.log('[weakModelMode] 1) validateToolArgs 校验');
let v = weakModel.validateToolArgs(demoTool, { path: 'x', mode: 'a' });
check('全部合法 → ok', v.ok === true && v.errors.length === 0);

v = weakModel.validateToolArgs(demoTool, { mode: 'a' });
check('缺必填 path → 报错', v.ok === false && v.errors.some((e) => e.includes('path')));

v = weakModel.validateToolArgs(demoTool, { path: 'x', mode: 'a', count: '5' });
check('count 应为数字 → 报错', v.ok === false && v.errors.some((e) => e.includes('count')));

v = weakModel.validateToolArgs(demoTool, { path: 'x', mode: 'z' });
check('mode 越界枚举 → 报错', v.ok === false && v.errors.some((e) => e.includes('a / b')));

v = weakModel.validateToolArgs(demoTool, 'not-an-object');
check('非对象 → 报错', v.ok === false);

v = weakModel.validateToolArgs(demoTool, { path: 'x', mode: 'a', extra: 1 });
check('未知参数 extra → 报错', v.ok === false && v.errors.some((e) => e.includes('extra')));

v = weakModel.validateToolArgs(demoTool, { path: '', mode: 'a' });
check('必填为空串 → 报错', v.ok === false);

console.log('[weakModelMode] 2) buildAnchor 截断');
const longQ = 'a'.repeat(500);
check('超长 query 被截断到 ≤200', weakModel.buildAnchor(longQ).length <= 200);
check('空白被压缩', weakModel.buildAnchor('  读 取  文件  ') === '读 取 文件');

console.log('[weakModelMode] 3) buildSystemPrompt 锚点不进 system（缓存不变量）');
const prompt = agent.buildSystemPrompt({ meta: { local: true }, systemPrompt: '' }, 'ENV', 'text', '请帮我读取 a.txt 这个文件');
// 锚点由 queryText 派生，若写进 system 前缀会让 system 每轮都变 → 前缀缓存全失效。
// 1.1.16 起锚点改为注入动态附录（最后一条 user 消息头部），system 必须 100% 静态。
check('本地文本分支不含 ⚓ 锚点（已移出 system）', !prompt.includes('⚓ 核心任务'));
check('system 不含用户原始诉求（避免前缀随 query 变）', !prompt.includes('读取 a.txt'));
// 锚点文本本身仍由 weakModel.buildAnchor 产出，供主循环注入动态附录使用
const anchor = weakModel.buildAnchor('请帮我读取 a.txt 这个文件');
check('buildAnchor 产出核心任务锚点', !!anchor && anchor.includes('读取 a.txt'));

console.log('[weakModelMode] 4) toTextManual 本地分支 Enum 标注');
const manual = tools.toTextManual('', { meta: { local: true } });
check('本地手册标注 Enum 取值限制', manual.includes('workspace / global'));
check('Enum 标注用「取值限：」前缀', manual.includes('取值限：'));

console.log('[weakModelMode] 5) TEXT_TOOL_GRAMMAR 结构');
const g = weakModel.TEXT_TOOL_GRAMMAR;
check('含 toolcall 规则', g.includes('toolcall ::='));
check('约束 <foxtool name= 结构', g.includes('<foxtool name='));
check('内嵌标准 JSON 子语法', g.includes('"true"') && g.includes('object ::='));
check('freechar 放行普通文本且保留 <', g.includes('freechar ::='));

console.log(`\n[weakModelMode] 通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
