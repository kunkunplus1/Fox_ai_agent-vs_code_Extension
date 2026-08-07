'use strict';

/**
 * 会话管理与会话树离线测试
 * 运行：node test/sessions.js
 */

const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

/* ---------- mock vscode ---------- */
let mockConfig = {};
let mockWorkspaceFolders = [{ uri: { fsPath: process.cwd() } }];
let mockGlobalState = {};

class EventEmitterMock {
  constructor() {
    this._listeners = [];
    this.event = (cb) => { this._listeners.push(cb); return { dispose: () => {} }; };
  }
  fire(data) { this._listeners.forEach((cb) => cb(data)); }
}

const vscodeMock = {
  workspace: {
    get workspaceFolders() { return mockWorkspaceFolders; },
    getConfiguration: () => ({
      get: (k, d) => (mockConfig[k] !== undefined ? mockConfig[k] : d),
      update: async (k, v) => { mockConfig[k] = v; }
    })
  },
  window: {},
  TreeItem: class {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {},
  ConfigurationTarget: { Global: 1 },
  EventEmitter: EventEmitterMock,
  Uri: { file: (p) => ({ fsPath: p }) }
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const { SessionManager } = require('../src/sessions');
const { SessionTreeProvider } = require('../src/sessionTree');

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

function makeContext(tmp) {
  return {
    globalStorageUri: { fsPath: path.join(tmp, 'global') },
    globalState: {
      get: (k) => mockGlobalState[k],
      update: async (k, v) => { mockGlobalState[k] = v; }
    }
  };
}

function cleanTmp(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  /* ---------- 默认路径：currentId 从 globalState 和 disk 加载 ---------- */
  {
    console.log('\n[1] 默认路径 currentId 持久化');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foxai-sessions-'));
    const ctx = makeContext(tmp);
    mockGlobalState = {};
    mockConfig = {};

    const mgr = new SessionManager(ctx);
    const s = mgr.create({ title: '测试会话' });
    const id = s.id;

    check('创建后 currentId 一致', () => assert.strictEqual(mgr.currentId(), id));

    // 模拟 reload：清空 globalState，只保留磁盘文件
    mockGlobalState = {};
    const mgr2 = new SessionManager(ctx);
    check('reload 后从磁盘恢复 currentId', () => assert.strictEqual(mgr2.currentId(), id));
    check('reload 后能列出会话', () => assert.strictEqual(mgr2.list().length, 1));

    cleanTmp(tmp);
  }

  /* ---------- 自定义绝对路径 ---------- */
  {
    console.log('\n[2] 自定义绝对路径');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foxai-sessions-'));
    const custom = path.join(tmp, 'custom-store');
    const ctx = makeContext(tmp);
    mockGlobalState = {};
    mockConfig = { 'sessions.storagePath': custom };

    const mgr = new SessionManager(ctx);
    const s = mgr.create({ title: '绝对路径会话' });

    check('会话文件写到自定义目录', () => assert.ok(fs.existsSync(path.join(custom, 'sessions', s.id + '.foxsession.json'))));

    mockGlobalState = {};
    const mgr2 = new SessionManager(ctx);
    check('reload 后从绝对路径恢复', () => assert.strictEqual(mgr2.currentId(), s.id));

    cleanTmp(tmp);
  }

  /* ---------- 自定义相对路径应解析到工作区根 ---------- */
  {
    console.log('\n[3] 自定义相对路径解析');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foxai-sessions-'));
    const workspaceRoot = path.join(tmp, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    mockWorkspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
    const ctx = makeContext(tmp);
    mockGlobalState = {};
    mockConfig = { 'sessions.storagePath': 'ai_models' }; // 相对路径

    const mgr = new SessionManager(ctx);
    const s = mgr.create({ title: '相对路径会话' });

    const expectedDir = path.join(workspaceRoot, 'ai_models', 'sessions');
    check('相对路径解析到工作区根', () => assert.ok(fs.existsSync(path.join(expectedDir, s.id + '.foxsession.json'))));

    // 模拟 reload，cwd 可能改变；mgr2 仍应解析到同一目录
    const mgr2 = new SessionManager(ctx);
    check('reload 后相对路径仍指向工作区根', () => assert.strictEqual(mgr2.currentId(), s.id));

    cleanTmp(tmp);
  }

  /* ---------- SessionTreeProvider 初始化即显示当前会话 ---------- */
  {
    console.log('\n[4] 会话树初始显示');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foxai-sessions-'));
    const ctx = makeContext(tmp);
    mockGlobalState = {};
    mockConfig = {};

    const mgr = new SessionManager(ctx);
    mgr.create({ title: '树测试会话' });

    const tree = new SessionTreeProvider(mgr, null);
    const roots = tree.getChildren();
    check('树有今天分组', () => assert.ok(roots.length > 0 && roots[0].label.startsWith('今天')));

    const children = tree.getChildren(roots[0]);
    check('分组下能拿到当前会话', () => assert.strictEqual(children.length, 1));
    check('当前会话标记为当前', () => assert.strictEqual(children[0].description, '当前'));

    cleanTmp(tmp);
  }

  /* ---------- currentId 失效时自动回退到最近会话 ---------- */
  {
    console.log('\n[5] currentId 失效回退');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foxai-sessions-'));
    const ctx = makeContext(tmp);
    mockGlobalState = { 'foxAi.currentSessionId': 'missing-id' };
    mockConfig = {};

    const mgr = new SessionManager(ctx);
    const s = mgr.create({ title: '兜底会话' });

    // 直接改写 current.json 指向不存在 id
    fs.writeFileSync(path.join(mgr.sessionsDir(), 'current.json'), JSON.stringify({ id: 'missing-id' }));
    const mgr2 = new SessionManager(ctx);
    check('失效 currentId 自动回退', () => assert.strictEqual(mgr2.currentId(), s.id));

    cleanTmp(tmp);
  }

  /* ---------- recoverSession：跨存储区恢复会话 ---------- */
  {
    console.log('\n[6] recoverSession 从默认目录恢复');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foxai-sessions-'));
    const custom = path.join(tmp, 'custom-store');
    const ctx = makeContext(tmp);
    mockGlobalState = {};
    mockConfig = {};

    const mgr = new SessionManager(ctx);
    const s = mgr.create({ title: '旧存储区会话', messages: [{ role: 'user', content: 'hello' }] });

    // 切换存储路径到自定义目录（新目录为空）
    mockConfig = { 'sessions.storagePath': custom };
    check('切换路径后当前存储区找不到旧会话', () => assert.strictEqual(mgr.load(s.id), null));

    const recovered = mgr.recoverSession(s.id);
    check('从默认目录恢复旧会话', () => assert.ok(recovered && recovered.id === s.id));
    check('恢复后当前存储区能找到', () => assert.ok(mgr.load(s.id) !== null));
    check('消息内容保持', () => assert.strictEqual(mgr.load(s.id).messages[0].content, 'hello'));

    cleanTmp(tmp);
  }

  /* ---------- recoverSession：从历史 storagePath 恢复 ---------- */
  {
    console.log('\n[7] recoverSession 从历史 storagePath 恢复');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foxai-sessions-'));
    const historical = path.join(tmp, 'historical-store');
    const current = path.join(tmp, 'current-store');
    const ctx = makeContext(tmp);
    mockGlobalState = {};
    mockConfig = {};

    // 在历史路径创建会话
    fs.mkdirSync(path.join(historical, 'sessions'), { recursive: true });
    const oldSession = {
      id: 'old-from-historical',
      title: '历史路径会话',
      messages: [{ role: 'user', content: 'historical' }],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    fs.writeFileSync(path.join(historical, 'sessions', oldSession.id + '.foxsession.json'), JSON.stringify(oldSession, null, 2));

    // 把 historical 路径写入默认索引，模拟曾经用过这个路径
    fs.mkdirSync(path.join(ctx.globalStorageUri.fsPath, 'sessions'), { recursive: true });
    fs.writeFileSync(
      path.join(ctx.globalStorageUri.fsPath, 'sessions', 'index.json'),
      JSON.stringify({ sessions: [{ id: oldSession.id, storagePath: path.join(historical, 'sessions') }] }, null, 2)
    );

    // 当前使用新路径
    mockConfig = { 'sessions.storagePath': current };
    const mgr = new SessionManager(ctx);
    check('当前存储区找不到历史会话', () => assert.strictEqual(mgr.load(oldSession.id), null));

    const recovered = mgr.recoverSession(oldSession.id);
    check('从历史 storagePath 恢复会话', () => assert.ok(recovered && recovered.id === oldSession.id));
    check('恢复后当前存储区能找到', () => assert.ok(mgr.load(oldSession.id) !== null));

    cleanTmp(tmp);
  }

  /* ---------- recoverSession：找不到返回 null ---------- */
  {
    console.log('\n[8] recoverSession 找不到返回 null');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foxai-sessions-'));
    const ctx = makeContext(tmp);
    mockGlobalState = {};
    mockConfig = {};

    const mgr = new SessionManager(ctx);
    const r = mgr.recoverSession('non-existent-id');
    check('找不到时返回 null', () => assert.strictEqual(r, null));

    cleanTmp(tmp);
  }

  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
