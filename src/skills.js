'use strict';

/**
 * src/skills.js — 狐狸 AI 的用户技能（agent 自己给自己写的可复用工作流）
 *
 * 与「自带技能」（WorkBuddy 的 ~/.workbuddy/skills/）完全隔开：
 * 用户技能只存在 fox-ai 自己的 globalStorage 下「user-skills/」目录，
 * 由 agent 通过 create_skill 自主创建、use_skill 自主调用。
 *
 * 每个技能是一个目录：user-skills/<name>/SKILL.md
 *   SKILL.md 顶部是 YAML frontmatter（name / description / when_to_use），下面是 Markdown 指导。
 *   可选的 run.js 是该技能的脚本，use_skill 激活时会被执行。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MAX_PROMPT_CHARS = 2000;

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(process.env.HOME || process.env.USERPROFILE || '', p.slice(2));
  if (p.startsWith('~\\')) return path.join(process.env.USERPROFILE || '', p.slice(2));
  return p;
}

/**
 * 找到能用于执行 node 脚本的 node 可执行文件。
 * 注意：VS Code 扩展宿主里 process.execPath 是 Code.exe / Electron，
 * 不能直接当 node 用；必须找到真正的 node，否则脚本会被当成 Electron 启动而报错。
 */
function resolveNodeBin() {
  try {
    execFileSync('node', ['-v'], { stdio: 'ignore' });
    return 'node';
  } catch (_) { /* 不在 PATH */ }
  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs', 'node.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'node.exe'),
    process.env.NVM_HOME && path.join(process.env.NVM_HOME, 'node.exe'),
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe'
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'node';
}

function resolveDir(globalStorageDir, customDir) {
  return (customDir || '').trim()
    ? path.join(path.resolve(expandHome(customDir)), 'user-skills')
    : path.join(globalStorageDir || '', 'user-skills');
}

function defaultDir(globalStorageDir) {
  return resolveDir(globalStorageDir, '');
}

function skillDir(baseDir, name) {
  return path.join(baseDir, name);
}

function sanitizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function parseFrontmatter(text) {
  const m = String(text || '').match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: String(text || '') };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[k] = v;
  }
  return { meta, body: String(text || '').slice(m[0].length) };
}

function buildSkillFile({ name, description, whenToUse, body, interactive }) {
  const fm =
    '---\n' +
    `name: ${name}\n` +
    `description: ${description || ''}\n` +
    `when_to_use: ${whenToUse || ''}\n` +
    `interactive: ${interactive ? 'true' : 'false'}\n` +
    '---\n\n' +
    (body && body.trim() ? body.trim() + '\n' : '');
  return fm;
}

class UserSkillStore {
  constructor(globalStorageDir, customDir) {
    this.baseDir = resolveDir(globalStorageDir, customDir);
  }

