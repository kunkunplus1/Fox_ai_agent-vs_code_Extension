'use strict';

// 思考卡切分与 reasoning 增量/全量合并逻辑单测。
// 背景：media/chat.js 的 splitThinkingSteps 与 updateThinkingStep 是 webview 闭包内函数，
// 无法直接 require。本文件把这些函数的核心算法提取为等价纯函数做镜像验证——
// 用于回归「思考卡片最后一句错乱」的修复：未闭合 STEP 标记的容错、碎片收束、
// stream:true 增量与轮末全量不混堆。
const assert = require('assert');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  try { assert.ok(cond, name); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '') + ' -> ' + e.message); }
}
function eq(name, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ' -> 期望 ' + JSON.stringify(expected) + ' 实得 ' + JSON.stringify(actual)); }
}

// —— chat.js splitThinkingSteps 的镜像实现（与已改的源码保持同一算法）——

function isToolFrag(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  if (/^\u0002STEP:[^\u0002]*$/m.test(s)) return true;
  if (/<fox:?tool|[[tool:|<tool[>\s]/.test(s)) return true;
  if (s.length <= 12 && !/[，。；：！？\n]{1,}/.test(s)) return true;
  return false;
}

function splitThinkingSteps(raw) {
  const STEP_RE = /\u0002STEP:([^\u0002]+)\u0002/g;
  const OPEN_STEP_RE = /\u0002STEP:([^\u0002]*)(?:\u0002|$)/g;
  const segs = [];
  let last = 0, m;
  while ((m = STEP_RE.exec(String(raw || ''))) !== null) {
    const pre = String(raw).slice(last, m.index);
    if (pre && pre.trim()) segs.push({ kind: 'text', text: pre });
    segs.push({ kind: 'tool', name: m[1] });
    last = m.index + m[0].length;
  }
  let tail = String(raw).slice(last);
  if (tail && tail.trim()) {
    OPEN_STEP_RE.lastIndex = 0;
    const om = OPEN_STEP_RE.exec(tail);
    if (om) {
      const preFrag = tail.slice(0, om.index);
      if (preFrag && preFrag.trim()) segs.push({ kind: 'text', text: preFrag });
      segs.push({ kind: 'tool', name: (om[1] || 'tool').trim() });
      tail = '';
    }
  }
  if (tail && tail.trim()) {
    if (!(isToolFrag(tail) && segs.length)) segs.push({ kind: 'text', text: tail });
  }
  if (!segs.length && String(raw || '').trim()) segs.push({ kind: 'text', text: raw });
  return segs;
}

// —— chat.js updateThinkingStep reasoning 分支的镜像实现 ——
function mergeReasoning(prev, text, isStream) {
  const t = String(text || '');
  if (isStream) {
    if (prev && t.length < prev.length && prev.startsWith(t)) { return prev; } // 增量是全量前缀，冗余
    if (prev) {
      if (t.length > prev.length && t.startsWith(prev)) return t;
      if (t.length > 0 && prev.includes(t)) return prev; // 已有相同片段
      return prev + t;
    }
    return t;
  }
  // 轮末全量：权威覆盖
  return (t && t.trim()) ? t : prev;
}

console.log('[splitThinking] isToolFrag 碎片识别');
ok('空串为碎片', isToolFrag(''));
ok('未闭合 STEP 头为碎片', isToolFrag('\u0002STEP:read_file'));
ok('极短无标点为碎片', isToolFrag('2数增减'));
ok('完整句子非碎片', !isToolFrag('从我的经验看涉及文件修改删除转换信息。'));

console.log('[splitThinking] 闭合 STEP 正常切分');
let segs = splitThinkingSteps('先思考。\u0002STEP:read_file\u0002后处理。');
eq('正文-工具-正文三段', segs.map(s => s.kind), ['text', 'tool', 'text']);
eq('工具名正确', segs[1].name, 'read_file');

console.log('[splitThinking] 半截 STEP 容错');
segs = splitThinkingSteps('分析工具问题。\u0002STEP:read_file');
eq('未闭合尾被折成工具段，不外露碎片正文', segs.map(s => s.kind), ['text', 'tool']);
ok('未闭合工具名被提取', segs[1].name === 'read_file', segs);

console.log('[splitThinking] 碎片尾巴收束');
segs = splitThinkingSteps('先看。\u0002STEP:write_file\u00022数增减可能导致同类不足');
eq('碎片尾巴被丢弃（不进正文）', segs.map(s => s.kind), ['text', 'tool']);
segs = splitThinkingSteps('干净正文。');
eq('纯正文单段', segs.map(s => s.kind), ['text']);

console.log('[splitThinking] reasoning 增量/全量合并');
eq('全量覆盖增量（无 stream 到达）', mergeReasoning('前半截半份', '完整思考全部内容', false), '完整思考全部内容');
eq('增量是全量前缀→保持全量', mergeReasoning('完整思考全部内容', '完整思考', true), '完整思考全部内容');
eq('增量正常追加', mergeReasoning('已想', '下一段', true), '已想下一段');
eq('增量与已有相同→去重', mergeReasoning('abc', 'abc', true), 'abc');
eq('首条增量直接赋值', mergeReasoning('', '开头', true), '开头');
eq('空全量不覆盖已有', mergeReasoning('已有内容', '   ', false), '已有内容');

console.log('');
console.log('[splitThinking] 通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);
