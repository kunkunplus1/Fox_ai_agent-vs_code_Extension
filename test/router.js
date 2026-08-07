'use strict';
// 前置路由门控测试：验证 shouldRoute 各分支与 answerWithRag
// 依赖（knowledgeBase / client）通过 require.cache 注入 mock，避免加载 vscode
const assert = require('assert');
const path = require('path');

const kbPath = require.resolve(path.join(__dirname, '../src/knowledgeBase'));
require.cache[kbPath] = {
  id: kbPath, filename: kbPath, loaded: true,
  exports: {
    isEnabled: () => true,
    retrieve: () => '资料片段：狐狸 AI 是一只修行三百年的小狐狸。'
  }
};
const clientPath = require.resolve(path.join(__dirname, '../src/client'));
require.cache[clientPath] = {
  id: clientPath, filename: clientPath, loaded: true,
  exports: { chatNonStream: async () => ({ content: '狐狸 AI 是修行三百年的小狐狸。' }) }
};

const router = require('../src/router');
const { shouldRoute, answerWithRag, ACTION_RE, QUESTION_RE } = router;

let pass = 0;
function ok(name, cond) {
  assert.ok(cond, '❌ ' + name);
  console.log('✅ ' + name);
  pass++;
}

const cfgOn = { routing: { gateEnabled: true, maxQueryLen: 120 }, baseUrl: 'x', apiKey: 'k', model: 'm', timeout: 1000 };
const cfgOff = { routing: { gateEnabled: false, maxQueryLen: 120 } };

// 1) 门控关闭 → 不路由
ok('gate off -> false', shouldRoute('狐狸 AI 是什么？', cfgOff) === false);
// 2) 简单问答命中 → 路由
const hit = shouldRoute('狐狸 AI 是什么？', cfgOn);
ok('simple question -> routed', hit && hit.query === '狐狸 AI 是什么？' && /资料片段/.test(hit.ctx));
// 3) 过长 → 不路由
ok('too long -> false', shouldRoute('狐狸'.repeat(200) + '是什么？', cfgOn) === false);
// 4) 动作意图 → 不路由
ok('action intent -> false', shouldRoute('帮我写一个排序函数', cfgOn) === false);
// 5) 非问句 → 不路由
ok('not a question -> false', shouldRoute('狐狸 AI 的文档', cfgOn) === false);
// 6) 斜杠命令 → 不路由
ok('slash cmd -> false', shouldRoute('/mcp foo bar', cfgOn) === false);

(async () => {
  // 7) answerWithRag 返回文本
  const ans = await answerWithRag('狐狸 AI 是什么？', '资料片段：小狐狸。', cfgOn);
  ok('answerWithRag returns text', ans === '狐狸 AI 是修行三百年的小狐狸。');
  // 8) 正则导出可用
  ok('ACTION_RE matches', ACTION_RE.test('帮我运行测试'));
  ok('QUESTION_RE matches', QUESTION_RE.test('如何配置？'));
  console.log('\n[router] 通过 ' + pass + ' 项断言');
})();
