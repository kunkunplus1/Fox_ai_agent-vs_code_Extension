'use strict';

/**
 * 离线单测：稳定上下文「首轮注入一次 + 烤回源历史」（1.1.21）
 * 验证 _collectStableParts（收集规则）与哨兵方法（_wrapAppendix/_hasMark/
 * _injectDynamicAppendix/_bakeAppendixIntoSource/_sourceHasMark）的双哨兵与门控行为。
 * 运行：node test/staticPrefix.js
 */

const Module = require('module');
const assert = require('assert');

/* ---------- mock vscode ---------- */
const vscodeMock = {
  workspace: {
    workspaceFolders: null,
    getConfiguration: () => ({ get: (k, d) => d, update: async () => {} }),
    textDocuments: [],
    fs: {}
  },
  window: { activeTextEditor: null, activeTerminal: null, tabGroups: { all: [] } },
  languages: { getDiagnostics: () => [] },
  commands: { executeCommand: async () => {} },
  env: { clipboard: { readText: async () => '', writeText: async () => {} } },
  Uri: { file: (p) => ({ fsPath: p, toString: () => 'file://' + p }), joinPath: () => ({}) },
  Position: class {}, Range: class {}, Selection: class {}, ThemeIcon: class {},
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  FileType: { File: 1, Directory: 2 },
  InlineCompletionItem: class {}, ConfigurationTarget: { Global: 1 },
  TextEditorRevealType: { InCenter: 2 }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const { AgentSession } = require('../src/agent');

const DYN = '【狐狸AI·动态上下文】';
const DYN_END = '【狐狸AI·动态上下文·完】';
const STABLE = '【狐狸AI·稳定上下文】';
const STABLE_END = '【狐狸AI·稳定上下文·完】';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); }
}

const session = new AgentSession({ cfg: {}, messages: [], ui: {} });
// 可控的数据源桩：规则(root 为 null 时跳过)、技能/结构/任务/记忆可注入
session.skills = { renderForPrompt: () => 'SKILL_BODY' };
session._workspaceRoot = () => null;            // 跳过项目根规则分支（避免真实 I/O）
session._buildProjectContext = () => 'PROJ_BODY';
session.planTasks = { renderForPrompt: () => 'PLAN_BODY' };
session.mode = null;                             // 跳过模式人格分支
session.memory = { renderForPrompt: () => 'FLAT_BODY' };

console.log('\n[1] _collectStableParts 拼接规则（技能/结构/任务/扁平记忆，rules 因 root=null 跳过、mode 因 null 跳过）');
const collected = session._collectStableParts('FLAT_BODY');
// 1.1.25：技能块标题已从「用户技能」改为「技能目录」（1.1.23 拆 prompts 时对齐 dsh 技能目录命名），断言同步
  check('返回数组且含【技能目录】', () => assert.ok(collected.some((p) => p.startsWith('【技能目录】') && p.includes('SKILL_BODY')), JSON.stringify(collected)));
check('含【项目结构】', () => assert.ok(collected.some((p) => p === '【项目结构】\nPROJ_BODY'), JSON.stringify(collected)));
check('不含【项目任务清单】(已移出稳定块，改由 list_plan_tasks 按需查询)', () => assert.ok(!collected.some((p) => p.startsWith('【项目任务清单】')), JSON.stringify(collected)));
check('含【长期记忆】(扁平)', () => assert.ok(collected.some((p) => p === '【长期记忆】\nFLAT_BODY'), JSON.stringify(collected)));
check('顺序为 技能→结构→长期记忆', () => {
  const i1 = collected.findIndex((p) => p.startsWith('【技能目录】'));
  const i2 = collected.findIndex((p) => p.startsWith('【项目结构】'));
  const i4 = collected.findIndex((p) => p.startsWith('【长期记忆】'));
  assert.ok(i1 >= 0 && i2 > i1 && i4 > i2, JSON.stringify(collected));
});
check('rules/mode 因跳过不出现', () => {
  assert.ok(!collected.some((p) => p.includes('CLAUDE.md') || p.includes('【Agent 模式')));
});

