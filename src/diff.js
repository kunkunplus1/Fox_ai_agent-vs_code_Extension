'use strict';

/**
 * 纯函数 diff 引擎（零 vscode 依赖，可单测）。
 * ----------------------------------------------------------------------------
 * 目标（相对旧实现的核心提升）：
 *  - 正确性：旧 unifiedPreview 只做「公共前后缀裁剪」，把中间整段一律输出为
 *    「全删 + 全加」；本引擎用 Myers O((N+M)·D) 做真正的行对齐，
 *    只改动几行就只显示几行，并能区分纯增/纯删/修改。
 *  - 性能：公共前后缀裁剪（大多数编辑命中）→ 行级哈希成 int（Int32Array 比较）
 *    → Myers（D 受 DIFF_MAX_D 上限）。裁剪后仍属「大范围改动」时自动降级为
 *    O(N+M) 的整段替换（degraded 标记），最坏情况不慢、不炸内存。
 *  - 可配置维度：ignoreWhitespace / ignoreCase / ignoreBlankLines / context /
 *    wordDiff / maxLineLength / maxLines / maxHunks / lineNumbers。
 *  - 兼容：diffStat 返回 { added, removed, ... }（旧字段语义保留：修改行计入
 *    added 与 removed 各 1），并新增 modified / similarity / degraded；
 *    formatUnified 输出骨架与旧 unifiedPreview 一致（行号右对齐 + │ 分隔 +
 *    -/+/空格 前缀 + 原→新 错位标注 + 尾部 … 还有 N 行）。
 */

const DIFF_MAX_D = 600;        // Myers 迭代深度上限；超出即降级（大范围改动走整段替换）
const BIG_INPUT = 20000;       // 裁剪后两侧行数之和超过此值直接降级
const OVERFLOW_ROW_BUF = 1024; // 展示行收集的溢出缓冲（超过 cap 后最多再多收这么多行即强制停）
const WORD_TOK_LIMIT = 120;    // 行内词级 diff 的每侧 token 上限，超出跳过 inline

const DEFAULT_OPTS = {
  ignoreWhitespace: false,
  ignoreCase: false,
  ignoreBlankLines: false,
  context: 2,
  wordDiff: false,
  maxLineLength: 400,
  maxLines: 40,
  maxHunks: 20,
  lineNumbers: true
};

/** 换行归一 + 按行切分（与旧实现一致：CRLF→LF 后再 split，保留尾部空串） */
function splitLines(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
}

/** 是否视为「空行」（用于 ignoreBlankLines 判定） */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 13 && c !== 10 && c !== 12) return false;
  }
  return true;
}

/**
 * 生成行的比较键（只用于「是否相等」判定，展示始终用原始文本）。
 * - ignoreWhitespace：折叠连续空白为单空格并 trim；
 * - ignoreCase：小写化；
 * - ignoreBlankLines：空行统一为哨兵键（两个空行互相相等，且不与内容行混淆）。
 */
function lineKey(line, o) {
  let s = line;
  if (o.ignoreCase) s = s.toLowerCase();
  if (o.ignoreWhitespace) s = s.replace(/\s+/g, ' ').trim();
  if (o.ignoreBlankLines && isBlank(s)) return '\u0000'; // 哨兵
  return s;
}

/** 行序列 → int 键数组（一次遍历构建 Map 缓存，Myers 全程整数比较）。
 * 注意：a、b 两侧必须【共享同一个 cache】，否则相同文本会在两侧得到不同整数，
 * Myers 的整数比较将完全错位（此前的隐蔽 bug）。 */
function hashLines(lines, o, shared) {
  const cache = shared || new Map();
  const keys = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const k = lineKey(lines[i], o);
    let id = cache.get(k);
    if (id === undefined) { id = cache.size; cache.set(k, id); }
    keys[i] = id;
  }
  return keys;
}

/**
 * Myers diff（贪心 + V 数组 + 每轮结束快照回溯）。
 * @param {number[]} a 旧文件 int 键（公共前后缀已裁掉）
 * @param {number[]} b 新文件 int 键
 * @returns {Array<{type:'del'|'add'|'eq', ai:number, bi:number}>|null}
 *          返回正序 edit script；裁剪后差异过大（超出上限）返回 null 表示应降级。
 */
