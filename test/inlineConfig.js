'use strict';

// 验证 config.resolve 对行内补全独立端点的解析逻辑。
const Module = require('module');
const origLoad = Module._load;

let configStore = {};
let secretStore = {};

function makeConf(store) {
  return {
    get: (k, d) => (store.hasOwnProperty(k) ? store[k] : d),
    update: () => Promise.resolve(),
    inspect: () => null
  };
}

const mockVscode = {
  workspace: {
    getConfiguration: () => makeConf(configStore),
    getWorkspaceFolder: () => null
  },
  SecretStorage: class {}
};

Module._load = function (request) {
  if (request === 'vscode') return mockVscode;
  return origLoad.apply(this, arguments);
};

const config = require('../src/config');

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

console.log('行内补全配置解析：');

async function run() {
  // 主模型配 deepseek
  configStore = {
    provider: 'deepseek',
    baseUrl: '',
    model: '',
    apiKey: 'main-key',
    'inlineCompletion.enabled': true,
    'inlineCompletion.provider': '',
    'inlineCompletion.baseUrl': '',
    'inlineCompletion.apiKey': '',
    'inlineCompletion.model': ''
  };
  secretStore = {};
  let r = await config.resolve({ secrets: { get: (k) => Promise.resolve(secretStore[k] || null) } });
  check('未配置时继承主模型端点', () => {
    eq(r.inlineCompletion.provider, '');
    eq(r.inlineCompletion.baseUrl, 'https://api.deepseek.com/v1');
    eq(r.inlineCompletion.apiKey, 'main-key');
    eq(r.inlineCompletion.model, 'deepseek-chat');
    eq(r.inlineCompletion.transport, 'openai');
    eq(r.inlineCompletion.apiMode, 'chat');
  });

  // 独立 provider=ollama，无 apiKey
  configStore['inlineCompletion.provider'] = 'ollama';
  r = await config.resolve({ secrets: { get: (k) => Promise.resolve(secretStore[k] || null) } });
  check('本地供应商无需 API Key', () => {
    eq(r.inlineCompletion.provider, 'ollama');
    eq(r.inlineCompletion.baseUrl, 'http://127.0.0.1:11434/v1');
    eq(r.inlineCompletion.apiKey, '');
    eq(r.inlineCompletion.model, 'qwen2.5-coder:7b');
    eq(r.inlineCompletion.meta.local, true);
  });

  // 独立 provider=deepseek，不填则 fallback 主模型 key
  configStore['inlineCompletion.provider'] = 'deepseek';
  configStore['inlineCompletion.baseUrl'] = '';
  configStore['inlineCompletion.apiKey'] = '';
  configStore['inlineCompletion.model'] = '';
  r = await config.resolve({ secrets: { get: (k) => Promise.resolve(secretStore[k] || null) } });
  check('独立供应商未填 Key 时回落主模型 Key', () => {
    eq(r.inlineCompletion.baseUrl, 'https://api.deepseek.com/v1');
    eq(r.inlineCompletion.apiKey, 'main-key');
    eq(r.inlineCompletion.model, 'deepseek-chat');
  });

  // 独立 provider=deepseek，全自定义
  configStore['inlineCompletion.baseUrl'] = 'https://custom.example/v1';
  configStore['inlineCompletion.apiKey'] = 'inline-key';
  configStore['inlineCompletion.model'] = 'custom-coder';
  r = await config.resolve({ secrets: { get: (k) => Promise.resolve(secretStore[k] || null) } });
  check('独立供应商使用自定义 baseUrl/apiKey/model', () => {
    eq(r.inlineCompletion.baseUrl, 'https://custom.example/v1');
    eq(r.inlineCompletion.apiKey, 'inline-key');
    eq(r.inlineCompletion.model, 'custom-coder');
  });

  // 自定义 baseUrl 时自动去尾斜杠
  configStore['inlineCompletion.baseUrl'] = 'https://custom.example/v1///';
  r = await config.resolve({ secrets: { get: (k) => Promise.resolve(secretStore[k] || null) } });
  check('baseUrl 自动去除尾部斜杠', () => {
    eq(r.inlineCompletion.baseUrl, 'https://custom.example/v1');
  });

  // 独立 provider 空但自定义 baseUrl：baseUrl 用自定义，key/model 继承主模型
  configStore['inlineCompletion.provider'] = '';
  configStore['inlineCompletion.baseUrl'] = 'https://mixed.example/v1';
  configStore['inlineCompletion.apiKey'] = '';
  configStore['inlineCompletion.model'] = '';
  r = await config.resolve({ secrets: { get: (k) => Promise.resolve(secretStore[k] || null) } });
  check('provider 空但 baseUrl 自定义时混合继承', () => {
    eq(r.inlineCompletion.baseUrl, 'https://mixed.example/v1');
    eq(r.inlineCompletion.apiKey, 'main-key');
    eq(r.inlineCompletion.model, 'deepseek-chat');
  });

  Module._load = origLoad;
  console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
