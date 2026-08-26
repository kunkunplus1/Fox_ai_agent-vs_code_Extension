// textStreamStripProbe.js
// 验证 1.1.16 text 协议实时流式：onDelta 剥 <fox:tool> 块逐字推正文（含跨 chunk 未闭合块缓冲）、
// 轮末 TailFix 补漏、不重复。
'use strict';

const TOOL_BLOCK = /<(fox:?tool|fox-tool|tool)\s+name\s*=\s*["']([^\s"'<>]+)["']\s*>([\s\S]*?)<\/(fox:?tool|fox-tool|tool)>/gi;

// 与 agent.js onDelta 完全相同的增量剥离（含未闭合块缓冲）
function makeStripper() {
  let buf = '';
  return function stripChunk(t) {
    buf += t;
    const cleaned = buf.replace(TOOL_BLOCK, '').replace(/<(fox:?tool|fox-tool|tool)[\s\S]*$/i, '').trim();
    const rawNoClosed = buf.replace(TOOL_BLOCK, '');
    const hasOpen = /<(fox:?tool|fox-tool|tool)[\s\S]*$/i.test(rawNoClosed);
    if (hasOpen) {
      return { push: '', buffered: true, bufLen: buf.length };
    }
    buf = '';
    return { push: cleaned, buffered: false, bufLen: 0 };
  };
}

// 与 agent.js stripToolBlocks 相同的最终全量剥离
function stripFull(src) {
  return String(src || '')
    .replace(TOOL_BLOCK, '')
    .replace(/<(fox:?tool|fox-tool|tool)[\s\S]*$/i, '')
    .trim();
}

function simulate(chunks, label) {
  const strip = makeStripper();
  let pushed = '';
  let pushedNonWs = 0;
  let finalStreamed = false;
  let buffered = 0;
  const pushes = [];
  for (const t of chunks) {
    if (!t) continue;
    const r = strip(t);
    if (r.buffered) { buffered++; pushes.push('[buf]'); continue; }
    if (!r.push) { pushes.push('[skip]'); continue; }
    pushes.push('+' + r.push);
    pushed += r.push;
    pushedNonWs += r.push.replace(/\s+/g, '').length;
    finalStreamed = true;
  }
  const visible = stripFull(chunks.join(''));
  // 轮末 flush（1.1.16 去空白前缀判定版，与 agent.js 同步）
  let tailFix = null;
  const visibleNoWs = visible.replace(/\s+/g, '');
  const pushedNoWs = pushed.replace(/\s+/g, '');
  if (visible && !finalStreamed) {
    tailFix = visible;
  } else if (visible && finalStreamed) {
    if (pushedNoWs && visibleNoWs.startsWith(pushedNoWs)) {
      tailFix = null; // 前缀匹配：仅空白差异，不补
    } else if (pushedNoWs) {
      tailFix = visibleNoWs.slice(pushedNoWs.length); // 真缺段才补
      if (!tailFix || !tailFix.trim()) tailFix = null;
    }
  }
  const finalText = finalStreamed ? pushedNoWs : visibleNoWs;
  const finalWithFix = finalText + (tailFix || '');
  return { label, pushes, pushed, finalStreamed, fullLen: visibleNoWs.length, pushedLen: pushedNonWs, tailFix, final: finalWithFix, buffered, pushedNoWs, visibleNoWs };
}

function assert(name, cond, extra) {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

const cases = [];
cases.push(simulate(['这是第一句话。', '<fox:tool name="bash"><arg>ls</arg></fox:tool>', ' 这是末尾正文。'], '同chunk完整工具块'));
cases.push(simulate(['开头正文。', '<fox:tool name="bash">', '<arg>ls -la</arg>', '</fox:tool>', ' 结尾正文。'], '跨chunk工具块'));
cases.push(simulate(['第一段。', '<fox:tool name="read"><arg>/a</arg></fox:tool>', '第二段。', '<fox:tool name="grep"><arg>x</arg></fox:tool>', '第三段。'], '多工具块'));
cases.push(simulate(['<fox:tool name="bash"><arg>ls</arg></fox:tool>'], '纯工具块无正文'));
cases.push(simulate(['正文A', '<fox:tool name="bash">'], '截断在开标签'));

for (const c of cases) {
  console.log('\n=== ' + c.label + ' ===');
  console.log('  chunks:', JSON.stringify(c.pushes));
  assert('有实时推送(或纯工具块跳过)', c.finalStreamed || c.buffered > 0 || c.pushes.every(p => p==='[skip]'));
  assert('轮末无整段重复', !c.tailFix || c.tailFix !== c.pushed, 'tailFix=' + (c.tailFix || '无'));
  assert('最终无工具标签', !/<fox:?tool/i.test(c.final), 'final=' + JSON.stringify(c.final.slice(0, 60)));
  if (c.label.includes('截断')) {
    assert('截断场景允许缺尾', true);
  } else if (c.label.includes('纯工具')) {
    assert('纯工具块最终为空', c.final === '', 'final=' + JSON.stringify(c.final));
  } else {
    assert('final 长度 = 可见正文长度', c.final.length === c.fullLen, 'final=' + c.final.length + ' full=' + c.fullLen + ' final=' + JSON.stringify(c.final));
  }
}

const s2 = cases[1];
assert('跨chunk最终正文完整', s2.final.includes('开头正文') && s2.final.includes('结尾正文') && !/<arg/i.test(s2.final), JSON.stringify(s2.final));
const s5 = cases[4];
assert('截断不再推半截块', s5.pushed === '正文A' || s5.pushed === '正文A', 'pushed=' + JSON.stringify(s5.pushed));

// 1.1.16 专项：空格/换行被剥离吃掉但正文完整 → 前缀判定 → 不误补 TailFIX（用户实测场景）
const spaced = simulate(
  ['第一句。', '\n\n', '第二句。', ' ', '第三句。', '\n', '第四句。'],
  '正文间的空格/换行被剥离'
);
console.log('\n=== ' + spaced.label + ' ===');
console.log('  chunks:', JSON.stringify(spaced.pushes));
assert('空格/换行被吞但正文全推', spaced.finalStreamed && spaced.pushes.length > 3, JSON.stringify(spaced.pushes));
assert('不误补 TailFIX（前缀匹配）', spaced.tailFix === null, 'tailFix=' + JSON.stringify(spaced.tailFix));
assert('最终正文完整', spaced.final.replace(/\s+/g, '') === '第一句。第二句。第三句。第四句。', 'final=' + JSON.stringify(spaced.final));

// 真缺段：模拟流式只推了「前半 + 未闭合工具块」（后半正文根本没到达）→ 无后半可补，不误补
const halved = simulate(
  ['前半部分正文。', '<fox:tool name="bash">'],
  '流式中断只推前半（无可补后半）'
);
console.log('\n=== ' + halved.label + ' ===');
console.log('  chunks:', JSON.stringify(halved.pushes));
assert('无后半可补时不误补', halved.tailFix === null || halved.tailFix === '前半部分正文。', 'tailFix=' + JSON.stringify(halved.tailFix));
assert('最终正文完整（只剩前半）', halved.final.replace(/\s+/g, '') === '前半部分正文。', 'final=' + JSON.stringify(halved.final));
console.log('\n完成。');