'use strict';

const vscode = require('vscode');

const GROUP_LABELS = {
  today: '今天',
  yesterday: '昨天',
  week: '7 天内',
  older: '更早'
};

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function groupKey(ts) {
  const now = Date.now();
  const today = startOfDay(now);
  const yesterday = today - 86400000;
  const week = today - 86400000 * 7;
  if (ts >= today) return 'today';
  if (ts >= yesterday) return 'yesterday';
  if (ts >= week) return 'week';
  return 'older';
}

class SessionItem extends vscode.TreeItem {
  constructor(session, isCurrent) {
    super(session.title, vscode.TreeItemCollapsibleState.None);
    this.id = session.id;
    this.contextValue = 'foxAi.session';
    this.tooltip = `${session.title}\n更新：${new Date(session.updatedAt).toLocaleString()}`;
    this.description = isCurrent ? '当前' : new Date(session.updatedAt).toLocaleDateString();
    this.iconPath = isCurrent ? new vscode.ThemeIcon('comment-discussion') : new vscode.ThemeIcon('comment');
    this.command = {
      command: 'foxAi.switchSession',
      title: '切换会话',
      arguments: [session.id]
    };
  }
}

class GroupItem extends vscode.TreeItem {
  constructor(key, count) {
    super(`${GROUP_LABELS[key] || key} (${count})`, vscode.TreeItemCollapsibleState.Expanded);
    this.id = 'group:' + key;
    this.contextValue = 'foxAi.sessionGroup';
  }
}

class SessionTreeProvider {
  constructor(sessionManager, chatProvider) {
    this.manager = sessionManager;
    this.chatProvider = chatProvider;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
    this.manager.onChange(() => this.refresh());
  }

  refresh() {
    this._onDidChange.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    if (!element) {
      const sessions = this.manager.list();
      const currentId = this.manager.currentId();
      const groups = {};
      for (const s of sessions) {
        const k = groupKey(s.updatedAt);
        if (!groups[k]) groups[k] = [];
        groups[k].push(new SessionItem(s, s.id === currentId));
      }
      const order = ['today', 'yesterday', 'week', 'older'];
      const out = [];
      for (const k of order) {
        if (groups[k]) out.push(new GroupItem(k, groups[k].length));
      }
      return out;
    }
    if (element instanceof GroupItem) {
      const key = element.id.replace('group:', '');
      const sessions = this.manager.list().filter((s) => groupKey(s.updatedAt) === key);
      const currentId = this.manager.currentId();
      return sessions.map((s) => new SessionItem(s, s.id === currentId));
    }
    return [];
  }
}

module.exports = { SessionTreeProvider };