  list() {
    try {
      if (!fs.existsSync(this.baseDir)) return [];
      return fs
        .readdirSync(this.baseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => this._metaOf(d.name))
        .filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  _metaOf(name) {
    const dir = skillDir(this.baseDir, name);
    const file = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    return {
      name: meta.name || name,
      description: meta.description || '',
      whenToUse: meta.when_to_use || '',
      interactive: meta.interactive === 'true' || meta.interactive === true,
      hasScript: fs.existsSync(path.join(dir, 'run.js')),
      path: file,
      body
    };
  }

  get(name) {
    const dir = skillDir(this.baseDir, name);
    const file = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
  }

  /**
   * 创建一个用户技能。body 为 Markdown 指导正文；script 可选，为脚本源码（写入 run.js 并做 node --check）。
   * @returns { ok:boolean, errors:string[], path:string }
   */
  create({ name, description, whenToUse, body, script, interactive, overwrite }) {
    const errors = [];
    const safe = sanitizeName(name);
    if (!safe) errors.push('技能名不能为空，且只能包含小写字母、数字、-、_');
    if (!body || !String(body).trim()) errors.push('技能指导 body 不能为空');
    if (errors.length) return { ok: false, errors, path: '' };

    // 去重：已存在的同名技能默认禁止重复创建，避免模型陷入
    // 「use_skill 激活 → create_skill 同名重写」的死循环（见 0.8.61）。
    // 模型应直接 use_skill 激活执行，或用 create_plan_task 跟踪进度；
    // 确实需要更新技能内容时，显式传 overwrite:true 即可。
    const existing = this._metaOf(safe);
    if (existing && !overwrite) {
      return {
        ok: false,
        errors: [
          `技能「${safe}」已存在，禁止重复创建。请直接用 use_skill 激活它执行任务，` +
          `或用 create_plan_task 把本次需求拆成可见清单；不要再次调用 create_skill。` +
          `（若你确实要主动更新该技能内容，请显式传 overwrite:true。）`
        ],
        path: existing.path
      };
    }

    const dir = skillDir(this.baseDir, safe);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      return { ok: false, errors: ['无法创建技能目录：' + e.message], path: '' };
    }

    // 写 SKILL.md
    const content = buildSkillFile({ name: safe, description, whenToUse, body, interactive });
    const skillPath = path.join(dir, 'SKILL.md');
    try {
      fs.writeFileSync(skillPath, content, 'utf8');
    } catch (e) {
      errors.push('写入 SKILL.md 失败：' + e.message);
      return { ok: false, errors, path: skillPath };
    }

    // 可选脚本：写入并自动校验语法
    if (script && String(script).trim()) {
      const scriptPath = path.join(dir, 'run.js');
      try {
        fs.writeFileSync(scriptPath, String(script), 'utf8');
      } catch (e) {
        errors.push('写入脚本失败：' + e.message);
        return { ok: false, errors, path: skillPath };
      }
      try {
        execFileSync(resolveNodeBin(), ['--check', scriptPath], { stdio: 'pipe' });
      } catch (e) {
        errors.push('脚本语法检查未通过（node --check）：' + String(e.stderr || e.message).split('\n').slice(0, 3).join(' '));
        return { ok: false, errors, path: skillPath };
      }
    }

    return { ok: true, errors, path: skillPath };
  }

  remove(name) {
    const safe = sanitizeName(name);
    const dir = skillDir(this.baseDir, safe);
    if (!fs.existsSync(dir)) return false;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 激活一个技能：读取指导；非交互式脚本会在这里执行，交互式脚本请在外部用终端启动 */
  activate(name, query) {
    const meta = this._metaOf(name);
    if (!meta) return { ok: false, reason: `没有名为「${name}」的技能`, guidance: '', output: '', hasScript: false, interactive: false };
    let scriptOut = '';
    // 交互式脚本不在此处执行（避免阻塞 stdin），由调用方启动到集成终端
    if (meta.hasScript && !meta.interactive) {
      const scriptPath = path.join(skillDir(this.baseDir, name), 'run.js');
      try {
        scriptOut = execFileSync(resolveNodeBin(), [scriptPath], { cwd: skillDir(this.baseDir, name), encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        scriptOut = '[脚本执行出错] ' + String(e.stderr || e.message).split('\n').slice(0, 5).join('\n');
      }
    }
    return { ok: true, reason: '', guidance: meta.body, output: scriptOut, whenToUse: meta.whenToUse, hasScript: meta.hasScript, interactive: meta.interactive };
  }

  /** 生成注入系统提示词的技能清单（带大小上限） */
  renderForPrompt() {
    const items = this.list();
    if (!items.length) return '';
    const lines = ['你拥有以下用户技能（agent 自己编写的可复用工作流），当用户需求匹配 when_to_use 时，应调用 use_skill 激活它并按其指导执行：'];
    let chars = 0;
    for (const it of items) {
      const line = `- ${it.name}：${it.description}${it.whenToUse ? '（适用：' + it.whenToUse + '）' : ''}${it.hasScript ? ' [含脚本]' : ''}`;
      if (chars + line.length + 20 > MAX_PROMPT_CHARS) break;
      lines.push(line);
      chars += line.length;
    }
    return lines.join('\n');
  }
}

module.exports = { UserSkillStore, defaultDir, sanitizeName, resolveDir };
