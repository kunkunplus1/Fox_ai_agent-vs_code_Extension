'use strict';

/**
 * src/planTasks.js — 狐狸 AI 的项目任务清单
 *
 * 让 agent 把多步骤项目拆成可见的 checklist：
 * - pending   ○ 未开始
 * - in_progress 🔄 进行中
 * - completed ✓ 已完成
 *
 * 任务目标可由 AI 自动总结（配置 foxAi.planTask.* 指定用哪个 AI）。
 * 存储在扩展 globalStorage 的 plan-tasks.json 中。
 */

const fs = require('fs');
const path = require('path');
const { chatNonStream } = require('./client');
const config = require('./config');

const MAX_PROMPT_CHARS = 2500;
const STATUS = { PENDING: 'pending', IN_PROGRESS: 'in_progress', COMPLETED: 'completed' };

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(process.env.HOME || process.env.USERPROFILE || '', p.slice(2));
  if (p.startsWith('~\\')) return path.join(process.env.USERPROFILE || '', p.slice(2));
  return p;
}

function resolvePath(globalStorageDir, customDir) {
  return (customDir || '').trim()
    ? path.join(path.resolve(expandHome(customDir)), 'plan-tasks.json')
    : path.join(globalStorageDir, 'plan-tasks.json');
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

class PlanTaskStore {
  constructor(globalStorageDir, opts) {
    opts = opts || {};
    this.file = opts.file || resolvePath(globalStorageDir, opts.customDir);
    this.items = safeLoad(this.file);
    this.onChange = opts.onChange || null;
    this.context = opts.context || null;
  }

  list() {
    // 稳定排序：状态分组（in_progress 最前 → pending 中间 → completed 沉底），
    // 同类内按创建时间升序，避免「按 updatedAt 降序」导致任务随每次更新乱跳、completed 被顶到最前。
    const rank = { in_progress: 0, pending: 1, completed: 2 };
    return this.items.slice().sort((a, b) => {
      const ra = rank[a.status] !== undefined ? rank[a.status] : 1;
      const rb = rank[b.status] !== undefined ? rank[b.status] : 1;
      if (ra !== rb) return ra - rb;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
  }

  /** 新增任务；如果 rawContext 非空且缺少 subject/description，会按配置调用 AI 总结 */
  async create({ subject, description, rawContext, status }) {
    let finalSubject = String(subject || '').trim();
    let finalDescription = String(description || '').trim();

    if (rawContext && (!finalSubject || !finalDescription) && this.context) {
      try {
        const cfg = await config.resolve(this.context);
        const summarized = await this.summarize(rawContext, cfg);
        finalSubject = finalSubject || summarized.subject;
        finalDescription = finalDescription || summarized.description;
      } catch (e) {
        console.error('[fox-ai planTasks] summarize failed:', e && e.message);
      }
    }

    if (!finalSubject) {
      finalSubject = String(rawContext || '未命名任务').replace(/\s+/g, ' ').slice(0, 60);
    }
    if (!finalDescription) {
      finalDescription = String(rawContext || '').replace(/\s+/g, ' ').slice(0, 200);
    }

    const now = Date.now();
    const item = {
      id: 'pt' + now.toString(36) + Math.random().toString(36).slice(2, 6),
      subject: finalSubject,
      description: finalDescription,
      status: Object.values(STATUS).includes(status) ? status : STATUS.PENDING,
      createdAt: now,
      updatedAt: now,
      completedAt: null
    };
    this.items.push(item);
    this._persist();
    this._notify();
    return item;
  }

  /** 更新任务（subject / description / status） */
  update(id, changes) {
    changes = changes || {};
    let it = this.items.find((x) => x.id === id);
    // 兜底：模型幻觉/记错 id 时，若同时提供了 subject，按 subject（trim 后相等）模糊匹配，
    // 避免「找不到任务」导致已完成步骤被标成没完成（状态更新丢失）。
    if (!it && changes.subject) {
      const subj = String(changes.subject || '').trim();
      if (subj) it = this.items.find((x) => String(x.subject || '').trim() === subj);
    }
    if (!it) return null;
    if (changes.subject !== undefined) it.subject = String(changes.subject || '').trim() || it.subject;
    if (changes.description !== undefined) it.description = String(changes.description || '').trim();
    if (changes.status && Object.values(STATUS).includes(changes.status)) {
      it.status = changes.status;
      it.completedAt = it.status === STATUS.COMPLETED ? Date.now() : null;
    }
    it.updatedAt = Date.now();
    this._persist();
    this._notify();
    return it;
  }

  setStatus(id, status) {
    return this.update(id, { status });
  }

  /** 一键清理所有 completed 状态的任务，返回被清理的任务数量 */
  clearCompleted() {
    const before = this.items.length;
    this.items = this.items.filter((x) => x.status !== STATUS.COMPLETED);
    const removed = before - this.items.length;
    if (removed) {
      this._persist();
      this._notify();
    }
    return removed;
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((x) => x.id !== id);
    if (this.items.length !== before) {
      this._persist();
      this._notify();
      return true;
    }
    return false;
  }

  /**
   * 整表替换（DSH todo_write 语义）：模型传完整 [{ content, status }] 列表，
   * 本清单直接以该列表为准——不依赖任何 id，彻底规避「模型记不住 id → 更新失败/重复创建」。
   * - 空 content 跳过；重复 content 去重（保留首个）
   * - content 截断到 200 字符（与 create 方法的 subject+description 上限对齐，防超长内容撑爆存储）
   * - 同 content 的旧任务复用其 id/createdAt（仅更新 status），保持 id 稳定、不产生重复项
   * - 不在新列表里的旧任务被移除
   * - 数组长度上限 200（防模型刷海量 todo 撑爆 plan-tasks.json）
   * 返回 { pending, inProgress, completed } 计数。
   */
  replaceAll(todos) {
    // 1.1.23：容错「todos 被模型传成字符串」——文本协议模型常见把整个数组二次 JSON 序列化
    // （todos 是 "[{...}]" 字符串而非数组），或 safeParseArgs 宽松修复后仍留下字符串值。
    // 字符串统一先 parse 成数组再走整表替换，彻底根治「任务清单内容为空」。
    // 1.1.24（对齐 dsh todo_write「响亮失败」）：既不是数组、也解析不出任何任务的输入，
    // 返回 { _error } 让调用方把具体错误回灌给模型，而不是静默空清单（空清单=模型以为写成功=又一轮困惑）。
    let arr = null;
    let silentError = null;
    if (Array.isArray(todos)) {
      arr = todos;
    } else if (typeof todos === 'string') {
      const trimmed = todos.trim();
      if (!trimmed) {
        silentError = 'todos 是空字符串';
      } else {
        // 先试 JSON 数组
        let parsed = null;
        try {
          parsed = JSON.parse(trimmed);
        } catch (_) { parsed = null; }
        if (Array.isArray(parsed)) {
          arr = parsed;
        } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          // 单个对象 {content,status} 而非数组——常见错误，包一层
          if (parsed.content) arr = [parsed];
          else silentError = 'todos 是单个对象但缺 content 字段（应为数组，如 [{"content":"..."}]）';
        } else {
          // 行式兜底：形如「1. xxx / - xxx / • xxx」时逐行拆成任务
          const rows = trimmed
            .split(/\n+/)
            .map((r) => r.replace(/^\s*(?:[-*•]|\d+[.、])\s*/, '').trim())
            .filter((r) => r && r.length > 1);
          if (rows.length) {
            arr = rows.map((c) => ({ content: c, status: STATUS.PENDING }));
          } else if (trimmed.length > 0 && trimmed.length <= 200 && !/[\n{}\[\]]/.test(trimmed)) {
            // 单行纯文本：当成一条任务（形如「第一步：xxx」）
            arr = [{ content: trimmed.slice(0, 200), status: STATUS.PENDING }];
          } else {
            silentError = `todos 解析失败（既非 JSON 数组也非任务列表文本，内容前 80 字符：${trimmed.slice(0, 80)}）`;
          }
        }
      }
    } else if (todos && typeof todos === 'object') {
      // 单个对象（safeParseArgs 可能把数组解析成对象的情况）
      if (todos.content) arr = [todos];
      else silentError = 'todos 是对象但缺 content 字段（应为 [{content,status}] 数组）';
    } else if (todos === null || todos === undefined) {
      silentError = 'todos 缺失（必填：完整任务列表数组）';
    } else {
      silentError = `todos 类型错误（${typeof todos}，应为数组）`;
    }
    // 响亮失败：解析不出任何任务时返回错误描述，由调用方回灌给模型
    if (!Array.isArray(arr) || arr.length === 0) {
      if (!silentError && Array.isArray(arr) && arr.length === 0) {
        silentError = 'todos 是空数组（至少应有一条任务）';
      }
      return { _error: silentError || 'todos 无法解析为任务列表' };
    }
    const now = Date.now();
    const seen = new Set();
    const next = [];
    const MAX_CONTENT = 200;     // 单条 content 上限（字符）
    const MAX_ITEMS = 200;       // 列表条数上限
    for (const t of arr) {
      if (next.length >= MAX_ITEMS) break; // 防刷爆
      const content = String((t && t.content) || '').trim().slice(0, MAX_CONTENT);
      if (!content) continue;
      if (seen.has(content)) continue;
      seen.add(content);
      const status = Object.values(STATUS).includes(t && t.status) ? t.status : STATUS.PENDING;
      const old = this.items.find((x) => String(x.subject || '').trim() === content);
      if (old) {
        next.push(Object.assign({}, old, {
          status,
          completedAt: status === STATUS.COMPLETED ? (old.completedAt || now) : null,
          updatedAt: now
        }));
      } else {
        next.push({
          id: 'pt' + now.toString(36) + Math.random().toString(36).slice(2, 6),
          subject: content,
          description: '',
          status,
          createdAt: now,
          completedAt: status === STATUS.COMPLETED ? now : null,
          updatedAt: now
        });
      }
    }
    this.items = next;
    this._persist();
    this._notify();
    return {
      pending: next.filter((x) => x.status === STATUS.PENDING).length,
      inProgress: next.filter((x) => x.status === STATUS.IN_PROGRESS).length,
      completed: next.filter((x) => x.status === STATUS.COMPLETED).length
    };
  }

  nextStatus(id) {
    const it = this.items.find((x) => x.id === id);
    if (!it) return null;
    const order = [STATUS.PENDING, STATUS.IN_PROGRESS, STATUS.COMPLETED];
    const idx = order.indexOf(it.status);
    const next = order[(idx + 1) % order.length];
    return this.setStatus(id, next);
  }

  /** 用指定 AI 把原始上下文总结成 subject + description */
  async summarize(rawContext, cfg) {
    if (!rawContext || !this.context) {
      return { subject: '', description: '' };
    }
    const providerId = (cfg.planTask && cfg.planTask.provider) || cfg.providerId;
    const model = (cfg.planTask && cfg.planTask.model) || cfg.model || config.modelName(providerId);
    const baseUrl = (cfg.planTask && cfg.planTask.baseUrl) || config.baseUrlFor(providerId);
    const apiKey = await config.getApiKey(this.context, providerId);

    const prompt =
      '请把下面的需求/上下文总结成一条任务清单项。要求：\n' +
      '- 用一句简短的话作为 subject（不超过 30 字）\n' +
      '- 用一两句话作为 description（说明具体要做什么、验收标准）\n' +
      '- 直接返回 JSON：{"subject":"...","description":"..."}\n\n' +
      '上下文：\n' + String(rawContext).slice(0, 2000);

    const res = await chatNonStream({
      baseUrl,
      apiKey,
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      maxTokens: 512,
      timeout: 30000
    });

    const text = res.content || '';
    const m = text.match(/\{[\s\S]*?\}/);
    if (m) {
      try {
        const data = JSON.parse(m[0]);
        return {
          subject: String(data.subject || '').trim(),
          description: String(data.description || '').trim()
        };
      } catch (_) {}
    }
    return { subject: '', description: '' };
  }

  /** 生成注入系统提示词的 Markdown 摘要 */
  renderForPrompt() {
    if (!this.items.length) return '';
    const sorted = this.list();
    const lines = ['当前项目的可见任务清单（请按状态推进，完成后及时更新）：'];
    let chars = 0;
    for (const it of sorted) {
      const mark =
        it.status === STATUS.COMPLETED ? '✓' : it.status === STATUS.IN_PROGRESS ? '🔄' : '○';
      const line = `${mark} ${it.subject}${it.description ? ' — ' + it.description : ''}`;
      if (chars + line.length + 40 > MAX_PROMPT_CHARS) break;
      lines.push(line);
      chars += line.length;
    }
    lines.push(
      '\n规则：遇到多步骤项目任务时，先用 create_plan_task 拆分；每完成一步用 update_plan_task 标记 completed；当前步骤标 in_progress。'
    );
    return lines.join('\n');
  }

  _persist() {
    const dir = path.dirname(this.file);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
    try {
      fs.writeFileSync(
        this.file,
        JSON.stringify({ version: 1, items: this.items }, null, 2),
        'utf8'
      );
    } catch (_) {}
  }

  _notify() {
    if (typeof this.onChange === 'function') {
      try {
        this.onChange();
      } catch (_) {}
    }
  }
}

module.exports = { PlanTaskStore, STATUS, defaultPath, resolvePath };
