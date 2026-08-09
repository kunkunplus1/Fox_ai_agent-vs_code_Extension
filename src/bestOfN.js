'use strict';

/**
 * Best-of-N 多模型对比：给定 prompt，并发跑 N 个候选模型，按打分挑最优。
 *
 * 设计原则（用户硬约束）：
 *  - 零 vscode 依赖：纯 Node 模块，单测友好，不常驻内存。
 *  - 懒加载：仅在 foxAi.bestOfN.enabled 或显式传入 candidates 时由工具层 require。
 *  - 配置门控：默认关；无候选则直接提示，不烧任何模型。
 *  - 有界并发：内部信号量 MAX_CONCURRENT，避免一次性打爆 N 个模型。
 *  - 有界缓存：prompt + 候选指纹 -> 结果，Map 上限 + 淘汰最早项，不留存对话上下文。
 *  - 用完即弃：只缓存结构化结论（best + 各候选摘要），不留存任何上下文。
 *
 * 与既有底座的关系：真实的模型 HTTP 调用由调用方注入（agent 复用 chatNonStream /
 * anthropic.chatNonStream + llmLimiter），本模块只负责“并发编排 + 打分挑选 + 缓存”。
 */

const crypto = require('crypto');

const MAX_CACHE = 256;
const _cache = new Map(); // key = promptHash\x00candHash -> { best, results, scores }
const MAX_CONCURRENT = 4;

/** 有界淘汰：超过上限时删最早写入项（Map 保持插入顺序即近似 LRU）。 */
function _cacheSet(key, val) {
  if (_cache.size >= MAX_CACHE && _cache.size > 0) {
    const fk = _cache.keys().next().value;
    if (fk !== undefined) _cache.delete(fk);
  }
  _cache.set(key, val);
}

/** prompt 指纹：同一问题只跑一次对比，避免重复烧模型。 */
function promptHash(prompt, system) {
  try {
    return crypto.createHash('sha1').update('P:' + (prompt || '') + '\nS:' + (system || '')).digest('hex').slice(0, 16);
  } catch (_) {
    return '0';
  }
}

/** 候选指纹：只取 provider/model/baseUrl（不含 apiKey），配置变动才重算。 */
function candidatesHash(cands) {
  try {
    const s = (cands || []).map((c) => [c.provider || '', c.model || '', c.baseUrl || ''].join('|')).join('\n');
    return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
  } catch (_) {
    return '0';
  }
}

/** 长度类打分：以非空白字符数为基准（默认启发式，可被 llm 评委覆盖）。 */
function scoreText(text) {
  if (!text) return 0;
  const t = String(text);
  let n = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t.charCodeAt(i);
    if (ch > 32) n++; // 跳过空白/控制符
  }
  return n;
}

/** 有界并发池：把 fn 套在 limit 个 worker 上跑完 items（顺序保持）。 */
async function _mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (e) {
        results[idx] = { error: String((e && e.message) || e) };
      }
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  const workers = [];
  for (let w = 0; w < n; w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/** 按分数挑最优（仅看 ok 且有文本的候选）。 */
function _pickByScore(raw) {
  let best = -1;
  let bestScore = -Infinity;
  for (const r of raw) {
    if (r && r.ok && r.text && r.score > bestScore) {
      bestScore = r.score;
      best = r.index;
    }
  }
  return best;
}

/**
 * LLM 评委：把各候选回答（截断）交给主模型挑最好的一个。
 * @param {Array} raw 已跑完的候选数组 [{index,id,model,provider,ok,text,score,error}]
 * @param {Function} llmFn (prompt:string) => Promise<string>
 * @returns {Promise<number>} 最优候选的 index（解析失败返回 -1）
 */
async function judgeWithLLM(raw, llmFn) {
  const valid = raw.filter((r) => r && r.ok && r.text);
  if (!valid.length) return -1;
  const parts = valid.map((r, i) => {
    const snippet = String(r.text).slice(0, 1500);
    return `【候选 ${r.index}｜${r.provider || '?'} / ${r.model || '?'}】\n${snippet}`;
  });
  const prompt = [
    '你是答案质量评委。下面是对同一个问题的多个模型回答，请选出“最准确、最完整、最贴合要求”的一个。',
    '评判要点：事实正确 > 完整度 > 切题 > 表达清晰。不要因为某条更长就选它，冗长但跑题的应扣分。',
    '只输出一个 JSON 对象，不要任何解释：{"best": <候选编号,从0开始的整数>,"reason":"简短中文理由"}',
    '注意：下面的“候选编号”是【候选 N】里的 N，不是模型序号。',
    '---',
    parts.join('\n\n')
  ].join('\n');

  let out;
  try {
    out = await llmFn(prompt);
  } catch (_) {
    return -1;
  }
  const text = typeof out === 'string' ? out : (out && out.text ? out.text : (out && out.content ? out.content : ''));
  // 先抓 JSON
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      if (typeof obj.best === 'number' && obj.best >= 0 && obj.best < raw.length) return obj.best;
    } catch (_) { /* fall through */ }
  }
  // 退路：正则抓 "best": 12
  const m2 = String(text).match(/best\s*[:=]\s*(\d+)/i);
  if (m2) {
    const idx = parseInt(m2[1], 10);
    if (idx >= 0 && idx < raw.length) return idx;
  }
  return -1;
}

