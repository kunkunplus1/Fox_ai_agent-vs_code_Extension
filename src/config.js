'use strict';

const vscode = require('vscode');
const { PROVIDERS } = require('./providers');

const SECRET_PREFIX = 'foxAi.apiKey.';

function conf() {
  return vscode.workspace.getConfiguration('foxAi');
}

function currentProviderId() {
  const id = conf().get('provider') || 'llamacpp';
  return PROVIDERS[id] ? id : 'llamacpp';
}

function providerMeta(id) {
  return PROVIDERS[id || currentProviderId()] || PROVIDERS.llamacpp;
}

function baseUrlFor(id) {
  const custom = (conf().get('baseUrl') || '').trim();
  if (custom) return custom.replace(/\/+$/, '');
  return (providerMeta(id).baseUrl || '').replace(/\/+$/, '');
}

function modelName(id) {
  const custom = (conf().get('model') || '').trim();
  if (custom) return custom;
  return providerMeta(id).model || 'local-model';
}

async function getApiKey(context, id) {
  const pid = id || currentProviderId();
  if (providerMeta(pid).local) return '';
  const secret = await context.secrets.get(SECRET_PREFIX + pid);
  if (secret) return secret;
  const plain = (conf().get('apiKey') || '').trim();
  return plain;
}

async function setApiKey(context, id, value) {
  await context.secrets.store(SECRET_PREFIX + (id || currentProviderId()), value);
}

async function clearApiKey(context, id) {
  await context.secrets.delete(SECRET_PREFIX + (id || currentProviderId()));
}

/** 行内补全专用 API Key：优先独立 secret，再 plain text，最后回落到主对话模型（兼容旧行为）。 */
async function getInlineApiKey(context, id) {
  const pid = id || currentProviderId();
  if (providerMeta(pid).local) return '';
  const secret = await context.secrets.get(SECRET_PREFIX + 'inlineCompletion.' + pid);
  if (secret) return secret;
  const plain = (conf().get('inlineCompletion.apiKey') || '').trim();
  if (plain) return plain;
  return getApiKey(context, pid);
}

// 整理 AI 专用：独立 secret 键，绝不写入主控 agent 的 apiKey 槽，避免互相覆盖。
// 键格式：foxAi.apiKey.organize.<providerId>（如 foxAi.apiKey.organize.deepseek）
async function getOrganizeApiKey(context, id) {
  const pid = id || 'llamacpp';
  const secret = await context.secrets.get(SECRET_PREFIX + 'organize.' + pid);
  if (secret) return secret;
  // 兼容旧版本：整理 key 曾直接写入主 apiKey 槽（foxAi.apiKey.<pid>）
  return getApiKey(context, pid);
}

async function setOrganizeApiKey(context, id, value) {
  await context.secrets.store(SECRET_PREFIX + 'organize.' + (id || 'llamacpp'), value);
}

