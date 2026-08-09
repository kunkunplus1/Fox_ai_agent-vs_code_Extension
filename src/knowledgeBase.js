'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const org = require('./knowledgeOrganizer');

const SUPPORTED_EXTS = new Set(['.md', '.txt', '.jsonl']);

// 用户显式授权可读取的其他会话摘要（跨会话隔离白名单）
const allowedOtherSessions = new Set();

function config() {
  return vscode.workspace.getConfiguration('foxAi').get('knowledgeBase') || {};
}

function isEnabled() {
  const cfg = config();
  if (cfg.enabled) return true;
  if (cfg.organize && cfg.organize.enabled) return true;
  if (cfg.autoSummarize && cfg.autoSummarize.enabled) return true;
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
const COLLECT_CACHE_MS = 5000;

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
  const kb2Dir = as.enabled ? org.defaultAutoSummaryDir(as.dir) : '';
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
  if (organize.enabled) {
    const out = org.defaultOutputDir(organize.outputDir);
    if (fs.existsSync(out)) paths.push(out);
  } else if (Array.isArray(cfg.paths) && cfg.paths.length) {
    for (const p of cfg.paths.map(expandHome).filter((p) => p && fs.existsSync(p))) paths.push(p);
  }
  const as = cfg.autoSummarize || {};
  if (as.enabled) {
    const dir = org.defaultAutoSummaryDir(as.dir);
    if (fs.existsSync(dir)) paths.push(dir);
  }
  if (!paths.length) return [];

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
  const dir = org.defaultAutoSummaryDir(as.dir);
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
  const dir = org.defaultAutoSummaryDir(as.dir);
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
  if (organize.enabled) {
    const out = org.defaultOutputDir(organize.outputDir);
    if (fs.existsSync(out)) {
      for (const f of walkDir(out)) files.push({ file: f, source: path.basename(f), kb2: false });
    }
  } else if (Array.isArray(cfg.paths) && cfg.paths.length) {
    for (const p of cfg.paths.map(expandHome).filter((p) => p && fs.existsSync(p))) {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        for (const f of walkDir(p)) files.push({ file: f, source: path.relative(p, f), kb2: false });
      } else {
        files.push({ file: p, source: path.basename(p), kb2: false });
      }
    }
  }
  if (as.enabled) {
    const dir = org.defaultAutoSummaryDir(as.dir);
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
function retrieve(query, maxChars, sessionId) {
  const cfg = config();
  const organize = cfg.organize || {};
  const chunks = collectChunks(sessionId);
  if (!chunks.length) return '';

  const limit = Math.max(0, maxChars || 8000);
  const bm25Enabled = cfg.bm25Enabled !== false;
  const topK = Math.max(3, Math.min(30, cfg.topK || 10));

  // 整理模式：整理后的文件数量通常可控，直接按文件排序全量注入
  if (organize.enabled) {
    const outDir = org.defaultOutputDir(organize.outputDir);
    const out = [];
    let used = 0;
    const orgChunks = chunks.filter((c) => c.file.startsWith(outDir + path.sep));
    for (const c of orgChunks.sort((a, b) => a.file.localeCompare(b.file))) {
      if (used + c.text.length > limit) break;
      out.push(`【来源：${c.source}】\n${c.text.trim()}`);
      used += c.text.length + 30;
    }
    const as = cfg.autoSummarize || {};
    const kb2Dir = as.enabled ? org.defaultAutoSummaryDir(as.dir) : '';
    const kb2Chunks = kb2Dir ? chunks.filter((c) => c.file.startsWith(kb2Dir + path.sep)) : [];
    if (kb2Chunks.length) {
      const scored = rankChunks(kb2Chunks, query, bm25Enabled, topK);
      for (const c of scored) {
        if (used + c.text.length > limit) break;
        out.push(`【来源：${c.source}（知识库-2）】\n${c.text.trim()}`);
        used += c.text.length + 30;
      }
    }
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

function augmentSystemPrompt(basePrompt, query, sessionId) {
  if (!isEnabled()) return basePrompt;
  const cfg = config();
  const context = retrieve(query, cfg.maxChars || 8000, sessionId);
  const files = listKnowledgeFiles(sessionId);
  if (!context.trim() && !files.length) return basePrompt;

  const fileList = files.map((f) => (f.kb2 ? `${f.source}(知识库-2)` : f.source)).join('、');
  let injected = `${basePrompt}\n\n【本地知识库参考】\n`;
  injected += `当前可用的知识库文件：${fileList}\n\n`;
  if (context.trim()) injected += `${context}\n\n`;
  injected += '（以上来自本地知识库，回答用户问题时请优先参考其中内容；不要调用 find_files / search_text 等工作区工具去“确认知识库是否存在”。）';
  return injected;
}

module.exports = {
  isEnabled, retrieve, augmentSystemPrompt, invalidate, stats, listKnowledgeFiles,
  listOtherSessionSummaries, requestSessionAccess, clearSessionAccess
};
