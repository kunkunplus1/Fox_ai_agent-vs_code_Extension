'use strict';

/**
 * 本地弱模型辅助模式 · 配置层测试（1.1.17）：
 * 验证 config.resolve 在 auto/on/off 下正确计算 localWeak，
 * 并强制开启 dynamicSubset 且收紧 topK（≤5）。
 */

const Module = require('module');
const origLoad = Module._load;

// 可控设置表
const store = {};
function setStore(o) { for (const k of Object.keys(store)) delete store[k]; Object.assign(store, o); }

const configObj = {
  get: (k, d) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d),
  update: async () => {},
  inspect: () => ({})
};
const vscodeMock = {
  workspace: { getConfiguration: () => configObj, workspaceFolders: [] },
  secrets: { get: async () => '', store: async () => {}, delete: async () => {} },
  window: {
    createOutputChannel: () => ({ append() {}, appendLine() {}, show() {} }),
    showErrorMessage() {}, showInformationMessage: async () => {}, showWarningMessage() {}
  },
  env: { machineId: 't', sessionId: 't', language: 'zh-cn' },
  Uri: { parse: (s) => ({ fsPath: s, toString: () => s }) },
  extensions: { getExtension: () => null, all: [] }
};

Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const config = require('../src/config');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗', name); }
}

const ctx = { secrets: { get: async () => '' } };

(async () => {
  console.log('[configWeak] 1) auto 模式：本地 llamacpp 默认开启弱模型模式');
  setStore({ provider: 'llamacpp', 'agent.localWeakModelMode': 'auto' });
  let c = await config.resolve(ctx);
  check('localWeak = true（auto + 本地）', c.localWeak === true);
  check('dynamicSubset 被强制开启', c.tools.dynamicSubset.enabled === true);
  check('topK 被收紧到 ≤5', c.tools.dynamicSubset.topK <= 5);
  check('localConstrainedDecoding 默认 auto（先探测服务端是否支持，支持才注入）', c.localConstrainedDecoding === 'auto');
  check('weakHistoryRounds 默认 2', c.weakHistoryRounds === 2);

  console.log('[configWeak] 2) on 模式：即使是云端模型也强制开启');
  setStore({ provider: 'deepseek', 'agent.localWeakModelMode': 'on' });
  c = await config.resolve(ctx);
  check('localWeak = true（on 强制开）', c.localWeak === true);
  check('云端模型 on 也强制 dynamicSubset', c.tools.dynamicSubset.enabled === true);

  console.log('[configWeak] 3) off 模式：关闭弱模型模式');
  setStore({ provider: 'llamacpp', 'agent.localWeakModelMode': 'off' });
  c = await config.resolve(ctx);
  check('localWeak = false（off）', c.localWeak === false);
  check('off 时 dynamicSubset 不强制（默认关）', c.tools.dynamicSubset.enabled === false);
  check('off 时 topK 恢复默认 12', c.tools.dynamicSubset.topK === 12);

  console.log('[configWeak] 4) auto 模式：云端模型默认不开启');
  setStore({ provider: 'deepseek', 'agent.localWeakModelMode': 'auto' });
  c = await config.resolve(ctx);
  check('localWeak = false（auto + 云端）', c.localWeak === false);
  check('云端 auto 下 dynamicSubset 默认关', c.tools.dynamicSubset.enabled === false);

  console.log('[configWeak] 5) 用户显式 topK 被弱模型模式收窄但不放大');
  setStore({ provider: 'llamacpp', 'agent.localWeakModelMode': 'auto', 'tools.dynamicSubset.topK': 3 });
  c = await config.resolve(ctx);
  check('topK=3 被保留（≤5）', c.tools.dynamicSubset.topK === 3);
  setStore({ provider: 'llamacpp', 'agent.localWeakModelMode': 'auto', 'tools.dynamicSubset.topK': 20 });
  c = await config.resolve(ctx);
  check('topK=20 被收窄到 5', c.tools.dynamicSubset.topK === 5);

  console.log(`\n[configWeak] 通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})();
