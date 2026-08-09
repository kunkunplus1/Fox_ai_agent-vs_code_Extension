'use strict';
/**
 * 一次性脚本：为 1.0.0 六大新能力补齐 package.json 的配置项、命令与 i18n 文案。
 * 幂等：重复执行不会产生重复项。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkgFile = path.join(root, 'package.json');
const nlsFile = path.join(root, 'package.nls.json');
const nlsEnFile = path.join(root, 'package.nls.en.json');

const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const nls = JSON.parse(fs.readFileSync(nlsFile, 'utf8'));
const nlsEn = JSON.parse(fs.readFileSync(nlsEnFile, 'utf8'));

// ---- i18n 键分配：从现有最大编号往后排 ----
let nextNum = Object.keys(nls)
  .filter((k) => /^foxai\.n\d+$/.test(k))
  .reduce((m, k) => Math.max(m, +k.slice(7)), 0);

const keyByText = new Map();
for (const [k, v] of Object.entries(nls)) keyByText.set(v, k);

/** 登记一条中英文案，返回 %foxai.nXXX% 引用（同文案复用同一键） */
function T(zh, en) {
  if (keyByText.has(zh)) return '%' + keyByText.get(zh) + '%';
  const key = 'foxai.n' + ++nextNum;
  nls[key] = zh;
  nlsEn[key] = en;
  keyByText.set(zh, key);
  return '%' + key + '%';
}

