'use strict';

/**
 * src/background.js — 后台 / 异步 Agent（零外部依赖，不 require vscode，可离线单测）
 *
 * 解决的问题：主代理是「一问一答、全程占用对话」的同步模型。遇到「顺手帮我把测试补全」
 * 「后台重构一下这个模块」这类耗时活儿，用户只能干等，期间没法继续聊别的。
 *
 * 本模块提供 fire-and-forget 的后台任务：
 *   1) submit(spec)  —— 立即返回 job 记录，任务在后台跑，主对话不阻塞
 *   2) 进度回流       —— 后台任务的每一步通过 onEvent / job.progress 回流，随时可查
 *   3) 结果落盘       —— job 状态持久化到磁盘，VS Code 重启后仍能看到历史结果
 *   4) 可产 PR        —— git 仓库内默认在独立 worktree + 独立分支里干活，
 *                        完成后产出 .patch 文件，可选自动 commit / 建 PR（gh 可用时）
 *
 * 隔离语义（关键）：后台任务默认**不在用户的主工作区里写文件**。
 * 因为用户此刻正在编辑器里干活，后台 agent 同时改同一批文件必然打架。
 * 因此 git 仓库内一律用 `git worktree` 开一份独立签出，写操作全落在那份副本里，
 * 用户随时可以 review patch 再决定合不合。非 git 仓库则降级为**只读**后台任务。
 *
 * 依赖注入：runTask / git.exec / onEvent 全部由调用方（agent.js）注入，
 * 本模块只管排队、状态机、持久化与 git 编排，测试里塞假函数即可完整覆盖。
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { appendLog } = require('./log');

// ---- 护栏常量 ----
const DEFAULT_MAX_CONCURRENT = 2;     // 同时在跑的后台任务数
const HARD_MAX_CONCURRENT = 4;
const DEFAULT_TIMEOUT = 900000;       // 单个后台任务墙钟超时（15 分钟）
const HARD_TIMEOUT = 3600000;
const MAX_QUEUED = 12;                // 排队上限，防止模型无脑刷任务
const MAX_JOBS = 60;                  // 磁盘上保留的历史任务数
const MAX_PROGRESS = 60;              // 单任务保留的进度条目数
const MAX_SUMMARY = 4000;             // 结论上限（字）
const GIT_TIMEOUT = 60000;            // 单条 git 命令超时

const STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted' // 上次 VS Code 关闭时还在跑，进程没了
};

const DONE_STATUSES = new Set([STATUS.SUCCEEDED, STATUS.FAILED, STATUS.CANCELLED, STATUS.INTERRUPTED]);

const STATUS_LABEL = {
  queued: '排队中',
  running: '进行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '被中断'
};

const STATUS_ICON = {
  queued: '⏳',
  running: '🔄',
  succeeded: '✅',
  failed: '❌',
  cancelled: '🚫',
  interrupted: '⚠️'
};

function nowId() {
  return 'bg' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function clip(text, max) {
  const s = typeof text === 'string' ? text : String(text == null ? '' : text);
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…（已截断，原文 ${s.length} 字）`;
}

/** 把任务标题转成安全的 git 分支片段：只留字母数字与连字符 */
function slugify(text, max) {
  const limit = max || 24;
  const s = String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // 中文没法进分支名（部分工具链不友好），全中文时退化成空串由调用方兜底
  const ascii = s.replace(/[^a-z0-9-]+/g, '');
  return ascii.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, limit);
}

function safeMkdir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (_) {
    return false;
  }
}

function clampNum(v, def, min, max) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** 默认的命令执行器：不抛异常，永远返回 {code, stdout, stderr} */
function defaultExec(file, args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let done = false;
    const finish = (code, stdout, stderr) => {
      if (done) return;
      done = true;
      resolve({ code, stdout: stdout || '', stderr: stderr || '' });
    };
    let child;
    try {
      child = execFile(
        file,
        args,
        { cwd: o.cwd || process.cwd(), timeout: o.timeout || GIT_TIMEOUT, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) finish(typeof err.code === 'number' ? err.code : 1, stdout, stderr || (err && err.message));
          else finish(0, stdout, stderr);
        }
      );
    } catch (e) {
      finish(127, '', (e && e.message) || String(e));
      return;
    }
    if (child && child.on) child.on('error', (e) => finish(127, '', (e && e.message) || String(e)));
  });
}

