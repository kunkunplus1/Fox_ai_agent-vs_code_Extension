'use strict';

/**
 * src/slashCommands.js — 自定义 Slash Commands 模板（对标 Claude Code 的 .claude/commands）
 *
 * 用户在 `.fox-ai/commands/` 放一个 `review.md`，里面写好一段 prompt 模板，
 * 之后在对话框敲 `/review src/agent.js`，就等价于把模板里的 $ARGUMENTS 换成
 * `src/agent.js` 后发给 agent。把「常用长指令」沉淀成一个词。
 *
 * 模板语法（刻意只做这三种，避免变成小型模板语言）：
 *   $ARGUMENTS  —— 整串参数原样替换
 *   $1 $2 … $9  —— 按空格切分的位置参数（缺失替换为空串）
 *   frontmatter —— 可选的 `--- description: 一句话说明 ---` 头，只用于列表展示
 *
 * 内存与逻辑优化（硬约束）：
 * - 纯 Node（fs/path），零 vscode 依赖 → 可离线单测。
 * - **不常驻 watcher**：靠目录 mtime + 文件数签名判断是否要重扫，签名没变直接复用列表。
 * - 列表缓存**只存元信息**（名字/描述/路径），**不缓存模板正文**——正文在真正执行 `/xxx`
 *   时才读一次盘、用完即弃，避免几十个模板的正文长期驻留内存。
 * - 单文件读取上限 MAX_TEMPLATE_BYTES，模板数上限 MAX_COMMANDS，防止误放大目录把内存吃满。
 */

const fs = require('fs');
const path = require('path');

const MAX_TEMPLATE_BYTES = 32 * 1024; // 单个模板最大 32KB
const MAX_COMMANDS = 100;             // 最多识别 100 个命令
const MAX_CACHE_DIRS = 4;             // 有界缓存：最多记 4 组目录

/** key(dirs.join('|')) -> { sig, items } */
const _cache = new Map();

function _cacheSet(key, value) {
  if (_cache.has(key)) _cache.delete(key);
  _cache.set(key, value);
  while (_cache.size > MAX_CACHE_DIRS) _cache.delete(_cache.keys().next().value);
}

/** 工作区级命令目录 */
function workspaceCommandsDir(root) {
  return root ? path.join(root, '.fox-ai', 'commands') : '';
}

/** 用户级命令目录（对所有项目生效） */
function userCommandsDir(baseDir) {
  const base = baseDir || path.join(require('os').homedir(), '.fox-ai');
  return path.join(base, 'commands');
}

/** 命令名合法性：字母数字与 - _，避免路径穿越 */
function isValidName(name) {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(String(name || ''));
}

/**
 * 解析输入是否为 slash 命令。
 * `/review src/a.js` -> { name:'review', args:'src/a.js' }；不是则返回 null。
 */
function parseInput(input) {
  const s = String(input || '');
  const m = s.match(/^\s*\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,39})(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { name: m[1], args: (m[2] || '').trim() };
}

/** 解析可选 frontmatter，返回 { meta, body } */
function parseFrontmatter(text) {
  const s = String(text || '');
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: s };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2] };
}

/** 目录签名：文件名 + mtime + size，只 stat 不读内容 */
function _dirSignature(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return { sig: '', files: [] };
  }
  const files = [];
  const parts = [];
  for (const n of names) {
    if (!n.toLowerCase().endsWith('.md')) continue;
    const base = n.slice(0, -3);
    if (!isValidName(base)) continue;
    const abs = path.join(dir, n);
    let st;
    try { st = fs.statSync(abs); } catch (_) { continue; }
    if (!st.isFile()) continue;
    files.push({ name: base, file: abs, size: st.size });
    parts.push(n + ':' + st.size + ':' + Math.floor(st.mtimeMs));
    if (files.length >= MAX_COMMANDS) break;
  }
  return { sig: dir + '>' + parts.join(','), files };
}

/**
 * 列出所有可用命令（工作区优先，同名时工作区覆盖用户级）。
 * @param {string[]} dirs 目录列表，前面的优先级高
 * @returns {Array<{name, description, file, source}>}
 */
