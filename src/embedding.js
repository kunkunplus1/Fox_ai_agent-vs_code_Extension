'use strict';

/*
 * src/embedding.js — 知识库「向量模型」（Embedding）适配层
 *
 * 定位（务必分清，别和「整理模型」混为一谈）：
 *   - 整理模型（knowledgeBase.organize.*）：把原始文档喂给对话模型，产出结构化知识笔记（写文件）。
 *   - 向量模型（knowledgeBase.embedding.*）：把文本转成向量，用于语义检索（不写笔记、不改内容）。
 *   两者完全独立配置：
 *     情况一 只配整理模型 → 检索行为与旧版一致（BM25 关键词）。
 *     情况二 两者都配   → 向量模型先做语义召回（前置），整理模型继续负责产出笔记（在后）。
 *   无论是否配置，UI 都有独立开关可随时启停向量检索。
 *
 * 厂商适配（依据各家官方文档，2026-08）：
 *   1. OpenAI 兼容 `/v1/embeddings`（绝大多数厂商走这条）
 *      POST {baseUrl}/embeddings
 *      body  { model, input: string|string[], encoding_format: "float", dimensions? }
 *      resp  { data: [{ index, embedding: number[] }], usage }
 *      覆盖：OpenAI、DeepSeek 系兼容端点、智谱 GLM（/api/paas/v4/embeddings）、
 *            硅基流动、OpenRouter、Mistral、Gemini 兼容端点、LM Studio、llama.cpp server。
 *   2. 阿里云百炼 / DashScope
 *      官方文档明确：text-embedding-v1~v4 支持 OpenAI 兼容模式，
 *      端点即 https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings，
 *      因此**走第 1 条路径**（注意：这与文生图万相不同，万相必须走原生异步 API）。
 *      dimensions 可选：v4 默认 1024，另支持 2048/1536/768/512/256/128/64。
 *      单次批量上限较小（官方建议 ≤10 条），故 batchSize 单独下调。
 *   3. Ollama 原生 `/api/embed`
 *      POST http://127.0.0.1:11434/api/embed
 *      body  { model, input: string|string[] }
 *      resp  { model, embeddings: number[][] }   ← 已做 L2 归一化
 *      旧版 Ollama 只有 `/api/embeddings`（单条、返回 { embedding }），本模块自动降级兼容。
 *
 * 设计要点：
 *   - 复用 client.requestJson（已支持 extra 自定义头透传），零新依赖。
 *   - 纯函数（分类 / 拼 URL / 拼 body / 解析响应 / 归一化 / 余弦）全部导出，便于 Node 单测。
 *   - 任何失败都抛错，由上层 knowledgeBase 优雅回退 BM25，绝不让知识库整体失效。
 */

const { requestJson } = require('./client');
const { appendLog } = require('./log');

// 向量适配层日志：统一 [vec][emb] 前缀，落盘 ~/.fox-ai/logs/kb.log
function vlog(s) {
  try { appendLog('kb', '[vec][emb] ' + s); } catch (_) {}
}
function maskKey(k) {
  const s = String(k || '');
  if (s.length <= 6) return s ? '***' : '(空)';
  return s.slice(0, 4) + '***' + s.slice(-4);
}

/** 各厂商官方 embedding 默认模型（用户没填 model 时的兜底） */
const DEFAULT_EMBED_MODELS = {
  ollama: 'nomic-embed-text',
  llamacpp: 'local-embedding',
  lmstudio: 'text-embedding-nomic-embed-text-v1.5',
  dashscope: 'text-embedding-v4',
  zhipu: 'embedding-3',
  siliconflow: 'BAAI/bge-m3',
  openai: 'text-embedding-3-small',
  gemini: 'text-embedding-004',
  mistral: 'mistral-embed',
  openrouter: '',
  // DeepSeek / Kimi 官方暂未提供 embeddings 接口，用户若选它需自行填兼容端点
  deepseek: '',
  moonshot: '',
  claude: '',
  custom: ''
};

/** 无官方 embedding 接口的厂商（UI 上给提示，不做硬拦截） */
const NO_EMBED_PROVIDERS = new Set(['deepseek', 'moonshot', 'claude']);

/** 多模态（视觉语言）向量模型：仅支持百炼原生多模态协议，不支持 OpenAI 兼容 /v1/embeddings（会返回 400 url error） */
const MULTIMODAL_EMBED_HINT = /vl-embedding|vision|multimodal|one-peace|one_peace/i;
function isMultimodalEmbedModel(model) {
  return MULTIMODAL_EMBED_HINT.test(String(model || ''));
}