/**
 * Git 编排：开 worktree、收 patch、提交、建 PR。
 * 所有方法都「失败不抛」，返回 {ok, ...}，因为后台任务不能因为 git 抽风就崩掉。
 */
class GitOps {
  /**
   * @param {object} opts
   * @param {string} opts.root 仓库根目录
   * @param {function} [opts.exec] 注入的执行器 (file, args, {cwd}) => Promise<{code,stdout,stderr}>
   */
  constructor(opts) {
    const o = opts || {};
    this.root = o.root || '';
    this.exec = o.exec || defaultExec;
  }

  _git(args, cwd) {
    return this.exec('git', args, { cwd: cwd || this.root, timeout: GIT_TIMEOUT });
  }

  /** 当前目录是否在 git 仓库里 */
  async isRepo() {
    if (!this.root) return false;
    const r = await this._git(['rev-parse', '--is-inside-work-tree']);
    return r.code === 0 && /true/.test(r.stdout || '');
  }

  /** 仓库里是否至少有一次提交（全新 init 的仓库没有 HEAD，开不了 worktree） */
  async hasCommit() {
    const r = await this._git(['rev-parse', '--verify', 'HEAD']);
    return r.code === 0;
  }

  /** 新建一份独立签出 + 独立分支 */
  async addWorktree(dir, branch, base) {
    const args = ['worktree', 'add', '-b', branch, dir, base || 'HEAD'];
    const r = await this._git(args);
    if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || '').trim() };
    return { ok: true, dir, branch };
  }

  /** 拆掉 worktree（force：里面有未提交改动也拆，patch 已经单独存盘了） */
  async removeWorktree(dir) {
    const r = await this._git(['worktree', 'remove', '--force', dir]);
    if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || '').trim() };
    return { ok: true };
  }

  /** 删掉后台分支（未合并也删，patch 已留档） */
  async deleteBranch(branch) {
    const r = await this._git(['branch', '-D', branch]);
    return { ok: r.code === 0, error: r.code === 0 ? '' : (r.stderr || '').trim() };
  }

  /**
   * 收集 worktree 内的全部改动为 patch 文本。
   * 先 `add -A`（只影响该 worktree 自己的 index，不碰主工作区），再取 staged diff，
   * 这样新增文件也能被 diff 出来。
   */
  async collectDiff(dir) {
    const add = await this._git(['add', '-A'], dir);
    if (add.code !== 0) return { ok: false, patch: '', error: (add.stderr || '').trim() };
    const st = await this._git(['diff', '--cached', '--numstat'], dir);
    const diff = await this._git(['diff', '--cached'], dir);
    if (diff.code !== 0) return { ok: false, patch: '', error: (diff.stderr || '').trim() };
    const files = String(st.stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const m = l.split('\t');
        return { added: m[0], removed: m[1], file: m[2] || '' };
      })
      .filter((f) => f.file);
    return { ok: true, patch: diff.stdout || '', files };
  }

  /** 在 worktree 里提交（后台分支上，主分支不受影响） */
  async commitAll(dir, message) {
    const add = await this._git(['add', '-A'], dir);
    if (add.code !== 0) return { ok: false, error: (add.stderr || '').trim() };
    const r = await this._git(['commit', '-m', message || 'fox-ai: 后台任务改动'], dir);
    if (r.code !== 0) {
      const text = (r.stdout || '') + (r.stderr || '');
      if (/nothing to commit/i.test(text)) return { ok: true, empty: true };
      return { ok: false, error: text.trim() };
    }
    return { ok: true, empty: false };
  }

  /** 推分支并尝试用 gh 建 PR；gh 不可用时只推分支并给出手动建 PR 的指引 */
  async pushAndPr(dir, opts) {
    const o = opts || {};
    const branch = o.branch;
    if (!branch) return { ok: false, error: '缺少分支名' };
    const remote = o.remote || 'origin';
    const hasRemote = await this._git(['remote', 'get-url', remote], dir);
    if (hasRemote.code !== 0) {
      return { ok: false, pushed: false, error: `没有远端 ${remote}，无法建 PR（改动已存为本地分支 ${branch}）` };
    }
    const push = await this._git(['push', '-u', remote, branch], dir);
    if (push.code !== 0) {
      return { ok: false, pushed: false, error: '推送失败：' + (push.stderr || '').trim() };
    }
    const pr = await this.exec(
      'gh',
      ['pr', 'create', '--head', branch, '--title', o.title || ('fox-ai: ' + branch), '--body', o.body || '由狐狸 AI 后台任务生成。'],
      { cwd: dir, timeout: GIT_TIMEOUT }
    );
    if (pr.code !== 0) {
      return {
        ok: true,
        pushed: true,
        url: '',
        error: 'gh 建 PR 未成功（可能未安装或未登录），分支已推送，请在仓库网页手动发起 PR。'
      };
    }
    const url = String(pr.stdout || '').trim().split('\n').filter((l) => /^https?:\/\//.test(l.trim())).pop() || '';
    return { ok: true, pushed: true, url };
  }
}

