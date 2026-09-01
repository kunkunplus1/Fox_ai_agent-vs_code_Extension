'use strict';
/**
 * 前缀缓存基线自愈测试：区分「一次性跳变（MCP 晚加载）」与「持续漂移」，避免残前缀基线导致永久误报。
 */
const { classifyPrefixDrift } = require('../src/cacheBaseline');

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) passed++; else { failed++; console.log('  ✗ ' + name); } }

// 场景：MCP 工具在首轮后才加载完
// 轮1: A（残前缀，无 mcp） → 基线=A
// 轮2: B（带 mcp）        → B!=A 且 B!=prev(A) → 真·变化，但这是首次出现，drift=true（首跳仍提示一次）
// 轮3: B（带 mcp）        → B==prev(B) → 自愈，基线=B，drift=false
// 轮4: B                  → drift=false
const st = { baseline: null, prev: null };
let r = classifyPrefixDrift(st, 'A');
ok('轮1 设基线 A 无漂移', r.baseline === 'A' && r.drift === false && r.selfHealed === false);
ok('轮1 状态 prev=A', st.prev === 'A');

r = classifyPrefixDrift(st, 'B');
ok('轮2 基线仍 A、drift=true（首次跳变提示一次）', r.baseline === 'A' && r.drift === true && st.prev === 'B');

r = classifyPrefixDrift(st, 'B');
ok('轮3 自愈：基线=B、drift=false', r.baseline === 'B' && r.drift === false && r.selfHealed === true);

r = classifyPrefixDrift(st, 'B');
ok('轮4 稳定无漂移', r.drift === false && r.baseline === 'B');

// 场景：持续漂移（每轮都变）→ 每轮都 drift=true（真失效）
const st2 = { baseline: null, prev: null };
ok('持续漂移轮1', classifyPrefixDrift(st2, 'X').drift === false);
ok('持续漂移轮2 (X→Y)', classifyPrefixDrift(st2, 'Y').drift === true);
ok('持续漂移轮3 (Y→Z)', classifyPrefixDrift(st2, 'Z').drift === true);
ok('持续漂移轮4 (Z→W)', classifyPrefixDrift(st2, 'W').drift === true);

// 场景：稳定后再次一次性跳变（MCP 二次加载更多工具）→ 应再自愈一次
const st3 = { baseline: null, prev: null };
classifyPrefixDrift(st3, 'A');
classifyPrefixDrift(st3, 'B'); // self-heal to B
classifyPrefixDrift(st3, 'B');
r = classifyPrefixDrift(st3, 'C'); // C != B 且 C != prev(B) → 首跳提示
ok('二次跳变首跳 drift=true', r.drift === true);
r = classifyPrefixDrift(st3, 'C'); // C == prev(C) → 自愈
ok('二次跳变自愈', r.selfHealed === true && r.drift === false && r.baseline === 'C');

console.log(`\ncache-baseline: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