// ================= 配置分组 =================
const groups = [
  {
    title: T('狐狸 AI · 子代理与并行', 'Fox AI · Subagents & Parallelism'),
    properties: {
      'foxAi.subagents.enabled': {
        type: 'boolean', default: true,
        description: T('允许智能体派生子代理并行干活。子代理有独立上下文，中间探索过程不会污染主对话。', 'Allow the agent to spawn subagents that work in parallel with isolated context.')
      },
      'foxAi.subagents.concurrency': {
        type: 'number', default: 3, minimum: 1, maximum: 6,
        description: T('同时运行的子代理数量上限。', 'Maximum number of subagents running at the same time.')
      },
      'foxAi.subagents.maxSteps': {
        type: 'number', default: 6, minimum: 1, maximum: 16,
        description: T('单个子代理的模型往返轮数上限。', 'Maximum model round-trips per subagent.')
      },
      'foxAi.subagents.maxToolCalls': {
        type: 'number', default: 14, minimum: 1, maximum: 40,
        description: T('单个子代理累计可调用的工具次数上限。', 'Maximum total tool calls per subagent.')
      },
      'foxAi.subagents.timeoutMs': {
        type: 'number', default: 180000, minimum: 10000, maximum: 600000,
        description: T('单个子代理的墙钟超时（毫秒）。', 'Wall-clock timeout per subagent (ms).')
      },
      'foxAi.subagents.autoApproveWrites': {
        type: 'boolean', default: false,
        description: T('允许子代理直接执行「本需人工确认」的写操作。关闭时这类操作会退回主对话由你确认，建议保持关闭。', 'Let subagents perform write operations that would normally require confirmation. Keep off for safety.')
      }
    }
  },
  {
    title: T('狐狸 AI · 后台任务', 'Fox AI · Background Jobs'),
    properties: {
      'foxAi.background.enabled': {
        type: 'boolean', default: true,
        description: T('允许把耗时任务丢到后台异步执行，不占用当前对话。', 'Allow long-running tasks to be executed asynchronously in the background.')
      },
      'foxAi.background.maxConcurrent': {
        type: 'number', default: 2, minimum: 1, maximum: 4,
        description: T('同时运行的后台任务数量上限，超出的排队。', 'Maximum concurrent background jobs; the rest are queued.')
      },
      'foxAi.background.timeoutMs': {
        type: 'number', default: 900000, minimum: 10000, maximum: 3600000,
        description: T('单个后台任务的墙钟超时（毫秒），默认 15 分钟。', 'Wall-clock timeout per background job (ms). Default 15 minutes.')
      },
      'foxAi.background.maxSteps': {
        type: 'number', default: 14, minimum: 1, maximum: 16,
        description: T('单个后台任务的模型往返轮数上限。', 'Maximum model round-trips per background job.')
      },
      'foxAi.background.maxToolCalls': {
        type: 'number', default: 36, minimum: 1, maximum: 40,
        description: T('单个后台任务累计可调用的工具次数上限。', 'Maximum total tool calls per background job.')
      },
      'foxAi.background.allowMainWorkspaceWrites': {
        type: 'boolean', default: false,
        description: T('允许后台任务直接改动你当前的工作区文件。关闭时：git 仓库内会自动开独立 worktree 副本干活，非 git 仓库则降级为只读调研。强烈建议保持关闭，避免后台任务和你同时改同一批文件。', 'Allow background jobs to write directly into your working tree. When off, jobs run in an isolated git worktree, or read-only outside git repos. Recommended: off.')
      },
      'foxAi.background.keepWorktree': {
        type: 'boolean', default: false,
        description: T('后台任务结束后保留独立 worktree 目录（便于手动检查）。默认结束即清理，改动已提交到独立分支并另存补丁。', 'Keep the isolated worktree directory after a job finishes. By default it is removed; changes are committed to a branch and saved as a patch.')
      },
      'foxAi.background.maxHistory': {
        type: 'number', default: 60, minimum: 5, maximum: 500,
        description: T('磁盘上保留的后台任务历史条数。', 'Number of background job records kept on disk.')
      },
      'foxAi.background.storagePath': {
        type: 'string', default: '',
        description: T('后台任务档案的存储目录，留空则使用扩展默认目录。', 'Storage directory for background job records. Leave empty for the extension default.')
      }
    }
  },
  {
    title: T('狐狸 AI · 检查点与回滚', 'Fox AI · Checkpoints & Rollback'),
    properties: {
      'foxAi.checkpoints.enabled': {
        type: 'boolean', default: true,
        description: T('每次写文件前自动存档，出问题可一键回滚到任意检查点。', 'Snapshot files before every write so you can roll back to any checkpoint.')
      },
      'foxAi.checkpoints.maxSnapshots': {
        type: 'number', default: 200, minimum: 10, maximum: 2000,
        description: T('单个会话最多保留多少条检查点，超出丢弃最旧的。', 'Maximum checkpoints kept per session; the oldest are dropped.')
      }
    }
  },
  {
    title: T('狐狸 AI · 生命周期钩子', 'Fox AI · Lifecycle Hooks'),
    properties: {
      'foxAi.hooks.enabled': {
        type: 'boolean', default: true,
        description: T('启用生命周期钩子：在工具调用前后、会话开始结束等时机执行你自定义的命令（如自动跑格式化、拦截危险操作）。配置文件位于 ~/.fox-ai/hooks/hooks.json 或工作区 .fox-ai/hooks/hooks.json。', 'Enable lifecycle hooks that run your own commands around tool calls and session events. Config: ~/.fox-ai/hooks/hooks.json or <workspace>/.fox-ai/hooks/hooks.json.')
      }
    }
  },
  {
    title: T('狐狸 AI · 代码库语义索引', 'Fox AI · Codebase Semantic Index'),
    properties: {
      'foxAi.rag.extensions': {
        type: 'array', items: { type: 'string' }, default: [],
        description: T('参与语义索引的文件扩展名（如 .ts、.py）。留空使用内置的常见代码与文档类型。', 'File extensions to include in the semantic index (e.g. .ts, .py). Empty uses the built-in defaults.')
      },
      'foxAi.rag.maxFiles': {
        type: 'number', default: 6000, minimum: 100, maximum: 50000,
        description: T('索引的文件数量上限，防止超大仓库把内存吃满。', 'Maximum number of files to index, protecting memory on huge repositories.')
      },
      'foxAi.rag.autoRebuildHours': {
        type: 'number', default: 24, minimum: 1, maximum: 720,
        description: T('索引超过这个小时数就在下次检索前自动重建。', 'Rebuild the index automatically before the next search once it is older than this many hours.')
      }
    }
  },
  {
    title: T('狐狸 AI · 结构化长期记忆', 'Fox AI · Structured Long-term Memory'),
    properties: {
      'foxAi.memory.topics.enabled': {
        type: 'boolean', default: true,
        description: T('启用按主题分文件的结构化长期记忆，检索时只加载与当前问题相关的主题，不再整段塞进上下文。', 'Enable topic-based long-term memory. Only topics relevant to the current question are loaded into context.')
      },
      'foxAi.memory.topics.budget': {
        type: 'number', default: 2500, minimum: 200, maximum: 20000,
        description: T('每次注入上下文的记忆字数预算。', 'Character budget for memory injected into each prompt.')
      },
      'foxAi.memory.topics.autoHarvest': {
        type: 'boolean', default: true,
        description: T('任务结束时自动从对话里沉淀你的明确约定与偏好（「以后都用…」「不要…」「记住…」），闲聊不收录。', 'Automatically capture explicit conventions and preferences from the conversation when a task finishes.')
      }
    }
  }
];