/**
 * 后台任务档案：状态、进度、结果全部落盘。
 * 落盘的意义在于：用户关掉 VS Code 再打开，还能看到「昨晚那个后台重构跑出啥了」。
 */
class BackgroundJobStore {
  /**
   * @param {object} opts
   * @param {string} opts.baseDir 存档根目录（一般是扩展 globalStorage）
   * @param {number} [opts.maxJobs] 最多保留多少条历史
   */
  constructor(opts) {
    const o = opts || {};
    this.dir = path.join(o.baseDir || process.cwd(), 'background');
    this.patchDir = path.join(this.dir, 'patches');
    this.file = path.join(this.dir, 'jobs.json');
    this.maxJobs = clampNum(o.maxJobs, MAX_JOBS, 5, 500);
    this.jobs = this._load();
    // 单调序号：同一毫秒内连续创建的任务靠它稳定排序（时间戳会撞）
    this._seq = this.jobs.reduce((m, j) => Math.max(m, Number(j.seq) || 0), 0);
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (Array.isArray(data.jobs)) return data.jobs;
      }
    } catch (e) {
      appendLog('background', '[load-fail] ' + (e && e.message));
    }
    return [];
  }

  _persist() {
    if (!safeMkdir(this.dir)) return false;
    try {
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, jobs: this.jobs }, null, 2), 'utf8');
      return true;
    } catch (e) {
      appendLog('background', '[persist-fail] ' + (e && e.message));
      return false;
    }
  }

  /** 上次进程被杀时还在跑/排队的任务，标记成「被中断」，避免永远显示进行中 */
  markInterrupted() {
    let n = 0;
    for (const j of this.jobs) {
      if (j.status === STATUS.RUNNING || j.status === STATUS.QUEUED) {
        j.status = STATUS.INTERRUPTED;
        j.endedAt = j.endedAt || Date.now();
        j.error = j.error || 'VS Code 关闭导致任务中断';
        n++;
      }
    }
    if (n) this._persist();
    return n;
  }

  create(spec) {
    const s = spec || {};
    const job = {
      id: nowId(),
      seq: ++this._seq,
      title: clip(s.title || s.task || '后台任务', 80),
      task: String(s.task || ''),
      role: s.role || 'generalist',
      status: STATUS.QUEUED,
      createdAt: Date.now(),
      startedAt: 0,
      endedAt: 0,
      sessionId: s.sessionId || '',
      readOnly: !!s.readOnly,
      workspace: { mode: s.mode || 'main', dir: '', branch: '' },
      progress: [],
      steps: 0,
      toolCalls: 0,
      summary: '',
      error: '',
      patchPath: '',
      changedFiles: [],
      pr: { url: '', pushed: false, note: '' }
    };
    this.jobs.push(job);
    if (this.jobs.length > this.maxJobs) {
      // 优先丢已结束的老任务，进行中的一律保留
      const removable = this.jobs.filter((j) => DONE_STATUSES.has(j.status));
      const overflow = this.jobs.length - this.maxJobs;
      const drop = new Set(removable.slice(0, overflow).map((j) => j.id));
      if (drop.size) this.jobs = this.jobs.filter((j) => !drop.has(j.id));
    }
    this._persist();
    return job;
  }

  get(id) {
    if (!id) return null;
    return this.jobs.find((j) => j.id === id) || null;
  }

  update(id, patch) {
    const job = this.get(id);
    if (!job) return null;
    Object.assign(job, patch || {});
    this._persist();
    return job;
  }

  addProgress(id, text) {
    const job = this.get(id);
    if (!job) return null;
    job.progress.push({ t: Date.now(), text: clip(String(text || ''), 300) });
    if (job.progress.length > MAX_PROGRESS) job.progress = job.progress.slice(-MAX_PROGRESS);
    this._persist();
    return job;
  }

  list(filter) {
    const f = filter || {};
    let out = this.jobs.slice();
    if (f.status) {
      const want = new Set(Array.isArray(f.status) ? f.status : [f.status]);
      out = out.filter((j) => want.has(j.status));
    }
    if (f.active) out = out.filter((j) => j.status === STATUS.RUNNING || j.status === STATUS.QUEUED);
    out.sort((a, b) => (b.createdAt - a.createdAt) || ((Number(b.seq) || 0) - (Number(a.seq) || 0)));
    if (f.limit > 0) out = out.slice(0, f.limit);
    return out;
  }

  remove(id) {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    if (this.jobs.length !== before) {
      this._persist();
      return true;
    }
    return false;
  }

  /** 清掉所有已结束的任务记录（进行中的保留） */
  clearFinished() {
    const before = this.jobs.length;
    const dropped = this.jobs.filter((j) => DONE_STATUSES.has(j.status));
    this.jobs = this.jobs.filter((j) => !DONE_STATUSES.has(j.status));
    for (const j of dropped) {
      if (j.patchPath) { try { fs.unlinkSync(j.patchPath); } catch (_) {} }
    }
    if (this.jobs.length !== before) this._persist();
    return before - this.jobs.length;
  }

  /** patch 落盘，返回文件绝对路径 */
  savePatch(id, patch) {
    if (!patch) return '';
    if (!safeMkdir(this.patchDir)) return '';
    const file = path.join(this.patchDir, id + '.patch');
    try {
      fs.writeFileSync(file, patch, 'utf8');
      return file;
    } catch (e) {
      appendLog('background', '[patch-fail] ' + (e && e.message));
      return '';
    }
  }
}