function myersOps(a, b) {
  const N = a.length;
  const M = b.length;
  if (N === 0 && M === 0) return [];
  if (N + M > BIG_INPUT) return null;
  if (N === 0) { const ops = []; for (let j = 0; j < M; j++) ops.push({ type: 'add', ai: -1, bi: j }); return ops; }
  if (M === 0) { const ops = []; for (let i = 0; i < N; i++) ops.push({ type: 'del', ai: i, bi: -1 }); return ops; }

  const maxD = Math.min(N + M, DIFF_MAX_D);
  const offset = maxD + 1;
  const size = 2 * maxD + 3;
  const V = new Int32Array(size);
  V[offset + 1] = 0;
  const trace = [];
  let reached = false;

  for (let d = 0; d <= maxD && !reached; d++) {
    trace.push(V.slice()); // 【轮开始前】快照（= 上一轮结束状态，回溯要用它找 prevK）
    for (let k = -d; k <= d; k += 2) {
      const idx = offset + k;
      let x;
      if (k === -d || (k !== d && V[idx - 1] < V[idx + 1])) {
        x = V[idx + 1];      // 向下（来自 k+1）：删 a 的一行
      } else {
        x = V[idx - 1] + 1;  // 向右（来自 k-1）：插 b 的一行
      }
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      V[idx] = x;
      if (x >= N && y >= M) { reached = true; break; }
    }
  }
  if (!reached) return null;

  // 回溯：从终点沿 trace 走回起点。trace[d] = V_{d-1}（d 轮开始前状态），
  // 因此编辑步从 d=D 回溯到 d=1，最后剩的是第 0 轮的纯 snake（全部相等）。
  const ops = [];
  let x = N;
  let y = M;
  for (let d = trace.length - 1; d >= 1; d--) {
    const Vd = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && Vd[offset + k - 1] < Vd[offset + k + 1])) ? k + 1 : k - 1;
    const prevX = Vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: 'eq', ai: x - 1, bi: y - 1 });
      x--; y--;
    }
    if (x === prevX) ops.push({ type: 'add', ai: -1, bi: y - 1 });
    else ops.push({ type: 'del', ai: x - 1, bi: -1 });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) { // 第 0 轮：剩余对角线全相等
    ops.push({ type: 'eq', ai: x - 1, bi: y - 1 });
    x--; y--;
  }
  ops.reverse();
  return ops;
}

/** 词级 token 化，返回 [{ t, s }]（t=token 文本，s=在原行的起始下标），保留位置供重建 */
function tokenizeLine(line) {
  const re = /[A-Za-z0-9_]+|[\u4e00-\u9fff]|[^\sA-Za-z0-9_\u4e00-\u9fff]/g;
  const out = [];
  let m;
  while ((m = re.exec(line))) out.push({ t: m[0], s: m.index });
  return out;
}

/** 按 token 位置重建带标记的文本：被删词 [-x-]、被加词 {+x+}，间隙空白原样保留 */
function buildMarked(line, toks, markedSet, open, close) {
  let out = '';
  let prevEnd = 0;
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    out += line.slice(prevEnd, tk.s);
    out += markedSet.has(i) ? open + tk.t + close : tk.t;
    prevEnd = tk.s + tk.t.length;
  }
  out += line.slice(prevEnd);
  return out;
}

/**
 * 行内词级 diff：对「改前/改后」一对行产出带标记的展示文本。
 * @returns {{old:string, new:string}|null} 无词级差异返回 null
 */