/** 单次请求最大批量：百炼官方建议 ≤10，其余给 16 */
const BATCH_LIMIT = { dashscope: 10, zhipu: 64, ollama: 32, llamacpp: 8, lmstudio: 8 };
const DEFAULT_BATCH = 16;

function normalizeBase(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

/**
 * 判定走哪条协议：'ollama'（原生 /api/embed）或 'openai'（兼容 /v1/embeddings）。
 * 百炼 dashscope 明确走 'openai'。
 */
function classifyEmbedProvider(cfg) {
  const provider = String((cfg && (cfg.provider || cfg.pid)) || '').toLowerCase();
  const base = normalizeBase(cfg && cfg.baseUrl).toLowerCase();
  if (provider === 'ollama') return 'ollama';
  if (/\/api\/embed(dings)?$/.test(base)) return 'ollama';
  if (/:11434(\/|$)/.test(base)) return 'ollama';
  return 'openai';
}

/**
 * 拼接 embedding 请求地址。
 * @param {string} kind 'ollama' | 'openai'
 * @param {string} baseUrl 配置里的 baseUrl（可带 /v1 后缀）
 * @param {{legacy?:boolean}} [opts] legacy=true 时用 Ollama 旧端点 /api/embeddings
 */
function buildEmbedUrl(kind, baseUrl, opts) {
  const legacy = !!(opts && opts.legacy);
  const base = normalizeBase(baseUrl);
  if (!base) return '';
  if (kind === 'ollama') {
    const root = base.replace(/\/api\/embed(dings)?$/i, '').replace(/\/v1$/i, '').replace(/\/+$/, '');
    return root + (legacy ? '/api/embeddings' : '/api/embed');
  }
  if (/\/embeddings$/i.test(base)) return base;
  return base + '/embeddings';
}

/**
 * 组装请求体。
 * @param {string} kind 'ollama' | 'openai'
 * @param {{model:string, texts:string[], dimensions?:number, legacy?:boolean}} spec
 */
function buildEmbedBody(kind, spec) {
  const model = String((spec && spec.model) || '');
  const texts = Array.isArray(spec && spec.texts) ? spec.texts : [];
  if (kind === 'ollama') {
    // 旧端点 /api/embeddings 只吃单条，字段名是 prompt
    if (spec && spec.legacy) return { model, prompt: texts[0] || '' };
    return { model, input: texts };
  }
  const body = { model, input: texts, encoding_format: 'float' };
  const dim = Number(spec && spec.dimensions) || 0;
  if (dim > 0) body.dimensions = dim;
  return body;
}

/** base64（小端 float32）→ number[]，兼容部分厂商的紧凑返回 */
function decodeBase64Floats(b64) {
  try {
    const buf = Buffer.from(String(b64), 'base64');
    const n = Math.floor(buf.length / 4);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
    return out;
  } catch (_) {
    return null;
  }
}

function toVector(v) {
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) {
      const n = Number(v[i]);
      if (!Number.isFinite(n)) return null;
      out[i] = n;
    }
    return out.length ? out : null;
  }
  if (typeof v === 'string' && v) {
    const dec = decodeBase64Floats(v);
    return dec && dec.length ? dec : null;
  }
  return null;
}

/**
 * 解析各家响应 → number[][]（顺序与输入一致）。
 * @param {string} kind 'ollama' | 'openai'
 */
function parseEmbedResponse(kind, json) {
  if (!json || typeof json !== 'object') return [];
  if (kind === 'ollama') {
    if (Array.isArray(json.embeddings)) return json.embeddings.map(toVector).filter(Boolean);
    const single = toVector(json.embedding);
    return single ? [single] : [];
  }
  // OpenAI 兼容：data[*].embedding，按 index 归位（有厂商乱序返回）
  if (Array.isArray(json.data) && json.data.length) {
    const data = json.data.slice().sort((a, b) => (Number(a && a.index) || 0) - (Number(b && b.index) || 0));
    return data.map((d) => toVector(d && d.embedding)).filter(Boolean);
  }
  // 兜底：DashScope 原生返回 output.embeddings[*].{text_index,embedding}
  if (json.output && Array.isArray(json.output.embeddings)) {
    const arr = json.output.embeddings
      .slice()
      .sort((a, b) => (Number(a && a.text_index) || 0) - (Number(b && b.text_index) || 0));
    return arr.map((d) => toVector(d && d.embedding)).filter(Boolean);
  }
  if (Array.isArray(json.embeddings)) return json.embeddings.map(toVector).filter(Boolean);
  const single = toVector(json.embedding);
  return single ? [single] : [];
}