/**
 * 决定后台任务在哪儿干活。
 * 核心原则：**绝不和用户抢主工作区的文件**。
 */
function resolveMode(spec, env) {
  const s = spec || {};
  const e = env || {};
  const isRepo = !!e.isRepo && !!e.hasCommit;
  const allowMain = !!e.allowMainWrites;
  const want = s.mode || 'auto';

  if (want === 'main') {
    if (allowMain) return { mode: 'main', readOnly: false, note: '按请求直接在主工作区写入' };
    return { mode: 'main', readOnly: true, note: '主工作区写入未授权（foxAi.background.allowMainWorkspaceWrites），后台任务降级为只读' };
  }
  if (isRepo) return { mode: 'worktree', readOnly: false, note: '' };
  if (allowMain) {
    return { mode: 'main', readOnly: false, note: '非 git 仓库（或无提交历史），已按授权直接在主工作区写入' };
  }
  return {
    mode: 'main',
    readOnly: true,
    note: '非 git 仓库（或还没有任何提交），无法开独立 worktree，后台任务降级为只读调研'
  };
}

/**
 * 后台任务调度器：排队、并发控制、超时、取消、git 生命周期。
 *
 * runTask 由 agent.js 注入，签名：
 *   async ({ job, cwd, readOnly, onProgress, isCancelled }) =>
 *     { ok, summary, steps, toolCalls, stopReason }
 */
