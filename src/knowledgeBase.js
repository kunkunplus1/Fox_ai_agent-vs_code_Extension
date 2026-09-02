'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const org = require('./knowledgeOrganizer');
const emb = require('./embedding');
const { appendLog } = require('./log');

// 向量层统一日志前缀：所有向量相关打点都带 [vec]，落盘 ~/.fox-ai/logs/kb.log
function vlog(s) {
  try { appendLog('kb', '[vec] ' + s); } catch (_) {}
}
function vlogErr(where, err) {
  try {
    const msg = err && err.stack ? String(err.stack).split('\n').slice(0, 4).join('\n') : String((err && err.message) || err);
    appendLog('kb', '[vec][ERR] ' + where + ' :: ' + msg);
  } catch (_) {}
}

const SUPPORTED_EXTS = new Set(['.md', '.txt', '.jsonl']);

// 用户显式授权可读取的其他会话摘要（跨会话隔离白名单）
const allowedOtherSessions = new Set();

function config() {
  return vscode.workspace.getConfiguration('foxAi').get('knowledgeBase') || {};
}

function isEnabled() {
  const cfg = config();
  // 1.1.27：顶层总开关（UI 页面「启用本地知识库」）。显式关闭时一票否决——
  // 总开关关掉后，即使子开关（整理/压缩/向量）开着，插件模型也用不了知识库工具。
  // 注意：只认「显式 false」（undefined 视为未设置，回退子开关判断，兼容老用户只开子开关）。
  if (cfg.enabled === false) return false;
  if (cfg.enabled === true) return true;
  if (cfg.organize && cfg.organize.enabled) return true;
  if (cfg.autoSummarize && cfg.autoSummarize.enabled) return true;
  // 只开了向量模型（语义检索）也算知识库启用
  if (cfg.embedding && cfg.embedding.enabled) return true;
  return false;
}

function expandHome(p) {
  if (p.startsWith('~/')) return path.join(process.env.HOME || process.env.USERPROFILE || '', p.slice(2));
  if (p.startsWith('~\\')) return path.join(process.env.USERPROFILE || '', p.slice(2));
  return p;
}

function* walkDir(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
        yield* walkDir(full);
      } else if (e.isFile() && SUPPORTED_EXTS.has(path.extname(e.name).toLowerCase())) {
        yield full;
      }
    }
  } catch (_) {}
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '';
  }
}

function chunkText(text, chunkSize, overlap) {
  const chunks = [];
  const step = Math.max(1, chunkSize - Math.max(0, overlap || 0));
  let i = 0;
  while (i < text.length) {
    let end = i + chunkSize;
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > i) end = nl + 1;
    }
    chunks.push(text.slice(i, end));
    i += step;
    if (i >= text.length) break;
  }
  return chunks;
}

function tokenize(text) {
  const s = String(text).toLowerCase();
  const tokens = [];
  // 拉丁字母 / 数字词（长度 ≥ 2 才有区分度）
  const latin = s.match(/[a-z0-9]+/g) || [];
  for (const w of latin) if (w.length >= 2) tokens.push(w);
  // 中文（CJK）按二元组切分：避免「酒月狐」被当成一整个词而无法在长句中命中。
  // 单个汉字的片段保留为一元组。
  const cjk = s.match(/[\u4e00-\u9fff]+/g) || [];
  for (const seg of cjk) {
    if (seg.length === 1) {
      tokens.push(seg);
      continue;
    }
    for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2));
  }
  return tokens;
}

/** 轻量 BM25：term 频率 × IDF，对长片段做长度归一 */
function scoreBM25(chunk, keywords, idf, avgLen) {
  const tokens = chunk._tokens || tokenize(chunk.text);
  const freq = {};
  for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
  let score = 0;
  const k1 = 1.2;
  const b = 0.75;
  const len = tokens.length || 1;
  for (const kw of keywords) {
    const f = freq[kw] || 0;
    if (!f) continue;
    const idfVal = idf[kw] || 0.1;
    score += idfVal * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (len / avgLen))));
  }
  return score;
}

function buildIdf(chunks, keywords) {
  const df = {};
  for (const c of chunks) {
    const tokens = c._tokens || tokenize(c.text);
    const seen = new Set(tokens);
    for (const kw of keywords) {
      if (seen.has(kw)) df[kw] = (df[kw] || 0) + 1;
    }
  }
  const N = Math.max(1, chunks.length);
  const idf = {};
  for (const kw of keywords) {
    const n = df[kw] || 0;
    idf[kw] = Math.log(1 + (N - n + 0.5) / (n + 0.5));
  }
  return idf;
}

/** 文件级索引缓存：按文件存储，只重建变更文件 */
const fileIndex = new Map();
let cacheKey = '';
let cacheBuiltAt = 0;
let cacheFileCount = 0;

const MAX_FILES = 400;          // 内存中最多保留多少文件（LRU 淘汰）
const MAX_CACHED_CHARS = 2 * 1024 * 1024; // 2MB 文本上限（从 4MB 下调）
const FILE_INDEX_TTL_MS = 30 * 60 * 1000; // 文件索引 30 分钟未访问则释放

function touchFileEntry(file) {
  const e = fileIndex.get(file);
  if (e) e.lastUsed = Date.now();
  return e;
}

/** 按 LRU + TTL 清理 fileIndex，避免知识库索引常驻内存无限增长 */
function pruneFileIndex() {
  const now = Date.now();
  // 先删过期条目
  for (const [file, e] of fileIndex) {
    if (e.lastUsed && now - e.lastUsed > FILE_INDEX_TTL_MS) fileIndex.delete(file);
  }
  // 再按 LRU 淘汰到目标水位
  if (fileIndex.size > MAX_FILES) {
    const sorted = Array.from(fileIndex.entries())
      .map(([file, e]) => ({ file, lastUsed: e.lastUsed || 0 }))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    const target = Math.floor(MAX_FILES * 0.8);
    for (let i = 0; i < sorted.length - target; i++) {
      fileIndex.delete(sorted[i].file);
    }
  }
}