function inlineWordMark(oldText, newText) {
  const ta = tokenizeLine(oldText);
  const tb = tokenizeLine(newText);
  if (!ta.length || !tb.length) return null;
  if (ta.length > WORD_TOK_LIMIT || tb.length > WORD_TOK_LIMIT) return null;
  const n = ta.length;
  const m = tb.length;
  // LCS DP（小规模：≤ WORD_TOK_LIMIT²）
  const dp = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const base = (i + 1) * (m + 1) + j + 1;
      if (ta[i].t === tb[j].t) dp[i * (m + 1) + j] = dp[base] + 1;
      else dp[i * (m + 1) + j] = Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  // 回溯：收集被删 token 下标集合 与 被加 token 下标集合
  const delSet = new Set();
  const addSet = new Set();
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (ta[i].t === tb[j].t) { i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) { delSet.add(i); i++; }
    else { addSet.add(j); j++; }
  }
  while (i < n) { delSet.add(i); i++; }
  while (j < m) { addSet.add(j); j++; }
  if (!delSet.size && !addSet.size) return null;
  return {
    old: buildMarked(oldText, ta, delSet, '[-', '-]'),
    new: buildMarked(newText, tb, addSet, '{+', '+}')
  };
}

/** 行文本安全截断：超长行按 maxLineLength 截断（防超长单行撑爆 token/内存） */
function capLine(text, maxLen) {
  const s = text || '';
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '…';
}

/**
 * 由文本计算 diff 结果（内部主入口）。
 * @returns {{ hunks:Array, stat:Object, degraded:boolean }}
 * hunks: [{ aStart, aLen, bStart, bLen, rows:[{type:'ctx'|'del'|'add', aNo, bNo, text}] }]
 *   - type:'del' 的 aNo=原行号；type:'add' 的 bNo=新行号；ctx 两者都有（1 基，含文件首行为 1）。
 *   - wordDiff 开启时 del/add 行文本内嵌 [-..-] / {+..+} 标记。
 */
