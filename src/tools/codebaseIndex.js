'use strict';

/**
 * 全仓库语义索引工具层（把 src/rag.js 的 RagIndex 接到工具系统）
 *
 * 两个工具：
 *   index_codebase   —— 建立/增量更新索引
 *   search_codebase  —— 混合检索（TF-IDF 余弦 + BM25），按语义找代码
 *
 * 与 search_text（正则/关键词精确匹配）的分工：
 *   知道确切标识符 → search_text；只知道「大概想干什么」→ search_codebase。
 *
 * 索引按工作区根目录缓存单例，避免每次调用都重新读盘反序列化。
 */

const vscode = require('vscode');
const path = require('path');
const { RagIndex, renderResults } = require('../rag');
const { appendLog } = require('../log');

const _cache = new Map(); // root -> RagIndex

function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) return '';
  return folders[0].uri.fsPath;
}

function cfgGet(key, def) {
  try {
    return vscode.workspace.getConfiguration('foxAi').get(key, def);
  } catch (_) {
    return def;
  }
}

/** 取（或建）当前工作区的索引实例 */
function getIndex(root) {
  const r = root || workspaceRoot();
  if (!r) return null;
  if (_cache.has(r)) return _cache.get(r);
  const exts = cfgGet('rag.extensions', []);
  const idx = new RagIndex({
    root: r,
    exts: Array.isArray(exts) && exts.length ? exts : undefined,
    maxFiles: cfgGet('rag.maxFiles', 6000)
  });
  _cache.set(r, idx);
  return idx;
}

/** 配置变更 / 工作区切换时丢弃缓存 */
function resetCache() {
  _cache.clear();
}

/** 索引是否已建立且不算太旧 */
function needsBuild(idx) {
  if (!idx) return false;
  const s = idx.stats();
  if (!s.chunks) return true;
  const maxAge = cfgGet('rag.autoRebuildHours', 24) * 3600 * 1000;
  if (maxAge > 0 && Date.now() - (s.builtAt || 0) > maxAge) return true;
  return false;
}

async function runIndex(args, ctx) {
  const root = workspaceRoot();
  if (!root) return '当前没有打开工作区，无法建立代码索引。';
  const idx = getIndex(root);
  if (!idx) return '索引初始化失败。';

  const force = !!(args && args.force);
  let lastPct = -1;
  const t0 = Date.now();
  let r;
  try {
    r = idx.build({
      force,
      onProgress: (done, total) => {
        if (!ctx || typeof ctx.onStream !== 'function' || !total) return;
        const pct = Math.floor((done / total) * 100);
        if (pct !== lastPct && pct % 10 === 0) {
          lastPct = pct;
          ctx.onStream(`索引中 ${pct}%（${done}/${total}）\n`);
        }
      }
    });
  } catch (e) {
    appendLog('rag', '[tool-build-fail] ' + (e && e.message));
    return `建立索引失败：${(e && e.message) || String(e)}`;
  }

  const lines = [
    `代码索引${force ? '已重建' : '已更新'}（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）：`,
    `- 文件：${r.files}｜片段：${r.chunks}`,
    `- 本次新增 ${r.added}、更新 ${r.updated}、清理 ${r.removed}`
  ];
  if (!r.chunks) {
    lines.push('⚠️ 没有索引到任何内容。可能是工作区里没有受支持的代码文件，或都被跳过规则排除了。');
  } else {
    lines.push('现在可以用 search_codebase 按语义检索了。');
  }
  return lines.join('\n');
}

async function runSearch(args, ctx) {
  const query = String((args && args.query) || '').trim();
  if (!query) return '请提供 query（想找什么，用自然语言描述即可）。';
  const root = workspaceRoot();
  if (!root) return '当前没有打开工作区，无法检索。';
  const idx = getIndex(root);
  if (!idx) return '索引初始化失败。';

  // 索引为空或过期：自动建一次，省得模型还要先手动调 index_codebase
  if (needsBuild(idx)) {
    if (ctx && typeof ctx.onStream === 'function') ctx.onStream('索引尚未建立或已过期，正在自动建立…\n');
    try {
      idx.build({});
    } catch (e) {
      appendLog('rag', '[auto-build-fail] ' + (e && e.message));
    }
  }
  if (!idx.stats().chunks) {
    return '代码索引为空（工作区可能没有受支持的代码文件）。请改用 search_text / find_files。';
  }

  const topK = Math.max(1, Math.min(20, Number((args && args.topK) || 8)));
  const withText = args && args.withText !== false; // 默认带原文
  let hits;
  try {
    hits = idx.search(query, {
      topK,
      pathFilter: (args && args.pathFilter) || '',
      withText
    });
  } catch (e) {
    return `检索失败：${(e && e.message) || String(e)}`;
  }
  if (!hits.length) {
    return `语义检索未命中「${query}」。可以换个说法，或改用 search_text 做精确匹配。`;
  }
  const body = renderResults(hits, { maxCharsPerHit: withText ? 1200 : 400 });
  return body + '\n\n（以上为语义检索结果，行号基于当前文件；需要完整上下文请用 read_file 读取对应区间。）';
}

async function runStats() {
  const idx = getIndex();
  if (!idx) return '当前没有打开工作区。';
  const s = idx.stats();
  if (!s.chunks) return '代码索引尚未建立。调用 index_codebase 可建立。';
  const age = s.builtAt ? Math.round((Date.now() - s.builtAt) / 60000) : -1;
  return [
    '代码索引状态：',
    `- 文件 ${s.files}｜片段 ${s.chunks}｜词条 ${s.terms}`,
    `- 上次更新：${age >= 0 ? age + ' 分钟前' : '未知'}`,
    `- 索引文件：${path.relative(workspaceRoot() || '', s.indexFile) || s.indexFile}`
  ].join('\n');
}

module.exports = { runIndex, runSearch, runStats, getIndex, resetCache, needsBuild, workspaceRoot };
