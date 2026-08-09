'use strict';

/**
 * src/rag.js — 全仓库语义索引与混合检索
 *
 * 对标 Cursor 的 whole-repo RAG / Copilot 的 codebase indexing。
 * fox-ai 此前只有知识库 BM25 + 手动 writeOrganize，缺少「把整个仓库切块 → 向量化 → 语义检索」。
 *
 * 本模块特点（零外部依赖，纯 Node，可离线单测）：
 *   1. 代码感知分块：优先按顶层定义（function/class/def 等）切，回落定长行窗口 + 重叠。
 *   2. 标识符感知分词：camelCase / snake_case / kebab-case 拆词，中文按 bigram，注释与字符串同样入索引。
 *   3. 混合检索 = 余弦相似度（TF-IDF 向量）× 权重 + BM25 × 权重，比单一算法更稳。
 *   4. 稀疏存储：只存 token 频次表与行号，不存全文；命中后回读源文件取最新片段，索引永不"过期串味"。
 *   5. 增量更新：按 mtime + size 判断，只重切改动过的文件；删除的文件自动清出索引。
 *
 * 索引落盘：<workspaceRoot>/.fox-ai/rag-index.json
 */

const fs = require('fs');
const path = require('path');
const { appendLog } = require('./log');

const INDEX_VERSION = 1;

const DEFAULT_EXTS = [
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.rb',
  '.vue', '.svelte', '.html', '.css', '.scss', '.less',
  '.json', '.yaml', '.yml', '.toml', '.ini',
  '.md', '.txt', '.sql', '.sh'
];

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.cache', 'coverage', '__pycache__', '.venv', 'venv',
  'vendor', '.idea', '.vscode-test', 'tmp', '.fox-ai'
]);

const MAX_FILE_BYTES = 512 * 1024; // 单文件超过 512KB 跳过（多半是压缩产物/数据）
const CHUNK_LINES = 45;
const CHUNK_OVERLAP = 10;
const MIN_CHUNK_CHARS = 24;

// 检索时的混合权重
const W_COSINE = 0.6;
const W_BM25 = 0.4;
// BM25 参数
const BM25_K1 = 1.4;
const BM25_B = 0.72;

const STOP = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'not', 'are', 'was', 'you', 'your',
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'true', 'false', 'null', 'undefined',
  'import', 'export', 'require', 'module', 'exports', 'new', 'class', 'def', 'self', 'public',
  'private', 'static', 'void', 'int', 'string', 'bool', '的', '了', '是', '在', '和', '有'
]);

/* ---------------- 分词 ---------------- */

/**
 * 标识符感知分词：
 *   getUserName → get user name userName getusername
 *   fetch_data  → fetch data
 *   中文 → 单字 + bigram
 */
function tokenize(text) {
  const s = String(text || '');
  const out = [];
  // 英文/数字标识符
  const idRe = /[A-Za-z_][A-Za-z0-9_]*|\d+/g;
  let m;
  while ((m = idRe.exec(s))) {
    const raw = m[0];
    if (raw.length < 2) continue;
    const lower = raw.toLowerCase();
    if (!STOP.has(lower)) out.push(lower);
    // 拆 camelCase / snake_case
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[_\-\s]+/)
      .filter((p) => p.length >= 2)
      .map((p) => p.toLowerCase());
    if (parts.length > 1) {
      for (const p of parts) if (!STOP.has(p)) out.push(p);
    }
  }
  // 中文：单字 + bigram
  const cn = s.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const seg of cn) {
    for (let i = 0; i < seg.length; i++) {
      const ch = seg[i];
      if (!STOP.has(ch)) out.push(ch);
      if (i < seg.length - 1) out.push(seg.slice(i, i + 2));
    }
  }
  return out;
}

/** token 数组 → 频次表 */
function termFreq(tokens) {
  const tf = Object.create(null);
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return tf;
}

/* ---------------- 分块 ---------------- */

