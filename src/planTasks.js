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
    return this.items.slice().sort((a, b) => b.updatedAt - a.updatedAt);
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
    const it = this.items.find((x) => x.id === id);
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
    const sorted = this.items.slice().sort((a, b) => b.updatedAt - a.updatedAt);
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
