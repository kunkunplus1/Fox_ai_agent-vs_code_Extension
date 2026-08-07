'use strict';

/**
 * src/memory.js — 狐狸 AI 的长期记忆
 *
 * 让 agent 像人一样跨会话记住用户的偏好、项目约定与踩过的坑。
 * 记忆以 JSON 文件持久化（默认在扩展 globalStorage 的 memory/ 下），
 * 每次对话开始时把摘要注入系统提示词，agent 还能用 save_memory / get_memory 工具自主读写。
 */

const fs = require('fs');
const path = require('path');
const { appendLog } = require('./log');

const MAX_PROMPT_CHARS = 4000;

// 字符 bigram 集合，用于近重复判定
function bigrams(s) {
  const out = [];
  const str = String(s || '');
  for (let i = 0; i < str.length - 1; i++) out.push(str.slice(i, i + 2));
  return out;
}

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(process.env.HOME || process.env.USERPROFILE || '', p.slice(2));
  if (p.startsWith('~\\')) return path.join(process.env.USERPROFILE || '', p.slice(2));
  return p;
}

function resolvePath(globalStorageDir, customDir) {
  const base = (customDir || '').trim()
    ? path.join(path.resolve(expandHome(customDir)), 'memory')
    : path.join(globalStorageDir, 'memory');
  return path.join(base, 'memory.json');
}

function defaultPath(globalStorageDir) {
  return resolvePath(globalStorageDir, '');
}

function safeLoad(file) {
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data.items)) return data.items;
    }
  } catch (_) {}
  return [];
}

class MemoryStore {
  constructor(globalStorageDir, customDir) {
    this.file = resolvePath(globalStorageDir, customDir);
    this.items = safeLoad(this.file);
  }

  all() {
    return this.items.slice();
  }

  /** 新增一条记忆；text 为空直接忽略。返回新建的条目或 null */
  add({ text, tags, category }) {
    const t = String(text || '').trim();
    if (!t) return null;
    // 近重复去重：避免长期堆积近似记忆（归一化相等 / 字符 bigram jaccard >= 0.9）
    const norm = t.replace(/\s+/g, '').toLowerCase();
    const dup = this.items.find((it) => {
      const n = String(it.text || '').replace(/\s+/g, '').toLowerCase();
      if (!n) return false;
      if (n === norm) return true;
      if (norm.length >= 8 && n.length >= 8) {
        const setA = new Set(bigrams(norm));
        const setB = new Set(bigrams(n));
        if (!setA.size || !setB.size) return false;
        let inter = 0;
        for (const g of setA) if (setB.has(g)) inter++;
        const jac = inter / (setA.size + setB.size - inter);
        return jac >= 0.9;
      }
      return false;
    });
    if (dup) {
      dup.updatedAt = Date.now();
      this._persist();
      appendLog('memory', '[add-skip-dup] text=' + t.slice(0, 60));
      return dup;
    }
    const now = Date.now();
    const item = {
      id: 'm' + now.toString(36) + Math.random().toString(36).slice(2, 6),
      text: t,
      tags: Array.isArray(tags)
        ? tags.map(String)
        : tags
        ? String(tags).split(',').map((t) => t.trim()).filter(Boolean)
        : [],
      category: category || 'general',
      createdAt: now,
      updatedAt: now
    };
    this.items.push(item);
    this._persist();
    appendLog('memory', '[add] category=' + (category || 'general') + ' tags=' + (item.tags.join(',') || '无') + ' text=' + t.slice(0, 60));
    return item;
  }

  update(id, text) {
    const it = this.items.find((x) => x.id === id);
    if (!it) return false;
    const t = String(text || '').trim();
    if (!t) return false;
    it.text = t;
    it.updatedAt = Date.now();
    this._persist();
    return true;
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((x) => x.id !== id);
    const changed = this.items.length !== before;
    if (changed) this._persist();
    return changed;
  }

  /** 关键字/标签检索，无 query 则返回全部 */
  search(query) {
    const q = query ? String(query).toLowerCase() : '';
    const result = !q
      ? this.items.slice()
      : this.items.filter(
          (it) =>
            it.text.toLowerCase().includes(q) ||
            (it.tags || []).some((t) => t.toLowerCase().includes(q))
        );
    appendLog('memory', '[search] query=' + (query ? String(query).slice(0, 40) : '全部') + ' hits=' + result.length);
    return result;
  }

  /** 生成注入系统提示词的 Markdown 摘要（按更新时间倒序，带大小上限） */
  renderForPrompt() {
    if (!this.items.length) return '';
    const sorted = this.items.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    const lines = [
      '你拥有一条长期记忆（跨会话保存的用户偏好、项目约定与踩坑教训），处理任务时请参考它们：'
    ];
    let chars = 0;
    for (const it of sorted) {
      const line = `- ${it.text}`;
      if (chars + line.length + 40 > MAX_PROMPT_CHARS) break;
      lines.push(line);
      chars += line.length;
    }
    lines.push(
      '\n（若某条记忆与当前任务无关可忽略；当用户纠正了你、透露了新偏好或确定了项目约定时，请用 save_memory 工具记下来。）'
    );
    return lines.join('\n');
  }

  _persist() {
    const dir = path.dirname(this.file);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
    try {
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, items: this.items }, null, 2), 'utf8');
    } catch (_) {}
  }
}

module.exports = { MemoryStore, defaultPath, resolvePath };