function computeDiff(before, after, opts = {}) {
  const o = Object.assign({}, DEFAULT_OPTS, opts || {});
  const a = splitLines(before);
  const b = splitLines(after);
  const sharedCache = new Map(); // a/b 共享哈希空间（见 hashLines 注释）
  const aKeys = hashLines(a, o, sharedCache);
  const bKeys = hashLines(b, o, sharedCache);

  // 公共前后缀裁剪（键相等才一致；绝大多数编辑只动一小段 → 大幅缩小 Myers 输入）
  let start = 0;
  while (start < a.length && start < b.length && aKeys[start] === bKeys[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && aKeys[endA] === bKeys[endB]) { endA--; endB--; }

  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);
  const ops = myersOps(midA, midB);

  if (ops === null) {
    // 降级路径：大范围改动（或超大输入）→ O(N+M) 整段替换 + 多重集近似统计
    const stat = multisetStat(a, b);
    stat.modified = Math.min(stat.added, stat.removed);
    stat.unchanged = start + (a.length - 1 - endA); // 前后缀公共行
    stat.total = a.length + b.length;
    stat.similarity = statTotalSafe(stat.unchanged, a.length, b.length);
    stat.degraded = true;
    stat.hunks = 1;
    const rows = [];
    const maxLen = o.maxLineLength;
    for (let i = start; i < a.length; i++) rows.push({ type: 'del', aNo: i + 1, bNo: null, text: capLine(a[i], maxLen) });
    for (let j = start; j < b.length; j++) rows.push({ type: 'add', aNo: null, bNo: j + 1, text: capLine(b[j], maxLen) });
    const hunks = rows.length
      ? [{ aStart: start + 1, aLen: a.length - start, bStart: start + 1, bLen: b.length - start, rows }]
      : [];
    return { hunks, stat, degraded: true };
  }

  // —— 正常路径：完整 entries（前缀 eq + mid ops + 后缀 eq）——
  // 裁剪掉的公共行必须放回序列：ctx 上下文展示与 unchanged 统计都依赖它们。
  const net = b.length - a.length; // 后缀段 bNo = aNo + net
  const entries = [];
  for (let i = 0; i < start; i++) entries.push({ type: 'eq', aNo: i + 1, bNo: i + 1, text: a[i] });
  for (const op of ops) {
    if (op.type === 'eq') entries.push({ type: 'eq', aNo: start + op.ai + 1, bNo: start + op.bi + 1, text: a[start + op.ai] });
    else if (op.type === 'del') entries.push({ type: 'del', aNo: start + op.ai + 1, bNo: null, text: a[start + op.ai] });
    else entries.push({ type: 'add', aNo: null, bNo: start + op.bi + 1, text: b[start + op.bi] });
  }
  for (let i = endA + 1; i < a.length; i++) entries.push({ type: 'eq', aNo: i + 1, bNo: i + 1 + net, text: a[i] });

  // 统计（基于完整对齐）：
  //  - unchanged：前缀 + 后缀 + ops 内的相等行
  //  - modified：相邻 del/add 块内的配对对数（修改行同时计入 added/removed，兼容旧语义）
  let eqMid = 0;
  let added = 0;
  let removed = 0;
  let modified = 0;
  let delSeq = 0;
  let addSeq = 0;
  for (const op of ops) {
    if (op.type === 'eq') { eqMid++; modified += Math.min(delSeq, addSeq); delSeq = 0; addSeq = 0; }
    else if (op.type === 'del') { removed++; delSeq++; }
    else { added++; addSeq++; }
  }
  modified += Math.min(delSeq, addSeq);
  const unchanged = start + (a.length - 1 - endA) + eqMid;
  const stat = {
    added,
    removed,
    modified,
    unchanged,
    total: a.length + b.length,
    similarity: statTotalSafe(unchanged, a.length, b.length),
    degraded: false,
    hunks: 0
  };

  // —— hunk 聚合：激活窗口 ——
  // 变更行必激活；与最近变更点距离 ≤ context 的相同行也激活；
  // 连续激活段 = 一个 hunk（gap > 2·context 的相同行自动被排除 → 天然按间隔切分）。
  const ctx = Math.max(0, parseInt(o.context, 10) || 0);
  const act = new Array(entries.length).fill(false);
  let anyChange = false;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].type !== 'eq') { act[i] = true; anyChange = true; }
  }
  const maxLen = o.maxLineLength;
  const hunks = [];
  if (!anyChange) { stat.hunks = 0; return { hunks, stat, degraded: false }; }

  if (ctx > 0) {
    let lastChange = -1e9;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].type !== 'eq') lastChange = i;
      else if (i - lastChange <= ctx) act[i] = true;   // 变更点之后的 ctx 行
    }
    lastChange = 1e9;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type !== 'eq') lastChange = i;
      else if (lastChange - i <= ctx) act[i] = true;   // 变更点之前的 ctx 行
    }
  }

  // 相邻变更间距 ≤ 2·ctx 的 eq 行在两次传播中都激活，从而并入同一 hunk ✔
  let truncatedHunks = 0;
  let segStart = -1;
  const commitSeg = (s, e) => {
    if (hunks.length >= o.maxHunks) { truncatedHunks += 1; return; }
    const rows = [];
    for (let i = s; i <= e; i++) {
      const en = entries[i];
      if (en.type === 'eq') rows.push({ type: 'ctx', aNo: en.aNo, bNo: en.bNo, text: capLine(en.text, maxLen) });
      else if (en.type === 'del') rows.push({ type: 'del', aNo: en.aNo, bNo: null, text: capLine(en.text, maxLen) });
      else rows.push({ type: 'add', aNo: null, bNo: en.bNo, text: capLine(en.text, maxLen) });
    }
    // wordDiff：相邻 del→add 配对做行内词级标记
    if (o.wordDiff) {
      for (let i = 0; i + 1 < rows.length; i++) {
        if (rows[i].type === 'del' && rows[i + 1].type === 'add') {
          const mark = inlineWordMark(rows[i].text, rows[i + 1].text);
          if (mark) { rows[i].text = mark.old; rows[i + 1].text = mark.new; }
        }
      }
    }
    // hunk 头区间：优先取段内真实行号；纯插入/纯删除段用同侧可考行号近似（展示行带真实行号）
    const first = entries[s];
    const aStart = first.aNo !== null ? first.aNo : (first.bNo !== null ? Math.max(1, first.bNo - 0) : 1);
    const bStart = first.bNo !== null ? first.bNo : (first.aNo !== null ? first.aNo : 1);
    let aLen = 0; let bLen = 0;
    for (let i = s; i <= e; i++) {
      const en = entries[i];
      if (en.type === 'eq') { aLen++; bLen++; }
      else if (en.type === 'del') aLen++;
      else bLen++;
    }
    hunks.push({ aStart, aLen, bStart, bLen, rows });
  };
  for (let i = 0; i < entries.length; i++) {
    if (act[i]) {
      if (segStart === -1) segStart = i;
    } else if (segStart !== -1) {
      commitSeg(segStart, i - 1);
      segStart = -1;
    }
  }
  if (segStart !== -1) commitSeg(segStart, entries.length - 1);
  stat.hunks = hunks.length;
  if (truncatedHunks) stat.truncatedHunks = truncatedHunks;
  return { hunks, stat, degraded: false };
}