/** L2 归一化（原地返回新数组）；零向量原样返回 */
function normalizeVector(vec) {
  if (!Array.isArray(vec) || !vec.length) return vec;
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (!norm || !Number.isFinite(norm)) return vec.slice();
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/** 余弦相似度（已归一化向量等价于点积；未归一化也能算） */
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  const s = dot / (Math.sqrt(na) * Math.sqrt(nb));
  if (!Number.isFinite(s)) return 0;
  return s;
}

function batchLimitFor(pid, kind, custom) {
  const c = Number(custom) || 0;
  if (c > 0) return Math.min(64, c);
  if (pid && BATCH_LIMIT[pid]) return BATCH_LIMIT[pid];
  if (kind === 'ollama') return BATCH_LIMIT.ollama;
  return DEFAULT_BATCH;
}

function chunkArray(arr, size) {
  const n = Math.max(1, size || 1);
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** 是否值得重试：限流 / 服务端错误 / 网络抖动 */
function isRetriable(err) {
  const status = err && err.status;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  const msg = String((err && err.message) || '');
  return /超时|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|网络|连接/i.test(msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 判断这份向量配置能不能真的发起调用。
 * @param {{enabled?:boolean, baseUrl?:string, model?:string}} e
 */
function isEmbedUsable(e) {
  if (!e || !e.enabled) return false;
  if (!normalizeBase(e.baseUrl)) return false;
  if (!String(e.model || '').trim()) return false;
  return true;
}

/**
 * 解析知识库向量模型配置（读 VS Code 设置 + SecretStorage）。
 * 注意：本函数依赖 vscode，故 config 采用惰性 require，保证纯函数部分可在 Node 单测里直接跑。
 */
async function resolveEmbeddingConfig(context) {
  const config = require('./config');
  const cfg = config.conf().get('knowledgeBase.embedding', {}) || {};
  const pid = cfg.provider || 'ollama';
  const meta = config.PROVIDERS[pid] || config.PROVIDERS.ollama;
  const baseUrl = normalizeBase(cfg.baseUrl) || normalizeBase(meta.baseUrl);
  const model = String(cfg.model || '').trim() || DEFAULT_EMBED_MODELS[pid] || '';
  const kind = classifyEmbedProvider({ provider: pid, baseUrl });
  let apiKey = '';
  if (!meta.local && context) {
    try {
      apiKey = await config.getEmbedApiKey(context, pid);
    } catch (_) {
      apiKey = '';
    }
  }
  vlog(
    `resolveEmbeddingConfig：provider=${pid} kind=${kind} enabled=${!!cfg.enabled} baseUrl=${baseUrl || '(空)'} ` +
      `model=${model || '(空)'} apiKey=${maskKey(apiKey)} local=${!!meta.local} dims=${Math.max(0, Number(cfg.dimensions) || 0)} ` +
      `batch=${batchLimitFor(pid, kind, cfg.batchSize)} hybrid=${cfg.hybrid !== false}` +
      (NO_EMBED_PROVIDERS.has(pid) ? ' [官方暂无接口]' : '')
  );
  return {
    enabled: !!cfg.enabled,
    pid,
    label: meta.label || pid,
    kind,
    baseUrl,
    model,
    apiKey,
    local: !!meta.local,
    dimensions: Math.max(0, Number(cfg.dimensions) || 0),
    batchSize: batchLimitFor(pid, kind, cfg.batchSize),
    timeout: Math.max(3000, Number(cfg.timeout) || 30000),
    hybrid: cfg.hybrid !== false,
    noOfficialApi: NO_EMBED_PROVIDERS.has(pid),
    multimodal: isMultimodalEmbedModel(model)
  };
}

/** 单批请求（含 Ollama 旧端点降级） */
async function embedBatchOnce(batch, e, opts) {
  const kind = e.kind || classifyEmbedProvider(e);
  const signal = opts && opts.signal;
  const timeout = (opts && opts.timeout) || e.timeout || 30000;

  const url = buildEmbedUrl(kind, e.baseUrl);
  if (!url) throw new Error('向量模型接口地址为空（请填写 baseUrl）');

  vlog(`embedBatchOnce：POST ${url} kind=${kind} model=${e.model} 批量=${batch.length} 条 key=${maskKey(e.apiKey)} timeout=${timeout}ms`);

  const send = (u, body) =>
    requestJson(u, {
      method: 'POST',
      apiKey: e.local ? '' : e.apiKey,
      body,
      timeout,
      signal
    });

  try {
    const json = await send(url, buildEmbedBody(kind, { model: e.model, texts: batch, dimensions: e.dimensions }));
    const vecs = parseEmbedResponse(kind, json);
    vlog(`embedBatchOnce：响应解析得到 ${vecs.length}/${batch.length} 条向量` + (vecs[0] ? `（维度 ${vecs[0].length}）` : ''));
    if (vecs.length === batch.length) return vecs;
    if (vecs.length) throw new Error(`向量条数不匹配：请求 ${batch.length} 条，返回 ${vecs.length} 条`);
    throw new Error('向量模型未返回 embedding 字段（响应无 data/embeddings）');
  } catch (err) {
    const status = err && err.status;
    const body = String(err.message || err).split('\n').slice(0, 3).join(' | ');
    vlog(`embedBatchOnce：请求失败 status=${status || '(无)'} -> ${body}`);
    // 旧版 Ollama 只有 /api/embeddings（单条），404/400 时逐条降级重试
    if (kind === 'ollama' && (status === 404 || status === 400)) {
      const legacyUrl = buildEmbedUrl(kind, e.baseUrl, { legacy: true });
      vlog(`embedBatchOnce：Ollama 新端点 ${status}，降级旧端点 ${legacyUrl}（逐条）`);
      const out = [];
      for (const text of batch) {
        const json = await send(legacyUrl, buildEmbedBody(kind, { model: e.model, texts: [text], legacy: true }));
        const vecs = parseEmbedResponse(kind, json);
        if (!vecs.length) throw new Error('向量模型未返回 embedding 字段（旧端点）');
        out.push(vecs[0]);
      }
      return out;
    }
    throw err;
  }
}

/**
 * 批量把文本转向量。
 * @param {string[]} texts 待向量化文本
 * @param {object} e resolveEmbeddingConfig 的结果（或等价对象）
 * @param {{signal?:AbortSignal, onLog?:Function, retries?:number, timeout?:number}} [opts]
 * @returns {Promise<number[][]>} 与输入等长、已 L2 归一化的向量数组
 */
async function embedTexts(texts, e, opts) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t == null ? '' : t));
  if (!list.length) return [];
  if (!e || !normalizeBase(e.baseUrl)) throw new Error('向量模型未配置 baseUrl');
  if (!String(e.model || '').trim()) throw new Error('向量模型未配置模型名');

  const o = opts || {};
  const retries = Math.max(0, o.retries == null ? 2 : o.retries);
  const size = batchLimitFor(e.pid, e.kind, e.batchSize);
  const batches = chunkArray(list, size);
  const out = [];

  vlog(`embedTexts：开始 共 ${list.length} 条 provider=${e.pid} kind=${e.kind} 批量上限=${size} 分 ${batches.length} 批 重试=${retries}`);

  for (let bi = 0; bi < batches.length; bi++) {
    if (o.signal && o.signal.aborted) throw new Error('已取消');
    const batch = batches[bi];
    let lastErr = null;
    let ok = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        ok = await embedBatchOnce(batch, e, o);
        break;
      } catch (err) {
        lastErr = err;
        const retryable = attempt < retries && isRetriable(err);
        vlog(`embedTexts：第 ${bi + 1}/${batches.length} 批 第 ${attempt + 1} 次失败${retryable ? '（可重试，稍后重试）' : '（终止）'} -> ${String(err.message || err).split('\n')[0]}` + (err.status ? ` [${err.status}]` : ''));
        if (attempt >= retries || !retryable) break;
        await sleep(400 * Math.pow(2, attempt));
      }
    }
    if (!ok) throw lastErr || new Error('向量化失败');
    for (const v of ok) out.push(normalizeVector(v));
    if (o.onLog && batches.length > 1) {
      o.onLog(`🧮 向量化进度：${Math.min(list.length, (bi + 1) * size)}/${list.length}`);
    }
  }
  vlog(`embedTexts：完成 共返回 ${out.length} 条向量`);
  return out;
}

module.exports = {
  DEFAULT_EMBED_MODELS,
  NO_EMBED_PROVIDERS,
  BATCH_LIMIT,
  DEFAULT_BATCH,
  normalizeBase,
  classifyEmbedProvider,
  buildEmbedUrl,
  buildEmbedBody,
  parseEmbedResponse,
  decodeBase64Floats,
  normalizeVector,
  cosineSimilarity,
  batchLimitFor,
  chunkArray,
  isRetriable,
  isEmbedUsable,
  resolveEmbeddingConfig,
  embedTexts,
  isMultimodalEmbedModel
};
