'use strict';

/**
 * src/checkpoints.js — 执行前快照与一键回滚
 *
 * 智能体改坏了代码怎么办？大厂方案是「执行前自动快照 + 一键回退」（Claude Code 双击 Esc 回滚）。
 * fox-ai 此前只有「热恢复续跑」，缺少可撤销快照。本模块补齐：
 *   - 每次 write_file / edit_file / delete_file 执行前，把文件真实内容存档
 *   - 支持手动打「里程碑」检查点（create_checkpoint），一次记录多个文件
 *   - 回滚到任意检查点：把该时刻之后所有被改动的文件还原成快照内容
 *
 * 存储：<globalStorage>/checkpoints/<sessionId>/index.json + blobs/<hash>
 *   - 内容按 sha1 去重存 blob，同一文件反复改也不会撑爆磁盘
 *   - 新增文件（快照时不存在）记 content:null，回滚时删除该文件
 *
 * 零外部依赖，纯 fs + crypto，可离线单测。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { appendLog } = require('./log');

const DEFAULT_MAX = 200;

function sha1(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

function nowId() {
  return 'cp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function safeMkdir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (_) {
    return false;
  }
}

class CheckpointStore {
  /**
   * @param {object} opts
   * @param {string} opts.baseDir  存档根目录（一般是扩展 globalStorage）
   * @param {string} [opts.workspaceRoot] 工作区根目录，用于把绝对路径转相对显示
   * @param {string} [opts.sessionId] 会话 id，用于分目录
   * @param {boolean} [opts.enabled] 总开关
   * @param {number} [opts.maxSnapshots] 单会话最多保留多少条（超出丢最旧）
   */
  constructor(opts) {
    const o = opts || {};
    this.enabled = o.enabled !== false;
    this.workspaceRoot = o.workspaceRoot || '';
    this.sessionId = o.sessionId || 'default';
    this.maxSnapshots = Number(o.maxSnapshots) > 0 ? Number(o.maxSnapshots) : DEFAULT_MAX;
    this.dir = path.join(o.baseDir || process.cwd(), 'checkpoints', String(this.sessionId).replace(/[^\w.-]/g, '_'));
    this.blobDir = path.join(this.dir, 'blobs');
    this.indexFile = path.join(this.dir, 'index.json');
    this.entries = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.indexFile)) {
        const data = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
        if (Array.isArray(data.entries)) return data.entries;
      }
    } catch (e) {
      appendLog('checkpoints', '[load-fail] ' + (e && e.message));
    }
    return [];
  }

  _persist() {
    if (!safeMkdir(this.dir)) return false;
    try {
      fs.writeFileSync(this.indexFile, JSON.stringify({ version: 1, entries: this.entries }, null, 2), 'utf8');
      return true;
    } catch (e) {
      appendLog('checkpoints', '[persist-fail] ' + (e && e.message));
      return false;
    }
  }

  /** 把内容写入 blob（按 hash 去重），返回 hash；content 为 null 表示文件当时不存在 */
  _putBlob(content) {
    if (content === null || content === undefined) return null;
    const h = sha1(String(content));
    if (!safeMkdir(this.blobDir)) return null;
    const f = path.join(this.blobDir, h);
    try {
      if (!fs.existsSync(f)) fs.writeFileSync(f, String(content), 'utf8');
      return h;
    } catch (e) {
      appendLog('checkpoints', '[blob-fail] ' + (e && e.message));
      return null;
    }
  }

  _getBlob(hash) {
    if (!hash) return null;
    try {
      const f = path.join(this.blobDir, hash);
      if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
    } catch (_) {}
    return null;
  }

  /** 相对工作区显示路径 */
  _rel(p) {
    const abs = String(p || '');
    if (this.workspaceRoot && abs.startsWith(this.workspaceRoot)) {
      return abs.slice(this.workspaceRoot.length).replace(/^[\\/]+/, '');
    }
    return abs;
  }

  /** 把可能的相对路径解析为绝对路径 */
  _abs(p) {
    const s = String(p || '');
    if (!s) return '';
    if (path.isAbsolute(s)) return s;
    return this.workspaceRoot ? path.join(this.workspaceRoot, s) : path.resolve(s);
  }

  /**
   * 记录一次「文件写入前」的快照。
   * @param {string} filePath 目标文件（相对或绝对）
   * @param {string|null} beforeContent 写入前的真实内容；文件不存在传 null
   * @param {object} [meta] { tool, title, step, label }
   * @returns {object|null} 新建的条目
   */
  snapshot(filePath, beforeContent, meta) {
    if (!this.enabled) return null;
    const p = String(filePath || '').trim();
    if (!p) return null;
    const m = meta || {};
    const entry = {
      id: nowId(),
      at: Date.now(),
      kind: 'auto',
      label: m.label || m.title || (m.tool ? m.tool + ' ' + this._rel(p) : '自动快照'),
      tool: m.tool || '',
      step: typeof m.step === 'number' ? m.step : null,
      files: [
        {
          path: this._abs(p),
          rel: this._rel(this._abs(p)),
          existed: beforeContent !== null && beforeContent !== undefined,
          hash: this._putBlob(beforeContent)
        }
      ]
    };
    this.entries.push(entry);
    this._trim();
    this._persist();
    appendLog('checkpoints', '[snapshot] ' + entry.id + ' ' + entry.files[0].rel + ' existed=' + entry.files[0].existed);
    return entry;
  }

  /**
   * 手动打一个里程碑检查点，一次记录多个文件的当前内容。
   * @param {string} label
   * @param {string[]} filePaths
   * @returns {object} 新建条目
   */
  createManual(label, filePaths) {
    const list = Array.isArray(filePaths) ? filePaths : [];
    const files = [];
    for (const p of list) {
      const abs = this._abs(p);
      let content = null;
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) content = fs.readFileSync(abs, 'utf8');
      } catch (_) {
        content = null;
      }
      files.push({ path: abs, rel: this._rel(abs), existed: content !== null, hash: this._putBlob(content) });
    }
    const entry = {
      id: nowId(),
      at: Date.now(),
      kind: 'manual',
      label: String(label || '手动检查点'),
      tool: '',
      step: null,
      files
    };
    this.entries.push(entry);
    this._trim();
    this._persist();
    appendLog('checkpoints', '[manual] ' + entry.id + ' files=' + files.length);
    return entry;
  }

  list(limit) {
    const n = Number(limit) > 0 ? Number(limit) : this.entries.length;
    return this.entries.slice(-n).reverse();
  }

  get(id) {
    return this.entries.find((e) => e.id === id) || null;
  }

  /**
   * 回滚到指定检查点：把该检查点及其之后所有条目里记录的文件，
   * 还原成「最早一次快照」记录的内容（即回到检查点之前的状态）。
   *
   * @param {string} id
   * @param {object} [opts] { dryRun: boolean }
   * @returns {{ok:boolean, restored:Array, deleted:Array, failed:Array, error?:string}}
   */
  rollbackTo(id, opts) {
    const o = opts || {};
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) return { ok: false, restored: [], deleted: [], failed: [], error: '找不到该检查点：' + id };

    // 取 idx 及之后的所有条目；同一文件取「最早」那条（即最接近原始状态的版本）
    const plan = new Map(); // absPath -> {hash, existed, rel}
    for (let i = idx; i < this.entries.length; i++) {
      for (const f of this.entries[i].files || []) {
        if (!plan.has(f.path)) plan.set(f.path, f);
      }
    }

    const restored = [];
    const deleted = [];
    const failed = [];
    for (const [abs, f] of plan) {
      try {
        if (!f.existed) {
          // 快照时文件不存在 → 回滚意味着删掉它
          if (!o.dryRun && fs.existsSync(abs)) fs.unlinkSync(abs);
          deleted.push(f.rel || abs);
          continue;
        }
        const content = this._getBlob(f.hash);
        if (content === null) {
          failed.push((f.rel || abs) + '（快照内容丢失）');
          continue;
        }
        if (!o.dryRun) {
          safeMkdir(path.dirname(abs));
          fs.writeFileSync(abs, content, 'utf8');
        }
        restored.push(f.rel || abs);
      } catch (e) {
        failed.push((f.rel || abs) + '（' + (e && e.message) + '）');
      }
    }

    if (!o.dryRun) {
      // 回滚成功后，丢弃 idx 之后的历史（含 idx 本身），避免二次回滚状态错乱
      this.entries = this.entries.slice(0, idx);
      this._persist();
    }
    appendLog(
      'checkpoints',
      '[rollback] id=' + id + ' dryRun=' + !!o.dryRun + ' restored=' + restored.length + ' deleted=' + deleted.length + ' failed=' + failed.length
    );
    return { ok: failed.length === 0, restored, deleted, failed };
  }

  /** 回滚最近一次自动快照（对应「撤销上一步改动」） */
  undoLast(opts) {
    if (!this.entries.length) return { ok: false, restored: [], deleted: [], failed: [], error: '没有可回滚的检查点' };
    return this.rollbackTo(this.entries[this.entries.length - 1].id, opts);
  }

  /** 超出上限时丢弃最旧条目（blob 不立即删，由 gc 统一清） */
  _trim() {
    while (this.entries.length > this.maxSnapshots) this.entries.shift();
  }

  /** 清理没有任何条目引用的 blob 文件 */
  gc() {
    const used = new Set();
    for (const e of this.entries) for (const f of e.files || []) if (f.hash) used.add(f.hash);
    let removed = 0;
    try {
      if (!fs.existsSync(this.blobDir)) return 0;
      for (const name of fs.readdirSync(this.blobDir)) {
        if (!used.has(name)) {
          try {
            fs.unlinkSync(path.join(this.blobDir, name));
            removed++;
          } catch (_) {}
        }
      }
    } catch (_) {}
    if (removed) appendLog('checkpoints', '[gc] removed=' + removed);
    return removed;
  }

  clear() {
    this.entries = [];
    this._persist();
    this.gc();
  }

  /** 生成给模型/用户看的清单文本 */
  describe(limit) {
    const list = this.list(limit || 20);
    if (!list.length) return '暂无检查点。';
    const lines = ['共 ' + this.entries.length + ' 个检查点（最新在前）：'];
    for (const e of list) {
      const when = new Date(e.at).toLocaleString('zh-CN');
      const files = (e.files || []).map((f) => f.rel || f.path).join('、');
      lines.push(`- [${e.id}] ${when} ${e.kind === 'manual' ? '🏁' : '·'} ${e.label}${files ? '\n    文件：' + files : ''}`);
    }
    return lines.join('\n');
  }
}

module.exports = { CheckpointStore, sha1 };