function statTotalSafe(eqCount, nA, nB) {
  const denom = nA + nB;
  if (!denom) return 1;
  return Math.round((2 * eqCount / denom) * 1000) / 1000;
}

/** 降级统计：多重集（顺序无关）——保留旧 diffStat 语义，用于大范围改动快速近似 */
function multisetStat(aLines, bLines) {
  const a = aLines || [];
  const b = bLines || [];
  const setA = new Map();
  for (const l of a) setA.set(l, (setA.get(l) || 0) + 1);
  let added = 0;
  for (const l of b) {
    const c = setA.get(l) || 0;
    if (c > 0) setA.set(l, c - 1);
    else added++;
  }
  let removed = 0;
  for (const c of setA.values()) removed += c;
  return { added, removed };
}

/**
 * 公开：行级 diff 统计。
 * @param {string} before
 * @param {string} after
 * @param {Object} [opts] 见 DEFAULT_OPTS（ignoreWhitespace、ignoreCase、wordDiff 等影响比对）
 * @returns {{added:number, removed:number, modified:number, unchanged:number,
 *            similarity:number, degraded:boolean, total:number, hunks?:number}}
 * 兼容说明：旧调用只读 added/removed；本实现中「修改 1 行」同样计入 added=1、removed=1，
 * 同时新增 modified=1 便于区分「纯增删」与「修改」。
 */
function diffStat(before, after, opts) {
  return computeDiff(before, after, opts).stat;
}

/**
 * 公开：带行号的紧凑 diff 摘要（兼容旧 unifiedPreview 输出骨架）。
 * @param {string} before
 * @param {string} after
 * @param {number} [maxLines=40] 输出行数上限
 * @param {Object} [opts] context/wordDiff/ignore 系列选项/maxLineLength/maxHunks/lineNumbers
 * @returns {string}
 */
function formatUnified(before, after, maxLines, opts) {
  const o = Object.assign({}, DEFAULT_OPTS, opts || {});
  const cap = (typeof maxLines === 'number' && maxLines > 0) ? Math.floor(maxLines) : o.maxLines;
  const { hunks } = computeDiff(before, after, o);
  const a = splitLines(before);
  const b = splitLines(after);
  const width = Math.max(1, String(a.length).length, String(b.length).length);
  const pad = (n) => String(n).padStart(width, ' ');
  const out = [];
  let collecting = true;

  for (const h of hunks) {
    if (!collecting) break;
    const head = '@@ -' + (h.aLen ? h.aStart + ',' + h.aLen : h.aStart + ',0')
      + ' +' + (h.bLen ? h.bStart + ',' + h.bLen : h.bStart + ',0') + ' @@';
    if (o.lineNumbers !== false) out.push(head);
    for (const r of h.rows) {
      if (out.length >= cap + OVERFLOW_ROW_BUF) { collecting = false; break; }
      if (r.type === 'ctx') {
        out.push((r.aNo === r.bNo ? ' ' + pad(r.aNo) : pad(r.aNo) + '→' + pad(r.bNo)) + '│ ' + r.text);
      } else if (r.type === 'del') {
        out.push('-' + pad(r.aNo) + '│ ' + r.text);
      } else {
        out.push('+' + pad(r.bNo) + '│ ' + r.text);
      }
    }
  }
  if (out.length > cap) {
    return out.slice(0, cap).join('\n') + '\n… 还有 ' + (out.length - cap) + ' 行';
  }
  return out.join('\n');
}

module.exports = {
  splitLines,
  lineKey,
  hashLines,
  myersOps,
  tokenizeLine,
  inlineWordMark,
  capLine,
  computeDiff,
  diffStat,
  formatUnified,
  DEFAULT_OPTS
};