/**
 * 主入口。
 * @param {object} opts
 *   - prompt: string（必填）
 *   - system?: string
 *   - candidates: Array<{id?,provider?,model,baseUrl,apiKey,transport?,temperature?}>
 *   - callModel: (candidate, {prompt,system,temperature}) => Promise<{ok,text?,error?}>（必填注入）
 *   - judge: 'length' | 'llm' | 'first'（默认 length）
 *   - llm?: (prompt:string) => Promise<string>（judge==='llm' 时注入）
 *   - noCache?: boolean
 * @returns {Promise<{ok, error?, best, results, scores, judge, fromCache?}>}
 */
async function runBestOfN(opts) {
  opts = opts || {};
  const prompt = opts.prompt;
  if (!prompt || !String(prompt).trim()) {
    return { ok: false, error: 'prompt 不能为空', results: [], scores: [], best: null };
  }
  const candidates = opts.candidates || [];
  if (!candidates.length) {
    return { ok: false, error: '没有候选模型（请在 foxAi.bestOfN.candidates 配置，或调用时传入 candidates）', results: [], scores: [], best: null };
  }
  if (typeof opts.callModel !== 'function') {
    return { ok: false, error: '未注入 callModel，无法调用候选模型', results: [], scores: [], best: null };
  }

  const key = promptHash(prompt, opts.system) + '\x00' + candidatesHash(candidates) + '\x00' + (opts.judge || 'length');
  if (!opts.noCache) {
    const hit = _cache.get(key);
    if (hit) return Object.assign({ ok: true, fromCache: true }, hit);
  }

  const judge = opts.judge || 'length';

  // 并发跑所有候选（有界信号量）
  const raw = await _mapPool(
    candidates.map((c, idx) => ({ c, idx })),
    MAX_CONCURRENT,
    async ({ c, idx }) => {
      let r;
      try {
        r = await opts.callModel(c, { prompt, system: opts.system, temperature: opts.temperature });
      } catch (e) {
        r = { ok: false, error: String((e && e.message) || e) };
      }
      const text = (r && r.ok && (r.text != null || r.content != null)) ? String(r.text != null ? r.text : r.content) : '';
      return {
        index: idx,
        id: c.id || c.model || ('candidate-' + idx),
        model: c.model || '',
        provider: c.provider || '',
        ok: !!(r && r.ok) && !!text,
        text,
        error: r && r.error ? String(r.error) : (text ? '' : '空响应'),
        score: scoreText(text)
      };
    }
  );

  // 挑选最优
  let bestIndex = -1;
  if (judge === 'llm') {
    if (typeof opts.llm === 'function') {
      try { bestIndex = await judgeWithLLM(raw, opts.llm); } catch (_) { bestIndex = -1; }
    }
    if (bestIndex < 0 || bestIndex >= raw.length) bestIndex = _pickByScore(raw);
  } else if (judge === 'first') {
    bestIndex = raw.findIndex((r) => r.ok && r.text);
    if (bestIndex < 0) bestIndex = _pickByScore(raw);
  } else {
    bestIndex = _pickByScore(raw);
  }

  const best = bestIndex >= 0 ? raw[bestIndex] : null;
  const out = {
    best,
    bestIndex,
    judge,
    results: raw,
    scores: raw.map((r) => ({ index: r.index, id: r.id, model: r.model, provider: r.provider, ok: r.ok, score: r.score }))
  };
  _cacheSet(key, { best: out.best, results: out.results, scores: out.scores });
  return Object.assign({ ok: true }, out);
}

function invalidate() { _cache.clear(); }
function cacheSize() { return _cache.size; }

module.exports = {
  runBestOfN,
  judgeWithLLM,
  scoreText,
  promptHash,
  candidatesHash,
  invalidate,
  cacheSize,
  MAX_CONCURRENT
};