/** 短时内存缓存：避免 retrieve 被频繁调用时反复遍历目录 */
let lastCollect = { key: '', fileSigs: '', all: [], at: 0 };
// 知识库片段扫描不做长时缓存：用户删除源文件后必须立即在检索中生效，否则旧内容会被 BM25/向量残留注入（0=每次实时扫盘）
const COLLECT_CACHE_MS = 0;

function fileSignature(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch (_) {
    return '';
  }
}

function listFiles(paths, sessionId) {
  const files = [];
  const cfg = config();
  const as = cfg.autoSummarize || {};
  const kb2Dir = as.enabled ? org.defaultAutoSummaryDir() : '';
  for (const p of paths) {
    let stat;
    try {
      stat = fs.statSync(p);
    } catch (_) {
      continue;
    }
    if (stat.isDirectory()) {
      for (const file of walkDir(p)) {
        // 知识库-2 目录按 session 隔离：只保留当前 session 与已授权的其他 session
        if (kb2Dir && file.startsWith(kb2Dir + path.sep)) {
          if (!isAllowedSummaryFile(file, sessionId)) continue;
        }
        files.push({ file, root: p });
        if (files.length >= MAX_FILES) return files;
      }
    } else {
      files.push({ file: p, root: null });
    }
  }
  return files;
}

function summarySessionId(filePath) {
  const base = path.basename(filePath);
  const m = base.match(/^([a-zA-Z0-9_-]+)-summary\.md$/);
  return m ? m[1] : null;
}

function isAllowedSummaryFile(filePath, currentSessionId) {
  const sid = summarySessionId(filePath);
  if (!sid) return false; // 非 session 摘要文件不扫描
  if (currentSessionId && sid === String(currentSessionId).replace(/[^a-zA-Z0-9_-]/g, '_')) return true;
  if (allowedOtherSessions.has(sid)) return true;
  return false;
}

function getCacheDir() {
  return path.join(os.homedir(), '.fox-ai', 'cache');
}

function cachePath() {
  return path.join(getCacheDir(), 'kb-index.json');
}

function loadDiskCache() {
  try {
    const p = cachePath();
    if (!fs.existsSync(p)) return;
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.files)) return;
    for (const f of data.files) {
      if (!f || !f.file || !Array.isArray(f.chunks)) continue;
      fileIndex.set(f.file, {
        signature: f.signature || '',
        chunks: f.chunks.map((c) => ({ text: c.text || '', source: c.source || '', file: f.file })),
        size: f.size || 0
      });
    }
    cacheBuiltAt = data.builtAt || 0;
    cacheFileCount = fileIndex.size;
  } catch (_) {}
}

function saveDiskCache() {
  try {
    const dir = getCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    let total = 0;
    for (const [file, entry] of fileIndex) {
      const chunks = entry.chunks.map((c) => ({ text: c.text, source: c.source }));
      total += chunks.reduce((s, c) => s + (c.text ? c.text.length : 0), 0);
      if (total > MAX_CACHED_CHARS) break;
      files.push({ file, signature: entry.signature, size: entry.size, chunks });
    }
    fs.writeFileSync(cachePath(), JSON.stringify({ builtAt: Date.now(), files }), 'utf8');
  } catch (_) {}
}

/**
 * 真增量索引：只重新 chunk 新增或修改的文件，删除已移除文件。
 * 返回当前所有 chunk 的扁平数组（不保留 lower 冗余字段）。
 * @param {string} [sessionId] 当前会话 ID；知识库-2 的自动摘要将按此 ID 隔离。
 */
