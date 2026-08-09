'use strict';

/**
 * src/fileNav.js — 文件导航树（活动栏「狐狸 AI」下的「文件」视图）
 *
 * 两个分组：
 *   本次会话涉及：agent 在本次会话里读 / 写 / 打开过的文件，按时间倒序，点击可跳转并定位行号。
 *   工作区文件：当前工作区的文件树（目录可展开），点击直接打开。
 *
 * 作用：大项目里不用在资源管理器里翻找，agent 碰过的文件一目了然，点一下就跳过去。
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'out', 'dist', 'build', '.vscode',
  'target', 'bin', 'obj', '.next', 'coverage', '.cache', '.idea'
]);

const MAX_PER_DIR = 1200;

const OP_COLOR = {
  '读': 'charts.blue',
  '写': 'charts.orange',
  '修改': 'charts.green',
  '引用': 'charts.purple',
  '打开': 'charts.blue'
};

class FileItem extends vscode.TreeItem {
  constructor(opts) {
    super(path.basename(opts.path), vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'foxAi.navFile';
    this.resourceUri = vscode.Uri.file(opts.path);
    this.tooltip = opts.path + (opts.line ? ' :' + opts.line : '');
    this.description = opts.description || '';
    const colorKey = OP_COLOR[opts.op] || 'charts.purple';
    this.iconPath = new vscode.ThemeIcon('file', new vscode.ThemeColor(colorKey));
    this.command = {
      command: 'foxAi.openFileAt',
      title: '打开',
      arguments: [opts.path, opts.line || 0, opts.op || '']
    };
  }
}

class DirItem extends vscode.TreeItem {
  constructor(dirPath) {
    super(path.basename(dirPath) || dirPath, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'foxAi.navDir';
    this.id = 'dir:' + dirPath;
    this.pathValue = dirPath;
    this.resourceUri = vscode.Uri.file(dirPath);
    this.iconPath = new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.yellow'));
  }
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

class GroupItem extends vscode.TreeItem {
  constructor(label, id) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'foxAi.navGroup';
    this.id = id;
    this.iconPath = id === 'session'
      ? new vscode.ThemeIcon('history', new vscode.ThemeColor('charts.orange'))
      : new vscode.ThemeIcon('folder-opened', new vscode.ThemeColor('charts.blue'));
  }
}

class FileNavProvider {
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
    /** path -> { path, line, op, ts } */
    this.sessionFiles = new Map();
  }

  refresh() {
    this._onDidChange.fire();
  }

  /** agent 触碰了某个文件就记下来（相对路径自动解析到工作区根） */
  addFile(p, opts) {
    if (!p) return;
    let abs = p;
    if (!path.isAbsolute(p)) {
      const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
      if (folder) abs = path.join(folder.uri.fsPath, p);
    }
    const prev = this.sessionFiles.get(abs) || {};
    this.sessionFiles.set(abs, {
      path: abs,
      line: opts && opts.line ? opts.line : prev.line || 0,
      op: (opts && opts.op) || prev.op || '引用',
      ts: Date.now()
    });
    this.refresh();
  }

  /** 平铺返回工作区所有文件（用于「跳转任意文件」快速选择） */
  allWorkspaceFiles() {
    const folder = vscode.workspace.workspaceFolders && vscode.workspaceFolders[0];
    if (!folder) return [];
    const out = [];
    const walk = (dir, depth) => {
      if (depth > 6 || out.length >= 2000) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const e of entries) {
        if (IGNORE_DIRS.has(e.name)) continue;
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) walk(fp, depth + 1);
        else if (out.length < 2000) out.push(fp);
      }
    };
    walk(folder.uri.fsPath, 0);
    return out.sort();
  }

  _listDir(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return [];
    }
    const dirs = [];
    const files = [];
    for (const e of entries) {
      if (e.name === '.git' || IGNORE_DIRS.has(e.name)) continue;
      if (e.isDirectory()) dirs.push(e.name);
      else files.push(e.name);
    }
    dirs.sort();
    files.sort();
    const out = [];
    for (const d of dirs) {
      if (out.length >= MAX_PER_DIR) break;
      out.push(new DirItem(path.join(dir, d)));
    }
    const parentName = path.basename(dir);
    for (const f of files) {
      if (out.length >= MAX_PER_DIR) break;
      out.push(new FileItem({ path: path.join(dir, f) }));
    }
    return out;
  }

  getTreeItem(el) {
    return el;
  }

  getChildren(el) {
    if (!el) {
      const groups = [];
      if (this.sessionFiles.size) {
        groups.push(new GroupItem('本次会话涉及 (' + this.sessionFiles.size + ')', 'session'));
      }
      groups.push(new GroupItem('工作区文件', 'workspace'));
      return groups;
    }
    if (el.id === 'session') {
      return Array.from(this.sessionFiles.values())
        .sort((a, b) => b.ts - a.ts)
        .map((f) =>
          new FileItem({
            path: f.path,
            line: f.line,
            op: f.op,
            description: f.op + (f.line ? ' · ' + f.line + ' 行' : '')
          })
        );
    }
    if (el.id === 'workspace') {
      const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
      if (!folder) return [];
      return this._listDir(folder.uri.fsPath);
    }
    if (el.id && el.id.startsWith('dir:')) {
      return this._listDir(el.pathValue);
    }
    return [];
  }
}

module.exports = { FileNavProvider };
