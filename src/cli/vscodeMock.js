'use strict';
/**
 * vscodeMock.js —— 无窗口 VS Code API 假实现（CLI 专用）
 *
 * 作用：fox 终端命令在系统终端跑，没有 vscode 模块。通过 Module._load
 * 拦截把本模块冒充 'vscode'，让 src/tools/index.js 整条工具链
 * （workspace.js / terminal.js / skills.js / securityAudit.js…）能在
 * 纯 node 环境 require 并执行。
 *
 * 只实现了工具链真正用到的 API 面；编辑器强绑定方法一律降级为空值/空实现，
 * 由 CLI 白名单决定哪些工具可用。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------- Uri ----------
function Uri() { throw new Error('Uri 是静态类，用 Uri.file()'); }
Uri.file = (p) => ({
  scheme: 'file',
  fsPath: String(p),
  authority: '',
  path: String(p).replace(/\\/g, '/'),
  toString() { return 'file://' + String(p).replace(/\\/g, '/'); },
  with() { return Uri.file(String(p)); }
});
Uri.joinPath = (root, ...parts) => {
  const base = root && root.fsPath ? root.fsPath : String(root || '');
  return Uri.file(path.join(base, ...parts.map(String)));
};
Uri.parse = (s) => Uri.file(String(s || '').replace(/^file:\/\//, ''));

// ---------- 枚举与常量 ----------
const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
const ProgressLocation = { Notification: 15, Window: 10 };
const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
function ThemeIcon(id) { this.id = String(id || ''); }

// ---------- Position / Range / WorkspaceEdit ----------
class Position {
  constructor(line, character) { this.line = Number(line) || 0; this.character = Number(character) || 0; }
}
class Range {
  constructor(a, b) {
    this.start = a instanceof Position ? a : new Position(Number(a) || 0, 0);
    this.end = b instanceof Position ? b : (a instanceof Position ? new Position(a.line, a.character) : new Position(Number(a) || 0, Number.MAX_SAFE_INTEGER));
  }
}
class WorkspaceEdit {
  constructor() { this._ops = []; }
  insert(uri, pos, text) { this._ops.push({ kind: 'insert', uri, pos, text }); }
  replace(uri, range, text) { this._ops.push({ kind: 'replace', uri, range, text }); }
  delete(uri, range) { this._ops.push({ kind: 'delete', uri, range }); }
  createFile(uri, opts) { this._ops.push({ kind: 'createFile', uri, opts: opts || {} }); }
  deleteFile(uri, opts) { this._ops.push({ kind: 'deleteFile', uri, opts: opts || {} }); }
}

// ---------- 配置：环境变量 FOXAI_* 注入，缺省用默认值 ----------
function readEnvConfig(scope) {
  const keys = {
    'workspace.fallbackDir': 'FOXAI_WORKSPACE',
    'skills.storagePath': 'FOXAI_SKILLS_DIR',
    'agent.shell': 'FOXAI_SHELL',
    'webSearch.provider': 'FOXAI_WEBSEARCH_PROVIDER',
    'webSearch.apiKey': 'FOXAI_WEBSEARCH_APIKEY',
    'mcp.modulesPath': 'FOXAI_MCP_MODULES',
    'workspace.globalSearchRoot': 'FOXAI_SEARCH_ROOT',
    'commandTimeout': 'FOXAI_COMMAND_TIMEOUT'
  };
  return {
    get(key, def) {
      const envKey = keys[key];
      if (envKey && process.env[envKey] !== undefined && process.env[envKey] !== '') return process.env[envKey];
      return def;
    },
    update() { return Promise.resolve(); },
    inspect() { return { defaultValue: undefined }; }
  };
}

// ---------- 工作区：CLI 下 cwd 即虚拟工作区根 ----------
const workspaceRoot = () => process.env.FOXAI_WORKSPACE || process.cwd();
const rootUri = () => Uri.file(workspaceRoot());

// ---------- 底层 fs 实现（Uri → 本地路径） ----------
function toFsPath(uri) {
  if (!uri) return workspaceRoot();
  if (typeof uri === 'string') return uri;
  if (uri.fsPath) return uri.fsPath;
  return String(uri);
}

// ---------- vscode 命名空间 ----------
const vscode = {
  Uri, FileType, DiagnosticSeverity, ProgressLocation, ConfigurationTarget, ThemeIcon,
  Position, Range, WorkspaceEdit,
  workspace: {
    getConfiguration: () => readEnvConfig(),
    get workspaceFolders() {
      const root = workspaceRoot();
      return [{ uri: Uri.file(root), name: path.basename(root), index: 0 }];
    },
    fs: {
      async stat(uri) {
        const st = fs.statSync(toFsPath(uri));
        return { type: st.isDirectory() ? FileType.Directory : FileType.File, size: st.size, mtime: st.mtimeMs };
      },
      async readFile(uri) { return fs.readFileSync(toFsPath(uri)); },
      async writeFile(uri, bytes) { fs.writeFileSync(toFsPath(uri), Buffer.from(bytes)); },
      async readDirectory(uri) {
        return fs.readdirSync(toFsPath(uri), { withFileTypes: true }).map((d) => [
          d.name,
          d.isDirectory() ? FileType.Directory : (d.isSymbolicLink() ? FileType.SymbolicLink : FileType.File)
        ]);
      },
      async createDirectory(uri) { fs.mkdirSync(toFsPath(uri), { recursive: true }); },
      async delete(uri, opts) {
        const p = toFsPath(uri);
        if (opts && opts.recursive) fs.rmSync(p, { recursive: true, force: true });
        else { const st = fs.statSync(p); if (st.isDirectory()) fs.rmdirSync(p); else fs.unlinkSync(p); }
      },
      async rename(a, b) { fs.renameSync(toFsPath(a), toFsPath(b)); }
    },
    async applyEdit(edit) {
      // 按 uri 分组，把 insert/replace 落盘（replace 整段 = 写文件）
      const groups = new Map();
      for (const op of edit._ops) {
        const key = toFsPath(op.uri);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(op);
      }
      for (const [p, ops] of groups) {
        let text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
        for (const op of ops) {
          if (op.kind === 'insert') {
            const lines = text.split('\n');
            const at = Math.min(op.pos.line, lines.length);
            lines.splice(at, 0, op.text);
            text = lines.join('\n');
          } else if (op.kind === 'replace' || op.kind === 'delete') {
            text = op.text !== undefined ? String(op.text) : '';
          } else if (op.kind === 'createFile') {
            // 新建文件：直接落盘空/初始内容（workspace.js write_file 用 createFile+insert 组合）
            text = text === '' && ops.some((o) => o.kind === 'insert') ? text : text;
            // createFile 只是「声明创建」，真正内容由同组 insert 写入，这里只需确保父目录存在
            fs.mkdirSync(path.dirname(p), { recursive: true });
            if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf8');
          } else if (op.kind === 'deleteFile') {
            if (fs.existsSync(p)) { const st = fs.statSync(p); if (st.isDirectory()) fs.rmdirSync(p); else fs.unlinkSync(p); }
          }
        }
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text, 'utf8');
      }
      return true;
    },
    async openTextDocument(uri) {
      const p = toFsPath(uri);
      const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
      const lines = text.split('\n');
      const doc = {
        uri: typeof uri === 'string' ? Uri.file(uri) : uri,
        fileName: p,
        getText() { return text; },
        lineAt(n) { return { text: lines[n] || '', lineNumber: n, range: new Range(n, 0, n, lines[n] ? lines[n].length : 0) }; },
        // CLI mock 下文件已同步落盘，save 直接成功（workspace.js 写完文件后会调 doc.save()）
        save: async () => true,
        isDirty: false,
        isClosed: false,
        positionAt(offset) {
          let line = 0, idx = 0;
          while (line < lines.length && idx + lines[line].length < offset) { idx += lines[line].length + 1; line++; }
          return new Position(line, Math.max(0, offset - idx));
        },
        offsetAt(pos) {
          let off = 0;
          for (let i = 0; i < Math.min(pos.line, lines.length); i++) off += lines[i].length + 1;
          return off + (pos.character || 0);
        },
        lineCount: lines.length,
        // workspace.js 写完文件后调 doc.save()（真实 VSCode 落盘）；CLI 下文件已同步写盘，save 直接成功
        save: async () => true,
        isDirty: false,
        isClosed: false
      };
      return doc;
    },
    textDocuments: [],
    registerTextDocumentContentProvider() { return { dispose() {} }; },
    onDidSaveTextDocument() { return { dispose() {} }; }
  },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    tabGroups: { all: [] },
    activeTerminal: undefined,
    terminals: [],
    createTerminal() {
      return { show() {}, sendText() {}, dispose() {}, name: 'fox-cli-terminal', exitStatus: undefined };
    },
    onDidChangeTerminalShellIntegration() { return { dispose() {} }; },
    onDidEndTerminalShellExecution() { return { dispose() {} }; },
    onDidCloseTerminal() { return { dispose() {} }; },
    showInformationMessage() { return Promise.resolve(undefined); },
    showWarningMessage() { return Promise.resolve(undefined); },
    showErrorMessage() { return Promise.resolve(undefined); },
    withProgress(_opts, task) { return task({ report() {} }); },
    showTextDocument() { return Promise.resolve({}); },
    createOutputChannel() { return { appendLine() {}, append() {}, show() {}, clear() {}, dispose() {} }; }
  },
  commands: {
    async executeCommand() { return undefined; },
    registerCommand() { return { dispose() {} }; }
  },
  env: {
    clipboard: { async readText() { return ''; }, async writeText() {} },
    machineId: 'fox-cli',
    appName: 'fox-ai-cli',
    shell: process.env.SHELL || (process.platform === 'win32' ? 'powershell' : 'bash')
  },
  languages: {
    getDiagnostics() { return []; },
    createDiagnosticCollection() { return { set() {}, clear() {}, dispose() {} }; }
  },
  debug: { activeDebugSession: undefined },
  extensions: { getExtension() { return undefined; } },
  version: '1.0.0-cli'
};

module.exports = { vscode, workspaceRoot, toFsPath };