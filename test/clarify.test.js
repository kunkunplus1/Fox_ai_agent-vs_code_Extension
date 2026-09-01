'use strict';

/**
 * 1.1.26：clarify（向用户澄清）工具回归测试。
 *  - 工具存在、kind=read、参数 question(必填)+options(可选数组)
 *  - 无 ctx.askUser 时兜底返回提示文本
 *  - 有 ctx.askUser 时把用户答复作为工具结果回传
 * 运行：node test/clarify.test.js
 */

const Module = require('module');
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') {
    return {
      workspace: { getConfiguration: () => ({ get: () => undefined }) },
      window: {}, commands: {}, Event: class {}, Uri: { file: (p) => ({ fsPath: p }) }
    };
  }
  return origLoad.apply(this, arguments);
};

const tools = require('../src/tools/index.js');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' => ' + JSON.stringify(extra) : '')); }
}

(async () => {
  const t = tools.getTool('clarify');
  check('clarify 工具存在', !!t);
  check('kind=read（无需审批）', t && t.kind === 'read');
  check('question 必填', t && t.parameters.required.includes('question'));
  check('options 为数组', t && t.parameters.properties.options.type === 'array');
  check('title 带问题摘要', t && t.title({ question: '你希望用哪种配色？' }).indexOf('配色') !== -1);

  // 序列化到 OpenAI tools：options 数组类型正确
  const all = tools.toOpenAITools('澄清', {});
  const c = all.find((x) => x && x.function && x.function.name === 'clarify');
  check('toOpenAITools 含 clarify', !!c);
  check('options 序列化为 array', c && c.function.parameters.properties.options.type === 'array');

  // 无 askUser → 兜底
  const fallback = await t.run({ question: '你希望哪种？', options: ['A', 'B'] }, {});
  check('无 askUser 时兜底返回文本', typeof fallback === 'string' && fallback.length > 0);

  // 有 askUser → 返回用户答复
  const answer = await t.run({ question: 'q', options: ['A'] }, { askUser: async (req) => 'A' });
  check('有 askUser 时返回用户答复', answer === 'A');
  check('askUser 收到 question', (() => {
    let got = '';
    t.run({ question: '矛盾在哪？', options: [] }, { askUser: async (req) => { got = req.question; return 'x'; } });
    return got === '矛盾在哪？';
  })());

  console.log('\nRESULT pass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})();