const existingKeys = new Set();
for (const g of pkg.contributes.configuration) {
  for (const k of Object.keys(g.properties || {})) existingKeys.add(k);
}
let addedGroups = 0;
let addedProps = 0;
for (const g of groups) {
  const fresh = {};
  for (const [k, v] of Object.entries(g.properties)) {
    if (existingKeys.has(k)) continue;
    fresh[k] = v;
    addedProps++;
  }
  if (!Object.keys(fresh).length) continue;
  pkg.contributes.configuration.push({ title: g.title, properties: fresh });
  addedGroups++;
}

// ================= 命令 =================
const commands = [
  {
    command: 'foxAi.showBackgroundJobs',
    title: T('狐狸 AI: 查看后台任务', 'Fox AI: Show Background Jobs'),
    category: '狐狸 AI'
  },
  {
    command: 'foxAi.rollbackCheckpoint',
    title: T('狐狸 AI: 回滚到检查点', 'Fox AI: Roll Back to Checkpoint'),
    category: '狐狸 AI'
  },
  {
    command: 'foxAi.rebuildCodeIndex',
    title: T('狐狸 AI: 重建代码库语义索引', 'Fox AI: Rebuild Codebase Semantic Index'),
    category: '狐狸 AI'
  },
  {
    command: 'foxAi.openHooksConfig',
    title: T('狐狸 AI: 编辑生命周期钩子', 'Fox AI: Edit Lifecycle Hooks'),
    category: '狐狸 AI'
  },
  {
    command: 'foxAi.openTopicMemory',
    title: T('狐狸 AI: 打开结构化记忆目录', 'Fox AI: Open Structured Memory Folder'),
    category: '狐狸 AI'
  }
];

const haveCmd = new Set(pkg.contributes.commands.map((c) => c.command));
let addedCmds = 0;
for (const c of commands) {
  if (haveCmd.has(c.command)) continue;
  pkg.contributes.commands.push(c);
  addedCmds++;
}

// ================= 版本号 =================
const oldVersion = pkg.version;
pkg.version = '1.0.0';

fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
fs.writeFileSync(nlsFile, JSON.stringify(nls, null, 2) + '\n', 'utf8');
fs.writeFileSync(nlsEnFile, JSON.stringify(nlsEn, null, 2) + '\n', 'utf8');

console.log(`版本 ${oldVersion} → ${pkg.version}`);
console.log(`新增配置分组 ${addedGroups} 组 / 配置项 ${addedProps} 条`);
console.log(`新增命令 ${addedCmds} 条`);
console.log(`i18n 键增至 foxai.n${nextNum}`);
