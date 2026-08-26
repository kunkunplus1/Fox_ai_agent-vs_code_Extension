'use strict';

// inline.js 顶部强依赖 vscode，这里用 Module._load 拦截，注入 mock，避免加载真实扩展宿主。
const Module = require('module');
const assert = require('assert');
const noop = () => {};

const baseVscode = {
  window: { createOutputChannel: () => ({ appendLine: noop, clear: noop }) },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => d, update: noop, inspect: () => null }),
    getWorkspaceFolder: () => null
  },
  languages: { registerInlineCompletionItemProvider: noop, registerInlineCompletionProvider: noop },
  Range: class { constructor(a, b, c, d) { this.a = a; this.b = b; this.c = c; this.d = d; } },
  InlineCompletionItem: class { constructor(t, r) { this.text = t; this.range = r; } },
  ConfigurationTarget: { Global: 1 }
};
const handler = { get(t, p) { return (p in t) ? t[p] : new Proxy(noop, handler); } };
const mockVscode = new Proxy(baseVscode, handler);
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return mockVscode;
  return origLoad.apply(this, arguments);
};

const inline = require('../src/inline');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); }
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || '') + ' 期望 ' + JSON.stringify(expected) + ' 实际 ' + JSON.stringify(actual));
  }
}

console.log('行内补全单元：');
check('模块可加载且导出 createInlineProvider', () => {
  if (typeof inline.createInlineProvider !== 'function') throw new Error('createInlineProvider 不是函数');
});
check('cleanup 去除 ``` 围栏', () => eq(inline.cleanup('```js\nfoo\n```'), 'foo\n'));
check('cleanup 去除 <|im_start|> 特殊 token', () => eq(inline.cleanup('<|im_start|>bar'), 'bar'));
check('trimOverlap 去除开头重复的光标前文本', () => eq(inline.trimOverlap('int jka() {', 'int jka()', ''), ' {'));
check('trimOverlap 去除结尾重复的光标后文本', () => eq(inline.trimOverlap('void;}', 'int jka()', 'void;'), '}'));
check('pickCompletionModel 无专用时回落主模型', () => eq(inline.pickCompletionModel({ get: () => '' }, { model: 'main-1' }), 'main-1'));
check('pickCompletionModel 优先专用模型', () => eq(inline.pickCompletionModel({ get: (k) => k === 'inlineCompletion.model' ? 'fast' : '' }, { model: 'main-1' }), 'fast'));
check('pickCompletionModel 无配置时回落 inlineCompletion.model', () => eq(inline.pickCompletionModel({ get: () => '' }, { model: 'main-1', inlineCompletion: { model: 'inline-fast' } }), 'inline-fast'));
check('pickCompletionModel 同时存在时优先 cfg 自定义模型', () => eq(inline.pickCompletionModel({ get: (k) => k === 'inlineCompletion.model' ? 'cfg-fast' : '' }, { model: 'main-1', inlineCompletion: { model: 'inline-fast' } }), 'cfg-fast'));
check('pickCompletionModel 都无则返回空串', () => eq(inline.pickCompletionModel({ get: () => '' }, null), ''));

check('detectFimStrategy auto 识别 codellama', () => eq(inline.detectFimStrategy('auto', 'codellama-7b'), 'codellama'));
check('detectFimStrategy auto 识别 deepseek', () => eq(inline.detectFimStrategy('auto', 'deepseek-chat'), 'deepseek'));
check('detectFimStrategy auto 识别 starcoder', () => eq(inline.detectFimStrategy('auto', 'starcoder2-15b'), 'starcoder'));
check('detectFimStrategy auto 识别 qwen coder', () => eq(inline.detectFimStrategy('auto', 'qwen2.5-coder-32b'), 'starcoder'));
check('detectFimStrategy auto 默认 diffusion', () => eq(inline.detectFimStrategy('auto', 'gpt-4o'), 'diffusion'));
check('detectFimStrategy 显式策略优先', () => eq(inline.detectFimStrategy('none', 'codellama-7b'), 'none'));

check('buildFimPrompt diffusion 格式', () => eq(
  inline.buildFimPrompt('prefix', 'suffix', 'diffusion'),
  '<fim_prefix>prefix<fim_suffix>suffix<fim_middle>'
));
check('buildFimPrompt codellama 格式', () => eq(
  inline.buildFimPrompt('prefix', 'suffix', 'codellama'),
  '<PRE>prefix<SUF>suffix<MID>'
));
check('buildFimPrompt deepseek 格式', () => eq(
  inline.buildFimPrompt('prefix', 'suffix', 'deepseek'),
  '<｜fim▁begin｜>prefix<｜fim▁hole｜>suffix<｜fim▁end｜>'
));
check('cleanup 去除 FIM token', () => eq(
  inline.cleanup('<fim_prefix>foo<fim_middle>'),
  'foo'
));
check('trimOverlap 去除结尾回显的光标后文本', () => eq(
  inline.trimOverlap('hello world', 'foo(', 'world'),
  'hello '
));

// —— 深度适配：DeepSeek 思考模型判定 + thinking 参数构造（官方文档：deepseek-reasoner 不支持 FIM）——
check('isDeepSeekReasoner 识别 deepseek-reasoner', () => {
  assert.ok(inline.isDeepSeekReasoner('deepseek-reasoner'));
  assert.ok(inline.isDeepSeekReasoner('deepseek-v4-pro'));
  assert.ok(inline.isDeepSeekReasoner('DeepSeek-R1'));
});
check('isDeepSeekReasoner 不误判 deepseek-chat', () => {
  assert.ok(!inline.isDeepSeekReasoner('deepseek-chat'));
  assert.ok(!inline.isDeepSeekReasoner('deepseek-coder'));
  assert.ok(!inline.isDeepSeekReasoner('gpt-4o'));
});