class BackgroundRunner {
  constructor(opts) {
    const o = opts || {};
    this.store = o.store;
    this.runTask = o.runTask;
    this.git = o.git || null;
    this.onEvent = typeof o.onEvent === 'function' ? o.onEvent : () => {};
    this.workspaceRoot = o.workspaceRoot || '';
    this.worktreeRoot = o.worktreeRoot || path.join(this.store ? this.store.dir : process.cwd(), 'worktrees');
    const lim = o.limits || {};
    this.maxConcurrent = clampNum(lim.maxConcurrent, DEFAULT_MAX_CONCURRENT, 1, HARD_MAX_CONCURRENT);
    this.timeoutMs = clampNum(lim.timeoutMs, DEFAULT_TIMEOUT, 5000, HARD_TIMEOUT);
    this.allowMainWrites = !!lim.allowMainWrites;
    this.keepWorktree = !!lim.keepWorktree;

    this._queue = [];               // 等待执行的 {job, spec}
    this._active = new Map();       // id -> Promise
    this._cancelled = new Set();    // 被请求取消的 id
    this._waiters = new Map();      // id -> [resolve]
  }

  get activeCount() {
    return this._active.size;
  }

  get queuedCount() {
    return this._queue.length;
  }

  _emit(type, payload) {
    try {
      this.onEvent(Object.assign({ type }, payload || {}));
    } catch (_) { /* UI 事件失败不得影响任务 */ }
  }

  /**
   * 提交后台任务：**立即返回**，不等待执行。
   * @returns {{ok:boolean, job?:object, error?:string}}
   */
  submit(spec) {
    const s = spec || {};
    if (!s.task || !String(s.task).trim()) {
      return { ok: false, error: '后台任务必须有明确的 task 描述' };
    }
    if (this._queue.length >= MAX_QUEUED) {
      return { ok: false, error: `后台队列已满（${MAX_QUEUED} 个待跑），请先等已有任务结束` };
    }
    const job = this.store.create(s);
    this._emit('jobQueued', { id: job.id, title: job.title });
    this._queue.push({ job, spec: s });
    // 不 await：fire-and-forget，主对话立刻继续
    this._pump();
    return { ok: true, job };
  }

  /** 取消任务：排队中的直接出队，进行中的置取消标记由 runTask 侧感知 */
  cancel(id) {
    const job = this.store.get(id);
    if (!job) return { ok: false, error: '找不到任务 ' + id };
    if (DONE_STATUSES.has(job.status)) return { ok: false, error: `任务已${STATUS_LABEL[job.status]}，无需取消` };
    this._cancelled.add(id);
    const qi = this._queue.findIndex((q) => q.job.id === id);
    if (qi >= 0) {
      this._queue.splice(qi, 1);
      this.store.update(id, { status: STATUS.CANCELLED, endedAt: Date.now(), error: '排队期间被取消' });
      this._settle(id);
      this._emit('jobEnd', { id, ok: false, status: STATUS.CANCELLED, title: job.title });
      return { ok: true, queued: true };
    }
    return { ok: true, running: true };
  }

  /** 等待某个任务结束（测试与「等它跑完再说」场景用） */
  wait(id) {
    const job = this.store.get(id);
    if (!job) return Promise.resolve(null);
    if (DONE_STATUSES.has(job.status)) return Promise.resolve(job);
    return new Promise((resolve) => {
      const arr = this._waiters.get(id) || [];
      arr.push(resolve);
      this._waiters.set(id, arr);
    });
  }

  /** 等待所有在跑与排队的任务结束 */
  async drain() {
    while (this._active.size || this._queue.length) {
      const ids = [];
      for (const q of this._queue) ids.push(q.job.id);
      for (const id of this._active.keys()) ids.push(id);
      if (!ids.length) break;
      await Promise.all(ids.map((id) => this.wait(id)));
    }
  }

  _settle(id) {
    const arr = this._waiters.get(id);
    if (!arr) return;
    this._waiters.delete(id);
    const job = this.store.get(id);
    for (const fn of arr) {
      try { fn(job); } catch (_) {}
    }
  }

