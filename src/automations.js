'use strict';

/**
 * 本地自动化调度：cron / interval 定时 + 本地 webhook（GitHub/Slack 均可经 webhook 触发）。
 *
 * 设计原则（用户硬约束）：
 *  - 零 vscode 依赖：纯 Node（http/fs/crypto/path 内置），单测友好，不常驻额外内存。
 *  - 懒加载：仅在 foxAi.automations.enabled 时由 extension 实例化；webhook 仅在有端口时监听。
 *  - 配置门控：默认关。
 *  - 不常驻监听文件：调度用 Node 定时器（扩展存活期间才跑，关机不跑——符合“无关机跑”）。
 *  - 红线（外部渠道）：webhook 只收“指令(id + 可选 args)”，响应只回 {ok, runId} 回执，
 *    绝不回吐任何内部资料（知识库/记忆/工具实现/文件路径等内容）。
 *
 * 与既有底座关系：定时/收到 webhook 触发后，由调用方把 automation.prompt 交给
 * BackgroundRunner.submit 异步执行（复用后台 agent 链路），本模块只负责“何时/何因触发”。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// ───────────────────────── cron 匹配（5 字段：分 时 日 月 周）零依赖 ─────────────────────────
function _matchField(val, cur) {
  if (val === '*') return true;
  const parts = String(val).split(',');
  for (let p of parts) {
    let step = 1;
    let range = p;
    const slash = p.indexOf('/');
    if (slash !== -1) {
      range = p.slice(0, slash) === '' ? '*' : p.slice(0, slash);
      step = parseInt(p.slice(slash + 1), 10) || 1;
    }
    if (range === '*') {
      if (cur % step === 0) return true;
      continue;
    }
    const dash = range.indexOf('-');
    if (dash !== -1) {
      const a = parseInt(range.slice(0, dash), 10);
      const b = parseInt(range.slice(dash + 1), 10);
      if (cur >= a && cur <= b && (cur - a) % step === 0) return true;
    } else if (range !== '') {
      // 形如 a/b：从 a 开始、步长 b（a, a+b, a+2b…）；也兼容纯数字 a（步长 1）
      const start = parseInt(range, 10);
      if (Number.isFinite(start) && cur >= start && (cur - start) % step === 0) return true;
    }
  }
  return false;
}

/** 标准 5 字段 cron 匹配；date 缺省为当前时间。 */
function matchCron(expr, date) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return false;
  const d = date || new Date();
  const M = d.getMinutes(), H = d.getHours(), D = d.getDate(), Mo = d.getMonth() + 1, Dw = d.getDay();
  return _matchField(f[0], M) && _matchField(f[1], H) && _matchField(f[2], D) && _matchField(f[3], Mo) && _matchField(f[4], Dw);
}

// ───────────────────────── 存储（JSON 落盘，有界） ─────────────────────────
class AutomationStore {
  constructor(storagePath) {
    this.path = storagePath || path.join(require('os').homedir(), '.fox-ai', 'automations.json');
    this.items = [];
    this._load();
  }
  _load() {
    try { this.items = JSON.parse(fs.readFileSync(this.path, 'utf8')); if (!Array.isArray(this.items)) this.items = []; }
    catch (_) { this.items = []; }
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      fs.writeFileSync(this.path, JSON.stringify(this.items, null, 2));
    } catch (_) { /* 落盘失败不致命 */ }
  }
  list() { return this.items.slice(); }
  enabledList() { return this.items.filter((a) => a && a.enabled); }
  get(id) { return this.items.find((a) => a.id === id) || null; }
  upsert(a) {
    if (!a || !a.id) return null;
    const i = this.items.findIndex((x) => x.id === a.id);
    if (i >= 0) this.items[i] = a; else this.items.push(a);
    this.save();
    return a;
  }
  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((x) => x.id !== id);
    if (this.items.length !== before) this.save();
    return this.items.length !== before;
  }
}