function collectChunks(sessionId) {
  const cfg = config();
  const organize = cfg.organize || {};
  let paths = [];
  // 整理产物目录：只要存在就纳入（无论「AI 整理」开关是否开启）。
  // 关键修复：关掉整理后，残留的历史笔记仍在产物目录里，不应让向量检索突然失明
  // ——否则会出现「没有整理模型情况下，向量内容没识别到」。
  const out = org.defaultOutputDir();
  if (fs.existsSync(out)) paths.push(out);
  // 用户显式配置的源目录：始终纳入，是向量/BM25 的独立内容来源，不依赖整理开关。
  if (Array.isArray(cfg.paths) && cfg.paths.length) {
    for (const p of cfg.paths.map(expandHome).filter((p) => p && fs.existsSync(p))) paths.push(p);
  }
  // 自定义向量检索路径（额外检索源）：关键词检索（BM25）与向量语义检索同时纳入；
  // 留空则沿用默认位置（整理产物目录 + 已配置知识库目录 + 知识库-2），不影响「AI 整理」那部分。
  if (cfg.vectorRetrievalPath && typeof cfg.vectorRetrievalPath === 'string') {
    const vp = expandHome(cfg.vectorRetrievalPath.trim());
    if (vp && fs.existsSync(vp)) paths.push(vp);
  }
  const as = cfg.autoSummarize || {};
  if (as.enabled) {
    const dir = org.defaultAutoSummaryDir();
    if (fs.existsSync(dir)) paths.push(dir);
  }
  if (!paths.length) {
    vlog(
      'collectChunks：无任何检索来源（未启用整理、未配置知识库源目录 paths、也无整理产物残留）→ 向量/BM25 均无内容可检索；' +
        '请在「知识库」设置里配置源目录 paths，或保留整理产物目录'
    );
    return [];
  }

  const chunkSize = Math.max(200, cfg.chunkSize || 800);
  const overlap = Math.min(chunkSize - 1, Math.floor(chunkSize * 0.1));
  const safeSid = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const allowed = Array.from(allowedOtherSessions).sort().join(',');
  const key = JSON.stringify(paths) + '|' + chunkSize + '|' + overlap + '|' + safeSid + '|' + allowed;

  if (cacheKey !== key) {
    fileIndex.clear();
    loadDiskCache();
    cacheKey = key;
  }

  const started = Date.now();
  const entries = listFiles(paths, sessionId);
  const wanted = new Set(entries.map((e) => e.file));

  // 短时缓存命中：文件列表与签名均未变化，直接返回上次结果
  const fileSigs = entries.map((e) => e.file + ':' + fileSignature(e.file)).join('\n');
  if (
    cacheKey === key &&
    lastCollect.key === key &&
    lastCollect.fileSigs === fileSigs &&
    Date.now() - lastCollect.at < COLLECT_CACHE_MS
  ) {
    return lastCollect.all;
  }

  // 删除已不存在的文件
  for (const file of fileIndex.keys()) {
    if (!wanted.has(file)) fileIndex.delete(file);
  }

  let changed = 0;
  let totalChars = 0;
  for (const { file, root } of entries) {
    const sig = fileSignature(file);
    const existing = fileIndex.get(file);
    if (existing && existing.signature === sig) {
      existing.lastUsed = Date.now();
      totalChars += existing.size;
      continue;
    }
    const text = readTextFile(file);
    const source = root ? path.relative(root, file) : path.basename(file);
    const chunks = chunkText(text, chunkSize, overlap).map((t) => ({ text: t, source, file }));
    fileIndex.set(file, { signature: sig, chunks, size: text.length, lastUsed: Date.now() });
    totalChars += text.length;
    changed++;
  }

  // 定期 LRU/TTL 清理，防止索引常驻内存
  pruneFileIndex();

  cacheFileCount = fileIndex.size;

  // 控制内存：如果总字符超过阈值，只保留最近修改的文件的 chunk
  let all = [];
  if (totalChars > MAX_CACHED_CHARS) {
    const sorted = Array.from(fileIndex.entries())
      .map(([file, e]) => ({ file, e, sig: e.signature }))
      .sort((a, b) => {
        const ma = Number(a.sig.split(':')[0]) || 0;
        const mb = Number(b.sig.split(':')[0]) || 0;
        return mb - ma;
      });
    let kept = 0;
    for (const { e } of sorted) {
      if (kept + e.size > MAX_CACHED_CHARS && kept > 0) break;
      all = all.concat(e.chunks);
      kept += e.size;
    }
  } else {
    for (const e of fileIndex.values()) all = all.concat(e.chunks);
  }

  if (changed) {
    try { saveDiskCache(); } catch (_) {}
  }

  // 仅在首次构建或真正有变更时输出日志，避免每次 retrieve 都刷屏
  const isFirstBuild = cacheBuiltAt === 0;
  cacheBuiltAt = Date.now();
  lastCollect = { key, fileSigs, all, at: cacheBuiltAt };
  if (changed || isFirstBuild) {
    console.log(
      `[fox-ai] 知识库索引：${entries.length} 个文件 / ${all.length} 个片段，本次更新 ${changed} 个文件，字符 ${totalChars}，耗时 ${Date.now() - started}ms`
    );
  }
  return all;
}

function invalidate() {
  fileIndex.clear();
  cacheKey = '';
  cacheBuiltAt = 0;
  lastCollect = { key: '', fileSigs: '', all: [], at: 0 };
  try {
    const p = cachePath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) {}
  // 重建索引时向量缓存一并作废（文本变了，旧向量不再对应）
  try {
    invalidateVectors();
  } catch (_) {}
}

/**
 * 列出知识库-2 中存在的其他会话摘要文件（不含当前 session）。
 * @param {string} [currentSessionId]
 * @returns {{sessionId:string, file:string, title:string}[]}
 */
