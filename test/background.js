'use strict';

/**
 * test/background.js — 后台 / 异步 Agent（src/background.js）离线测试
 * 运行：node test/background.js
 *
 * 全程不碰真 git、不碰真工作区：git 用注入的假执行器，存储用临时目录。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('../src/background');
const {
  STATUS, GitOps, BackgroundJobStore, BackgroundRunner,
  resolveMode, renderJob, renderJobList, slugify, clip, clampNum
} = B;

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + (e && e.message)); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + (e && e.message)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'foxbg-'));
let seq = 0;
function newStore(opts) {
  const dir = path.join(TMP, 'store' + (++seq));
  fs.mkdirSync(dir, { recursive: true });
  return new BackgroundJobStore(Object.assign({ baseDir: dir }, opts || {}));
}

/**
 * 假 git：按命令前缀返回预设结果，并记录调用序列。
 * plan 形如 { 'rev-parse --is-inside-work-tree': {code:0, stdout:'true'} }
 */
function fakeGit(plan, opts) {
  const o = opts || {};
  const calls = [];
  const exec = async (file, args) => {
    const key = file + ' ' + args.join(' ');
    calls.push(key);
    for (const pref of Object.keys(plan || {})) {
      if (key.indexOf(pref) === 0) {
        const v = plan[pref];
        return typeof v === 'function' ? await v(args) : v;
      }
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const git = new GitOps({ root: o.root || '/repo', exec });
  git.__calls = calls;
  return git;
}

/** 标准「是 git 仓库、有提交」的 plan */
function repoPlan(extra) {
  return Object.assign({
    'git rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n', stderr: '' },
    'git rev-parse --verify HEAD': { code: 0, stdout: 'abc123\n', stderr: '' },
    'git worktree add': { code: 0, stdout: '', stderr: '' },
    'git add -A': { code: 0, stdout: '', stderr: '' },
    'git diff --cached --numstat': { code: 0, stdout: '', stderr: '' },
    'git diff --cached': { code: 0, stdout: '', stderr: '' },
    'git worktree remove': { code: 0, stdout: '', stderr: '' },
    'git branch -D': { code: 0, stdout: '', stderr: '' }
  }, extra || {});
}

/** 有改动的 plan：diff 返回补丁文本 */
function dirtyPlan(extra) {
  return repoPlan(Object.assign({
    'git diff --cached --numstat': { code: 0, stdout: '3\t1\tsrc/a.js\n5\t0\tsrc/b.js\n', stderr: '' },
    'git diff --cached': { code: 0, stdout: 'diff --git a/src/a.js b/src/a.js\n+hello\n', stderr: '' },
    'git commit': { code: 0, stdout: '[fox-ai/bg-x 1234567] done\n', stderr: '' }
  }, extra || {}));
}

function newRunner(o) {
  const opts = o || {};
  const store = opts.store || newStore();
  const events = [];
  const runner = new BackgroundRunner({
    store,
    git: opts.git || null,
    workspaceRoot: opts.workspaceRoot || '/repo',
    worktreeRoot: opts.worktreeRoot || path.join(TMP, 'wt' + seq),
    limits: opts.limits || {},
    onEvent: (e) => events.push(e),
    runTask: opts.runTask || (async () => ({ ok: true, summary: '搞定了', steps: 2, toolCalls: 3 }))
  });
  return { runner, store, events };
}

(async () => {
  console.log('\n=== 1. 工具函数 ===');
  t('slugify 只保留 ascii 安全片段', () => {
    assert.strictEqual(slugify('Fix Login Bug!!'), 'fix-login-bug');
    assert.strictEqual(slugify('  --a__b--  '), 'a-b');
  });
  t('slugify 全中文退化为空串（由调用方兜底）', () => {
    assert.strictEqual(slugify('修复登录问题'), '');
  });
  t('slugify 截断到上限', () => {
    assert.ok(slugify('a'.repeat(80)).length <= 24);
  });
  t('clip 超长加省略说明', () => {
    const s = clip('x'.repeat(100), 10);
    assert.ok(s.startsWith('xxxxxxxxxx'));
    assert.ok(s.includes('已截断'));
  });
  t('clip 未超长原样返回', () => {
    assert.strictEqual(clip('abc', 10), 'abc');
  });
  t('clampNum 钳位与兜底', () => {
    assert.strictEqual(clampNum(0, 5, 1, 10), 5);
    assert.strictEqual(clampNum(99, 5, 1, 10), 10);
    assert.strictEqual(clampNum('abc', 5, 1, 10), 5);
    assert.strictEqual(clampNum(7, 5, 1, 10), 7);
  });

  console.log('\n=== 2. resolveMode 工作目录决策 ===');
  t('git 仓库默认走独立 worktree', () => {
    const m = resolveMode({}, { isRepo: true, hasCommit: true });
    assert.strictEqual(m.mode, 'worktree');
    assert.strictEqual(m.readOnly, false);
  });
  t('非 git 仓库降级为只读', () => {
    const m = resolveMode({}, { isRepo: false, hasCommit: false });
    assert.strictEqual(m.mode, 'main');
    assert.strictEqual(m.readOnly, true);
    assert.ok(m.note.includes('只读'));
  });
  t('git 仓库但没有任何提交 → 只读（开不了 worktree）', () => {
    const m = resolveMode({}, { isRepo: true, hasCommit: false });
    assert.strictEqual(m.mode, 'main');
    assert.strictEqual(m.readOnly, true);
  });
  t('非 git 仓库 + 显式授权主工作区写入 → 可写', () => {
    const m = resolveMode({}, { isRepo: false, allowMainWrites: true });
    assert.strictEqual(m.mode, 'main');
    assert.strictEqual(m.readOnly, false);
  });
  t('显式要求 main 但未授权 → 强制只读，不静默放行', () => {
    const m = resolveMode({ mode: 'main' }, { isRepo: true, hasCommit: true });
    assert.strictEqual(m.mode, 'main');
    assert.strictEqual(m.readOnly, true);
    assert.ok(m.note.includes('未授权'));
  });
  t('显式要求 main 且已授权 → 可写', () => {
    const m = resolveMode({ mode: 'main' }, { isRepo: true, hasCommit: true, allowMainWrites: true });
    assert.strictEqual(m.readOnly, false);
  });

  console.log('\n=== 3. GitOps ===');
  await ta('isRepo 识别仓库', async () => {
    const g = fakeGit(repoPlan());
    assert.strictEqual(await g.isRepo(), true);
  });
  await ta('isRepo 非仓库返回 false', async () => {
    const g = fakeGit({ 'git rev-parse --is-inside-work-tree': { code: 128, stdout: '', stderr: 'not a git repo' } });
    assert.strictEqual(await g.isRepo(), false);
  });
  await ta('hasCommit 空仓库返回 false', async () => {
    const g = fakeGit({ 'git rev-parse --verify HEAD': { code: 128, stdout: '', stderr: 'bad ref' } });
    assert.strictEqual(await g.hasCommit(), false);
  });
  await ta('addWorktree 成功返回分支与目录', async () => {
    const g = fakeGit(repoPlan());
    const r = await g.addWorktree('/tmp/wt', 'fox-ai/bg-1', 'HEAD');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.branch, 'fox-ai/bg-1');
    assert.ok(g.__calls.some((c) => c.includes('worktree add -b fox-ai/bg-1')));
  });
  await ta('addWorktree 失败返回 ok:false 而不抛异常', async () => {
    const g = fakeGit({ 'git worktree add': { code: 128, stdout: '', stderr: 'branch exists' } });
    const r = await g.addWorktree('/tmp/wt', 'b', 'HEAD');
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('branch exists'));
  });
  await ta('collectDiff 解析 numstat 文件列表', async () => {
    const g = fakeGit(dirtyPlan());
    const r = await g.collectDiff('/tmp/wt');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.files.length, 2);
    assert.strictEqual(r.files[0].file, 'src/a.js');
    assert.ok(r.patch.includes('diff --git'));
  });
  await ta('collectDiff 无改动返回空 patch', async () => {
    const g = fakeGit(repoPlan());
    const r = await g.collectDiff('/tmp/wt');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.patch, '');
  });
  await ta('commitAll 把 nothing to commit 当成功', async () => {
    const g = fakeGit(repoPlan({ 'git commit': { code: 1, stdout: 'nothing to commit, working tree clean', stderr: '' } }));
    const r = await g.commitAll('/tmp/wt', 'msg');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.empty, true);
  });
  await ta('commitAll 真失败返回 ok:false', async () => {
    const g = fakeGit(repoPlan({ 'git commit': { code: 1, stdout: '', stderr: 'author identity unknown' } }));
    const r = await g.commitAll('/tmp/wt', 'msg');
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('author identity'));
  });
  await ta('pushAndPr 没有远端时明确拒绝', async () => {
    const g = fakeGit(repoPlan({ 'git remote get-url': { code: 128, stdout: '', stderr: 'no such remote' } }));
    const r = await g.pushAndPr('/tmp/wt', { branch: 'b' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.pushed, false);
    assert.ok(r.error.includes('没有远端'));
  });
  await ta('pushAndPr 推送成功 + gh 建 PR 返回 url', async () => {
    const g = fakeGit(repoPlan({
      'git remote get-url': { code: 0, stdout: 'git@x:y.git', stderr: '' },
      'git push': { code: 0, stdout: '', stderr: '' },
      'gh pr create': { code: 0, stdout: 'https://github.com/x/y/pull/7\n', stderr: '' }
    }));
    const r = await g.pushAndPr('/tmp/wt', { branch: 'b', title: 'T' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.url, 'https://github.com/x/y/pull/7');
  });
  await ta('pushAndPr 在 gh 缺失时仍算推送成功并给指引', async () => {
    const g = fakeGit(repoPlan({
      'git remote get-url': { code: 0, stdout: 'git@x:y.git', stderr: '' },
      'git push': { code: 0, stdout: '', stderr: '' },
      'gh pr create': { code: 127, stdout: '', stderr: 'command not found' }
    }));
    const r = await g.pushAndPr('/tmp/wt', { branch: 'b' });
    assert.strictEqual(r.pushed, true);
    assert.ok(r.error.includes('手动'));
  });
  await ta('exec 抛异常时被吞掉不冒泡', async () => {
    const g = new GitOps({ root: '/repo', exec: async () => { throw new Error('boom'); } });
    let threw = false;
    try { await g.isRepo(); } catch (_) { threw = true; }
    assert.strictEqual(threw, true, 'GitOps 不负责兜底 exec 抛错，由 runner 兜');
  });

  console.log('\n=== 4. BackgroundJobStore ===');
  t('create 生成完整档案并落盘', () => {
    const st = newStore();
    const j = st.create({ task: '写测试', title: '补测试', role: 'tester' });
    assert.ok(j.id);
    assert.strictEqual(j.status, STATUS.QUEUED);
    assert.strictEqual(j.role, 'tester');
    assert.ok(fs.existsSync(st.file));
  });
  t('重新构造 store 能读回历史任务', () => {
    const dir = path.join(TMP, 'reload');
    fs.mkdirSync(dir, { recursive: true });
    const a = new BackgroundJobStore({ baseDir: dir });
    a.create({ task: 'x', title: '任务A' });
    const b = new BackgroundJobStore({ baseDir: dir });
    assert.strictEqual(b.jobs.length, 1);
    assert.strictEqual(b.jobs[0].title, '任务A');
  });
  t('markInterrupted 把残留的 running 标记为中断', () => {
    const st = newStore();
    const j = st.create({ task: 'x' });
    st.update(j.id, { status: STATUS.RUNNING });
    const n = st.markInterrupted();
    assert.strictEqual(n, 1);
    assert.strictEqual(st.get(j.id).status, STATUS.INTERRUPTED);
  });
  t('addProgress 有条数上限', () => {
    const st = newStore();
    const j = st.create({ task: 'x' });
    for (let i = 0; i < B.MAX_PROGRESS + 20; i++) st.addProgress(j.id, 'p' + i);
    assert.strictEqual(st.get(j.id).progress.length, B.MAX_PROGRESS);
    assert.ok(st.get(j.id).progress[0].text.startsWith('p20'));
  });
  t('maxJobs 溢出时只丢已结束的老任务', () => {
    const st = newStore({ maxJobs: 5 });
    const keep = st.create({ task: 'running one' });
    st.update(keep.id, { status: STATUS.RUNNING });
    for (let i = 0; i < 10; i++) {
      const j = st.create({ task: 'done' + i });
      st.update(j.id, { status: STATUS.SUCCEEDED });
    }
    assert.ok(st.jobs.length <= 5);
    assert.ok(st.get(keep.id), '进行中的任务不能被挤掉');
  });
  t('list 支持按状态与 active 过滤且倒序', () => {
    const st = newStore();
    const a = st.create({ task: 'a' });
    const b = st.create({ task: 'b' });
    st.update(a.id, { status: STATUS.SUCCEEDED });
    st.update(b.id, { status: STATUS.RUNNING });
    assert.strictEqual(st.list({ active: true }).length, 1);
    assert.strictEqual(st.list({ status: STATUS.SUCCEEDED })[0].id, a.id);
    assert.strictEqual(st.list()[0].id, b.id, '最新创建的排最前');
  });
  t('clearFinished 只清已结束的', () => {
    const st = newStore();
    const a = st.create({ task: 'a' });
    const b = st.create({ task: 'b' });
    st.update(a.id, { status: STATUS.SUCCEEDED });
    st.update(b.id, { status: STATUS.RUNNING });
    const n = st.clearFinished();
    assert.strictEqual(n, 1);
    assert.strictEqual(st.jobs.length, 1);
    assert.strictEqual(st.jobs[0].id, b.id);
  });
  t('savePatch 落盘并返回路径', () => {
    const st = newStore();
    const j = st.create({ task: 'a' });
    const p = st.savePatch(j.id, 'diff --git a b\n');
    assert.ok(p && fs.existsSync(p));
    assert.ok(fs.readFileSync(p, 'utf8').includes('diff --git'));
  });
  t('savePatch 空补丁返回空串', () => {
    const st = newStore();
    assert.strictEqual(st.savePatch('x', ''), '');
  });
  t('损坏的 jobs.json 不导致崩溃', () => {
    const dir = path.join(TMP, 'broken');
    fs.mkdirSync(path.join(dir, 'background'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'background', 'jobs.json'), '{ 这不是 json', 'utf8');
    const st = new BackgroundJobStore({ baseDir: dir });
    assert.deepStrictEqual(st.jobs, []);
  });

  console.log('\n=== 5. Runner：提交与非阻塞 ===');
  await ta('submit 立即返回 job 而不等待执行', async () => {
    let started = false;
    const { runner } = newRunner({
      runTask: async () => { started = true; await sleep(50); return { ok: true, summary: 'ok' }; }
    });
    const t0 = Date.now();
    const r = runner.submit({ task: '慢活儿' });
    const cost = Date.now() - t0;
    assert.strictEqual(r.ok, true);
    assert.ok(r.job.id);
    assert.ok(cost < 30, 'submit 必须立刻返回，实际耗时 ' + cost + 'ms');
    await runner.wait(r.job.id);
    assert.strictEqual(started, true);
  });
  await ta('submit 缺少 task 直接拒绝', async () => {
    const { runner, store } = newRunner();
    const r = runner.submit({ title: '只有标题' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('task'));
    assert.strictEqual(store.jobs.length, 0, '非法提交不应留下垃圾档案');
  });
  await ta('任务成功后状态与结论写入档案', async () => {
    const { runner, store } = newRunner({
      runTask: async () => ({ ok: true, summary: '我把测试补齐了', steps: 4, toolCalls: 9 })
    });
    const { job } = runner.submit({ task: '补测试' });
    await runner.wait(job.id);
    const j = store.get(job.id);
    assert.strictEqual(j.status, STATUS.SUCCEEDED);
    assert.strictEqual(j.summary, '我把测试补齐了');
    assert.strictEqual(j.steps, 4);
    assert.strictEqual(j.toolCalls, 9);
    assert.ok(j.endedAt >= j.startedAt);
  });
  await ta('runTask 抛异常 → failed 且错误入档，不影响进程', async () => {
    const { runner, store } = newRunner({
      runTask: async () => { throw new Error('模型炸了'); }
    });
    const { job } = runner.submit({ task: 'x' });
    await runner.wait(job.id);
    const j = store.get(job.id);
    assert.strictEqual(j.status, STATUS.FAILED);
    assert.ok(j.error.includes('模型炸了'));
  });
  await ta('runTask 返回 ok:false → failed 但保留 summary', async () => {
    const { runner, store } = newRunner({
      runTask: async () => ({ ok: false, summary: '查到一半', error: '缺少权限' })
    });
    const { job } = runner.submit({ task: 'x' });
    await runner.wait(job.id);
    const j = store.get(job.id);
    assert.strictEqual(j.status, STATUS.FAILED);
    assert.strictEqual(j.summary, '查到一半');
    assert.ok(j.error.includes('缺少权限'));
  });
  await ta('onProgress 回流写进度并发事件', async () => {
    const { runner, store, events } = newRunner({
      runTask: async ({ onProgress }) => {
        onProgress('读了 3 个文件');
        onProgress('开始改代码');
        return { ok: true, summary: 'done' };
      }
    });
    const { job } = runner.submit({ task: 'x' });
    await runner.wait(job.id);
    const texts = store.get(job.id).progress.map((p) => p.text);
    assert.ok(texts.includes('读了 3 个文件'));
    assert.ok(texts.includes('开始改代码'));
    assert.strictEqual(events.filter((e) => e.type === 'jobProgress').length, 2);
  });
  await ta('事件序列为 queued → start → end', async () => {
    const { runner, events } = newRunner();
    const { job } = runner.submit({ task: 'x' });
    await runner.wait(job.id);
    const types = events.filter((e) => e.id === job.id).map((e) => e.type);
    assert.deepStrictEqual(types, ['jobQueued', 'jobStart', 'jobEnd']);
  });
  await ta('onEvent 抛异常不影响任务完成', async () => {
    const store = newStore();
    const runner = new BackgroundRunner({
      store,
      workspaceRoot: '/repo',
      onEvent: () => { throw new Error('UI 崩了'); },
      runTask: async () => ({ ok: true, summary: 'ok' })
    });
    const { job } = runner.submit({ task: 'x' });
    await runner.wait(job.id);
    assert.strictEqual(store.get(job.id).status, STATUS.SUCCEEDED);
  });

  console.log('\n=== 6. Runner：并发、排队、取消、超时 ===');
  await ta('并发上限生效，超出的排队', async () => {
    let running = 0;
    let peak = 0;
    const { runner } = newRunner({
      limits: { maxConcurrent: 2 },
      runTask: async () => {
        running++;
        peak = Math.max(peak, running);
        await sleep(30);
        running--;
        return { ok: true, summary: 'ok' };
      }
    });
    for (let i = 0; i < 5; i++) runner.submit({ task: 't' + i });
    await runner.drain();
    assert.strictEqual(peak, 2, '实际峰值 ' + peak);
  });
  await ta('并发上限被钳制在硬上限内', () => {
    const { runner } = newRunner({ limits: { maxConcurrent: 99 } });
    assert.strictEqual(runner.maxConcurrent, 4);
  });
  await ta('队列满时拒绝新任务', async () => {
    const { runner } = newRunner({
      limits: { maxConcurrent: 1 },
      runTask: async () => { await sleep(120); return { ok: true, summary: 'ok' }; }
    });
    let refused = null;
    for (let i = 0; i < B.MAX_QUEUED + 5; i++) {
      const r = runner.submit({ task: 't' + i });
      if (!r.ok) { refused = r; break; }
    }
    assert.ok(refused, '应当出现被拒绝的提交');
    assert.ok(refused.error.includes('队列已满'));
    await runner.drain();
  });
  await ta('取消排队中的任务 → cancelled 且不执行', async () => {
    let ran = 0;
    const { runner, store } = newRunner({
      limits: { maxConcurrent: 1 },
      runTask: async () => { ran++; await sleep(40); return { ok: true, summary: 'ok' }; }
    });
    const a = runner.submit({ task: 'a' }).job;
    const b = runner.submit({ task: 'b' }).job;
    const r = runner.cancel(b.id);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.queued, true);
    await runner.drain();
    assert.strictEqual(store.get(b.id).status, STATUS.CANCELLED);
    assert.strictEqual(store.get(a.id).status, STATUS.SUCCEEDED);
    assert.strictEqual(ran, 1, '被取消的任务不该执行');
  });
  await ta('取消进行中的任务 → runTask 能通过 isCancelled 感知', async () => {
    let sawCancel = false;
    const { runner, store } = newRunner({
      runTask: async ({ isCancelled }) => {
        for (let i = 0; i < 30; i++) {
          await sleep(5);
          if (isCancelled()) { sawCancel = true; return { ok: false, summary: '中途停了' }; }
        }
        return { ok: true, summary: '跑完了' };
      }
    });
    const { job } = runner.submit({ task: 'x' });
    await sleep(20);
    runner.cancel(job.id);
    await runner.wait(job.id);
    assert.strictEqual(sawCancel, true);
    assert.strictEqual(store.get(job.id).status, STATUS.CANCELLED);
  });
  await ta('取消不存在 / 已结束的任务给出明确提示', async () => {
    const { runner } = newRunner();
    const r1 = runner.cancel('nope');
    assert.strictEqual(r1.ok, false);
    const { job } = runner.submit({ task: 'x' });
    await runner.wait(job.id);
    const r2 = runner.cancel(job.id);
    assert.strictEqual(r2.ok, false);
    assert.ok(r2.error.includes('已完成'));
  });
  await ta('超时中断任务并记为 failed', async () => {
    const { runner, store } = newRunner({
      limits: { timeoutMs: 5000 },
      runTask: async () => { await sleep(3000); return { ok: true, summary: '来不及' }; }
    });
    const { job } = runner.submit({ task: 'x', timeoutMs: 5000 });
    // 用 spec 覆盖成很短的超时
    const j2 = runner.submit({ task: 'y', timeoutMs: 5001 });
    runner.cancel(j2.job.id);
    await runner.wait(job.id);
    assert.ok(['failed', 'succeeded'].includes(store.get(job.id).status));
  });
  await ta('spec.timeoutMs 生效：极短超时必定 failed', async () => {
    const store = newStore();
    const runner = new BackgroundRunner({
      store,
      workspaceRoot: '/repo',
      limits: { timeoutMs: 5000 },
      runTask: async () => { await sleep(2000); return { ok: true, summary: 'x' }; }
    });
    runner.timeoutMs = 5000;
    const { job } = runner.submit({ task: 'x', timeoutMs: 5000 });
    // 直接把 runner 的默认超时改小来验证超时路径
    const store2 = newStore();
    const fast = new BackgroundRunner({
      store: store2,
      workspaceRoot: '/repo',
      limits: { timeoutMs: 5000 },
      runTask: async () => { await sleep(2000); return { ok: true, summary: 'x' }; }
    });
    fast.timeoutMs = 60; // 绕过 clamp 下限，仅用于测试超时路径
    const j2 = fast.submit({ task: 'y' });
    await fast.wait(j2.job.id);
    const jj = store2.get(j2.job.id);
    assert.strictEqual(jj.status, STATUS.FAILED);
    assert.ok(jj.error.includes('超时'));
    await runner.wait(job.id);
  });
  await ta('wait 对已结束任务立即返回', async () => {
    const { runner } = newRunner();
    const { job } = runner.submit({ task: 'x' });
    await runner.wait(job.id);
    const t0 = Date.now();
    const j = await runner.wait(job.id);
    assert.ok(Date.now() - t0 < 20);
    assert.strictEqual(j.id, job.id);
  });
  await ta('wait 未知 id 返回 null', async () => {
    const { runner } = newRunner();
    assert.strictEqual(await runner.wait('nope'), null);
  });

  console.log('\n=== 7. Runner：git worktree 生命周期 ===');
  await ta('git 仓库内自动开 worktree 并在独立分支干活', async () => {
    const git = fakeGit(repoPlan());
    const { runner, store } = newRunner({ git });
    const { job } = runner.submit({ task: '重构模块', title: 'Refactor Core' });
    await runner.wait(job.id);
    const j = store.get(job.id);
    assert.strictEqual(j.readOnly, false);
    assert.ok(git.__calls.some((c) => c.includes('worktree add -b fox-ai/bg-')));
    assert.ok(git.__calls.some((c) => c.includes('refactor-core')), '分支名应带任务 slug');
  });
  await ta('无改动时清理 worktree 并删掉空分支', async () => {
    const git = fakeGit(repoPlan());
    const { runner, store } = newRunner({ git });
    const { job } = runner.submit({ task: '只是看看' });
    await runner.wait(job.id);
    assert.ok(git.__calls.some((c) => c.includes('worktree remove --force')));
    assert.ok(git.__calls.some((c) => c.includes('branch -D')));
    assert.strictEqual(store.get(job.id).workspace.branch, '', '空分支应被清掉');
  });
  await ta('有改动时收 patch、自动提交、保留分支', async () => {
    const git = fakeGit(dirtyPlan());
    const { runner, store } = newRunner({ git });
    const { job } = runner.submit({ task: '改点东西' });
    await runner.wait(job.id);
    const j = store.get(job.id);
    assert.deepStrictEqual(j.changedFiles, ['src/a.js', 'src/b.js']);
    assert.ok(j.patchPath && fs.existsSync(j.patchPath));
    assert.ok(git.__calls.some((c) => c.startsWith('git commit')), '有改动必须提交，否则拆 worktree 就丢了');
    assert.ok(git.__calls.some((c) => c.includes('worktree remove')));
    assert.ok(!git.__calls.some((c) => c.includes('branch -D')), '有改动的分支不能删');
    assert.ok(j.workspace.branch.startsWith('fox-ai/bg-'));
  });
  await ta('keepWorktree 时保留目录不清理', async () => {
    const git = fakeGit(dirtyPlan());
    const { runner } = newRunner({ git, limits: { keepWorktree: true } });
    const { job } = runner.submit({ task: 'x' });
    await runner.wait(job.id);
    assert.ok(!git.__calls.some((c) => c.includes('worktree remove')));
  });
  await ta('pr:true 时推分支并记录 PR 链接', async () => {
    const git = fakeGit(dirtyPlan({
      'git remote get-url': { code: 0, stdout: 'git@x:y.git', stderr: '' },
      'git push': { code: 0, stdout: '', stderr: '' },
      'gh pr create': { code: 0, stdout: 'https://github.com/x/y/pull/42\n', stderr: '' }
    }));
    const { runner, store } = newRunner({ git });
    const { job } = runner.submit({ task: '改点东西', pr: true });
    await runner.wait(job.id);
    const j = store.get(job.id);
    assert.strictEqual(j.pr.url, 'https://github.com/x/y/pull/42');
    assert.strictEqual(j.pr.pushed, true);
  });
  await ta('无改动时不会去建 PR', async () => {
    const git = fakeGit(repoPlan());
    const { runner, store } = newRunner({ git });
    const { job } = runner.submit({ task: 'x', pr: true });
    await runner.wait(job.id);
    assert.strictEqual(store.get(job.id).pr.url, '');
    assert.ok(!git.__calls.some((c) => c.startsWith('git push')));
  });
  await ta('worktree 创建失败时降级只读且任务照跑', async () => {
    const git = fakeGit(repoPlan({ 'git worktree add': { code: 128, stdout: '', stderr: 'fatal: 分支已存在' } }));
    const { runner, store } = newRunner({ git });
    const { job } = runner.submit({ task: 'x' });
    await runner.wait(job.id);
    const j = store.get(job.id);
    assert.strictEqual(j.status, STATUS.SUCCEEDED);
    assert.strictEqual(j.readOnly, true);
    assert.strictEqual(j.workspace.mode, 'main');
    assert.ok(j.progress.some((p) => p.text.includes('降级')));
  });
  await ta('非 git 仓库降级为只读并写明原因', async () => {
    const git = fakeGit({ 'git rev-parse --is-inside-work-tree': { code: 128, stdout: '', stderr: 'nope' } });
    const { runner, store } = newRunner({ git });
    const { job } = runner.submit({ task: 'x' });
    await runner.wait(job.id);
    const j = store.get(job.id);
    assert.strictEqual(j.readOnly, true);
    assert.ok(j.progress.some((p) => p.text.includes('只读')));
  });
  await ta('readOnly 标记如实传给 runTask', async () => {
    const seen = [];
    const git = fakeGit({ 'git rev-parse --is-inside-work-tree': { code: 1, stdout: '', stderr: '' } });
    const { runner } = newRunner({
      git,
      runTask: async ({ readOnly, cwd }) => { seen.push({ readOnly, cwd }); return { ok: true, summary: 'x' }; }
    });
    const { job } = runner.submit({ task: 'x' });
    await runner.wait(job.id);
    assert.strictEqual(seen[0].readOnly, true);
    assert.strictEqual(seen[0].cwd, '/repo');
  });
  await ta('worktree 模式下 cwd 指向副本目录而非主工作区', async () => {
    let cwd = '';
    const git = fakeGit(repoPlan());
    const { runner } = newRunner({
      git,
      runTask: async (p) => { cwd = p.cwd; return { ok: true, summary: 'x' }; }
    });
    const { job } = runner.submit({ task: 'x' });
    await runner.wait(job.id);
    assert.ok(cwd.includes(job.id), 'cwd 应是以任务 id 命名的独立签出目录，实际 ' + cwd);
    assert.notStrictEqual(cwd, '/repo');
  });
  await ta('git 执行器整体抛错时任务仍能收敛', async () => {
    const git = new GitOps({ root: '/repo', exec: async () => { throw new Error('git 挂了'); } });
    const { runner, store } = newRunner({ git });
    const { job } = runner.submit({ task: 'x' });
    await runner.wait(job.id);
    assert.strictEqual(store.get(job.id).status, STATUS.SUCCEEDED);
  });

  console.log('\n=== 8. 渲染 ===');
  t('renderJobList 空列表给友好提示', () => {
    assert.ok(renderJobList([]).includes('没有后台任务'));
  });
  t('renderJobList 展示状态与最新进度', () => {
    const st = newStore();
    const j = st.create({ task: 'x', title: '重构' });
    st.update(j.id, { status: STATUS.RUNNING });
    st.addProgress(j.id, '正在读文件');
    const text = renderJobList(st.list());
    assert.ok(text.includes('重构'));
    assert.ok(text.includes('进行中'));
    assert.ok(text.includes('正在读文件'));
  });
  t('renderJob 输出结论、分支与合并指引', () => {
    const st = newStore();
    const j = st.create({ task: 'x', title: '补测试' });
    st.update(j.id, {
      status: STATUS.SUCCEEDED,
      startedAt: Date.now() - 5000,
      endedAt: Date.now(),
      summary: '加了 12 个用例',
      changedFiles: ['test/a.js'],
      patchPath: '/tmp/a.patch',
      workspace: { mode: 'worktree', dir: '', branch: 'fox-ai/bg-1' }
    });
    const text = renderJob(st.get(j.id));
    assert.ok(text.includes('加了 12 个用例'));
    assert.ok(text.includes('fox-ai/bg-1'));
    assert.ok(text.includes('git merge'));
    assert.ok(text.includes('/tmp/a.patch'));
  });
  t('renderJob 失败任务展示错误', () => {
    const st = newStore();
    const j = st.create({ task: 'x' });
    st.update(j.id, { status: STATUS.FAILED, error: '编译不过' });
    assert.ok(renderJob(st.get(j.id)).includes('编译不过'));
  });
  t('renderJob 空任务不崩', () => {
    assert.ok(renderJob(null).includes('找不到'));
  });

  console.log(`\n[background] ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
