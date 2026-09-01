'use strict';
/**
 * 视觉与功能协调系统 · 第一/二层（设计令牌 + 原子组件库）与提示词注入测试。
 * 复制 test/configWeak.js 的 vscode 桩以便 require prompts/config。
 */
const Module = require('module');
const origLoad = Module._load;
const store = {};
const configObj = {
  get: (k, d) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d),
  update: async () => {},
  inspect: () => ({})
};
const vscodeMock = {
  workspace: { getConfiguration: () => configObj, workspaceFolders: [] },
  secrets: { get: async () => '', store: async () => {}, delete: async () => {} },
  window: { createOutputChannel: () => ({ append() {}, appendLine() {}, show() {} }), showErrorMessage() {}, showInformationMessage: async () => {}, showWarningMessage() {} },
  env: { machineId: 't', sessionId: 't', language: 'zh-cn' },
  Uri: { parse: (s) => ({ fsPath: s, toString: () => s }) },
  extensions: { getExtension: () => null, all: [] }
};
Module._load = function (request) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const tokens = require('../src/designSystem/tokens');
const atoms = require('../src/designSystem/atoms');
const prompts = require('../src/prompts');

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; } else { failed++; console.log('  ✗ ' + name); } }
function includes(name, hay, needle) { ok(name, typeof hay === 'string' && hay.includes(needle)); }

// ---- 令牌（第一层）----
ok('主色锁定 #1890ff', tokens.DEFAULT_TOKENS.color.primary === '#1890ff');
ok('圆角锁定 8px (radius.md)', tokens.DEFAULT_TOKENS.radius.md === '8px');
ok('栅格间距锁定 20px (space.lg)', tokens.DEFAULT_TOKENS.space.lg === '20px');
const css = tokens.cssVarBlock();
includes('cssVarBlock 含主色变量', css, '--fox-color-primary: #1890ff;');
includes('cssVarBlock 含圆角变量', css, '--fox-radius-md: 8px;');
includes('cssVarBlock 含间距变量', css, '--fox-space-lg: 20px;');
const cat = tokens.promptCatalog();
includes('promptCatalog 含主色', cat, '#1890ff');
includes('promptCatalog 含圆角 8px', cat, '8px');
includes('promptCatalog 含间距 20px', cat, '20px');

// ---- 原子组件（第二层）----
const tags = atoms.ATOMS.map((a) => a.tag);
ok('原子库含 fox-modal', tags.includes('fox-modal'));
ok('原子库含 fox-button', tags.includes('fox-button'));
ok('fox-modal 契约要求 onclose', !!atoms.ATOMS.find((a) => a.tag === 'fox-modal').props.find((p) => p.name === 'onclose'));
includes('atomsPrompt 含 fox-modal 用法', atoms.atomsPrompt(), '<fox-modal>');

// ---- 提示词注入（开启时）----
const sp = prompts.buildSystemPrompt({}, '', 'function', '');
includes('开启时注入协调系统段', sp, '【视觉与功能协调系统');
includes('开启时注入主色', sp, '#1890ff');
includes('开启时注入 verify_ui_anchors 工具', sp, 'verify_ui_anchors');
includes('开启时注入 ui_selfcheck 工具', sp, 'ui_selfcheck');
includes('开启时注入 ID 锚定纪律', sp, 'ID 锚定');

// ---- 提示词注入（关闭时）----
const spOff = prompts.buildSystemPrompt({ designSystem: { enabled: false } }, '', 'function', '');
ok('关闭时不注入协调系统段', !spOff.includes('【视觉与功能协调系统'));

// ---- 覆盖令牌 ----
const ov = tokens.resolveTokens({ color: { primary: '#ff0000' } });
ok('令牌可覆盖', ov.color.primary === '#ff0000' && ov.color.error === '#ff4d4f');

console.log(`design-system: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