console.log('\n[2] _collectStableParts 鲁棒性（任一来源异常都不抛、返回已收集部分）');
session.skills = { renderForPrompt: () => { throw new Error('boom'); } };
session._buildProjectContext = () => { throw new Error('boom'); };
session.planTasks = { renderForPrompt: () => { throw new Error('boom'); } };
let threw = false; let r = [];
try { r = session._collectStableParts('FLAT_BODY'); } catch (_) { threw = true; }
check('全异常也不抛出', () => assert.strictEqual(threw, false));
check('全异常只保留扁平记忆（其余来源被 try/catch 跳过）', () => {
  assert.deepStrictEqual(r, ['【长期记忆】\nFLAT_BODY']);
});
// 还原
session.skills = { renderForPrompt: () => 'SKILL_BODY' };
session._buildProjectContext = () => 'PROJ_BODY';
session.planTasks = { renderForPrompt: () => 'PLAN_BODY' };

console.log('\n[3] _wrapAppendix 双哨兵包裹');
check('默认 mark = 动态哨兵', () => {
  const w = session._wrapAppendix('X');
  assert.ok(w.includes(DYN) && w.includes(DYN_END) && !w.includes(STABLE), w);
});
check('显式 DYN mark', () => {
  const w = session._wrapAppendix('X', '狐狸AI·动态上下文');
  assert.ok(w.includes(DYN) && w.includes(DYN_END), w);
});
check('显式 STABLE mark', () => {
  const w = session._wrapAppendix('X', '狐狸AI·稳定上下文');
  assert.ok(w.includes(STABLE) && w.includes(STABLE_END) && !w.includes(DYN), w);
});

console.log('\n[4] _hasMark 按 mark 独立识别（互不误判）');
check('含 DYN 的消息：DYN 识别 true、STABLE 识别 false', () => {
  const m = { role: 'user', content: 'Q' + session._wrapAppendix('D', '狐狸AI·动态上下文') };
  assert.strictEqual(session._hasMark(m, '狐狸AI·动态上下文'), true);
  assert.strictEqual(session._hasMark(m, '狐狸AI·稳定上下文'), false);
});
check('含 STABLE 的消息：STABLE 识别 true、DYN 识别 false', () => {
  const m = { role: 'user', content: 'Q' + session._wrapAppendix('S', '狐狸AI·稳定上下文') };
  assert.strictEqual(session._hasMark(m, '狐狸AI·稳定上下文'), true);
  assert.strictEqual(session._hasMark(m, '狐狸AI·动态上下文'), false);
});
check('数组 content 中的文本块也能识别', () => {
  const m = { role: 'user', content: [{ type: 'text', text: 'Q' + session._wrapAppendix('S', '狐狸AI·稳定上下文') }] };
  assert.strictEqual(session._hasMark(m, '狐狸AI·稳定上下文'), true);
});

console.log('\n[5] _injectDynamicAppendix 注入 + 按 mark 幂等（同消息可同时含两种哨兵而不冲突）');
let hist = [{ role: 'user', content: 'Q' }];
session._injectDynamicAppendix(hist, 'S', '狐狸AI·稳定上下文');
check('注入 STABLE 后含 STABLE 哨兵、不含 DYN', () => {
  assert.ok(hist[0].content.includes(STABLE) && !hist[0].content.includes(DYN), hist[0].content);
});
session._injectDynamicAppendix(hist, 'D', '狐狸AI·动态上下文');
check('再注入 DYN 后两种哨兵共存', () => {
  assert.ok(hist[0].content.includes(STABLE) && hist[0].content.includes(DYN), hist[0].content);
});
const before = hist[0].content;
session._injectDynamicAppendix(hist, 'S', '狐狸AI·稳定上下文'); // 重注同 mark → 不变
session._injectDynamicAppendix(hist, 'D', '狐狸AI·动态上下文'); // 重注同 mark → 不变
check('同 mark 重复注入幂等（内容不变）', () => assert.strictEqual(hist[0].content, before));

console.log('\n[6] _bakeAppendixIntoSource 烤回源 + 哨兵门控');
session.messages = [{ role: 'user', content: 'Q' }];
session._bakeAppendixIntoSource('S', '狐狸AI·稳定上下文');
// 1.1.25：_sourceHasMark 方法已被重构移除（哨兵判定统一走 _hasMark），
// 源消息列表只含 messages[0] 一条 user，等价 session._hasMark(session.messages[0], mark)。
check('烤回源后源含 STABLE 哨兵', () => assert.ok(session.messages[0].content.includes(STABLE)));
check('STABLE 哨兵已烤入（门控将跳过首轮注入）', () => assert.strictEqual(session._hasMark(session.messages[0], '狐狸AI·稳定上下文'), true));
check('DYN 仍未烤入（易变块未烤）', () => assert.strictEqual(session._hasMark(session.messages[0], '狐狸AI·动态上下文'), false));
session._bakeAppendixIntoSource('S', '狐狸AI·稳定上下文'); // 重烤同 mark → 不变
check('同 mark 重烤幂等', () => assert.strictEqual(session.messages[0].content.includes(STABLE_END) && (session.messages[0].content.match(new RegExp(STABLE, 'g')) || []).length === 1, true));
session._bakeAppendixIntoSource('D', '狐狸AI·动态上下文');
check('再烤 DYN 后源同时含两套哨兵', () => assert.ok(session.messages[0].content.includes(STABLE) && session.messages[0].content.includes(DYN)));