function listOtherSessionSummaries(currentSessionId) {
  const cfg = config();
  const as = cfg.autoSummarize || {};
  if (!as.enabled) return [];
  const dir = org.defaultAutoSummaryDir();
  if (!fs.existsSync(dir)) return [];
  const currentSafe = String(currentSessionId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const out = [];
  for (const f of walkDir(dir)) {
    const sid = summarySessionId(f);
    if (!sid || sid === currentSafe) continue;
    const text = readTextFile(f).trim();
    const firstLine = text.split('\n')[0] || '';
    const title = firstLine.replace(/^#+\s*/, '').slice(0, 80) || sid;
    out.push({ sessionId: sid, file: f, title });
  }
  return out;
}

/**
 * 请求读取指定会话的摘要。用户确认后加入白名单并清空索引缓存。
 * @param {string} sessionId 目标会话 ID（来自 listOtherSessionSummaries）
 * @param {string} [currentSessionId] 当前会话 ID
 * @returns {Promise<{allowed:boolean, sessionId:string}>}
 */
async function requestSessionAccess(sessionId, currentSessionId) {
  const safeId = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!safeId) return { allowed: false, sessionId: '' };
  const currentSafe = String(currentSessionId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  if (safeId === currentSafe) return { allowed: true, sessionId: safeId };
  if (allowedOtherSessions.has(safeId)) return { allowed: true, sessionId: safeId };

  const cfg = config();
  const as = cfg.autoSummarize || {};
  const dir = org.defaultAutoSummaryDir();
  const file = path.join(dir, `${safeId}-summary.md`);
  if (!fs.existsSync(file)) {
    return { allowed: false, sessionId: safeId, reason: '未找到该会话的压缩摘要文件' };
  }

  const choice = await vscode.window.showWarningMessage(
    `是否允许当前会话读取「${safeId}」会话的压缩上下文摘要？`,
    { modal: true, detail: '不同会话的上下文默认互相隔离，仅在你明确要求跨会话回忆时才可访问。' },
    '允许',
    '拒绝'
  );
  if (choice === '允许') {
    allowedOtherSessions.add(safeId);
    invalidate();
    return { allowed: true, sessionId: safeId };
  }
  return { allowed: false, sessionId: safeId };
}

function clearSessionAccess() {
  allowedOtherSessions.clear();
  invalidate();
}

function stats() {
  let chunks = 0;
  for (const e of fileIndex.values()) chunks += e.chunks.length;
  return { files: cacheFileCount, chunks, builtAt: cacheBuiltAt };
}

function listKnowledgeFiles(sessionId) {
  const cfg = config();
  const organize = cfg.organize || {};
  const as = cfg.autoSummarize || {};
  const files = [];
  // 整理产物目录：只要存在就纳入（无论「AI 整理」开关状态），避免「关整理后残留笔记从文件列表消失」
  const out = org.defaultOutputDir();
  if (fs.existsSync(out)) {
    for (const f of walkDir(out)) files.push({ file: f, source: path.basename(f), kb2: false });
  }
  // 显式源目录：始终纳入，是独立于整理开关的知识库内容来源
  if (Array.isArray(cfg.paths) && cfg.paths.length) {
    for (const p of cfg.paths.map(expandHome).filter((p) => p && fs.existsSync(p))) {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        for (const f of walkDir(p)) files.push({ file: f, source: path.relative(p, f), kb2: false });
      } else {
        files.push({ file: p, source: path.basename(p), kb2: false });
      }
    }
  }
  // 自定义向量检索路径（额外检索源）：与显式源目录同样处理，关键词与向量检索同时可用。
  if (cfg.vectorRetrievalPath && typeof cfg.vectorRetrievalPath === 'string') {
    const vp = expandHome(cfg.vectorRetrievalPath.trim());
    if (vp && fs.existsSync(vp)) {
      const stat = fs.statSync(vp);
      if (stat.isDirectory()) {
        for (const f of walkDir(vp)) files.push({ file: f, source: path.relative(vp, f), kb2: false });
      } else {
        files.push({ file: vp, source: path.basename(vp), kb2: false });
      }
    }
  }
  if (as.enabled) {
    const dir = org.defaultAutoSummaryDir();
    if (fs.existsSync(dir)) {
      for (const f of walkDir(dir)) {
        if (!isAllowedSummaryFile(f, sessionId)) continue;
        files.push({ file: f, source: path.basename(f), kb2: true });
      }
    }
  }
  return files;
}

/**
 * 检索相关片段。
 * 整理模式下优先全量注入整理后目录；非整理模式用 BM25 打分取 Top-K。
 * @param {string} [sessionId] 当前会话 ID；自动摘要按会话隔离。
 */
function retrieve(query, maxChars, sessionId, opts) {
  const cfg = config();
  const organize = cfg.organize || {};
  const chunks = collectChunks(sessionId);
  if (!chunks.length) return '';

  const limit = Math.max(0, maxChars || 8000);
  const bm25Enabled = cfg.bm25Enabled !== false;
  const topK = Math.max(3, Math.min(30, cfg.topK || 10));
  // 收集本次注入的知识来源（label + 绝对文件路径），供角标点击定位文件
  const srcs = [];
  const pushSrc = (c) => srcs.push({ label: c.source, file: c.file });
  const flushSrcs = () => {
    if (opts && typeof opts.onSources === 'function') {
      const seen = new Set();
      const uniq = [];
      for (const s of srcs) {
        if (seen.has(s.file)) continue;
        seen.add(s.file);
        uniq.push(s);
      }
      opts.onSources(uniq);
    }
  };

  // 整理模式：整理后的文件数量通常可控，直接按文件排序全量注入
  // 1.1.27：forceOrganize 覆盖——模型传 organize=true 时即使页面未开整理也只看整理产物
  if (organize.enabled || (opts && opts.forceOrganize)) {
    const outDir = org.defaultOutputDir();
    const out = [];
    let used = 0;
    const orgChunks = chunks.filter((c) => c.file.startsWith(outDir + path.sep));
    for (const c of orgChunks.sort((a, b) => a.file.localeCompare(b.file))) {
      if (used + c.text.length > limit) break;
      out.push(`【来源：${c.source}】\n${c.text.trim()}`);
      used += c.text.length + 30;
      pushSrc(c);
    }
    const as = cfg.autoSummarize || {};
    const kb2Dir = as.enabled ? org.defaultAutoSummaryDir() : '';
    const kb2Chunks = kb2Dir ? chunks.filter((c) => c.file.startsWith(kb2Dir + path.sep)) : [];
    if (kb2Chunks.length) {
      const scored = rankChunks(kb2Chunks, query, bm25Enabled, topK);
      for (const c of scored) {
        if (used + c.text.length > limit) break;
        out.push(`【来源：${c.source}（知识库-2）】\n${c.text.trim()}`);
        used += c.text.length + 30;
        pushSrc(c);
      }
    }
    flushSrcs();
    return out.join('\n\n---\n\n');
  }

  // 非整理模式：按关键词 / BM25 检索
  const scored = rankChunks(chunks, query, bm25Enabled, topK);
  const out = [];
  let used = 0;
  for (const c of scored) {
    if (used + c.text.length > limit) break;
    out.push(`【来源：${c.source} · 相关度 ${c.score.toFixed(2)}】\n${c.text.trim()}`);
    used += c.text.length + 30;
    pushSrc(c);
  }
  return out.join('\n\n---\n\n');
}

function rankChunks(chunks, query, bm25Enabled, topK) {
  const keywords = tokenize(query);
  if (!keywords.length) return chunks.slice(0, topK).map((c) => ({ ...c, score: 0 }));

  // 给每个 chunk 预计算 tokens（一次性）
  for (const c of chunks) {
    if (!c._tokens) c._tokens = tokenize(c.text);
  }

  const avgLen = chunks.reduce((s, c) => s + (c._tokens.length || 1), 0) / Math.max(1, chunks.length);
  const idf = buildIdf(chunks, keywords);

  const scored = [];
  for (const c of chunks) {
    const score = bm25Enabled ? scoreBM25(c, keywords, idf, avgLen) : scoreLegacy(c, keywords);
    if (score > 0) scored.push({ text: c.text, source: c.source, file: c.file, score });
  }
  scored.sort((a, b) => b.score - a.score);

  // 相邻去重：同一文件连续高相关片段合并时避免重复展示
  const seen = new Set();
  const out = [];
  for (const c of scored) {
    if (out.length >= topK) break;
    const key = c.file + ':' + c.text.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** 兼容旧版的关键词子串打分 */
function scoreLegacy(chunk, keywords) {
  const lower = chunk.text.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    let idx = lower.indexOf(kw);
    while (idx !== -1) {
      score += kw.length;
      idx = lower.indexOf(kw, idx + 1);
    }
  }
  return score;
}

/* ==========================================================================
 * 向量检索层（1.1.33）
 *
 * 与「整理模型」彻底解耦，行为按用户约定的两种情况：
 *   情况一 只配整理模型 → 本层完全不介入，检索与旧版一致（BM25 关键词 / 整理模式全量注入）。
 *   情况二 整理 + 向量都配 → 向量模型先做语义召回（前置），排序结果再交给上层注入；
 *          整理模型依旧负责产出笔记（在后），向量只是「读」它的产物，不改内容。
 * 无论是否配置，UI 都有 foxAi.knowledgeBase.embedding.enabled 开关随时启停。
 *
 * 缓存策略：向量按「文本内容哈希」存于独立文件 kb-vector-store.json，每条带来源文件与签名；
 *   换模型 / 换维度 → 签名变化 → 整体作废重建；来源文件被删/改动 → 该条向量自动作废（防复活），落盘有界（LRU 淘汰）。
 * 失败策略：任何一步抛错都优雅回退到 BM25，绝不让知识库整体失效。
 * ========================================================================== */

const vecStore = new Map(); // textHash -> { vec:number[], text:string, file:string, sig:string, at:number }
let vecSig = '';            // 当前向量签名（provider|model|dims|kind）
let vecLoaded = false;
const MAX_VEC_ENTRIES = 4000;         // 内存/磁盘最多缓存多少条向量
const MAX_EMBED_PER_RETRIEVE = 300;   // 单次检索最多补算多少条，避免首次卡住

function vecCachePath() {
  // 向量模型的专属独立文件（自包含 text/file/sig，不依赖整理产物目录）
  return path.join(getCacheDir(), 'kb-vector-store.json');
}

/** 安全取文件签名：文件不存在/异常返回空串（用于来源失效判定） */
function fileSigOf(file) {
  if (!file) return '';
  try {
    return fs.existsSync(file) ? fileSignature(file) : '';
  } catch (_) {
    return '';
  }
}

/** 判断向量条目来源是否仍有效（文件存在且签名未变）；源被删或改动即失效 */
function isSourceFresh(entry) {
  if (!entry || !entry.file) return false;
  const sig = fileSigOf(entry.file);
  return !!sig && sig === entry.sig;
}

function textHash(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 24);
}

function embedSignature(e) {
  return [e.pid || '', e.model || '', e.dimensions || 0, e.kind || ''].join('|');
}

function loadVecCache(sig) {
  if (vecLoaded && vecSig === sig) return;
  vecStore.clear();
  vecSig = sig;
  vecLoaded = true;
  try {
    const p = vecCachePath();
    if (!fs.existsSync(p)) return;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!data || data.sig !== sig || !Array.isArray(data.items)) {
      // 换了模型/维度/损坏 → 整体作废旧缓存文件
      try { fs.unlinkSync(p); } catch (_) {}
      return;
    }
    for (const it of data.items) {
      if (!it || !it.k || !Array.isArray(it.v) || !it.v.length) continue;
      vecStore.set(it.k, { vec: it.v, text: it.t || '', file: it.f || '', sig: it.s || '', at: it.at || 0 });
      if (vecStore.size >= MAX_VEC_ENTRIES) break;
    }
    // 加载后立即剔除「来源已删除/变更」的脏向量（如旧版遗留的 file 空条目），防止复活旧内容
    pruneStaleVectors();
  } catch (_) {}
}

