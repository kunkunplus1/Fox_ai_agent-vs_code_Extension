/**
 * 验证 generate_image 的厂商自动路由（1.1.31）：
 *  - classifyImageVendor：阿里百炼/万相 → dashscope-native；OpenAI DALL·E → openai-images；其余 → openai-chat。
 *  - deriveNativeBase：从兼容端点 /v1、/compatible-mode/v1 推导出厂商原生 API origin。
 *  - normalizeDashscopeSize / normalizeOpenAISize：尺寸格式归一化。
 * 纯函数离线测试，不触碰网络 / vscode。
 */
const assert = require('assert');
const Module = require('module');

/* vscode mock（与 officialSearchFormat.js 一致，防止任何间接依赖在宿主外加载失败） */
const vscodeMock = {
  workspace: { workspaceFolders: null, getConfiguration: () => ({ get: (k, d) => d, update: async () => {} }), textDocuments: [], fs: {} },
  window: { activeTextEditor: null, activeTerminal: null, tabGroups: { all: [] } },
  languages: { getDiagnostics: () => [] },
  commands: { executeCommand: async () => {} },
  env: { clipboard: { readText: async () => '', writeText: async () => {} } },
  Uri: { file: (p) => ({ fsPath: p, toString: () => 'file://' + p }), joinPath: () => ({}) },
  Position: class {}, Range: class {}, Selection: class {}, ThemeIcon: class {},
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  FileType: { File: 1, Directory: 2 }, InlineCompletionItem: class {},
  ConfigurationTarget: { Global: 1 }, TextEditorRevealType: { InCenter: 2 }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const { classifyImageVendor, deriveNativeBase, normalizeDashscopeSize, normalizeOpenAISize } = require('../src/tools/imageGen');

let pass = 0;
function check(name, cond) {
  assert.ok(cond, '❌ ' + name);
  console.log('✅ ' + name);
  pass++;
}

// 1) classifyImageVendor：百炼/万相一律原生异步；OpenAI DALL·E 走 images；其余 chat
{
  const dash1 = classifyImageVendor({ provider: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'wanx2.1-t2i-turbo' });
  check('vendor: 百炼 + wanx2.1-t2i-turbo → dashscope-native', dash1 === 'dashscope-native');

  const dash2 = classifyImageVendor({ provider: 'custom', baseUrl: 'https://ws-oe4njbdit15p0wjp.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'wanx-v1' });
  check('vendor: MaaS 私有域名 + wanx-v1 → dashscope-native', dash2 === 'dashscope-native');

  const dash3 = classifyImageVendor({ provider: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-image-plus' });
  check('vendor: 百炼 + qwen-image-plus → dashscope-native（通义万相也走原生）', dash3 === 'dashscope-native');

  const oai1 = classifyImageVendor({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'dall-e-3' });
  check('vendor: openai + dall-e-3 → openai-images', oai1 === 'openai-images');

  const oai2 = classifyImageVendor({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1' });
  check('vendor: openai + gpt-image-1 → openai-images', oai2 === 'openai-images');

  const chat1 = classifyImageVendor({ provider: 'custom', baseUrl: 'https://my.proxy.example.com/v1', model: 'qwen-image' });
  check('vendor: 非百炼第三方代理 + qwen-image → openai-chat（不误判）', chat1 === 'openai-chat');

  const chat2 = classifyImageVendor({ provider: 'llamacpp', baseUrl: 'http://localhost:8080/v1', model: 'stable-diffusion' });
  check('vendor: 本地模型 → openai-chat', chat2 === 'openai-chat');

  const chat3 = classifyImageVendor({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: '' });
  check('vendor: openai 但模型名非生图 → openai-chat（不误走 images）', chat3 === 'openai-chat');
}

// 2) deriveNativeBase：兼容端点 → 原生 origin
{
  check('base: dashscope compatible-mode/v1', deriveNativeBase('https://dashscope.aliyuncs.com/compatible-mode/v1') === 'https://dashscope.aliyuncs.com');
  check('base: MaaS 私有域名 compatible-mode/v1', deriveNativeBase('https://ws-oe4njbdit15p0wjp.cn-beijing.maas.aliyuncs.com/compatible-mode/v1') === 'https://ws-oe4njbdit15p0wjp.cn-beijing.maas.aliyuncs.com');
  check('base: 已带 /v1', deriveNativeBase('https://dashscope.aliyuncs.com/v1') === 'https://dashscope.aliyuncs.com');
  check('base: 末尾斜杠', deriveNativeBase('https://dashscope.aliyuncs.com/') === 'https://dashscope.aliyuncs.com');
  check('base: 已是原生（无路径）', deriveNativeBase('https://dashscope.aliyuncs.com') === 'https://dashscope.aliyuncs.com');
  check('base: openai /v1', deriveNativeBase('https://api.openai.com/v1') === 'https://api.openai.com');
}

// 3) normalizeDashscopeSize：归一化为 宽*高
{
  check('dsize: 1024x1024 → 1024*1024', normalizeDashscopeSize('1024x1024') === '1024*1024');
  check('dsize: 已星号保留', normalizeDashscopeSize('1024*1024') === '1024*1024');
  check('dsize: 全角 × 转换', normalizeDashscopeSize('1280×720') === '1280*720');
  check('dsize: 单数字补成正方形', normalizeDashscopeSize('1024') === '1024*1024');
  check('dsize: 空 → 空', normalizeDashscopeSize('') === '');
  check('dsize: 非法 → 空（交默认）', normalizeDashscopeSize('weird') === '');
}

// 4) normalizeOpenAISize：归一化为 宽x高
{
  check('osize: 1024*1024 → 1024x1024', normalizeOpenAISize('1024*1024') === '1024x1024');
  check('osize: 已 x 保留', normalizeOpenAISize('1024x1024') === '1024x1024');
  check('osize: 单数字补成正方形', normalizeOpenAISize('1024') === '1024x1024');
  check('osize: 空 → 空', normalizeOpenAISize('') === '');
  check('osize: 非法 → 空', normalizeOpenAISize('abc') === '');
}

console.log('\n全部通过：' + pass + ' 项 ✅');