console.log('\n[7] 首轮注入门控（run 决策等价：源无 STABLE 才收集，有则跳过）');
session.messages = [];
check('源为空 → 门控放行（应收集 stableAppendix）', () => assert.strictEqual(session._hasMark(session.messages[0], '狐狸AI·稳定上下文'), false));
session.messages = [{ role: 'user', content: 'Q' + session._wrapAppendix('S', '狐狸AI·稳定上下文') }];
check('源已含 STABLE → 门控拦截（stableAppendix 应为空、不再重注）', () => assert.strictEqual(session._hasMark(session.messages[0], '狐狸AI·稳定上下文'), true));

console.log('\n[8] _applyAppendix 替换语义（降级重算场景：内容变化也对齐，不重复叠加）');
check('无 mark 时追加到尾部（首追补 \\n\\n 分隔）', () => {
  const out = session._applyAppendix('Q', 'D', '狐狸AI·动态上下文');
  assert.strictEqual(out, 'Q\n\n' + session._wrapAppendix('D', '狐狸AI·动态上下文'));
});
check('已含同 mark 块且内容不同 → 替换旧块（仅一份）', () => {
  const withOld = 'Q' + session._wrapAppendix('OLD', '狐狸AI·动态上下文');
  const out = session._applyAppendix(withOld, 'NEW', '狐狸AI·动态上下文');
  assert.ok(out.includes('NEW') && !out.includes('OLD'), out);
  assert.strictEqual((out.match(new RegExp(DYN, 'g')) || []).length, 1, '应只有一份动态哨兵');
});
check('数组 content：无 mark 追加、有 mark 替换最后一个文本块', () => {
  const arr = [{ type: 'text', text: 'Q' + session._wrapAppendix('OLD', '狐狸AI·动态上下文') }];
  const out = session._applyAppendix(arr, 'NEW', '狐狸AI·动态上下文');
  const txt = out.map((c) => c.text).join('');
  assert.ok(txt.includes('NEW') && !txt.includes('OLD'), txt);
  assert.strictEqual(out.filter((c) => c.text && c.text.includes(DYN)).length, 1, '应只有一份动态哨兵');
});

console.log('\n[9] ★ 1.1.22 修复核心：烤回源与注入副本字节一致（跨轮前缀才能命中）');
// 模拟一轮：源历史只含当前 user 消息；副本由源克隆；var 附录 V1
session.messages = [{ role: 'user', content: '用户提问' }];
const copy1 = session.messages.map((m) => Object.assign({}, m));
session._injectDynamicAppendix(copy1, 'V1动态附录', '狐狸AI·动态上下文');
session._bakeAppendixIntoSource('V1动态附录', '狐狸AI·动态上下文');
check('下发副本与源历史逐字节一致（含同一份 DYN 块）', () => {
  assert.strictEqual(copy1[0].content, session.messages[0].content, '副本与源不一致 → 下一轮前缀会断裂');
});
check('源历史确实带上了 DYN 附录（之前漏烤的致命点）', () => {
  assert.ok(session.messages[0].content.includes('V1动态附录') && session.messages[0].content.includes(DYN), session.messages[0].content);
});
// 模拟下一轮 + 降级重算（var 变成 V2）：从源重建副本，重注并烤回
const copy2 = session.messages.map((m) => Object.assign({}, m)); // 来自已带 V1 的源
session._injectDynamicAppendix(copy2, 'V2动态附录', '狐狸AI·动态上下文');
session._bakeAppendixIntoSource('V2动态附录', '狐狸AI·动态上下文');
check('降级重算后：副本与源仍一致（都换成 V2）', () => {
  assert.strictEqual(copy2[0].content, session.messages[0].content, '降级后副本与源不一致');
});
check('降级重算后：旧 V1 被替换、无残留重复', () => {
  const c = session.messages[0].content;
  assert.ok(c.includes('V2动态附录') && !c.includes('V1动态附录'), c);
  assert.strictEqual((c.match(new RegExp(DYN, 'g')) || []).length, 1, '应只有一份动态哨兵');
});

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
