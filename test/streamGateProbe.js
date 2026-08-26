// streamGateProbe.js
// 目标：验证 agent.js 三处流式门控（forceNonStream / streamBroken / protocol==='text'）
// 究竟哪一道会导致「三协议都不流式」，并验证修复方向（text 协议也做实时 delta 剥离）。
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');

// 从 agent.js 提取关键门控表达式（模拟真实逻辑，不 mock client）
function extractGates(src) {
  const gates = {};
  // 1) _requestEndpoint: if (forceNonStream || this.streamBroken)
  const m1 = src.match(/if\s*\(forceNonStream\s*\|\|\s*this\.streamBroken\)/);
  gates.requestEndpoint = !!m1;
  // 2) onDelta: const streaming = !(cfg.forceNonStream || this.streamBroken);
  const m2 = src.match(/const\s+streaming\s*=\s*!\(cfg\.forceNonStream\s*\|\|\s*this\.streamBroken\)/);
  gates.onDeltaStreaming = !!m2;
  // 3) onDelta 实时推送: if (this.protocol !== 'text' && streaming)
  const m3 = src.match(/if\s*\(this\.protocol\s*!==\s*'text'\s*&&\s*streaming\)/);
  gates.onDeltaTextGate = !!m3;
  // 4) onReasoning 实时推送: if (this.protocol !== 'text' && !(cfg.forceNonStream || this.streamBroken))
  const m4 = src.match(/if\s*\(this\.protocol\s*!==\s*'text'\s*&&\s*!\(cfg\.forceNonStream\s*\|\|\s*this\.streamBroken\)\)/);
  gates.onReasoningTextGate = !!m4;
  // 5) 轮末 flush 守卫: if (visibleText && ... && !this._finalStreamed)
  const m5 = src.match(/if\s*\(visibleText\s*&&\s*String\(visibleText\)\.trim\(\)\s*&&\s*!this\._finalStreamed\)/);
  gates.endFlushGuard = !!m5;
  // 6) _finalStreamed 置位位置
  const m6 = src.match(/this\._finalStreamed\s*=\s*true/);
  gates.finalStreamedSet = !!m6;
  // 7) streamBroken 置位
  const m7 = src.match(/this\.streamBroken\s*=\s*true/);
  gates.streamBrokenSet = !!m7;
  // 8) streamBroken 复位（自愈）
  const m8 = src.match(/this\.streamBroken\s*=\s*false/);
  gates.streamBrokenReset = !!m8;
  return gates;
}

// 模拟 agent 层三种协议决策，判断「delta 是否会实时推给 UI」
function simulate(protocol, forceNonStream, streamBroken) {
  const streaming = !(forceNonStream || streamBroken);
  // 实时 delta 推送条件（onDelta 3181-3189）
  const liveDeltaPushed = protocol !== 'text' && streaming;
  // 轮末 flush（2143）：仅当 !_finalStreamed 才补发
  // 若实时没推 → 轮末 flush 补发 → 表现为「一次性蹦出」
  const finalFlush = protocol !== 'text'
    ? (!liveDeltaPushed ? '补发整段' : '已流式，不补发')
    : 'text 协议轮末 flush 整段';
  return {
    protocol,
    forceNonStream,
    streamBroken,
    streaming,
    liveDeltaPushed,
    finalFlush
  };
}

function main() {
  const src = require('fs').readFileSync(path.join(REPO, 'src', 'agent.js'), 'utf8');
  const gates = extractGates(src);
  console.log('=== agent.js 门控存在性 ===');
  for (const [k, v] of Object.entries(gates)) console.log(`  ${k}: ${v ? '✅' : '❌'}`);
  console.log('');

  const cases = [
    ['native / 正常',            'native', false, false],
    ['native / forceNonStream',  'native', true,  false],
    ['native / streamBroken',    'native', false, true],
    ['text / 正常',              'text',   false, false],
    ['text / forceNonStream',    'text',   true,  false],
    ['text / streamBroken',      'text',   false, true],
  ];
  console.log('=== 流式门控模拟（关键矩阵） ===');
  for (const [name, p, fn, sb] of cases) {
    const r = simulate(p, fn, sb);
    console.log(
      `  ${name.padEnd(24)} | 实时delta: ${r.liveDeltaPushed ? '✅逐字' : '❌不推'} | 轮末: ${r.finalFlush}`
    );
  }
  console.log('');
  console.log('结论判断：');
  console.log('  用户实测「三协议都不流式」且重装仍复现 → 若 streamBroken=0 且 forceNonStream=0，');
  console.log('  唯一能解释「全都不流式」的门 = protocol === \'text\'（onDelta 只给 native 实时推）。');
  console.log('  text 协议为什么常见：toolProtocol auto + 模型不支持 native（或 _forceText 400 降级）→');
  console.log('  agent 自动走 text，onDelta 实时推送被 protocol!==\'text\' 整体关闭 → 轮末一次性蹦出。');
}

main();