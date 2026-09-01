'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const SESSIONS_DIR_NAME = 'sessions';
const SESSION_EXT = '.foxsession.json';

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length) return folders[0].uri.fsPath;
  return process.cwd();
}

function safeReadJson(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function safeWriteJson(p, data) {
  try {
    ensureDir(path.dirname(p));
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[fox-ai] write json failed', p, e);
    return false;
  }
}

function generateId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function makeTitle(firstUserText) {
  const t = String(firstUserText || '新会话').trim();
  // 取第一行，最多 20 字
  const line = t.split('\n')[0].slice(0, 24);
  return line || '新会话';
}

/** 会话管理器 */
class SessionManager {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    this._currentId = null;
    this._onChange = new vscode.EventEmitter();
    this.onChange = this._onChange.event;
    this._loadCurrentId();
  }

  _globalStorage() {
    return this.context.globalStorageUri.fsPath;
  }

  _defaultDir() {
    return path.join(this._globalStorage(), SESSIONS_DIR_NAME);
  }

  sessionsDir() {
    const custom = (vscode.workspace.getConfiguration('foxAi').get('sessions.storagePath') || '').trim();
    if (custom) {
      // 支持 ~/ 展开；相对路径以工作区根目录为基准，避免 reload 后 cwd 变化导致找不到会话
      let expanded = custom.replace(/^~\//, process.env.HOME || process.env.USERPROFILE || '').replace(/^~\\/, process.env.USERPROFILE || '');
      if (!path.isAbsolute(expanded)) {
        expanded = path.join(workspaceRoot(), expanded);
      }
      return path.resolve(expanded, SESSIONS_DIR_NAME);
    }
    return this._defaultDir();
  }

  _indexPath() {
    return path.join(this.sessionsDir(), 'index.json');
  }

  _sessionPath(id) {
    return path.join(this.sessionsDir(), id + SESSION_EXT);
  }

  _currentIdPath() {
    return path.join(this.sessionsDir(), 'current.json');
  }

  _loadCurrentId() {
    let id = this.context.globalState.get('foxAi.currentSessionId') || null;
    // globalState 在强制关机时可能没 flush，再从同步文件兜底读取
    if (!id) {
      const disk = safeReadJson(this._currentIdPath(), null);
      id = (disk && disk.id) || null;
    }
    // 校验会话文件确实存在，否则 current() 会回退到最近有效会话
    if (id && !fs.existsSync(this._sessionPath(id))) {
      this.context.globalState.update('foxAi.currentSessionId', undefined);
      id = null;
    }
    this._currentId = id;
  }

  _saveCurrentId() {
    this.context.globalState.update('foxAi.currentSessionId', this._currentId);
    // 同步写一份到磁盘，防止非正常退出丢失当前会话
    safeWriteJson(this._currentIdPath(), { id: this._currentId, updatedAt: Date.now() });
  }

  _index() {
    return safeReadJson(this._indexPath(), { sessions: [] });
  }

  _saveIndex(idx) {
    safeWriteJson(this._indexPath(), idx);
  }

  _addToIndex(id, title, updatedAt) {
    const idx = this._index();
    const existing = idx.sessions.find((s) => s.id === id);
    if (existing) {
      existing.title = title;
      existing.updatedAt = updatedAt;
      existing.storagePath = this.sessionsDir();
    } else {
      idx.sessions.push({ id, title, createdAt: updatedAt, updatedAt, storagePath: this.sessionsDir() });
    }
    // 按更新时间倒序
    idx.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    this._saveIndex(idx);
  }

  _removeFromIndex(id) {
    const idx = this._index();
    idx.sessions = idx.sessions.filter((s) => s.id !== id);
    this._saveIndex(idx);
  }

  list() {
    const dir = this.sessionsDir();
    ensureDir(dir);
    const files = [];
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith(SESSION_EXT)) {
          const p = path.join(dir, f);
          const s = safeReadJson(p, null);
          if (s && s.id) {
            files.push({
              id: s.id,
              title: s.title || makeTitle((s.messages || []).find((m) => m.role === 'user')?.content),
              updatedAt: s.updatedAt || s.createdAt || 0,
              createdAt: s.createdAt || s.updatedAt || 0
            });
          }
        }
      }
    } catch (e) {
      console.error('[fox-ai] list sessions failed', e);
    }
    files.sort((a, b) => b.updatedAt - a.updatedAt);

    // 如果索引里有但文件丢失的会话，清理掉
    const idx = this._index();
    const fileIds = new Set(files.map((f) => f.id));
    const stale = idx.sessions.filter((s) => !fileIds.has(s.id));
    if (stale.length) {
      idx.sessions = idx.sessions.filter((s) => fileIds.has(s.id));
      this._saveIndex(idx);
    }
    return files;
  }

  currentId() {
    return this._currentId;
  }

  current() {
    if (this._currentId) {
      const s = this.load(this._currentId);
      if (s) return s;
    }
    // 当前 ID 失效或丢失时，自动恢复到最近一个有效会话
    const latest = this.list()[0];
    if (latest) {
      this._currentId = latest.id;
      this._saveCurrentId();
      return this.load(latest.id);
    }
    return null;
  }

  load(id) {
    const s = safeReadJson(this._sessionPath(id), null);
    if (!s) return null;
    return {
      id: s.id,
      title: s.title || makeTitle((s.messages || []).find((m) => m.role === 'user')?.content),
      messages: s.messages || [],
      transcript: s.transcript || [],
      createdAt: s.createdAt || 0,
      updatedAt: s.updatedAt || 0,
      provider: s.provider || null,
      model: s.model || null,
      attachments: s.attachments || [],
      // 会话进度摘要（对齐 DSH session checkpoint）：工具执行流水账的紧凑渲染，
      // 重开/断点续跑时由 chatView 回灌给 agent，模型凭它知道「上次干到哪、下一步做什么」。
      progress: s.progress || null
    };
  }

  save(session) {
    const id = session.id || generateId();
    const now = Date.now();
    const old = this.load(id);
    const toSave = {
      id,
      title: session.title || makeTitle((session.messages || []).find((m) => m.role === 'user')?.content),
      messages: session.messages || [],
      transcript: session.transcript || [],
      createdAt: session.createdAt || now,
      updatedAt: now,
      provider: session.provider || null,
      model: session.model || null,
      attachments: session.attachments || [],
      // 会话进度摘要持久化（对齐 DSH session-persistence）：写后置落盘，\n      // 崩溃/重开/断点续跑时 load 回灌，模型凭紧凑流水知道自己干到哪。
      progress: session.progress || null
    };
    ensureDir(this.sessionsDir());
    safeWriteJson(this._sessionPath(id), toSave);
    this._addToIndex(id, toSave.title, toSave.updatedAt);
    // 标题变化或新建会话时通知侧边栏刷新
    if (!old || old.title !== toSave.title || old.updatedAt !== toSave.updatedAt) {
      this._fireChange();
    }
    return id;
  }

  create(opts) {
    opts = opts || {};
    const id = generateId();
    const now = Date.now();
    const session = {
      id,
      title: opts.title || '新会话',
      messages: opts.messages || [],
      transcript: opts.transcript || [],
      createdAt: now,
      updatedAt: now,
      provider: opts.provider || null,
      model: opts.model || null,
      attachments: opts.attachments || [],
      progress: opts.progress || null
    };
    this.save(session);
    this._currentId = id;
    this._saveCurrentId();
    this._fireChange();
    return session;
  }

  switchTo(id) {
    const s = this.load(id);
    if (!s) return null;
    this._currentId = id;
    this._saveCurrentId();
    this._fireChange();
    return s;
  }

  delete(id) {
    try {
      const p = this._sessionPath(id);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {
      console.error('[fox-ai] delete session failed', e);
    }
    this._removeFromIndex(id);
    if (this._currentId === id) {
      const remaining = this.list();
      this._currentId = remaining.length ? remaining[0].id : null;
      this._saveCurrentId();
    }
    this._fireChange();
  }

  rename(id, title) {
    const s = this.load(id);
    if (!s) return false;
    s.title = title;
    this.save(s);
    this._fireChange();
    return true;
  }

  setStoragePath(newDir) {
    // 只是把配置改掉，后续会话存到新位置；旧文件不自动迁移，避免误删
    const cfg = vscode.workspace.getConfiguration('foxAi');
    cfg.update('sessions.storagePath', newDir, vscode.ConfigurationTarget.Global);
    this._fireChange();
  }

  /** 迁移所有旧会话到新目录 */
  async migrateStorage(newDir) {
    const oldDir = this.sessionsDir();
    const oldFiles = this.list();
    if (!oldFiles.length) {
      this.setStoragePath(newDir);
      return { moved: 0 };
    }
    const choice = await vscode.window.showWarningMessage(
      `要把现有的 ${oldFiles.length} 个会话迁移到新位置吗？`,
      { modal: true },
      '迁移',
      '只改路径，不迁移'
    );
    if (choice === '迁移') {
      ensureDir(path.join(newDir, SESSIONS_DIR_NAME));
      for (const f of oldFiles) {
        const src = path.join(oldDir, f.id + SESSION_EXT);
        const dst = path.join(newDir, SESSIONS_DIR_NAME, f.id + SESSION_EXT);
        try {
          fs.copyFileSync(src, dst);
        } catch (e) {
          console.error('[fox-ai] migrate copy failed', e);
        }
      }
      // 同时迁移 index
      const oldIndex = path.join(oldDir, 'index.json');
      if (fs.existsSync(oldIndex)) {
        try {
          fs.copyFileSync(oldIndex, path.join(newDir, SESSIONS_DIR_NAME, 'index.json'));
        } catch (_) {}
      }
    }
    this.setStoragePath(newDir);
    return { moved: choice === '迁移' ? oldFiles.length : 0 };
  }

  /**
   * 跨存储区恢复会话：当 task.sessionId 在当前 sessionsDir 找不到时，
   * 去默认目录（globalStorage/sessions）以及历史索引里记录过的 storagePath 查找，
   * 找到后把会话文件导入当前存储区并加入索引。
   * @param {string} id 会话 ID
   * @returns {object|null}
   */
  recoverSession(id) {
    if (!id) return null;
    const existing = this.load(id);
    if (existing) return existing;

    const candidates = new Set();
    const collectPaths = (dir) => {
      candidates.add(dir);
      const idxPath = path.join(dir, 'index.json');
      const idx = safeReadJson(idxPath, { sessions: [] });
      for (const s of idx.sessions) {
        if (s.storagePath) candidates.add(s.storagePath);
      }
    };
    collectPaths(this._defaultDir());
    collectPaths(this.sessionsDir());

    const currentDir = path.resolve(this.sessionsDir());
    for (const dir of candidates) {
      if (!dir || path.resolve(dir) === currentDir) continue;
      // storagePath 可能指向 sessions 目录本身，也可能指向其父目录；两种都试试
      const possiblePaths = [
        path.join(dir, id + SESSION_EXT),
        path.join(dir, SESSIONS_DIR_NAME, id + SESSION_EXT)
      ];
      for (const p of possiblePaths) {
        if (!fs.existsSync(p)) continue;
        const data = safeReadJson(p, null);
        if (!data || data.id !== id) continue;
        // 导入到当前存储区
        ensureDir(this.sessionsDir());
        safeWriteJson(this._sessionPath(id), data);
        this._addToIndex(
          id,
          data.title || makeTitle((data.messages || []).find((m) => m.role === 'user')?.content),
          data.updatedAt || data.createdAt || Date.now()
        );
        return this.load(id);
      }
    }
    return null;
  }

  _fireChange() {
    this._onChange.fire({ currentId: this._currentId });
  }
}

module.exports = { SessionManager };