function saveVecCache() {
  try {
    fs.mkdirSync(getCacheDir(), { recursive: true });
    const items = Array.from(vecStore.entries())
      .map(([k, v]) => ({ k, v: v.vec, t: v.text || '', f: v.file || '', s: v.sig || '', at: v.at || 0 }))
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_VEC_ENTRIES);
    fs.writeFileSync(vecCachePath(), JSON.stringify({ sig: vecSig, items }), 'utf8');
  } catch (_) {}
}

function pruneVecStore() {
  if (vecStore.size <= MAX_VEC_ENTRIES) return;
  const sorted = Array.from(vecStore.entries()).sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
  const target = Math.floor(MAX_VEC_ENTRIES * 0.8);
  for (let i = 0; i < sorted.length - target; i++) vecStore.delete(sorted[i][0]);
}

/** 剔除「来源文件已删除 / 已变更」的向量条目：防止删了知识库内容后旧向量被复活注入 */
function pruneStaleVectors() {
  let removed = 0;
  for (const [k, v] of vecStore) {
    if (!isSourceFresh(v)) {
      vecStore.delete(k);
      removed++;
    }
  }
  if (removed) {
    vlog(`pruneStaleVectors：剔除 ${removed} 条来源已失效（文件删除/变更）的向量`);
    try {
      fs.unlinkSync(vecCachePath());
    } catch (_) {}
  }
  return removed;
}

function invalidateVectors() {
  vecStore.clear();
  vecSig = '';
  vecLoaded = false;
  try {
    const p = vecCachePath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
    // 兼容旧文件名
    const old = path.join(getCacheDir(), 'kb-vec.json');
    if (fs.existsSync(old)) fs.unlinkSync(old);
  } catch (_) {}
}

/** 手动清空向量缓存（UI 按钮/命令触发）：删除知识库内容后用于强制重置任何顽固残留 */
function clearVectorCache() {
  vecStore.clear();
  vecSig = '';
  vecLoaded = false;
  try {
    const p = vecCachePath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
    const old = path.join(getCacheDir(), 'kb-vec.json');
    if (fs.existsSync(old)) fs.unlinkSync(old);
  } catch (_) {}
  vlog('clearVectorCache：已清空向量缓存文件');
  return { ok: true };
}

/** 解析向量模型配置；未启用 / 配不全返回 null（上层直接走 BM25）。
 *  @param {{force?:boolean}} [opts] force=true 时忽略 embedding.enabled 开关（工具传 vector:true 强制尝试），
 *   但 baseUrl/model 仍须配置完整，多模态模型仍拒绝。 */
