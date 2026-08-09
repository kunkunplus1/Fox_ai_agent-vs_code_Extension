'use strict';

// inline.js 顶部强依赖 vscode，这里用 Module._load 拦截，注入 mock，避免加载真实扩展宿主。
const Module = require('module');
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

Module._load = origLoad;
console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
