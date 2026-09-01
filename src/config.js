'use strict';

const vscode = require('vscode');
const { PROVIDERS } = require('./providers');
const providerProfiles = require('./providerProfiles');

const SECRET_PREFIX = 'foxAi.apiKey.';

function conf() {
  return vscode.workspace.getConfiguration('foxAi');
}

/** 取配置项：用户显式设置过则用它，否则用 fallback（用于厂商速度默认值，避免覆盖用户手填） */
function resolvedOr(c, key, fallback) {
  try {
    const insp = c.inspect(key);
    if (insp) {
      const v = insp.globalValue !== undefined ? insp.globalValue
        : insp.workspaceValue !== undefined ? insp.workspaceValue
        : insp.workspaceFolderValue !== undefined ? insp.workspaceFolderValue
        : undefined;
      if (v !== undefined) return v;
    }
  } catch (_) {}
  return fallback;
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

// 知识库「向量模型」（embedding）专用：又一套独立 secret 键，与主对话、整理 AI 三者互不覆盖。
// 键格式：foxAi.apiKey.embed.<providerId>（如 foxAi.apiKey.embed.dashscope）
// 说明：向量模型与整理模型是两件事——向量模型只做语义检索，不产出笔记，故密钥也独立存放。
async function getEmbedApiKey(context, id) {
  const pid = id || 'ollama';
  const secret = await context.secrets.get(SECRET_PREFIX + 'embed.' + pid);
  if (secret) return secret;
  // 兜底：用户可能只在主对话模型里填过同一家的 key
  return getApiKey(context, pid);
}

async function setEmbedApiKey(context, id, value) {
  await context.secrets.store(SECRET_PREFIX + 'embed.' + (id || 'ollama'), value);
}

/** 汇总一次调用需要的全部参数 */
async function resolve(context) {
  const id = currentProviderId();
  const c = conf();
  const meta = providerMeta(id); // 提前取出，供本地模型默认值判断

  // —— 本地弱模型辅助模式（1.1.17）——
  // auto：本地模型（Ollama/LM Studio/llama.cpp 等）默认开启；on：强制开；off：关。
  // 开启后逐项生效：约束解码、工具检索精简、闭环校验、上下文锚点。
  const weakModeSetting = c.get('agent.localWeakModelMode', 'auto');
  const localWeak =
    weakModeSetting === 'on' ||
    (weakModeSetting === 'auto' && !!meta.local);

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
    meta,
    baseUrl: baseUrlFor(id),
    model: modelName(id),
    apiKey: await getApiKey(context, id),
    temperature: c.get('temperature', 0.3),
    // 厂商速度默认：DeepSeek/OpenAI/Claude 各有延迟与输出特性，未显式设置时套用专属 timeout/maxTokens
    maxTokens: (() => {
      const sp = providerProfiles.resolveSpeed({ provider: id, model: modelName(id), transport: (PROVIDERS[id] && PROVIDERS[id].transport) || 'openai', local: !!meta.local });
      return resolvedOr(c, 'maxTokens', (sp && sp.maxTokens) || (meta.local ? 1536 : 2048));
    })(),
    timeout: (() => {
      const sp = providerProfiles.resolveSpeed({ provider: id, model: modelName(id), transport: (PROVIDERS[id] && PROVIDERS[id].transport) || 'openai', local: !!meta.local });
      return resolvedOr(c, 'timeout', (sp && sp.timeout) || 60000);
    })(),
    maxHistory: c.get('maxHistory', 40),
    systemPrompt: c.get('systemPrompt', ''),
    forceNonStream: c.get('forceNonStream', false),
    streamFormat: c.get('streamFormat', 'auto'),
    insecureHttpParser: c.get('insecureHttpParser', false),
    // 传输层协议：foxAi.transport 用户显式覆盖（openai/anthropic）> apiMode='anthropic' 联动 > provider 预置。
    // 这样 deepseek/gemini/自定义 等任意模型都能通过 Anthropic Messages API 格式接入
    // （适用于只提供 Anthropic 格式端点或走 Anthropic 格式网关的中转站）。
    transport: (() => {
      const t = c.get('transport', '');
      if (t === 'anthropic' || t === 'openai') return t;
      if (c.get('apiMode', '') === 'anthropic') return 'anthropic';
      return (PROVIDERS[id] && PROVIDERS[id].transport) || 'openai';
    })(),
    apiMode: (() => {
      // apiMode='anthropic' 是「API 协议下拉里的 Anthropic API 接入方式」——直接作为 anthropic 传输标记
      const explicitMode = c.get('apiMode', '');
      if (explicitMode === 'anthropic') return 'anthropic';
      const t = c.get('transport', '');
      const isAnth = t === 'anthropic' || (PROVIDERS[id] && PROVIDERS[id].transport) === 'anthropic';
      return isAnth ? 'chat' : explicitMode || (PROVIDERS[id] && PROVIDERS[id].apiMode) || 'chat';
    })(),
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
      // 行内补全传输层：openai（OpenAI 兼容 /chat/completions）或 anthropic（Messages API）。
      // 默认取主 provider 的 transport；deepseek 等预置 provider 是 openai，claude 是 anthropic。
      transport: c.get('inlineCompletion.transport', 'auto') === 'anthropic'
        ? 'anthropic'
        : c.get('inlineCompletion.transport', 'auto') === 'openai'
          ? 'openai'
          : ((PROVIDERS[inlineProvider] || {}).transport === 'anthropic' ? 'anthropic' : 'openai'),
      apiMode: 'chat',
      // 行内补全思考模式：off（默认，最快）/ on（开启思考，更准但更慢）。
      // DeepSeek 思考模型（deepseek-reasoner）官方不支持 FIM 补全 → 开启思考时自动降级为 chat 补全。
      thinking: c.get('inlineCompletion.thinking', 'off'),
      thinkingEffort: c.get('inlineCompletion.thinkingEffort', 'medium'),
      maxTokens: c.get('inlineCompletion.maxTokens', 256),
      contextLines: c.get('inlineCompletion.contextLines', 60),
      suffixLines: c.get('inlineCompletion.suffixLines', 30),
      fimStrategy: c.get('inlineCompletion.fimStrategy', 'auto'),
      fimEndpoint: c.get('inlineCompletion.fimEndpoint', false),
      useProjectContext: c.get('inlineCompletion.useProjectContext', true),
      projectContextChars: c.get('inlineCompletion.projectContextChars', 1000),
      maxFileLines: c.get('inlineCompletion.maxFileLines', 8000),
      maxContextChars: c.get('inlineCompletion.maxContextChars', 6000),
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
      // 传输层：用户显式配置（auto/openai/anthropic）> provider 预置。anthropic 支持图片输入（image 块）。
      transport: (() => {
        const t = c.get('vision.transport', 'auto');
        if (t === 'anthropic' || t === 'openai') return t;
        return (PROVIDERS[c.get('vision.provider', 'custom')] || {}).transport || 'openai';
      })(),
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
      // 传输层：用户显式配置（auto/openai/anthropic）> provider 预置。
      // 注意：Anthropic Messages API 不输出图片，生图选 anthropic 会走文本描述（意义有限），
      // 生图首选 OpenAI 兼容端点（Qwen 兼容 / 本地等）。
      transport: (() => {
        const t = c.get('imageGen.transport', 'auto');
        if (t === 'anthropic' || t === 'openai') return t;
        return (PROVIDERS[c.get('imageGen.provider', 'custom')] || {}).transport || 'openai';
      })(),
      maxTokens: c.get('imageGen.maxTokens', 1024),
      timeout: c.get('imageGen.timeout', 60000)
    },
    contextWindow: c.get('contextWindow', 0),
    showContextUsage: c.get('showContextUsage', true),
    agentEnabled: c.get('agent.enabled', true),
    planAndExecute: {
      enabled: c.get('planAndExecute.enabled', true),
      // 计划确认门（对齐 DSH goal-round-driver「计划即执行」）：默认关闭——
      // present_plan/revise_plan 只把计划展示给用户看，不设确认门，模型提交后立即继续执行。
      // 仅当用户显式开启此开关时才真正暂停等待用户确认。
      confirmGate: c.get('planAndExecute.confirmGate', false)
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
        // 本地弱模型模式：强制开启工具检索，把「百选一」降为「三选一」，显著降低选择负担
        enabled: localWeak ? true : c.get('tools.dynamicSubset.enabled', false),
        // 弱模型模式下进一步收紧 topK（≤5），只给最相关的少量工具
        topK: localWeak
          ? Math.min(Number(c.get('tools.dynamicSubset.topK', 12)) || 12, 5)
          : c.get('tools.dynamicSubset.topK', 12),
        alwaysInclude: c.get('tools.dynamicSubset.alwaysInclude', '')
      }
    },
    guardrails: {
      forceCitation: c.get('guardrails.forceCitation', false)
    },
    planner: {
      // 默认开启（auto 模式已按「是否多步骤任务」跳过单步，不浪费调用）：
      // 从结构层强制「先规划后动手」，避免长链路边想边错、越改越乱堆屎山。
      enabled: c.get('planner.enabled', true),
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
    maxSteps: c.get('agent.maxSteps', meta.local ? 8 : 12),
    maxContinues: c.get('agent.maxContinues', 3),
    toolProtocol: c.get('agent.toolProtocol', 'auto'),
    // 1.1.14：工具手册「按需检索」模式。auto=仅 textOnly（WebAI2API 网页接入）启用；
    // on=所有 text 协议强制启用；off=关闭（保留旧行为：完整工具手册写进 system）。
    toolGuideMode: c.get('agent.toolGuide', 'auto'),
    // 厂商专属适配：auto（按 provider 自动选）/ deepseek / openai / claude / none / 自定义文本
    providerProfile: c.get('agent.providerProfile', 'auto'),
    // —— 本地弱模型辅助模式设置（1.1.17 / 1.1.19）——
    localWeakModelMode: weakModeSetting,
    localWeak: localWeak, // 便捷布尔，agent 直接读它判断是否进入弱模型适配逻辑
    // 约束解码开关，三态（1.1.19 起）：
    //   false / 'off' → 关闭，永不注入 grammar（最保守，对应 1.1.18 的默认行为）
    //   true  / 'on'  → 强制开启，不探测直接注入（靠 retryWithoutGrammar 兜底拒绝）
    //   'auto'（默认） → 调用前先探测服务端是否支持 grammar，支持才注入，不支持/挂起则跳过，
    //                    既不卡死又能自动享受约束解码带来的格式稳定收益。
    // 探测机制：发一个极短超时 + max_tokens=1 的极小 GBNF 试探请求，健康服务端秒回→支持，
    // 挂起型服务端超时失败→不支持，绝不再注入（详见 src/grammarProbe.js）。
    localConstrainedDecoding: c.get('agent.localConstrainedDecoding', 'auto'),
    weakHistoryRounds: c.get('agent.weakHistoryRounds', 2),
    autoApprove: c.get('agent.autoApprove', 'read'),
    // 1.1.20 自动续跑（对齐 DSH goal-round-driver）：达到 maxSteps 硬性上限时不再干等用户手点「继续」，
    // 自动追加一轮预算并把「续跑提示」写回历史，模型带上断点信息直接继续。
    // autoResume=false 关闭（回到旧行为：挂起等手动确认）；autoResumeRounds 是自动续跑累计轮数上限，
    // 超过后真正挂起等用户。两键都由 agent.js 的 _hardStopPause 读取。
    autoResume: c.get('agent.autoResume', true),
    autoResumeRounds: c.get('agent.autoResumeRounds', 5),
    blockedCommands: c.get('agent.blockedCommands', []),
    policy: c.get('policy', {}),
    // —— 失败降级 / 自动 failover（1.1.20）——
    // 主模型调用失败时，按配置的错误类型自动切换到备用模型（UI 自由配置，支持本地与云端）。
    // enabled 默认 false（保持旧行为）；triggers 默认超时/连接/服务端错误；targets 为备用模型列表，
    // 数量受 maxRetries 截断。每个 target 含 name/baseUrl/apiKey/model/local（本地不发送 apiKey）。
    failover: (() => {
      const fo = c.get('failover', {}) || {};
      const enabled = !!fo.enabled;
      const triggers = new Set(
        Array.isArray(fo.triggers) && fo.triggers.length
          ? fo.triggers
          : ['timeout', 'connection', 'serverError']
      );
      const maxRetries = Math.max(0, Number(fo.maxRetries) || 1);
      const rawTargets = Array.isArray(fo.targets) ? fo.targets : [];
      const targets = rawTargets
        .filter((t) => t && (t.baseUrl || t.model))
        .slice(0, maxRetries)
        .map((t, i) => ({
          name: (t.name || '').trim() || ('备用' + (i + 1)),
          baseUrl: (t.baseUrl || '').trim().replace(/\/+$/, ''),
          apiKey: (t.apiKey || '').trim(),
          model: (t.model || '').trim() || 'local-model',
          local: !!t.local
        }));
      return { enabled, triggers, maxRetries, targets };
    })(),
    maxToolOutput: c.get('agent.maxToolOutput', 8000),
    maxMessageBytes: c.get('agent.maxMessageBytes', 1024 * 1024),
    // 历史 token 预算（前缀缓存优化）：历史 append-only 增长，只有超过此预算才从最早截断。
    // 相比固定条数滑动窗口，token 预算窗口大、截断频率低，前缀更稳定、命中率更高。
    // 优先级：显式配置 > contextWindow*0.6 > 默认 60000（约 DeepSeek 128K 的一半，留 system/tools/输出空间）。
    maxHistoryTokens: (() => {
      const explicit = c.get('agent.maxHistoryTokens', 0);
      if (explicit > 0) return explicit;
      const cw = c.get('contextWindow', 0);
      if (cw > 0) return Math.floor(cw * 0.6);
      return 60000;
    })(),
    structuredOutput: c.get('agent.structuredOutput', false),
    // 视觉与功能协调系统（四层）：默认开启；可设 foxAi.designSystem.enabled=false 关闭，
    // foxAi.designSystem.tokens 覆盖默认设计令牌（主色/圆角/间距等）。
    designSystem: {
      enabled: c.get('designSystem.enabled', true),
      tokens: c.get('designSystem.tokens', {})
    },
    // 前缀/上下文缓存「强制保留本会话缓存副本」：默认开启。
    // 仅对官方支持的厂商注入缓存指令（OpenRouter 走请求头、OpenAI gpt-5.6+ 走请求体），
    // 其余厂商依赖稳定前缀自动命中，绝不臆造参数。
    // 可通过 foxAi.cacheControl.enabled=false 关闭；foxAi.cacheControl.retention 改 OpenAI TTL（默认 '24h'）。
    cacheControl: {
      enabled: c.get('cacheControl.enabled', true),
      retention: c.get('cacheControl.retention', '24h')
    },
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
    sandbox: {
      enabled: c.get('sandbox.enabled', true),
      dir: c.get('sandbox.dir', '') || '',
      timeout: Math.max(1000, Number(c.get('sandbox.timeout', 30000)) || 30000),
      allowDocker: c.get('sandbox.allowDocker', false)
    },
    autoSummarize: {
      enabled: c.get('knowledgeBase.autoSummarize.enabled', false),
      threshold: c.get('knowledgeBase.autoSummarize.threshold', 0.9),
      keepRecent: c.get('knowledgeBase.autoSummarize.keepRecent', 6),
      dir: c.get('knowledgeBase.autoSummarize.dir', '')
    },
    // —— 知识库向量模型（语义检索，1.1.33）——
    // 与「整理模型」完全解耦：整理模型产出笔记，向量模型只负责把文本转向量做语义召回。
    // enabled 默认 false，关闭时知识库检索行为与旧版完全一致（BM25 关键词）。
    embeddingConfig: {
      enabled: c.get('knowledgeBase.embedding.enabled', false),
      provider: c.get('knowledgeBase.embedding.provider', 'ollama'),
      baseUrl: (c.get('knowledgeBase.embedding.baseUrl', '') || '').trim().replace(/\/+$/, ''),
      model: (c.get('knowledgeBase.embedding.model', '') || '').trim(),
      dimensions: c.get('knowledgeBase.embedding.dimensions', 0),
      batchSize: c.get('knowledgeBase.embedding.batchSize', 0),
      timeout: c.get('knowledgeBase.embedding.timeout', 30000),
      hybrid: c.get('knowledgeBase.embedding.hybrid', true)
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
  getEmbedApiKey,
  setEmbedApiKey,
  resolve,
  PROVIDERS
};