check('buildInlineExtraBody off 不注入', () => eq(
  JSON.stringify(inline.buildInlineExtraBody({ thinking: 'off', transport: 'openai' }, 'gpt-4o')),
  '{}'
));
check('buildInlineExtraBody openai+on → reasoning_effort', () => {
  const b = inline.buildInlineExtraBody({ thinking: 'on', thinkingEffort: 'high', transport: 'openai' }, 'gpt-5');
  assert.strictEqual(b.reasoning_effort, 'high');
});
check('buildInlineExtraBody openai+deepseek-reasoner 不传参数（官方无 reasoning_effort）', () => {
  const b = inline.buildInlineExtraBody({ thinking: 'on', thinkingEffort: 'low', transport: 'openai' }, 'deepseek-reasoner');
  assert.strictEqual(JSON.stringify(b), '{}');
});
check('buildInlineExtraBody anthropic+on → thinking.budget_tokens', () => {
  const b = inline.buildInlineExtraBody({ thinking: 'on', thinkingEffort: 'medium', transport: 'anthropic', maxTokens: 8192 }, 'claude-sonnet-4');
  assert.strictEqual(b.thinking.type, 'enabled');
  assert.strictEqual(b.thinking.budget_tokens, 4096);
});
check('buildInlineExtraBody anthropic budget 恒 < maxTokens', () => {
  // maxTokens=2048 时 high(8192) 被压到 maxTokens-1024=1024 以下，保证 Anthropic API 不报错
  const b = inline.buildInlineExtraBody({ thinking: 'on', thinkingEffort: 'high', transport: 'anthropic', maxTokens: 2048 }, 'claude-sonnet-4');
  assert.ok(b.thinking.budget_tokens < 2048, 'budget 必须 < maxTokens，实际=' + b.thinking.budget_tokens);
});
check('buildInlineExtraBody anthropic 默认 openai transport 时按 openai 处理', () => {
  const b = inline.buildInlineExtraBody({ thinking: 'on', thinkingEffort: 'low', transport: 'openai' }, 'gpt-5');
  assert.strictEqual(b.reasoning_effort, 'low');
});

// —— 异步单测：fimCompleteOnce 专用 FIM 端点（DeepSeek Beta /completions）——
const asyncChecks = [];
function checkAsync(name, fn) { asyncChecks.push({ name, fn }); }

checkAsync('fimCompleteOnce 命中 /completions 且取 choices[0].text', async () => {
  const client = require('../src/client');
  let calledUrl = null, calledBody = null;
  const stub = async (url, opts) => { calledUrl = url; calledBody = opts.body; return { choices: [{ text: '  filled  ' }] }; };
  const { promise } = client.fimCompleteOnce({
    baseUrl: 'https://api.deepseek.com/beta/',
    apiKey: 'k', model: 'deepseek-coder',
    prompt: 'def f', suffix: 'return', maxTokens: 64, stop: ['\n\n'],
    _requestJson: stub
  });
  const r = await promise;
  if (calledUrl !== 'https://api.deepseek.com/beta/completions') throw new Error('url=' + calledUrl);
  if (r.content !== '  filled  ') throw new Error('content=' + JSON.stringify(r.content));
  if (calledBody.model !== 'deepseek-coder') throw new Error('model=' + calledBody.model);
  if (calledBody.prompt !== 'def f') throw new Error('prompt=' + calledBody.prompt);
  if (calledBody.suffix !== 'return') throw new Error('suffix=' + calledBody.suffix);
  if (calledBody.max_tokens !== 64) throw new Error('max_tokens=' + calledBody.max_tokens);
  if (!Array.isArray(calledBody.stop) || calledBody.stop[0] !== '\n\n') throw new Error('stop=' + JSON.stringify(calledBody.stop));
  if (calledBody.stream !== false) throw new Error('stream=' + calledBody.stream);
});

checkAsync('fimCompleteOnce 无 suffix 时不发送 suffix 字段', async () => {
  const client = require('../src/client');
  let calledBody = null;
  const stub = async (url, opts) => { calledBody = opts.body; return { choices: [{ text: '' }] }; };
  const { promise } = client.fimCompleteOnce({
    baseUrl: 'https://api.deepseek.com/beta', apiKey: 'k', model: 'm',
    prompt: 'p', maxTokens: 16, _requestJson: stub
  });
  await promise;
  if ('suffix' in calledBody) throw new Error('suffix 不应出现：' + JSON.stringify(calledBody));
});

checkAsync('fimCompleteOnce 服务端 error 抛异常', async () => {
  const client = require('../src/client');
  const stub = async () => ({ error: { message: 'bad model' } });
  let threw = false;
  try {
    const { promise } = client.fimCompleteOnce({ baseUrl: 'x', apiKey: 'k', model: 'm', prompt: 'p', _requestJson: stub });
    await promise;
  } catch (e) {
    threw = true;
    if (!/bad model/.test(e.message)) throw new Error('msg=' + e.message);
  }
  if (!threw) throw new Error('未抛错');
});

Module._load = origLoad;
(async () => {
  for (const ac of asyncChecks) {
    try { await ac.fn(); pass++; console.log('  ✓ ' + ac.name); }
    catch (e) { fail++; console.log('  ✗ ' + ac.name + ' → ' + e.message); }
  }
  console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