function listCommands(dirs) {
  const list = (Array.isArray(dirs) ? dirs : []).filter(Boolean);
  if (!list.length) return [];
  const key = list.join('|');

  const sigs = [];
  const found = [];
  for (let i = 0; i < list.length; i++) {
    const d = _dirSignature(list[i]);
    sigs.push(d.sig);
    for (const f of d.files) found.push(Object.assign({}, f, { source: i === 0 ? 'workspace' : 'user' }));
  }
  const sig = sigs.join('||');
  const hit = _cache.get(key);
  if (hit && hit.sig === sig) return hit.items;

  const seen = new Set();
  const items = [];
  for (const f of found) {
    if (seen.has(f.name)) continue; // 前面的目录优先
    seen.add(f.name);
    // 只为拿 description 读一次头部，最多读 1KB，不缓存正文
    let description = '';
    try {
      const head = _readHead(f.file, 1024);
      const { meta } = parseFrontmatter(head);
      description = meta.description || meta.desc || '';
      if (!description) {
        const firstLine = head.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('---'));
        description = (firstLine || '').replace(/^#+\s*/, '').slice(0, 60);
      }
    } catch (_) {}
    items.push({ name: f.name, description, file: f.file, source: f.source });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  _cacheSet(key, { sig, items });
  return items;
}

function _readHead(file, bytes) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, n).toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

/** 把 args 串切成位置参数（支持双引号包裹） */
function splitArgs(argsText) {
  const s = String(argsText || '').trim();
  if (!s) return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

/**
 * 展开模板：$ARGUMENTS / $1..$9。
 * 注意替换顺序——先 $ARGUMENTS 再位置参数，且位置参数从 $9 往 $1 replace，
 * 否则 `$1` 会先把 `$10` 的前缀吃掉（虽然只支持到 $9，但保持顺序更稳）。
 */
function expand(template, argsText) {
  const body = String(template || '');
  const all = String(argsText || '').trim();
  const parts = splitArgs(all);
  let out = body.replace(/\$ARGUMENTS\b/g, all);
  for (let i = 9; i >= 1; i--) {
    out = out.replace(new RegExp('\\$' + i + '\\b', 'g'), parts[i - 1] !== undefined ? parts[i - 1] : '');
  }
  return out;
}

/**
 * 读取并展开一个命令模板。
 * @returns {{ok:boolean, text?:string, name?:string, file?:string, error?:string, available?:string[]}}
 */
function renderCommand(name, argsText, dirs) {
  if (!isValidName(name)) return { ok: false, error: '命令名不合法：' + name };
  const items = listCommands(dirs);
  const hit = items.find((i) => i.name === name);
  if (!hit) {
    return {
      ok: false,
      error: '没有找到自定义命令 /' + name,
      available: items.map((i) => i.name)
    };
  }
  let raw = '';
  try {
    const st = fs.statSync(hit.file);
    if (st.size > MAX_TEMPLATE_BYTES) {
      raw = _readHead(hit.file, MAX_TEMPLATE_BYTES) + '\n…（模板过大，已截断）';
    } else {
      raw = fs.readFileSync(hit.file, 'utf8');
    }
  } catch (e) {
    return { ok: false, error: '读取模板失败：' + ((e && e.message) || String(e)) };
  }
  const { body } = parseFrontmatter(raw);
  return { ok: true, name, file: hit.file, text: expand(body, argsText).trim() };
}

/** 内置示例模板，首次打开命令目录时写入，让用户照着改 */
const SAMPLE_COMMAND = `---
description: 审查指定文件的改动风险
---
请审查 $ARGUMENTS 这个文件：

1. 先用 read_file 读一遍真实内容，不要凭猜测。
2. 指出潜在 bug、边界情况、性能与安全隐患，按「🔴严重 / 🟡建议」分级。
3. 每条问题给出具体行号与修改建议，不要泛泛而谈。
4. 最后一句话总结整体风险等级。
`;

/** 手动清缓存 */
function invalidate() {
  _cache.clear();
}

function cacheSize() {
  return _cache.size;
}

module.exports = {
  MAX_TEMPLATE_BYTES,
  MAX_COMMANDS,
  SAMPLE_COMMAND,
  workspaceCommandsDir,
  userCommandsDir,
  isValidName,
  parseInput,
  parseFrontmatter,
  splitArgs,
  expand,
  listCommands,
  renderCommand,
  invalidate,
  cacheSize
};