/** 汇总一次调用需要的全部参数 */
async function resolve(context) {
  const id = currentProviderId();
  const c = conf();

  // 行内补全可独立配置端点；未设置时整体继承主对话模型。
  const inlineProvider = (c.get('inlineCompletion.provider') || '').trim();
  const inlinePid = inlineProvider || id;
  const inlineMeta = providerMeta(inlinePid);
  const inlineBaseUrl = (c.get('inlineCompletion.baseUrl') || '').trim().replace(/\/+$/, '')
    || (inlineProvider ? inlineMeta.baseUrl : baseUrlFor(id))
    || '';
  const inlineModel = (c.get('inlineCompletion.model') || '').trim()
    || (inlineProvider ? inlineMeta.model : modelName(id))
    || '';
  const inlineApiKey = inlineProvider
    ? (inlineMeta.local ? '' : await getInlineApiKey(context, inlinePid))
    : await getApiKey(context, id);

  return {
    providerId: id,
    provider: id, // 兼容仍使用 cfg.provider 的代码（如 agent.js 的 DeepSeek 判断）
    meta: providerMeta(id),
    baseUrl: baseUrlFor(id),
    model: modelName(id),
    apiKey: await getApiKey(context, id),
    temperature: c.get('temperature', 0.3),
    maxTokens: c.get('maxTokens', 2048),
    timeout: c.get('timeout', 30000),
    maxHistory: c.get('maxHistory', 20),
    systemPrompt: c.get('systemPrompt', ''),
    forceNonStream: c.get('forceNonStream', false),
    streamFormat: c.get('streamFormat', 'auto'),
    insecureHttpParser: c.get('insecureHttpParser', false),
    transport: (PROVIDERS[id] && PROVIDERS[id].transport) || 'openai',
    apiMode: (PROVIDERS[id] && PROVIDERS[id].transport) === 'anthropic'
      ? 'chat'
      : c.get('apiMode', (PROVIDERS[id] && PROVIDERS[id].apiMode) || 'chat'),
    deepThinking: {
      enabled: c.get('deepThinking.enabled', false),
      effort: c.get('deepThinking.effort', 'medium'),
      budgetTokens: c.get('deepThinking.budgetTokens', 0),
      promptFallback: c.get('deepThinking.promptFallback', true)
    },
    inlineCompletion: {
      enabled: c.get('inlineCompletion.enabled', true),
      provider: inlineProvider,
      baseUrl: inlineBaseUrl,
      apiKey: inlineApiKey,
      model: inlineModel,
      meta: inlineMeta,
      transport: 'openai',
      apiMode: 'chat',
      maxTokens: c.get('inlineCompletion.maxTokens', 256),
      contextLines: c.get('inlineCompletion.contextLines', 60),
      suffixLines: c.get('inlineCompletion.suffixLines', 30),
      fimStrategy: c.get('inlineCompletion.fimStrategy', 'auto'),
      useProjectContext: c.get('inlineCompletion.useProjectContext', true),
      projectContextChars: c.get('inlineCompletion.projectContextChars', 1000),
      maxFileLines: c.get('inlineCompletion.maxFileLines', 8000),
      debounce: c.get('inlineCompletion.debounce', 350)
    },
    visionMode: c.get('visionMode', 'auto'),
    visionModels: c.get('visionModels', []),
    textOnlyModels: c.get('textOnlyModels', []),
    keepImageTurns: c.get('keepImageTurns', 1),
    visionConfig: {
      enabled: c.get('vision.enabled', false),
      provider: c.get('vision.provider', 'custom'),
      baseUrl: c.get('vision.baseUrl', '').trim().replace(/\/+$/, ''),
      apiKey: c.get('vision.apiKey', ''),
      model: c.get('vision.model', '').trim(),
      apiMode: c.get('vision.apiMode', 'chat'),
      transport: (PROVIDERS[c.get('vision.provider', 'custom')] || {}).transport || 'openai',
      maxTokens: c.get('vision.maxTokens', 1024),
      timeout: c.get('vision.timeout', 30000)
    },
    imageGenConfig: {
      enabled: c.get('imageGen.enabled', false),
      provider: c.get('imageGen.provider', 'custom'),
      baseUrl: c.get('imageGen.baseUrl', '').trim().replace(/\/+$/, ''),
      apiKey: c.get('imageGen.apiKey', ''),
      model: c.get('imageGen.model', '').trim(),
      apiMode: c.get('imageGen.apiMode', 'chat'),
      transport: (PROVIDERS[c.get('imageGen.provider', 'custom')] || {}).transport || 'openai',
      maxTokens: c.get('imageGen.maxTokens', 1024),
      timeout: c.get('imageGen.timeout', 60000)
    },
    contextWindow: c.get('contextWindow', 0),
    showContextUsage: c.get('showContextUsage', true),
    agentEnabled: c.get('agent.enabled', true),
    planAndExecute: {
      enabled: c.get('planAndExecute.enabled', true)
    },
    review: {
      enabled: c.get('review.enabled', true)
    },
    routing: {
      gateEnabled: c.get('routing.gateEnabled', false),
      maxQueryLen: c.get('routing.maxQueryLen', 120)
    },
    tools: {
      dynamicSubset: {
        enabled: c.get('tools.dynamicSubset.enabled', false),
        topK: c.get('tools.dynamicSubset.topK', 12),
        alwaysInclude: c.get('tools.dynamicSubset.alwaysInclude', '')
      }
    },
    guardrails: {
      forceCitation: c.get('guardrails.forceCitation', false)
    },
    planner: {
      enabled: c.get('planner.enabled', false),
      mode: c.get('planner.mode', 'auto'),
      provider: c.get('planner.provider', ''),
      baseUrl: c.get('planner.baseUrl', ''),
      model: c.get('planner.model', ''),
      maxTokens: c.get('planner.maxTokens', 700),
      timeoutMs: c.get('planner.timeoutMs', 30000)
    },
    selfConsistency: {
      enabled: c.get('selfConsistency.enabled', false),
      tools: c.get('selfConsistency.tools', []),
      sampleTemp: c.get('selfConsistency.sampleTemp', 0.8)
    },
    maxSteps: c.get('agent.maxSteps', 12),
    maxContinues: c.get('agent.maxContinues', 3),
    toolProtocol: c.get('agent.toolProtocol', 'auto'),
    autoApprove: c.get('agent.autoApprove', 'read'),
    blockedCommands: c.get('agent.blockedCommands', []),
    policy: c.get('policy', {}),
    maxToolOutput: c.get('agent.maxToolOutput', 8000),
    maxMessageBytes: c.get('agent.maxMessageBytes', 1024 * 1024),
    structuredOutput: c.get('agent.structuredOutput', false),
    projectSkeleton: c.get('agent.projectSkeleton', true),
    includeFileContext: c.get('includeFileContext', true),
    workspace: {
      allowOutsideReads: c.get('workspace.allowOutsideReads', true),
      outsideEditConfirm: c.get('workspace.outsideEditConfirm', 'triple'),
      globalSearchRoot: c.get('workspace.globalSearchRoot', '')
    },
    projectScanCache: c.get('projectScan.cacheEnabled', true),
    nodePath: c.get('nodePath', '') || c.get('node.path', ''),
    planTask: {
      enabled: c.get('planTask.enabled', true),
      provider: c.get('planTask.provider', ''),
      baseUrl: c.get('planTask.baseUrl', ''),
      model: c.get('planTask.model', '')
    },
    verify: {
      enabled: c.get('verify.enabled', false),
      provider: c.get('verify.provider', ''),
      baseUrl: c.get('verify.baseUrl', ''),
      model: c.get('verify.model', '')
    },
    autoSummarize: {
      enabled: c.get('knowledgeBase.autoSummarize.enabled', false),
      threshold: c.get('knowledgeBase.autoSummarize.threshold', 0.9),
      keepRecent: c.get('knowledgeBase.autoSummarize.keepRecent', 6),
      dir: c.get('knowledgeBase.autoSummarize.dir', '')
    }
  };
}

/** 用户自定义的视觉能力白/黑名单（供 capabilities.supportsVision 使用） */
function visionLists() {
  const c = conf();
  return {
    visionModels: c.get('visionModels', []),
    textOnlyModels: c.get('textOnlyModels', [])
  };
}

module.exports = {
  conf,
  visionLists,
  currentProviderId,
  providerMeta,
  baseUrlFor,
  modelName,
  getApiKey,
  setApiKey,
  clearApiKey,
  getInlineApiKey,
  getOrganizeApiKey,
  setOrganizeApiKey,
  resolve,
  PROVIDERS
};