// ───────────────────────── 调度器（Node 定时器，扩展存活期间生效） ─────────────────────────
class AutomationScheduler {
  constructor(store, onFire) {
    this.store = store;
    this.onFire = onFire || (() => {});
    this.timers = new Map();     // id -> interval handle
    this.lastFired = new Map();  // id -> 'YYYY-M-D-H-M' 防同分钟重复触发
  }
  start() {
    this.stop();
    for (const a of this.store.enabledList()) this._schedule(a);
  }
  stop() {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }
  _schedule(a) {
    const s = a.schedule || {};
    if (s.type === 'cron') {
      // 每 30s 轮询一次；命中且本分钟未触发过才 fire（cron 最小粒度分钟）
      const t = setInterval(() => {
        if (!matchCron(s.expr, new Date())) return;
        const d = new Date();
        const key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate() + '-' + d.getHours() + '-' + d.getMinutes();
        if (this.lastFired.get(a.id) === key) return;
        this.lastFired.set(a.id, key);
        this.onFire(a);
      }, 30000);
      this.timers.set(a.id, t);
    } else if (s.type === 'interval') {
      const ms = Number(s.ms) || 0;
      if (ms > 0) {
        const t = setInterval(() => this.onFire(a), ms);
        this.timers.set(a.id, t);
      }
    }
  }
  /** 配置变更后调用：仅重建受影响的定时器（不重启全部，降低抖动）。 */
  reschedule(a) {
    if (this.timers.has(a.id)) { clearInterval(this.timers.get(a.id)); this.timers.delete(a.id); }
    if (a && a.enabled) this._schedule(a);
  }
}

// ───────────────────────── Webhook（本地 HTTP，只收指令不回内部） ─────────────────────────
/**
 * 纯函数版 webhook 处理：供单测直接调用（无需真实 socket）。
 * @returns {{statusCode:number, body:object}}
 */
/** webhook secret 的最短长度：低于此值视为「未配置/强度不足」，一律拒绝服务 */
const MIN_SECRET_LEN = 16;

/** 常量时间比较 secret，避免按响应耗时逐字节爆破 */
function secretMatches(provided, secret) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LEN) return false;
  if (typeof provided !== 'string' || provided.length !== secret.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(secret, 'utf8'));
  } catch (_) { return false; }
}

function handleWebhook({ body, secret, allowedIds, dispatch }) {
  let payload;
  try { payload = JSON.parse(typeof body === 'string' ? body : (body ? JSON.stringify(body) : '{}')); }
  catch (_) { return { statusCode: 400, body: { ok: false, error: 'bad json' } }; }

  // ① 先鉴权：未认证请求不得探测任务是否存在（否则可用 404/403 的差异枚举自动化 id）。
  //    secret 为空或过短即视为未配置 —— 宁可拒绝服务，也不裸奔（防 CSRF / 局域网未授权触发）。
  if (!secretMatches(payload && payload.secret, secret)) {
    return {
      statusCode: 403,
      body: { ok: false, error: (secret && String(secret).length >= MIN_SECRET_LEN) ? 'forbidden' : 'webhook secret not configured' }
    };
  }
  // ② 再校验任务 id：白名单为空 = 拒绝全部（原实现空数组会放行任意 id）
  const id = payload.id || payload.task;
  if (!id || !Array.isArray(allowedIds) || allowedIds.length === 0 || !allowedIds.includes(id)) {
    return { statusCode: 404, body: { ok: false, error: 'unknown task' } };
  }
  const runId = (typeof dispatch === 'function') ? dispatch(id, payload.args || {}) : crypto.randomBytes(6).toString('hex');
  // 红线：只回执，绝不回任何内部资料（知识库/记忆/工具实现/路径等）
  return { statusCode: 200, body: { ok: true, runId: String(runId) } };
}

function createWebhookServer({ port, secret, allowedIds, dispatch, route, host }) {
  const r = route || '/webhook';
  // 安全：默认只监听回环（127.0.0.1）。原实现 server.listen(port) 会绑定全部网卡（0.0.0.0/::），
  // 使局域网内任意主机、以及用户浏览器里的任意网页（CSRF）都能 POST 触发自动化任务。
  const bindHost = host || '127.0.0.1';
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || (req.url || '').split('?')[0] !== r) {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
      return;
    }
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy(); // 防御超大请求
    });
    req.on('end', () => {
      const { statusCode, body } = handleWebhook({ body: raw, secret, allowedIds, dispatch });
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body)); // 仅回执
    });
  });
  server.listen(port, bindHost);
  return server;
}

function generateId() { return 'auto-' + crypto.randomBytes(4).toString('hex'); }

module.exports = {
  matchCron,
  AutomationStore,
  AutomationScheduler,
  handleWebhook,
  createWebhookServer,
  generateId,
  MIN_SECRET_LEN
};