  /** 有空位就从队列取任务开跑 */
  _pump() {
    while (this._active.size < this.maxConcurrent && this._queue.length) {
      const item = this._queue.shift();
      if (this._cancelled.has(item.job.id)) continue;
      const p = this._run(item.job, item.spec)
        .catch((e) => {
          appendLog('background', '[run-crash] ' + item.job.id + ' ' + ((e && e.message) || e));
        })
        .then(() => {
          this._active.delete(item.job.id);
          this._settle(item.job.id);
          this._pump();
        });
      this._active.set(item.job.id, p);
    }
  }

  /** 准备工作目录：git 仓库开独立 worktree，否则降级只读 */
  async _prepareWorkspace(job, spec) {
    let env = { isRepo: false, hasCommit: false, allowMainWrites: this.allowMainWrites };
    if (this.git) {
      try {
        env.isRepo = await this.git.isRepo();
        env.hasCommit = env.isRepo ? await this.git.hasCommit() : false;
      } catch (_) {}
    }
    const m = resolveMode(spec, env);
    if (m.mode !== 'worktree') {
      return { mode: 'main', dir: this.workspaceRoot, branch: '', readOnly: m.readOnly, note: m.note };
    }
    const slug = slugify(spec.branchSlug || spec.title || spec.task);
    const branch = 'fox-ai/bg-' + job.id + (slug ? '-' + slug : '');
    const dir = path.join(this.worktreeRoot, job.id);
    safeMkdir(this.worktreeRoot);
    let r = { ok: false, error: 'git 不可用' };
    try {
      r = await this.git.addWorktree(dir, branch, spec.base || 'HEAD');
    } catch (e) {
      r = { ok: false, error: (e && e.message) || String(e) };
    }
    if (!r.ok) {
      return {
        mode: 'main',
        dir: this.workspaceRoot,
        branch: '',
        readOnly: !this.allowMainWrites,
        note: '创建独立 worktree 失败（' + clip(r.error || '', 160) + '），已降级' + (this.allowMainWrites ? '为主工作区写入' : '为只读')
      };
    }
    return { mode: 'worktree', dir, branch, readOnly: false, note: '' };
  }

  /** 收尾：收 patch、按需提交/建 PR、清理 worktree */
  async _finalizeWorkspace(job, spec) {
    const wsInfo = job.workspace || {};
    if (wsInfo.mode !== 'worktree' || !wsInfo.dir || !this.git) return;
    let diff = { ok: false, patch: '', files: [] };
    try {
      diff = await this.git.collectDiff(wsInfo.dir);
    } catch (e) {
      diff = { ok: false, patch: '', files: [], error: (e && e.message) || String(e) };
    }
    const hasChanges = !!(diff.ok && diff.patch && diff.patch.trim());
    if (hasChanges) {
      const patchPath = this.store.savePatch(job.id, diff.patch);
      this.store.update(job.id, {
        patchPath,
        changedFiles: (diff.files || []).map((f) => f.file).slice(0, 50)
      });
      // 有改动就一定要提交到后台分支，否则拆 worktree 时改动就没了
      try {
        const c = await this.git.commitAll(wsInfo.dir, 'fox-ai 后台任务：' + clip(job.title, 60));
        if (!c.ok) appendLog('background', '[commit-fail] ' + job.id + ' ' + (c.error || ''));
      } catch (e) {
        appendLog('background', '[commit-crash] ' + job.id + ' ' + ((e && e.message) || e));
      }
      if (spec && spec.pr) {
        try {
          const pr = await this.git.pushAndPr(wsInfo.dir, {
            branch: wsInfo.branch,
            title: 'fox-ai: ' + clip(job.title, 60),
            body: '由狐狸 AI 后台任务自动生成。\n\n任务描述：\n' + clip(job.task, 1000)
          });
          this.store.update(job.id, {
            pr: { url: pr.url || '', pushed: !!pr.pushed, note: pr.error || '' }
          });
        } catch (e) {
          this.store.update(job.id, { pr: { url: '', pushed: false, note: (e && e.message) || String(e) } });
        }
      }
    }
    if (!this.keepWorktree) {
      try { await this.git.removeWorktree(wsInfo.dir); } catch (_) {}
      // 没有任何改动的分支留着只会污染分支列表，直接删
      if (!hasChanges) {
        try { await this.git.deleteBranch(wsInfo.branch); } catch (_) {}
        this.store.update(job.id, { workspace: Object.assign({}, wsInfo, { branch: '', dir: '' }) });
      } else {
        this.store.update(job.id, { workspace: Object.assign({}, wsInfo, { dir: '' }) });
      }
    }
  }

