'use strict';

/**
 * src/projectRules.js — 项目根规则自动读取（CLAUDE.md / AGENTS.md 等）
 *
 * 目标：与 Claude Code / Roo Code / Cursor 生态互通——用户在仓库根放一份
 * CLAUDE.md、AGENTS.md、.cursorrules 之类的「项目规约」，狐狸 AI 自动读到并注入系统提示词，
 * 不需要用户在设置里重复抄一遍。
 *
 * 内存与逻辑优化（硬约束，改这个文件时务必保持）：
 * - 纯 Node（fs/path），零 vscode 依赖 → 可离线单测，也不会在扩展启动时拖 vscode API。
 * - **不常驻文件监听**：不开 FileSystemWatcher（每个 watcher 都是常驻句柄 + 事件回调内存）。
 *   改用「mtime 签名失效」——每次取用时只 stat 候选文件（几个 stat 系统调用，微秒级），
 *   签名没变就直接返回上次渲染好的字符串，不重复读盘、不重复拼接。
 * - **有界缓存**：模块级 Map 最多缓存 MAX_CACHE_ROOTS 个工作区，超出按插入序淘汰最旧的，
 *   多根工作区/频繁切目录也不会无限增长。
 * - **有界读取**：单文件最多读 MAX_FILE_BYTES，总预算 defaultBudget 字符，超出即截断并标注，
 *   避免用户往 CLAUDE.md 里塞几 MB 内容把上下文和内存一起撑爆。
 * - 缓存只存**最终渲染文本**（一个字符串），不缓存每个文件的原始内容数组。
 */

const fs = require('fs');
const path = require('path');

// 候选规则文件，按优先级从高到低。前面的先占预算。
// 说明：同时兼容 Claude Code（CLAUDE.md）、OpenAI/Roo 生态（AGENTS.md）、Cursor（.cursorrules）
// 以及狐狸 AI 自己的 .fox-ai/rules.md。
const RULE_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  '.fox-ai/rules.md',
  '.cursorrules',
  'CONVENTIONS.md',
  '.github/copilot-instructions.md'
];

const MAX_FILE_BYTES = 64 * 1024;  // 单文件最多读 64KB
const DEFAULT_BUDGET = 6000;       // 注入系统提示词的总字符预算
const MAX_CACHE_ROOTS = 4;         // 有界缓存：最多记住 4 个工作区

/** root -> { sig, text } */
const _cache = new Map();

/** 有界写入缓存：超出上限淘汰最早插入的一条 */
function _cacheSet(key, value) {
  if (_cache.has(key)) _cache.delete(key);
  _cache.set(key, value);
  while (_cache.size > MAX_CACHE_ROOTS) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

/**
 * 计算候选文件的 mtime 签名。只做 stat，不读内容。
 * 文件不存在就跳过；任何异常都当作「该文件不存在」，绝不抛错影响主流程。
 * @returns {{ sig: string, hits: Array<{rel:string, abs:string, size:number}> }}
 */
function scanSignature(root, files) {
  const list = Array.isArray(files) && files.length ? files : RULE_FILES;
  const hits = [];
  const parts = [];
  for (const rel of list) {
    const abs = path.join(root, rel);
    let st;
    try {
      st = fs.statSync(abs);
    } catch (_) {
      continue;
    }
    if (!st || !st.isFile()) continue;
    hits.push({ rel, abs, size: st.size });
    parts.push(rel + ':' + st.size + ':' + Math.floor(st.mtimeMs));
  }
  return { sig: parts.join('|'), hits };
}

/** 读单个规则文件，限长；失败返回 '' */
function readCapped(abs, maxBytes) {
  const limit = maxBytes || MAX_FILE_BYTES;
  let fd = null;
  try {
    const st = fs.statSync(abs);
    if (st.size <= limit) return fs.readFileSync(abs, 'utf8');
    // 超大文件只读前 limit 字节，避免整份载入内存
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.allocUnsafe(limit);
    const n = fs.readSync(fd, buf, 0, limit, 0);
    return buf.slice(0, n).toString('utf8') + '\n…（文件过大，已截断）';
  } catch (_) {
    return '';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

/** 去掉 Markdown 里的空行冗余，压一压体积（不改语义） */
function compact(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 读取并渲染项目规则文本（带 mtime 缓存）。
 * @param {object} opts
 * @param {string} opts.root 工作区根目录
 * @param {number} [opts.budget] 总字符预算，默认 6000
 * @param {string[]} [opts.files] 自定义候选文件名（相对 root）
 * @returns {{ text: string, sources: string[], truncated: boolean, cached: boolean }}
 */
function loadProjectRules(opts) {
  const o = opts || {};
  const root = String(o.root || '');
  const budget = Math.max(200, Math.min(20000, Number(o.budget) || DEFAULT_BUDGET));
  const files = o.files;
  const empty = { text: '', sources: [], truncated: false, cached: false };
  if (!root) return empty;

  const { sig, hits } = scanSignature(root, files);
  if (!hits.length) {
    // 没有任何规则文件：也要把「空签名」缓存起来，避免每轮都重复 stat 六个路径
    _cacheSet(root, { sig: '', text: '', sources: [], truncated: false });
    return empty;
  }

  const cacheKey = root + '#' + budget;
  const hit = _cache.get(cacheKey);
  if (hit && hit.sig === sig) {
    return { text: hit.text, sources: hit.sources, truncated: hit.truncated, cached: true };
  }

  const chunks = [];
  const sources = [];
  let used = 0;
  let truncated = false;
  for (const f of hits) {
    if (used >= budget) { truncated = true; break; }
    const raw = compact(readCapped(f.abs));
    if (!raw) continue;
    const remain = budget - used;
    let body = raw;
    if (body.length > remain) {
      body = body.slice(0, remain) + '\n…（超出预算，已截断）';
      truncated = true;
    }
    used += body.length;
    sources.push(f.rel);
    chunks.push('── ' + f.rel + ' ──\n' + body);
  }

  const text = chunks.join('\n\n');
  _cacheSet(cacheKey, { sig, text, sources, truncated });
  return { text, sources, truncated, cached: false };
}

/**
 * 渲染成可直接拼进系统提示词的段落。无规则文件时返回 ''。
 */
function renderForPrompt(opts) {
  const r = loadProjectRules(opts);
  if (!r.text) return '';
  const head = '【项目规则（来自仓库根：' + r.sources.join('、') + '）】\n'
    + '以下是本项目自带的规约文件，**优先级高于你的默认习惯**。除非用户当场另有指示，'
    + '否则写代码、起名、提交、测试都要遵守它；与你的通用经验冲突时以本规约为准。\n\n';
  return head + r.text;
}

/** 手动清缓存（改配置 / 用户主动刷新时调用），不传 root 则全清 */
function invalidate(root) {
  if (!root) { _cache.clear(); return; }
  for (const k of Array.from(_cache.keys())) {
    if (k === root || k.startsWith(root + '#')) _cache.delete(k);
  }
}

/** 供测试与诊断：当前缓存条目数 */
function cacheSize() {
  return _cache.size;
}

module.exports = {
  RULE_FILES,
  MAX_FILE_BYTES,
  DEFAULT_BUDGET,
  MAX_CACHE_ROOTS,
  scanSignature,
  readCapped,
  compact,
  loadProjectRules,
  renderForPrompt,
  invalidate,
  cacheSize
};
