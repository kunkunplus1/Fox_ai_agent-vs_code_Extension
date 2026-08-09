'use strict';

/**
 * src/modes.js — Agent 模式（Code / Architect / Ask / Debug）
 *
 * 对标 Roo Code 的多模式人格：同一个 agent，按当前模式改变三件事——
 *   1) 人格与工作重心（system 提示词后缀）
 *   2) 能动的工具范围（kind 白名单 + 文件路径限制）
 *   3) 使用的模型（每个模式可以配不同模型：架构用贵的强模型，问答用便宜的快模型）
 *
 * 内存与逻辑优化（硬约束）：
 * - 纯 Node，零 vscode / 零 fs 依赖 → 全是纯函数，可离线单测，也不占任何常驻内存。
 * - 模式定义是**模块级常量**，不按会话复制；resolveMode 只在有用户覆盖时才浅拷贝一层。
 * - glob 匹配用一次性编译的正则，并用**有界缓存**（MAX_GLOB_CACHE）记住编译结果，
 *   避免每次工具调用都重新编译正则；缓存超限即整体清空（模式的 glob 数量极少，无需 LRU 开销）。
 * - 门控只在「模式 !== code」时才真正计算，默认模式零开销。
 */

const DEFAULT_MODE = 'code';

/**
 * 内置模式定义。
 * - allowKinds：允许的工具 kind（read / edit / exec / delete…）。null = 不限制。
 * - editGlobs：edit 类工具允许写入的路径 glob 白名单。null = 不限制。
 * - denyTools：额外按工具名禁用（即使 kind 允许）。
 */
const BUILTIN_MODES = {
  code: {
    id: 'code',
    label: '编码',
    emoji: '🦊',
    description: '默认模式：读写代码、跑命令、改 bug，全权限。',
    allowKinds: null,
    editGlobs: null,
    denyTools: [],
    systemSuffix: ''
  },
  architect: {
    id: 'architect',
    label: '架构',
    emoji: '📐',
    description: '只做方案与设计：可以读全部代码、写文档，但不改代码、不跑命令。',
    allowKinds: ['read', 'edit'],
    // 架构师只允许落笔在文档上（Roo Code 同款约束），代码文件一律不许动
    editGlobs: ['**/*.md', '**/*.markdown', '**/*.txt', '**/*.rst', 'docs/**'],
    denyTools: ['run_command', 'delete_file'],
    systemSuffix: `
【当前模式：📐 架构模式】
你现在只负责**想清楚**，不负责动手改代码。
1. 先把需求拆成清晰的方案：目标、边界、涉及模块、数据流、风险点、验收标准。
2. 你可以读任意文件、检索代码来了解现状，但**只能写 Markdown / 文档类文件**，禁止改动任何源码，禁止执行命令。
3. 方案要落到具体文件与函数级别（改哪个文件、加什么函数、谁调谁），不要停在「优化架构」这种空话。
4. 方案讲完后主动提示用户：确认无误可以切到「编码模式」由我来实施。`
  },
  ask: {
    id: 'ask',
    label: '问答',
    emoji: '💬',
    description: '纯只读答疑：解释代码与概念，绝不改动任何东西。',
    allowKinds: ['read'],
    editGlobs: [],
    denyTools: ['run_command', 'write_file', 'edit_file', 'delete_file'],
    systemSuffix: `
【当前模式：💬 问答模式】
你现在**只回答问题，不做任何改动**。
1. 可以读文件、检索代码、联网查资料，用来把问题解释清楚。
2. 禁止写文件、禁止改代码、禁止执行命令——即使用户顺口说「顺手改一下」，也要先说明当前是问答模式，请他切到编码模式。
3. 解释要给出依据（文件名 + 行号 / 检索来源），不要凭印象编造。
4. 需要动手时，给出**建议的改法**（贴出应该改成什么样的代码片段）让用户自己决定。`
  },
  debug: {
    id: 'debug',
    label: '排错',
    emoji: '🔍',
    description: '定位并修复问题：强调先取证再动手，可读可改可跑命令。',
    allowKinds: null,
    editGlobs: null,
    denyTools: [],
    systemSuffix: `
【当前模式：🔍 排错模式】
你现在的任务是**找到真正的根因**，而不是急着改代码。
1. 先取证：用 get_diagnostics / get_terminal_output / 读日志 / 跑最小复现命令，拿到真实报错，不要靠猜。
2. 列出 2~3 个可能原因，说明各自的验证方式，逐个排除，把排除过程讲给用户听。
3. 确认根因后再改，且只做**定位到根因的最小修改**，不要顺手重构无关代码。
4. 改完必须复跑验证（跑测试 / 复现命令 / get_diagnostics），把「改前报错 → 改后结果」一起报告。
5. 如果证据不足以断定根因，如实说明并给出下一步取证建议，禁止用「应该是…吧」搪塞。`
  }
};

const MODE_IDS = Object.keys(BUILTIN_MODES);

// ---- 有界 glob 正则缓存 ----
const MAX_GLOB_CACHE = 64;
const _globCache = new Map();