  async _run(job, spec) {
    const id = job.id;
    const timeoutMs = clampNum(spec.timeoutMs, this.timeoutMs, 5000, HARD_TIMEOUT);
    this.store.update(id, { status: STATUS.RUNNING, startedAt: Date.now() });
    this._emit('jobStart', { id, title: job.title, role: job.role });

    const wsInfo = await this._prepareWorkspace(job, spec);
    this.store.update(id, {
      workspace: { mode: wsInfo.mode, dir: wsInfo.dir, branch: wsInfo.branch },
      readOnly: !!wsInfo.readOnly
    });
    if (wsInfo.note) this.store.addProgress(id, wsInfo.note);
    if (wsInfo.mode === 'worktree') {
      this.store.addProgress(id, '已在独立分支 ' + wsInfo.branch + ' 上开工，不影响你当前的工作区');
    }

    let timer = null;
    let timedOut = false;
    const isCancelled = () => this._cancelled.has(id) || timedOut;
    const onProgress = (text) => {
      this.store.addProgress(id, text);
      this._emit('jobProgress', { id, title: job.title, text: String(text || '') });
    };

    let res = null;
    let err = null;
    try {
      const timeoutP = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('后台任务超时（' + Math.round(timeoutMs / 1000) + 's）'));
        }, timeoutMs);
        if (timer && timer.unref) timer.unref();
      });
      res = await Promise.race([
        this.runTask({ job: this.store.get(id) || job, cwd: wsInfo.dir, readOnly: !!wsInfo.readOnly, onProgress, isCancelled }),
        timeoutP
      ]);
    } catch (e) {
      err = e;
    } finally {
      if (timer) clearTimeout(timer);
    }

    try {
      await this._finalizeWorkspace(this.store.get(id) || job, spec);
    } catch (e) {
      appendLog('background', '[finalize-fail] ' + id + ' ' + ((e && e.message) || e));
    }

    const cancelled = this._cancelled.has(id);
    let status;
    let summary = '';
    let error = '';
    if (cancelled) {
      status = STATUS.CANCELLED;
      error = '任务被取消';
    } else if (err) {
      status = STATUS.FAILED;
      error = clip((err && err.message) || String(err), 500);
    } else if (res && res.ok === false) {
      status = STATUS.FAILED;
      summary = clip((res && res.summary) || '', MAX_SUMMARY);
      error = clip((res && res.error) || (res && res.stopReason) || '任务未成功', 500);
    } else {
      status = STATUS.SUCCEEDED;
      summary = clip((res && res.summary) || '（无结论输出）', MAX_SUMMARY);
    }

    const final = this.store.update(id, {
      status,
      endedAt: Date.now(),
      summary,
      error,
      steps: (res && res.steps) || 0,
      toolCalls: (res && res.toolCalls) || 0
    });
    this._cancelled.delete(id);
    this._emit('jobEnd', {
      id,
      title: job.title,
      ok: status === STATUS.SUCCEEDED,
      status,
      durationMs: (final && final.endedAt - final.startedAt) || 0,
      changed: (final && final.changedFiles && final.changedFiles.length) || 0,
      branch: (final && final.workspace && final.workspace.branch) || '',
      prUrl: (final && final.pr && final.pr.url) || ''
    });
    return final;
  }
}

// ---------------- 渲染（给模型与用户看的文本） ----------------

function fmtDuration(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return n + 'ms';
  if (n < 60000) return (n / 1000).toFixed(1) + 's';
  const m = Math.floor(n / 60000);
  const s = Math.round((n % 60000) / 1000);
  return m + 'm' + (s ? s + 's' : '');
}