async function resolveVectorConfig(context, opts) {
  try {
    const force = !!(opts && opts.force);
    const e = await emb.resolveEmbeddingConfig(context);
    if (!e.enabled && !force) {
      vlog('resolveVectorConfig：向量检索开关未开启（embedding.enabled=false）→ 走 BM25');
      return null;
    }
    if (e.multimodal) {
      vlog(
        'resolveVectorConfig：⚠️ 模型 ' + e.model + ' 是多模态/视觉语言向量模型，不支持 OpenAI 兼容 /v1/embeddings' +
          '（会返回 400 url error）；纯文本知识库请改用 text-embedding-v4 或 qwen3-embedding → 回退 BM25'
      );
      return null;
    }
    if (!emb.isEmbedUsable(Object.assign({}, e, { enabled: force || !!e.enabled }))) {
      vlog(
        'resolveVectorConfig：向量配置不可用 → 走 BM25。' +
          `enabled=${e.enabled} kind=${e.kind} baseUrl=${e.baseUrl || '(空)'} model=${e.model || '(空)'} provider=${e.pid}` +
          (e.noOfficialApi ? ' [该厂商官方暂无 embedding 接口，需自填兼容端点]' : '')
      );
      return null;
    }
    vlog(
      `resolveVectorConfig：向量配置可用 → ${e.label}/${e.model}（${e.kind === 'ollama' ? 'Ollama 原生' : 'OpenAI 兼容'}）` +
        ` baseUrl=${e.baseUrl} dims=${e.dimensions || '默认'} batch=${e.batchSize} hybrid=${e.hybrid}`
    );
    return e;
  } catch (err) {
    vlogErr('resolveVectorConfig 解析异常', err);
    return null;
  }
}

/** 把缺失向量的片段补算出来（受预算限制），返回本次实际补算条数 */
async function ensureVectors(chunks, e, opts) {
  const o = opts || {};
  const budget = Math.max(0, o.budget == null ? MAX_EMBED_PER_RETRIEVE : o.budget);
  if (!budget) return 0;
  pruneStaleVectors(); // 先清掉已删/已改动来源的旧向量，避免复活
  const missing = [];
  const seen = new Set();
  for (const c of chunks) {
    const text = String(c.text || '').trim();
    if (!text) continue;
    const k = textHash(text);
    if (vecStore.has(k) || seen.has(k)) continue;
    seen.add(k);
    missing.push({ k, text, file: c.file || '', sig: fileSigOf(c.file) });
    if (missing.length >= budget) break;
  }
  if (!missing.length) return 0;
  vlog(`ensureVectors：需补算 ${missing.length} 条向量（预算 ${budget}）；签名=${embedSignature(e)}`);
  let vecs;
  try {
    vecs = await emb.embedTexts(missing.map((m) => m.text), e, o);
  } catch (err) {
    vlogErr('ensureVectors 向量化失败', err);
    throw err;
  }
  const now = Date.now();
  for (let i = 0; i < missing.length && i < vecs.length; i++) {
    vecStore.set(missing[i].k, { vec: vecs[i], text: missing[i].text, file: missing[i].file, sig: missing[i].sig, at: now });
  }
  pruneVecStore();
  saveVecCache();
  vlog(`ensureVectors：实际补算 ${Math.min(missing.length, vecs.length)} 条（维度 ${vecs[0] ? vecs[0].length : '?'}，缓存落盘 ${vecStore.size} 条）`);
  return Math.min(missing.length, vecs.length);
}

/**
 * 语义排序（可与 BM25 做 RRF 混排）。
 * @returns {Promise<{list:Array, covered:number, total:number}>}
 */
async function rankChunksSemantic(chunks, query, e, topK, hybrid, opts) {
  vlog(`rankChunksSemantic：入参 chunks=${chunks.length} topK=${topK} hybrid=${hybrid} queryLen=${String(query || '').length}`);
  const qVecs = await emb.embedTexts([String(query || '').slice(0, 4000)], e, opts);
  const qVec = qVecs && qVecs[0];
  if (!qVec) throw new Error('查询向量为空');
  vlog(`rankChunksSemantic：查询向量维度=${qVec.length}`);

  await ensureVectors(chunks, e, opts);

  const semantic = [];
  let covered = 0;
  const stale = [];
  for (const c of chunks) {
    const k = textHash(String(c.text || '').trim());
    const entry = vecStore.get(k);
    if (!entry) continue;
    // 来源失效（文件已删/已改动）：该向量作废，绝不把旧内容注入主控
    if (!isSourceFresh(entry)) {
      stale.push(k);
      continue;
    }
    covered++;
    entry.at = Date.now();
    semantic.push({ text: c.text, source: c.source, file: c.file, score: emb.cosineSimilarity(qVec, entry.vec) });
  }
  if (stale.length) {
    for (const k of stale) vecStore.delete(k);
    saveVecCache();
    vlog(`rankChunksSemantic：剔除 ${stale.length} 条来源失效的向量（源内容已被删除/修改）`);
  }
  semantic.sort((a, b) => b.score - a.score);

  if (!hybrid) {
    return { list: dedupTop(semantic, topK), covered, total: chunks.length };
  }

  // RRF（Reciprocal Rank Fusion）：只按排名融合，无需为两路打分做量纲对齐
  const K = 60;
  const fused = new Map();
  const keyOf = (c) => c.file + '#' + textHash(String(c.text || '').trim());
  semantic.forEach((c, i) => {
    const k = keyOf(c);
    fused.set(k, { text: c.text, source: c.source, file: c.file, score: 1 / (K + i + 1), sem: c.score });
  });
  let lexical = [];
  try {
    lexical = rankChunks(chunks, query, config().bm25Enabled !== false, Math.max(topK, 20));
  } catch (_) {
    lexical = [];
  }
  lexical.forEach((c, i) => {
    const k = keyOf(c);
    const prev = fused.get(k);
    if (prev) prev.score += 1 / (K + i + 1);
    else fused.set(k, { text: c.text, source: c.source, file: c.file, score: 1 / (K + i + 1), sem: 0 });
  });
  const merged = Array.from(fused.values()).sort((a, b) => b.score - a.score);
  return { list: dedupTop(merged, topK), covered, total: chunks.length };
}

