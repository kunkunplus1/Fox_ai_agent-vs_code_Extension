'use strict';

/**
 * 1.1.32：纯问候/闲聊直答护栏回归测试。
 *  - isChatter：极短 + 无任务/时效性关键词 → true（聊天轮直答、不调工具）
 *  - text-only 手册模式：不再强制「第一步必须先调 get_tools」
 * 运行：node test/chat-direct.test.js
 */

const Module = require('module');
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') {
    return {
      workspace: { getConfiguration: () => ({ get: (k, d) => d, update: async () => {} }) },
      window: {}, commands: {}, Event: class {}, Uri: { file: (p) => ({ fsPath: p }) }
    };
  }
  return origLoad.apply(this, arguments);
};

const { isChatter, buildSystemPrompt } = require('../src/agent.js');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' => ' + JSON.stringify(extra) : '')); }
}

/* ---------- 1. 闲聊判定：该直答的 ---------- */
check('你好 → 闲聊', isChatter('你好') === true);
check('hello → 闲聊', isChatter('hello') === true);
check('嗯 → 闲聊', isChatter('嗯') === true);
check('谢谢！ → 闲聊', isChatter('谢谢！') === true);
check('好的收到 → 闲聊', isChatter('好的收到') === true);
check('在吗？ → 闲聊', isChatter('在吗？') === true);
check('晚上好呀 → 闲聊', isChatter('晚上好呀') === true);

/* ---------- 2. 非闲聊：必须走工具的 ---------- */
check('帮我读取 main.js → 非闲聊', isChatter('帮我读取 main.js') === false);
check('如何优化代码 → 非闲聊', isChatter('如何优化代码') === false);
check('为什么报错 → 非闲聊', isChatter('为什么报错') === false);
check('现在几点 → 非闲聊（需调时间工具）', isChatter('现在几点') === false);
check('今天天气 → 非闲聊（需联网）', isChatter('今天天气') === false);
check('最新版本 → 非闲聊（需联网）', isChatter('最新版本') === false);
check('检查一下文件 → 非闲聊', isChatter('检查一下文件') === false);
check('长句 >10 字 → 非闲聊', isChatter('你好，我想了解一下你们的功能有哪些') === false);
check('空串 → 非闲聊', isChatter('') === false);

/* ---------- 3. text-only 手册模式：不再强制首轮 get_tools ---------- */
const cfgTextOnly = {
  systemPrompt: '你是一位工程师。',
  meta: { textOnly: true },
  guardrails: {},
  planAndExecute: {},
  provider: 'webai2api',
  apiMode: 'chat'
};
const sys = buildSystemPrompt(cfgTextOnly, '', 'text', '你好');
check('text-only system 不再含「必须先调用 get_tools」', !/必须先调用 get_tools/.test(sys), sys.slice(0, 80));
check('text-only system 含「问候/闲聊…不要调用 get_tools」', /问候\/闲聊/.test(sys), sys.slice(0, 120));

console.log('\nRESULT pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