function fmtAgo(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  return Math.floor(d / 86400000) + ' 天前';
}

/** 单个任务的详情文本 */
function renderJob(job, opts) {
  if (!job) return '找不到该后台任务。';
  const o = opts || {};
  const L = [];
  L.push(`${STATUS_ICON[job.status] || '•'} **${job.title}** \`${job.id}\` — ${STATUS_LABEL[job.status] || job.status}`);
  const meta = [];
  meta.push('角色：' + job.role);
  if (job.workspace && job.workspace.mode === 'worktree') meta.push('分支：' + (job.workspace.branch || '（已清理）'));
  else meta.push('位置：主工作区' + (job.readOnly ? '（只读）' : ''));
  if (job.startedAt) meta.push('开始：' + fmtAgo(job.startedAt));
  if (job.endedAt && job.startedAt) meta.push('耗时：' + fmtDuration(job.endedAt - job.startedAt));
  if (job.steps) meta.push(job.steps + ' 轮 / ' + job.toolCalls + ' 次工具');
  L.push('　' + meta.join(' · '));

  if (o.progress !== false && job.progress && job.progress.length) {
    const tail = job.progress.slice(-(o.progressLimit || 6));
    L.push('');
    L.push('进度：');
    for (const p of tail) L.push('　- ' + p.text);
  }
  if (job.changedFiles && job.changedFiles.length) {
    L.push('');
    L.push(`改动文件（${job.changedFiles.length}）：` + job.changedFiles.slice(0, 12).join('、') + (job.changedFiles.length > 12 ? ' …' : ''));
    if (job.patchPath) L.push('补丁文件：' + job.patchPath);
  }
  if (job.pr && (job.pr.url || job.pr.note)) {
    L.push('');
    L.push('PR：' + (job.pr.url || '未创建') + (job.pr.note ? '（' + job.pr.note + '）' : ''));
  }
  if (job.summary) {
    L.push('');
    L.push('结论：');
    L.push(job.summary);
  }
  if (job.error) {
    L.push('');
    L.push('错误：' + job.error);
  }
  if (DONE_STATUSES.has(job.status) && job.workspace && job.workspace.branch) {
    L.push('');
    L.push('查看改动：`git diff HEAD..' + job.workspace.branch + '`　合并：`git merge ' + job.workspace.branch + '`');
  }
  return L.join('\n');
}

/** 任务列表文本 */
function renderJobList(jobs, opts) {
  const o = opts || {};
  const list = jobs || [];
  if (!list.length) return o.emptyText || '当前没有后台任务。';
  const L = [];
  L.push(`后台任务（${list.length}）：`);
  for (const j of list) {
    const bits = [];
    bits.push(`${STATUS_ICON[j.status] || '•'} \`${j.id}\` ${j.title}`);
    bits.push('— ' + (STATUS_LABEL[j.status] || j.status));
    if (j.status === 'running' && j.progress && j.progress.length) {
      bits.push('· ' + clip(j.progress[j.progress.length - 1].text, 50));
    } else if (DONE_STATUSES.has(j.status) && j.endedAt) {
      bits.push('· ' + fmtAgo(j.endedAt));
    }
    if (j.changedFiles && j.changedFiles.length) bits.push('· ' + j.changedFiles.length + ' 文件改动');
    L.push('　' + bits.join(' '));
  }
  L.push('');
  L.push('用 `background_jobs` 的 action=get + id 查看某个任务的完整结论。');
  return L.join('\n');
}

module.exports = {
  STATUS,
  STATUS_LABEL,
  STATUS_ICON,
  DONE_STATUSES,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TIMEOUT,
  MAX_QUEUED,
  MAX_JOBS,
  MAX_PROGRESS,
  GitOps,
  BackgroundJobStore,
  BackgroundRunner,
  defaultExec,
  resolveMode,
  renderJob,
  renderJobList,
  fmtDuration,
  fmtAgo,
  nowId,
  clip,
  slugify,
  clampNum
};