function dedupTop(list, topK) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (out.length >= topK) break;
    const key = c.file + ':' + String(c.text || '').slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * 异步检索：向量模型可用时走语义召回（前置），否则完全等价于同步 retrieve。
 * @param {string} query 用户提问
 * @param {number} maxChars 注入上限
 * @param {string} [sessionId]
 * @param {{context?:object, signal?:AbortSignal, onLog?:Function}} [opts]
 */
async function retrieveAsync(query, maxChars, sessionId, opts) {
  const o = opts || {};
  // 收集本次注入的知识来源（label + 绝对文件路径），供角标点击定位文件
  const srcs = [];
  const pushSrc = (c) => srcs.push({ label: c.source, file: c.file });
  const flushSrcs = () => {
    if (o && typeof o.onSources === 'function') {
      const seen = new Set();
      const uniq = [];
      for (const s of srcs) {
        if (seen.has(s.file)) continue;
        seen.add(s.file);
        uniq.push(s);
      }
      o.onSources(uniq);
    }
  };
  vlog(`retrieveAsync：入口 query="${String(query || '').slice(0, 60)}" maxChars=${maxChars} sessionId=${sessionId || '(无)'} context=${o.context ? '有' : '无'} forceOrganize=${!!o.forceOrganize} forceVector=${!!o.forceVector} noVector=${!!o.noVector}`);
  // 1.1.27：工具参数 override——noVector 跳过向量；forceVector 忽略页面向量开关强行尝试（配置仍须可用）
  if (!o.noVector) {
    const e = await resolveVectorConfig(o.context, o.forceVector ? { force: true } : undefined);
    if (e) {
      const cfg = config();
      const organize = cfg.organize || {};
      const chunks = collectChunks(sessionId);
      if (!chunks.length) {
        vlog('retrieveAsync：无知识库片段 → 返回空');
        return '';
      }

      const limit = Math.max(0, maxChars || 8000);
      const topK = Math.max(3, Math.min(30, cfg.topK || 10));

      // 候选池：整理模式只看「整理后的产物」+ 知识库-2；否则全部片段
      // 1.1.27：forceOrganize 覆盖——模型传 organize=true 时即使页面未开整理也只看整理产物
      let pool = chunks;
      if (organize.enabled || o.forceOrganize) {
        const outDir = org.defaultOutputDir();
        const as = cfg.autoSummarize || {};
        const kb2Dir = as.enabled ? org.defaultAutoSummaryDir() : '';
        pool = chunks.filter(
          (c) => c.file.startsWith(outDir + path.sep) || (kb2Dir && c.file.startsWith(kb2Dir + path.sep))
        );
        if (!pool.length) pool = chunks;
      }
      vlog(`retrieveAsync：候选池 ${pool.length}/${chunks.length} 片段（整理模式=${!!organize.enabled || !!o.forceOrganize}）`);

      loadVecCache(embedSignature(e));

      try {
        const started = Date.now();
        const { list, covered, total } = await rankChunksSemantic(pool, query, e, topK, e.hybrid !== false, o);
        if (!list.length) {
          vlog('retrieveAsync：语义召回为空 → 回退 BM25');
          return retrieve(query, maxChars, sessionId, o);
        }
        const out = [];
        let used = 0;
        for (const c of list) {
          if (used + c.text.length > limit) break;
          const rel = typeof c.sem === 'number' && c.sem ? c.sem : c.score;
          out.push(`【来源：${c.source} · 语义相关度 ${Number(rel).toFixed(2)}】\n${c.text.trim()}`);
          used += c.text.length + 30;
          pushSrc(c);
        }
    const stat =
      `🧭 向量检索：${e.label} / ${e.model}（${e.kind === 'ollama' ? 'Ollama 原生' : 'OpenAI 兼容'}）` +
      `，候选 ${total} 片段、已向量化 ${covered}，命中 ${out.length} 段，耗时 ${Date.now() - started}ms` +
      (e.hybrid !== false ? '，混排 BM25' : '');
    vlog(stat);
    if (o.onLog) o.onLog(stat);
    if (!out.length) return retrieve(query, maxChars, sessionId, o);
    flushSrcs();
    return out.join('\n\n---\n\n');
  } catch (err) {
    const msg = String((err && err.message) || err).split('\n')[0];
    const full = err && err.stack ? String(err.stack).split('\n').slice(0, 5).join('\n') : msg;
    console.warn('[fox-ai] 向量检索失败，已回退关键词检索：' + msg);
    vlog('retrieveAsync 失败已回退 BM25：' + full);
    if (o.onLog) o.onLog(`⚠️ 向量检索失败，已回退关键词检索：${msg}`);
    return retrieve(query, maxChars, sessionId, o);
  }
    }
    // 1.1.27：向量不可用（未开/配不全）→ 回退 BM25；forceVector 且配置不可用时同样回退并说明
    vlog('retrieveAsync：向量不可用 → 回退 BM25' + (o.forceVector ? '（forceVector 但配置不可用）' : ''));
    return retrieve(query, maxChars, sessionId, o);
  }
  // 1.1.27：noVector=true（模型指定跳过向量）→ 直接走 BM25
  return retrieve(query, maxChars, sessionId, o);
}

/**
 * 主动构建全量向量索引（UI「构建向量索引」按钮用）。
 * @returns {Promise<{ok:boolean, added:number, total:number, reason?:string}>}
 */
