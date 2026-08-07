'use strict';

/**
 * 所有服务商都走 OpenAI 兼容协议：POST {baseUrl}/chat/completions
 * local = true 的服务商不需要 API Key。
 */
const PROVIDERS = {
  llamacpp: {
    label: 'llama.cpp（本地）',
    detail: 'llama-server 默认 http://127.0.0.1:8080',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'local-model',
    local: true,
    docs: '启动示例：llama-server -m model.gguf -c 8192 --port 8080'
  },
  ollama: {
    label: 'Ollama（本地）',
    detail: '默认 http://127.0.0.1:11434',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5-coder:7b',
    local: true,
    docs: '启动示例：ollama serve；拉模型：ollama pull qwen2.5-coder:7b'
  },
  lmstudio: {
    label: 'LM Studio（本地）',
    detail: '默认 http://127.0.0.1:1234',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
    local: true
  },
  deepseek: {
    label: 'DeepSeek 深度求索',
    detail: 'api.deepseek.com',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys'
  },
  zhipu: {
    label: '智谱 GLM',
    detail: 'open.bigmodel.cn',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys'
  },
  dashscope: {
    label: '通义千问 / 阿里云百炼',
    detail: 'dashscope 兼容模式',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1'
  },
  moonshot: {
    label: '月之暗面 Kimi',
    detail: 'api.moonshot.cn',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys'
  },
  siliconflow: {
    label: '硅基流动 SiliconFlow',
    detail: 'api.siliconflow.cn',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak'
  },
  openrouter: {
    label: 'OpenRouter',
    detail: 'openrouter.ai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-chat',
    keyUrl: 'https://openrouter.ai/keys'
  },
  openai: {
    label: 'OpenAI (Responses API)',
    detail: 'api.openai.com, default uses Responses API (/v1/responses)',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiMode: 'responses',
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  gemini: {
    label: 'Google Gemini（OpenAI 兼容模式）',
    detail: 'generativelanguage.googleapis.com 的 OpenAI 兼容端点',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash',
    keyUrl: 'https://aistudio.google.com/apikey'
  },
  grok: {
    label: 'xAI Grok',
    detail: 'api.x.ai，支持 OpenAI 兼容与 Responses API',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-2-latest',
    apiMode: 'responses',
    keyUrl: 'https://console.x.ai/'
  },
  mistral: {
    label: 'Mistral AI',
    detail: 'api.mistral.ai 的 OpenAI 兼容端点',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-large-latest',
    keyUrl: 'https://console.mistral.ai/'
  },
  claude: {
    label: 'Anthropic Claude（官方 Messages API）',
    detail: 'api.anthropic.com，走原生 Messages 协议（非 OpenAI 兼容）；仅支持 chat 模式，不支持 Responses API',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-20250514',
    apiMode: 'chat',
    transport: 'anthropic',
    notOpenAI: true,
    keyUrl: 'https://console.anthropic.com/settings/keys'
  },
  custom: {
    label: '自定义 OpenAI 兼容服务',
    detail: '在设置里填 foxAi.baseUrl',
    baseUrl: '',
    model: '',
    local: false
  }
};

module.exports = { PROVIDERS };