/** 把 glob 转成正则（支持 ** / * / ?），结果有界缓存 */
function globToRegExp(glob) {
  const key = String(glob || '');
  const hit = _globCache.get(key);
  if (hit) return hit;
  let re = '';
  for (let i = 0; i < key.length; i++) {
    const c = key[i];
    if (c === '*') {
      if (key[i + 1] === '*') {
        // ** 跨目录；后面紧跟 / 时连斜杠一起吃掉，让 docs/** 能匹配 docs 本身下的文件
        i++;
        if (key[i + 1] === '/') i++;
        re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$+.()|{}[]'.includes(c)) {
      re += '\\' + c;
    } else if (c === '/') {
      re += '/';
    } else {
      re += c;
    }
  }
  const compiled = new RegExp('^' + re + '$', 'i');
  if (_globCache.size >= MAX_GLOB_CACHE) _globCache.clear();
  _globCache.set(key, compiled);
  return compiled;
}

/** 统一成 posix 风格相对路径，去掉 ./ 前缀与盘符差异 */
function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function matchAnyGlob(p, globs) {
  if (!Array.isArray(globs) || !globs.length) return false;
  const np = normalizePath(p);
  // 只取相对部分做匹配：绝对路径时用「最后若干段」也能命中 **/*.md
  for (const g of globs) {
    if (globToRegExp(g).test(np)) return true;
    // docs/** 这类相对 glob，对绝对路径做后缀匹配
    if (!g.startsWith('**') && np.includes('/')) {
      const idx = np.toLowerCase().indexOf('/' + normalizePath(g).split('*')[0].toLowerCase());
      if (idx >= 0 && globToRegExp('**/' + g).test(np)) return true;
    }
  }
  return false;
}

/**
 * 取得模式定义（含用户覆盖）。
 * @param {string} id
 * @param {object} [overrides] 形如 { architect: { editGlobs: [...], model: 'gpt-x' } }
 */
function resolveMode(id, overrides) {
  const key = String(id || DEFAULT_MODE).toLowerCase();
  const base = BUILTIN_MODES[key] || BUILTIN_MODES[DEFAULT_MODE];
  const ov = overrides && overrides[base.id];
  if (!ov || typeof ov !== 'object') return base;
  // 只在有覆盖时浅拷贝，避免每次调用都产生新对象
  const merged = Object.assign({}, base);
  if (Array.isArray(ov.allowKinds)) merged.allowKinds = ov.allowKinds;
  if (Array.isArray(ov.editGlobs)) merged.editGlobs = ov.editGlobs;
  if (Array.isArray(ov.denyTools)) merged.denyTools = ov.denyTools;
  if (typeof ov.systemSuffix === 'string' && ov.systemSuffix) merged.systemSuffix = ov.systemSuffix;
  if (typeof ov.model === 'string' && ov.model) merged.model = ov.model;
  return merged;
}

/**
 * 工具门控：当前模式是否允许调用该工具。
 * @param {object} mode resolveMode 的结果
 * @param {{name:string, kind:string, path?:string}} call
 * @returns {{allowed:boolean, reason?:string}}
 */
function isToolAllowed(mode, call) {
  const m = mode || BUILTIN_MODES[DEFAULT_MODE];
  const c = call || {};
  const name = String(c.name || '');
  const kind = String(c.kind || 'read');

  // 默认模式（无任何限制）直接放行，零计算
  if (!(m.denyTools && m.denyTools.length) && !m.allowKinds && !Array.isArray(m.editGlobs)) {
    return { allowed: true };
  }

  if (Array.isArray(m.denyTools) && m.denyTools.includes(name)) {
    return {
      allowed: false,
      reason: `当前是「${m.emoji} ${m.label}模式」，${name} 已被禁用。${m.id === 'ask' ? '问答模式只读，不做任何改动。' : '如需执行，请切换到编码模式。'}`
    };
  }

  if (Array.isArray(m.allowKinds) && !m.allowKinds.includes(kind)) {
    return {
      allowed: false,
      reason: `当前是「${m.emoji} ${m.label}模式」，不允许「${kind}」类操作（工具 ${name}）。请先切换模式再试。`
    };
  }

  if (kind === 'edit' || kind === 'write' || kind === 'delete') {
    if (Array.isArray(m.editGlobs)) {
      if (!m.editGlobs.length) {
        return { allowed: false, reason: `当前是「${m.emoji} ${m.label}模式」，禁止写入任何文件。` };
      }
      const p = c.path;
      if (!p) {
        return { allowed: false, reason: `当前是「${m.emoji} ${m.label}模式」，写操作必须指明目标路径。` };
      }
      if (!matchAnyGlob(p, m.editGlobs)) {
        return {
          allowed: false,
          reason: `当前是「${m.emoji} ${m.label}模式」，只允许写入 ${m.editGlobs.join('、')}，${p} 不在允许范围内。方案写文档即可，改代码请切到编码模式。`
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * 每模式独立模型：返回该模式要覆盖的模型名，没有配置则返回 ''（用主模型）。
 * @param {string} id
 * @param {object} models 形如 { architect: 'claude-opus', ask: 'deepseek-chat' }
 */
function modelFor(id, models) {
  if (!models || typeof models !== 'object') return '';
  const key = String(id || DEFAULT_MODE).toLowerCase();
  const v = models[key];
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

/** 供设置界面/快捷选择用的列表 */
function listModes() {
  return MODE_IDS.map((id) => {
    const m = BUILTIN_MODES[id];
    return { id: m.id, label: m.label, emoji: m.emoji, description: m.description };
  });
}

/** 渲染注入系统提示词的模式段落（code 模式返回 ''，不浪费 token） */
function renderForPrompt(mode) {
  const m = mode || BUILTIN_MODES[DEFAULT_MODE];
  return m.systemSuffix ? m.systemSuffix.trim() : '';
}

module.exports = {
  DEFAULT_MODE,
  BUILTIN_MODES,
  MODE_IDS,
  MAX_GLOB_CACHE,
  globToRegExp,
  normalizePath,
  matchAnyGlob,
  resolveMode,
  isToolAllowed,
  modelFor,
  listModes,
  renderForPrompt
};