async function buildVectors(sessionId, opts) {
  const o = opts || {};
  vlog(`buildVectors：入口 sessionId=${sessionId || '(无)'} context=${o.context ? '有' : '无'}`);
  const e = await resolveVectorConfig(o.context);
  if (!e) {
    let reason = '向量模型未启用或未配置完整（需 baseUrl + 模型名）';
    try {
      const raw = await emb.resolveEmbeddingConfig(o.context);
      if (raw && raw.multimodal) {
        reason =
          `模型 ${raw.model} 是多模态(视觉语言)向量模型，不支持 OpenAI 兼容 /v1/embeddings（会 400 url error）；` +
          '纯文本知识库请改用 text-embedding-v4 或 qwen3-embedding';
      }
    } catch (_) {}
    vlog('buildVectors：配置不可用 → ' + reason);
    return { ok: false, added: 0, total: 0, reason };
  }
  const chunks = collectChunks(sessionId);
  if (!chunks.length) {
    vlog('buildVectors：知识库暂无可索引内容');
    return { ok: false, added: 0, total: 0, reason: '知识库暂无可索引内容' };
  }
  vlog(`buildVectors：开始全量构建，候选 ${chunks.length} 片段，模型 ${e.label}/${e.model}`);
  loadVecCache(embedSignature(e));
  try {
    const added = await ensureVectors(chunks, e, Object.assign({}, o, { budget: MAX_VEC_ENTRIES }));
    vlog(`buildVectors：完成，新增 ${added}/${chunks.length} 条向量`);
    if (o.onLog) o.onLog(`✅ 向量索引构建完成：新增 ${added}/${chunks.length} 条`);
    return { ok: true, added, total: chunks.length };
  } catch (err) {
    vlogErr('buildVectors 构建失败', err);
    if (o.onLog) o.onLog(`⚠️ 向量索引构建失败：${String((err && err.message) || err).split('\n')[0]}`);
    return { ok: false, added: 0, total: chunks.length, reason: String((err && err.message) || err).split('\n')[0] };
  }
}

/** 向量索引状态（供 UI 展示） */
function vectorStats() {
  return { entries: vecStore.size, sig: vecSig, loaded: vecLoaded };
}

/**
 * 异步版系统提示词增强：向量模型启用时走语义召回，否则与同步版行为一致。
 */
async function augmentSystemPromptAsync(basePrompt, query, sessionId, opts) {
  if (!isEnabled()) return basePrompt;
  vlog(`augmentSystemPromptAsync：入口（${opts && opts.context ? '有 context' : '无 context'}）query="${String(query || '').slice(0, 50)}"`);
  const cfg = config();
  let context = '';
  try {
    context = await retrieveAsync(query, cfg.maxChars || 8000, sessionId, opts);
  } catch (err) {
    vlogErr('augmentSystemPromptAsync 向量检索异常，回退同步', err);
    context = retrieve(query, cfg.maxChars || 8000, sessionId, opts);
  }
  const files = listKnowledgeFiles(sessionId);
  vlog(`augmentSystemPromptAsync：注入上下文长度 ${context.length}，文件数 ${files.length}`);
  if (!context.trim() && !files.length) return basePrompt;
  return renderInjected(basePrompt, context, files);
}

function augmentSystemPrompt(basePrompt, query, sessionId, opts) {
  if (!isEnabled()) return basePrompt;
  const cfg = config();
  const context = retrieve(query, cfg.maxChars || 8000, sessionId, opts);
  const files = listKnowledgeFiles(sessionId);
  if (!context.trim() && !files.length) return basePrompt;
  return renderInjected(basePrompt, context, files);
}

/**
 * 注入内容防注入转义（1.1.18g，对齐 DSH agent-instructions 的 `<system-reminder>` 转义）。
 * 知识库文件是外部注入文本，可能藏伪装「系统指令」标签（如 `<system-reminder>`、
 * `<fox:system>`、`<tool>` 等闭合标签），把它们注入 system 会让模型把文件内容当成
 * 真正的控制指令。这里把常见闭合标签的 `/` 转义为 `\\/`（如 `</system-reminder>` →
 * `<\\/system-reminder>`），让模型看到的是普通文本而非可闭合的标签结构。
 * @param {string} text 外部注入文本
 * @returns {string} 转义后的文本
 */
function escapeInjectedTags(text) {
  return String(text).replace(/<\/(system-reminder|fox:system|system|tool|foxtool|fox:tool)>/gi, '<\\/$1>');
}

/** 拼装注入文本（同步 / 异步两条路径共用，保证格式完全一致） */
function renderInjected(basePrompt, context, files) {
  const fileList = files.map((f) => (f.kb2 ? `${f.source}(知识库-2)` : f.source)).join('、');
  /** 1.1.18f（对齐 DSH agent-instructions 基线语义）：知识库是「基线快照」而非追加历史——
   * 头部明确「本基线取代先前所有知识库基线」，防止模型把旧轮的知识库（可能已过期）当最新。 */
  let injected = `${basePrompt}\n\n【本地知识库参考·当前基线】\n`;
  injected += `本知识库基线取代先前所有知识库基线；当前可用的知识库文件：${fileList}\n\n`;
  if (context.trim()) injected += `${escapeInjectedTags(context)}\n\n`;
  injected += '（以上来自本地知识库，回答用户问题时请优先参考其中内容；不要调用 find_files / search_text 等工作区工具去“确认知识库是否存在”。）';
  return injected;
}

/**
 * 知识库文件清单指纹（1.1.18f）：用文件集合（含来源名）生成稳定指纹，
 * 供主控判断「知识库是否新增/移除/变更了文件」——同话题续轮时只对变更发增量块。
 * @param {Array<{file:string,source:string,kb2?:boolean}>} files
 * @returns {string} sha1 指纹（空集合返回空串）
 */
function filesFingerprint(files) {
  if (!Array.isArray(files) || files.length === 0) return '';
  const joined = files
    .map((f) => (f.kb2 ? `${f.source}#kb2` : f.source))
    .sort()
    .join('\u0000');
  return textHash(joined);
}

module.exports = {
  isEnabled, retrieve, augmentSystemPrompt, invalidate, stats, listKnowledgeFiles,
  listOtherSessionSummaries, requestSessionAccess, clearSessionAccess,
  // 向量检索（1.1.33）
  retrieveAsync, augmentSystemPromptAsync, buildVectors, vectorStats, invalidateVectors, clearVectorCache,
  // 纯函数导出，供单测
  embedSignature, textHash, dedupTop, filesFingerprint, escapeInjectedTags
};
