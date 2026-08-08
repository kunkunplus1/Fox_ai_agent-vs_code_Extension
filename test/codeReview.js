'use strict';

/**
 * 离线测试：自动代码审查子代理（Code Review Sub-Agent）
 *  - reviewer.runReview 纯函数：接收 silentCall 返回审查文本；异常时 ok=false
 *  - AgentSession._runCodeReview：本轮有代码写操作时触发，emit('review')
 *  - AgentSession._awaitReview：主控输出前限时等待审查，等到了注入 system，超时则异步弹出卡片
 *  - 关闭 foxAi.review.enabled 时不触发
 * 运行：node test/codeReview.js
 */

const Module = require('module');
const os = require('os');
const path = require('path');
const fs = require('fs');
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
  Position: class {},
  Range: class {},
  Selection: class {},
  ThemeIcon: class {},
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  FileType: { File: 1, Directory: 2 },
  InlineCompletionItem: class {},
  ConfigurationTarget: { Global: 1 },
  TextEditorRevealType: { InCenter: 2 }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const { AgentSession } = require('../src/agent');
const { PlanTaskStore } = require('../src/planTasks');
const reviewer = require('../src/reviewer');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + ' → ' + e.message);
  }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-rev-'));
  const fakeTM = {
    createTask: async () => ({ id: 't', state: 'queued', steps: [] }),
    getTask: async () => null,
    updateState: async () => ({}),
    appendStep: async () => {}
  };
  const cfg = {
    agentEnabled: true,
    planAndExecute: { enabled: false },
    review: { enabled: true, injectTimeout: 8000 },
    toolProtocol: 'native',
    maxSteps: 25,
    temperature: 0.3,
    maxTokens: 2048,
    timeout: 30000,
    maxHistory: 20,
    contextWindow: 0,
    autoSummarize: { enabled: false },
    autoApprove: 'read',
    maxToolOutput: 8000,
    blockedCommands: [],
    insecureHttpParser: false,
    streamFormat: 'auto',
    forceNonStream: false,
    vision: 'auto',
    visionModels: [],
    textOnlyModels: [],
    keepImageTurns: 1,
    systemPrompt: '',
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'x',
    model: 'test',
    providerId: 'custom',
    meta: { local: true }
  };
  let reviews = [];
  const ui = {
    text: () => {}, reasoning: () => {}, toolPending: () => {}, toolStart: () => {},
    toolStream: () => {}, toolEnd: () => {}, requestApproval: (req, cb) => cb('approve'),
    state: () => {}, notice: () => {}, contextUsage: () => {}, finalText: () => {},
    planPending: () => {}, review: (p) => { reviews.push(p); }
  };

  console.log('\n[1] reviewer.runReview 纯函数');
  const r1 = await reviewer.runReview({
    silentCall: async () => ({ content: '## 🔴 严重问题\n- 未处理空值' }),
    cfg,
    changed: [{ name: 'edit_file', path: 'a.js', op: '修改', summary: 'old->new' }]
  });
  check('返回 ok=true', () => assert.strictEqual(r1.ok, true));
  check('返回审查文本', () => assert.ok(r1.text.includes('严重问题')));

  const r2 = await reviewer.runReview({
    silentCall: async () => { throw new Error('net down'); },
    cfg,
    changed: []
  });
  check('异常时 ok=false', () => assert.strictEqual(r2.ok, false));
  check('异常时保留 error', () => assert.ok(r2.error));

  console.log('\n[2] AgentSession 触发审查');
  reviews = [];
  const session = new AgentSession({
    cfg,
    messages: [{ role: 'user', content: '改 a.js' }],
    ui,
    harness: { taskManager: fakeTM, policy: null },
    planTasks: new PlanTaskStore(tmp, {})
  });
  session._pendingReview = [{ name: 'edit_file', path: 'a.js', op: '修改', summary: 'old->new' }];
  session._silentCall = async () => ({ content: '## 🔴 严重问题\n- 未处理空值' });
  const p2 = session._runCodeReview();
  check('fire 后同步返回 Promise', () => assert.ok(p2 && typeof p2.then === 'function'));
  await p2;
  check('emit review 被调用', () => assert.strictEqual(reviews.length, 1));
  check('review 含文件', () => assert.ok(reviews[0].files.includes('a.js')));
  check('review 含文本', () => assert.ok(reviews[0].text.includes('未处理空值')));
  check('本轮 pendingReview 已清空', () => assert.strictEqual(session._pendingReview.length, 0));
  check('审查结果仅以卡片推送（不再塞回主对话历史，避免阻塞主回复）', () =>
    assert.ok(!session.messages.some((m) => m.role === 'user' && /代码审查意见/.test(m.content))));

  console.log('\n[3] 关闭 review.enabled 不触发');
  reviews = [];
  const cfg2 = Object.assign({}, cfg, { review: { enabled: false } });
  const session2 = new AgentSession({
    cfg: cfg2,
    messages: [{ role: 'user', content: 'x' }],
    ui,
    harness: { taskManager: fakeTM, policy: null },
    planTasks: new PlanTaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'fox-rev2-')), {})
  });
  session2._pendingReview = [{ name: 'write_file', path: 'b.js', op: '新增/覆盖', summary: '...' }];
  session2._silentCall = async () => ({ content: 'x' });
  await session2._runCodeReview();
  check('关闭时未 emit review', () => assert.strictEqual(reviews.length, 0));

  console.log('\n[4] 异步不阻塞 + 合并审查');
  reviews = [];
  const session3 = new AgentSession({
    cfg,
    messages: [{ role: 'user', content: 'y' }],
    ui,
    harness: { taskManager: fakeTM, policy: null },
    planTasks: new PlanTaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'fox-rev3-')), {})
  });
  session3._pendingReview = [{ name: 'edit_file', path: 'd.js', op: '修改', summary: 'old->new' }];
  let calls = 0;
  session3._silentCall = (m, opts) => {
    calls++;
    return new Promise((resolve) => {
      setTimeout(() => {
        // 第一次审查进行期间，模拟又有新改动累积
        if (calls === 1) session3._pendingReview.push({ name: 'edit_file', path: 'e.js', op: '修改', summary: 'x' });
        resolve({ content: '## 🔴 严重问题\n- 未处理空值' });
      }, 30);
    });
  };
  const p3 = session3._runCodeReview(); // fire，不 await
  check('fire 后同步返回 Promise（不阻塞主流程）', () => assert.ok(p3 && typeof p3.then === 'function'));
  check('fire 后未阻塞：审查卡片尚未产生', () => assert.strictEqual(reviews.length, 0));
  await p3;
  await new Promise((r) => setTimeout(r, 150));
  check('异步审查最终 emit 卡片', () => assert.ok(reviews.length >= 1));
  check('合并审查：期间新增改动触发第二次（共 2 次）', () => assert.strictEqual(reviews.length, 2));
  check('合并审查覆盖全部改动文件', () => {
    const files = reviews.flatMap((r) => r.files);
    assert.ok(files.includes('d.js') && files.includes('e.js'));
  });
  check('合并审查后 pendingReview 清空', () => assert.strictEqual(session3._pendingReview.length, 0));

  console.log('\n[5] 限时内完成：审查被注入主控（_awaitReview）');
  reviews = [];
  const session4 = new AgentSession({
    cfg,
    messages: [{ role: 'user', content: 'z' }],
    ui,
    harness: { taskManager: fakeTM, policy: null },
    planTasks: new PlanTaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'fox-rev4-')), {})
  });
  session4._pendingReview = [{ name: 'edit_file', path: 'f.js', op: '修改', summary: 'old->new' }];
  session4._silentCall = () => new Promise((resolve) => setTimeout(() => resolve({ content: '## 🟡 中等问题\n- 建议补全边界判断' }), 60));
  session4._runCodeReview();
  const snapshot = await session4._awaitReview(200);
  check('_awaitReview 等到审查结果', () => assert.ok(snapshot && snapshot.text.includes('边界判断')));
  check('_awaitReview  emit review 卡片', () => assert.strictEqual(reviews.length, 1));
  check('_awaitReview 标记 _reviewInjected', () => assert.strictEqual(session4._reviewInjected, true));
  check('审查完成后不再重复 emit', () => {
    assert.strictEqual(reviews.length, 1);
  });

  console.log('\n[6] 超时 fallback：主控先走，审查完成后异步弹出卡片');
  reviews = [];
  const session5 = new AgentSession({
    cfg,
    messages: [{ role: 'user', content: 'w' }],
    ui,
    harness: { taskManager: fakeTM, policy: null },
    planTasks: new PlanTaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'fox-rev5-')), {})
  });
  session5._pendingReview = [{ name: 'edit_file', path: 'g.js', op: '修改', summary: 'old->new' }];
  session5._silentCall = () => new Promise((resolve) => setTimeout(() => resolve({ content: '## 🟢 建议\n- 命名可更清晰' }), 200));
  const p5 = session5._runCodeReview();
  const snapshot5 = await session5._awaitReview(50);
  check('_awaitReview 超时返回 null', () => assert.strictEqual(snapshot5, null));
  check('超时期间尚未 emit review', () => assert.strictEqual(reviews.length, 0));
  await p5;
  await new Promise((r) => setTimeout(r, 50));
  check('审查完成后异步 emit review 卡片', () => assert.strictEqual(reviews.length, 1));
  check('超时后完成不标记 _reviewInjected', () => assert.strictEqual(session5._reviewInjected, false));

  console.log('\n[7] 审查子代理配额错误冒泡给主任务');
  reviews = [];
  const session6 = new AgentSession({
    cfg,
    messages: [{ role: 'user', content: 'q' }],
    ui,
    harness: { taskManager: fakeTM, policy: null },
    planTasks: new PlanTaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'fox-rev6-')), {})
  });
  session6._pendingReview = [{ name: 'edit_file', path: 'h.js', op: '修改', summary: 'old->new' }];
  const quotaErr = new Error('insufficient balance');
  quotaErr.isQuota = true;
  session6._silentCall = async () => { throw quotaErr; };
  const p6 = session6._runCodeReview();
  await p6.catch(() => {});
  check('配额错误记录到 _reviewQuotaError', () => assert.strictEqual(session6._reviewQuotaError, quotaErr));
  check('主任务被 cancel', () => assert.strictEqual(session6.cancelled, true));
  check('配额错误不 emit review', () => assert.strictEqual(reviews.length, 0));

  console.log('\n[8] _reviewSummary 基于真实文件内容（不再信模型参数）');
  const session7 = new AgentSession({
    cfg,
    messages: [{ role: 'user', content: 'q' }],
    ui,
    harness: { taskManager: fakeTM, policy: null },
    planTasks: new PlanTaskStore(tmp, {})
  });
  // 1) 假编辑：模型给 old_text==new_text，但文件 before==after → 应判定“无变化”，不再误导审查
  const fakeSummary = session7._reviewSummary(
    'edit_file',
    { path: 'a.js', old_text: 'page.$eval(', new_text: 'page.$eval(' },
    'const x = page.$eval(() => 1);',
    'const x = page.$eval(() => 1);'
  );
  check('假编辑（+0 -0）判定为无变化', () => assert.ok(/无变化/.test(fakeSummary)));
  check('假编辑不会报告 $eval→$$eval 改动', () => assert.ok(!/page\.\$\$eval/.test(fakeSummary)));

  // 2) 真实改动：before/after 不同 → 输出真实 unified diff（反映文件实际状态）
  const realSummary = session7._reviewSummary(
    'edit_file',
    { path: 'a.js', old_text: 'page.$eval(', new_text: 'page.$$eval(' },
    'const x = page.$eval(() => 1);',
    'const x = page.$$eval(() => 1);'
  );
  check('真实改动生成 diff 含 +N -N 统计', () => assert.ok(/\+\d+ -\d+/.test(realSummary)));
  check('真实 diff 反映 $$eval（基于文件真实状态）', () => assert.ok(/page\.\$\$eval/.test(realSummary)));
  check('真实 diff 不再展示模型声明的 old/new 参数段', () => assert.ok(!/- 旧：/.test(realSummary) && !/- 新：/.test(realSummary)));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n结果：通过 ${pass} / 失败 ${fail}\n`);
  process.exit(fail ? 1 : 0);
})();