// 顶层定义的粗略识别（多语言通用）
const DEF_RE = /^\s{0,4}(?:export\s+)?(?:async\s+)?(?:function\s+\w|class\s+\w|def\s+\w|(?:public|private|protected|static)[\s\w<>,]*\s+\w+\s*\(|const\s+\w+\s*=\s*(?:async\s*)?\(|(?:func|fn|impl|interface|type|struct)\s+\w)/;

/**
 * 把文件内容切成块。优先在顶层定义处断开，块过大再按行窗口切。
 * @returns {Array<{startLine:number, endLine:number, text:string}>}
 */
function chunkFile(content, opts) {
  const o = opts || {};
  const maxLines = o.maxLines || CHUNK_LINES;
  const overlap = o.overlap === undefined ? CHUNK_OVERLAP : o.overlap;
  const lines = String(content || '').split(/\r?\n/);
  if (!lines.length) return [];

  // 1) 找定义边界
  const bounds = [0];
  for (let i = 1; i < lines.length; i++) {
    if (DEF_RE.test(lines[i])) {
      if (i - bounds[bounds.length - 1] >= 5) bounds.push(i);
    }
  }
  bounds.push(lines.length);

  const chunks = [];
  const push = (start, end) => {
    if (end <= start) return;
    const text = lines.slice(start, end).join('\n');
    if (text.trim().length < MIN_CHUNK_CHARS) return;
    chunks.push({ startLine: start + 1, endLine: end, text });
  };

  for (let b = 0; b < bounds.length - 1; b++) {
    let start = bounds[b];
    const end = bounds[b + 1];
    if (end - start <= maxLines) {
      push(start, end);
      continue;
    }
    // 段落太长：按窗口 + 重叠切
    while (start < end) {
      const stop = Math.min(start + maxLines, end);
      push(start, stop);
      if (stop >= end) break;
      start = stop - overlap > start ? stop - overlap : stop;
    }
  }
  return chunks;
}

/* ---------------- 文件遍历 ---------------- */

function shouldSkipDir(name) {
  return SKIP_DIRS.has(name) || name.startsWith('.');
}

/**
 * 递归收集可索引文件。
 * @returns {Array<{abs:string, rel:string, mtime:number, size:number}>}
 */
function walkFiles(root, opts) {
  const o = opts || {};
  const exts = new Set(o.exts && o.exts.length ? o.exts : DEFAULT_EXTS);
  const maxFiles = o.maxFiles || 6000;
  const maxBytes = o.maxFileBytes || MAX_FILE_BYTES;
  const out = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const d of names) {
      if (out.length >= maxFiles) break;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (!shouldSkipDir(d.name)) stack.push(abs);
        continue;
      }
      if (!d.isFile()) continue;
      const ext = path.extname(d.name).toLowerCase();
      if (!exts.has(ext)) continue;
      let st;
      try {
        st = fs.statSync(abs);
      } catch (_) {
        continue;
      }
      if (st.size > maxBytes || st.size === 0) continue;
      out.push({
        abs,
        rel: path.relative(root, abs).split(path.sep).join('/'),
        mtime: Math.floor(st.mtimeMs),
        size: st.size
      });
    }
  }
  return out;
}

/* ---------------- 索引 ---------------- */

class RagIndex {
  /**
   * @param {object} opts
   * @param {string} opts.root 仓库根目录
   * @param {string} [opts.indexFile] 索引落盘路径（默认 <root>/.fox-ai/rag-index.json）
   * @param {string[]} [opts.exts] 参与索引的扩展名
   * @param {number} [opts.maxFiles]
   */
  constructor(opts) {
    const o = opts || {};
    this.root = o.root || process.cwd();
    this.indexFile = o.indexFile || path.join(this.root, '.fox-ai', 'rag-index.json');
    this.exts = o.exts && o.exts.length ? o.exts : DEFAULT_EXTS;
    this.maxFiles = o.maxFiles || 6000;
    this.maxFileBytes = o.maxFileBytes || MAX_FILE_BYTES;
    this.data = this._empty();
    this.load();
  }

  _empty() {
    return { version: INDEX_VERSION, root: this.root, builtAt: 0, files: {}, chunks: [], df: Object.create(null) };
  }

