'use strict';

/**
 * 验证本地模型协议判定：llama.cpp / Ollama / LM Studio 等本地 provider
 * 默认应走 text 协议，避免被误判为支持 native function calling 而卡死。
 */

function modelSupportsNativeTools(cfg) {
  if (cfg.transport === 'anthropic') return true;
  const model = String(cfg.model || '').toLowerCase();
  const provider = String(cfg.provider || '').toLowerCase();
  if (cfg.meta && cfg.meta.local) return false;
  const textOnlyProviders = ['ollama', 'lmstudio', 'localai', 'text-generation-webui', 'kobold', 'llama.cpp', 'llamacpp', 'tabbyapi'];
  if (textOnlyProviders.includes(provider)) return false;
  if (provider === 'local' || model.includes('.gguf') || model.endsWith('.gguf')) return false;
  const textOnlyModels = [
    'qwen2:', 'qwen2.5:', 'qwen3:', 'qwen3.6', 'phi-', 'gemma-2b', 'gemma-4b',
    'codellama', 'vicuna', 'openchat', 'stablelm', 'dolly', 'starcoder',
    'wizardcoder', 'phind', 'deepseek-r1', 'deepseek-reasoner'
  ];
  for (const h of textOnlyModels) {
    if (model.includes(h)) return false;
  }
  if (/^o[13]-/.test(model)) return false;
  return true;
}

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
    console.log('  ✓', name);
  } else {
    failed++;
    console.log('  ✗', name);
  }
}

console.log('[localModelProtocol] 测试本地模型协议判定');

check('llamacpp 默认 local-model 走 text', !modelSupportsNativeTools({ provider: 'llamacpp', model: 'local-model', meta: { local: true } }));
check('llamacpp 配 Qwen3.6.gguf 走 text', !modelSupportsNativeTools({ provider: 'llamacpp', model: 'Qwen3.6-35B-A3B-APEX-Quality.gguf', meta: { local: true } }));
check('ollama qwen2.5-coder 走 text', !modelSupportsNativeTools({ provider: 'ollama', model: 'qwen2.5-coder:7b', meta: { local: true } }));
check('lm studio 走 text', !modelSupportsNativeTools({ provider: 'lmstudio', model: 'local-model', meta: { local: true } }));
check('custom 本地 .gguf 走 text', !modelSupportsNativeTools({ provider: 'custom', model: 'some-model.gguf', meta: { local: true } }));
check('custom 本地 qwen3.6 走 text', !modelSupportsNativeTools({ provider: 'custom', model: 'Qwen3.6-35B', meta: { local: true } }));
check('deepseek 云端 deepseek-chat 走 native', modelSupportsNativeTools({ provider: 'deepseek', model: 'deepseek-chat', meta: { local: false } }));
check('openai gpt-4o 走 native', modelSupportsNativeTools({ provider: 'openai', model: 'gpt-4o', meta: { local: false } }));
check('anthropic 强制 native', modelSupportsNativeTools({ provider: 'claude', model: 'claude-sonnet-4', transport: 'anthropic', meta: { local: false } }));
check('deepseek-r1 走 text', !modelSupportsNativeTools({ provider: 'custom', model: 'DeepSeek-R1-Distill-Qwen-1.5B', meta: { local: false } }));

console.log(`\n[localModelProtocol] 通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