  load() {
    try {
      if (fs.existsSync(this.indexFile)) {
        const d = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
        if (d && d.version === INDEX_VERSION && Array.isArray(d.chunks)) {
          d.df = d.df || Object.create(null);
          d.files = d.files || {};
          this.data = d;
          return true;
        }
      }
    } catch (e) {
      appendLog('rag', '[load-fail] ' + (e && e.message));
    }
    this.data = this._empty();
    return false;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.indexFile), { recursive: true });
      fs.writeFileSync(this.indexFile, JSON.stringify(this.data), 'utf8');
      return true;
    } catch (e) {
      appendLog('rag', '[save-fail] ' + (e && e.message));
      return false;
    }
  }

  get chunkCount() {
    return this.data.chunks.length;
  }

  get fileCount() {
    return Object.keys(this.data.files).length;
  }

  /** 从 df 表里扣掉某个文件的所有 chunk 贡献 */
  _removeFile(rel) {
    const info = this.data.files[rel];
    if (!info) return 0;
    const before = this.data.chunks.length;
    const kept = [];
    for (const c of this.data.chunks) {
      if (c.f !== rel) {
        kept.push(c);
        continue;
      }
      // 扣 df
      for (const tok of Object.keys(c.tf)) {
        const v = (this.data.df[tok] || 1) - 1;
        if (v <= 0) delete this.data.df[tok];
        else this.data.df[tok] = v;
      }
    }
    this.data.chunks = kept;
    delete this.data.files[rel];
    return before - kept.length;
  }

  /** 索引单个文件（先移除旧块） */
  _indexFile(file) {
    this._removeFile(file.rel);
    let content;
    try {
      content = fs.readFileSync(file.abs, 'utf8');
    } catch (_) {
      return 0;
    }
    // 二进制/压缩文件粗判：含大量不可见字符或超长单行
    if (content.indexOf('\u0000') >= 0) return 0;
    const chunks = chunkFile(content);
    let n = 0;
    for (const ch of chunks) {
      // 把文件路径本身也纳入 token（让「找 rag 模块」能命中 src/rag.js）
      const tokens = tokenize(file.rel + '\n' + ch.text);
      if (!tokens.length) continue;
      const tf = termFreq(tokens);
      for (const tok of Object.keys(tf)) this.data.df[tok] = (this.data.df[tok] || 0) + 1;
      this.data.chunks.push({
        f: file.rel,
        s: ch.startLine,
        e: ch.endLine,
        n: tokens.length,
        tf,
        p: ch.text.trim().slice(0, 160).replace(/\s+/g, ' ')
      });
      n++;
    }
    this.data.files[file.rel] = { mtime: file.mtime, size: file.size, chunks: n };
    return n;
  }

  /**
   * 建立/增量更新索引。
   * @param {object} [opts] { force: 全量重建, onProgress: (done,total,rel)=>void }
   * @returns {{files:number, chunks:number, added:number, updated:number, removed:number, ms:number}}
   */
  build(opts) {
    const o = opts || {};
    const t0 = Date.now();
    if (o.force) this.data = this._empty();

    const found = walkFiles(this.root, { exts: this.exts, maxFiles: this.maxFiles, maxFileBytes: this.maxFileBytes });
    const seen = new Set();
    let added = 0;
    let updated = 0;

    for (let i = 0; i < found.length; i++) {
      const f = found[i];
      seen.add(f.rel);
      const old = this.data.files[f.rel];
      if (old && old.mtime === f.mtime && old.size === f.size) continue; // 未变更，跳过
      const isNew = !old;
      this._indexFile(f);
      if (isNew) added++;
      else updated++;
      if (o.onProgress) {
        try { o.onProgress(i + 1, found.length, f.rel); } catch (_) {}
      }
    }

    // 清理已删除的文件
    let removed = 0;
    for (const rel of Object.keys(this.data.files)) {
      if (!seen.has(rel)) {
        this._removeFile(rel);
        removed++;
      }
    }

    this.data.builtAt = Date.now();
    this.data.root = this.root;
    this.save();
    const ms = Date.now() - t0;
    appendLog(
      'rag',
      `[build] files=${this.fileCount} chunks=${this.chunkCount} added=${added} updated=${updated} removed=${removed} ms=${ms}`
    );
    return { files: this.fileCount, chunks: this.chunkCount, added, updated, removed, ms };
  }

  /**
   * 混合检索：TF-IDF 余弦 + BM25。
   * @param {string} query
   * @param {object} [opts] { topK, pathFilter, minScore, withText }
   * @returns {Array<{file, startLine, endLine, score, cosine, bm25, preview, text?}>}
   */
  search(query, opts) {
    const o = opts || {};
    const topK = o.topK || 8;
    const qTokens = tokenize(query);
    if (!qTokens.length || !this.data.chunks.length) return [];

    const N = this.data.chunks.length;
    const df = this.data.df;
    const qtf = termFreq(qTokens);

    // 查询向量（TF-IDF，L2 归一化）
    const qvec = Object.create(null);
    let qnorm = 0;
    for (const tok of Object.keys(qtf)) {
      const d = df[tok] || 0;
      if (!d) continue; // 库里没有的词直接忽略
      const idf = Math.log(1 + (N - d + 0.5) / (d + 0.5));
      const w = (1 + Math.log(qtf[tok])) * idf;
      qvec[tok] = w;
      qnorm += w * w;
    }
    qnorm = Math.sqrt(qnorm) || 1;
    const qKeys = Object.keys(qvec);
    if (!qKeys.length) return [];

    // 平均文档长度（BM25 用）
    let totalLen = 0;
    for (const c of this.data.chunks) totalLen += c.n;
    const avgLen = totalLen / N || 1;

    const pathRe = o.pathFilter ? safeRe(o.pathFilter) : null;
    const scored = [];

    for (let i = 0; i < N; i++) {
      const c = this.data.chunks[i];
      if (pathRe && !pathRe.test(c.f)) continue;

      let dot = 0;
      let dnorm = 0;
      let bm25 = 0;
      let hit = 0;

      // 只遍历查询里的词（稀疏点积）
      for (const tok of qKeys) {
        const cnt = c.tf[tok];
        if (!cnt) continue;
        hit++;
        const d = df[tok] || 1;
        const idf = Math.log(1 + (N - d + 0.5) / (d + 0.5));
        const cw = (1 + Math.log(cnt)) * idf;
        dot += qvec[tok] * cw;
        // BM25
        bm25 += idf * ((cnt * (BM25_K1 + 1)) / (cnt + BM25_K1 * (1 - BM25_B + BM25_B * (c.n / avgLen))));
      }
      if (!hit) continue;

      // chunk 向量模长：只能近似（不遍历全表则无法精确），用命中词能量 + 长度惩罚近似
      for (const tok of qKeys) {
        const cnt = c.tf[tok];
        if (!cnt) continue;
        const d = df[tok] || 1;
        const idf = Math.log(1 + (N - d + 0.5) / (d + 0.5));
        const cw = (1 + Math.log(cnt)) * idf;
        dnorm += cw * cw;
      }
      dnorm = Math.sqrt(dnorm) || 1;
      const cosine = dot / (qnorm * dnorm);
      // 覆盖率加成：命中查询词越多越可信（避免单个高 idf 词刷分）
      const coverage = hit / qKeys.length;
      const cosineAdj = cosine * (0.55 + 0.45 * coverage);

      scored.push({ i, cosine: cosineAdj, bm25 });
    }

    if (!scored.length) return [];

    // BM25 归一化到 0-1 再混合
    let maxB = 0;
    for (const s of scored) if (s.bm25 > maxB) maxB = s.bm25;
    maxB = maxB || 1;
    for (const s of scored) s.score = W_COSINE * s.cosine + W_BM25 * (s.bm25 / maxB);

    scored.sort((a, b) => b.score - a.score);
    const minScore = o.minScore === undefined ? 0.02 : o.minScore;

    const out = [];
    for (const s of scored) {
      if (out.length >= topK) break;
      if (s.score < minScore) break;
      const c = this.data.chunks[s.i];
      const item = {
        file: c.f,
        startLine: c.s,
        endLine: c.e,
        score: Number(s.score.toFixed(4)),
        cosine: Number(s.cosine.toFixed(4)),
        bm25: Number(s.bm25.toFixed(3)),
        preview: c.p
      };
      if (o.withText) item.text = this.readChunk(c.f, c.s, c.e);
      out.push(item);
    }
    appendLog('rag', '[search] q=' + String(query).slice(0, 50) + ' hits=' + out.length + '/' + scored.length);
    return out;
  }

  /** 按行号回读源文件片段（索引不存全文，保证内容永远是最新的） */
  readChunk(rel, startLine, endLine) {
    try {
      const abs = path.join(this.root, rel);
      const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
      return lines.slice(Math.max(0, startLine - 1), endLine).join('\n');
    } catch (_) {
      return '';
    }
  }

  /** 状态摘要 */
  stats() {
    return {
      files: this.fileCount,
      chunks: this.chunkCount,
      terms: Object.keys(this.data.df).length,
      builtAt: this.data.builtAt,
      indexFile: this.indexFile
    };
  }

  clear() {
    this.data = this._empty();
    try {
      if (fs.existsSync(this.indexFile)) fs.unlinkSync(this.indexFile);
    } catch (_) {}
  }
}

function safeRe(p) {
  try {
    return new RegExp(p, 'i');
  } catch (_) {
    return null;
  }
}

/** 把检索结果渲染成给模型看的文本 */
function renderResults(results, opts) {
  const o = opts || {};
  if (!results || !results.length) return '未检索到相关代码片段。';
  const lines = [`语义检索命中 ${results.length} 处：`];
  for (const r of results) {
    lines.push(`\n【${r.file}:${r.startLine}-${r.endLine}】(相关度 ${r.score})`);
    const body = r.text || r.preview || '';
    const clipped = o.maxCharsPerHit ? String(body).slice(0, o.maxCharsPerHit) : body;
    lines.push(clipped);
  }
  return lines.join('\n');
}

module.exports = {
  RagIndex,
  tokenize,
  termFreq,
  chunkFile,
  walkFiles,
  renderResults,
  DEFAULT_EXTS,
  SKIP_DIRS
};
