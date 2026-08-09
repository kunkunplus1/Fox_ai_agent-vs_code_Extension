'use strict';

/**
 * 子代理 / 并行 Agent / Agent Teams（零外部依赖，不 require vscode，可离线单测）
 *
 * 解决的问题：单一主代理串行跑长任务时，上下文会被大量中间探索过程污染，
 * 且无法同时推进多条互不相干的支线。本模块提供三种编排：
 *
 *   1) spawn(spec)              —— 派生一个隔离上下文的子代理，独立跑自己的工具循环
 *   2) runParallel(specs)       —— 多个子代理并发跑（带并发上限），互不干扰
 *   3) runTeam({goal, members}) —— 按 dependsOn 依赖图拓扑分批，批内并行、批间串行，
 *                                  前置成员的产出自动注入后置成员的上下文
 *
 * 隔离语义：每个子代理持有**自己的** messages 数组，主代理只收到最终 summary，
 * 中间的读文件 / 搜索 / 试错过程**不会**进入主上下文 —— 这正是省 token 的关键。
 *
 * 安全语义：每个角色有工具白名单（按 kind + 显式增删），越权调用不会抛异常打断，
 * 而是把「你无权使用该工具」作为观察回灌给子代理，让它换条路走。
 * spawn_subagent 自身对所有角色一律禁用，杜绝无限递归派生。
 *
 * 依赖注入：callModel / execute / listTools 全部由调用方（agent.js）注入，
 * 因此本模块不碰 vscode、不碰网络，测试里塞假函数即可完整覆盖。
 */

const { createLimiter } = require('./concurrency');

// ---- 预算护栏（可被 spec / opts 覆盖，但不得超过硬上限）----
const DEFAULT_MAX_STEPS = 6;        // 单个子代理的模型往返轮数
const HARD_MAX_STEPS = 16;
const DEFAULT_MAX_TOOL_CALLS = 14;  // 单个子代理累计工具调用次数
const HARD_MAX_TOOL_CALLS = 40;
const DEFAULT_TIMEOUT = 180000;     // 单个子代理墙钟超时（ms）
const HARD_TIMEOUT = 600000;
const DEFAULT_CONCURRENCY = 3;      // 并行子代理数
const HARD_CONCURRENCY = 6;
const MAX_MEMBERS = 8;              // 单次编排最多派生几个子代理
const MAX_SUMMARY = 2400;           // 单个子代理回传主代理的结论上限（字）
const MAX_TOOL_OUTPUT = 4000;       // 子代理内部单次工具输出上限（字）

/** 永远不允许子代理使用的工具（防递归派生 / 防越权改配置） */
const GLOBAL_DENY = new Set([
  'spawn_subagent',
  'create_mcp_server',
  'create_skill',
  'present_plan',
  'revise_plan'
]);

const COMMON_RULES = `
# 通用规则
1. 你是**子代理**，只负责被指派的这一件事，不要扩展范围、不要顺手改别的。
2. 你的上下文是隔离的，主代理看不到你的中间过程，**只会看到你最后一条结论**，所以结论必须自包含。
3. 能用工具核实的就别猜；工具不可用时说明「无法核实」，不要编造文件路径、行号、函数名。
4. 完成后直接输出结论，**不要再调用工具**。结论用 Markdown，控制在 400 字以内。
5. 结论结尾必须有一行 \`结果：成功\` 或 \`结果：失败（原因）\`。`;

/**
 * 角色预设。
 * kinds  —— 允许的工具类别（对应 tools/index.js 的 tool.kind）
 * extra  —— 额外放行的具体工具名（即便 kind 不在 kinds 里）
 * deny   —— 该角色额外禁止的工具名
 */
const ROLES = {
  explorer: {
    title: '探索员',
    emoji: '🔍',
    kinds: ['read'],
    deny: ['generate_image'],
    system: `你是**探索员**子代理，专职在代码库/文件系统里定位信息。
你只有只读权限：可以读文件、列目录、找文件、全文搜索、查代码图谱，**不能写文件、不能执行命令**。

# 你的产出
- 命中的文件路径（相对工作区）+ 关键行号
- 关键代码片段（每段不超过 15 行，只贴真正相关的）
- 一句话结论：它在哪、怎么工作、和目标有什么关系`
  },
  coder: {
    title: '编码员',
    emoji: '🛠️',
    kinds: ['read', 'edit'],
    system: `你是**编码员**子代理，专职实现被指派的那一处具体改动。
你可以读文件和写/改文件，**不要执行命令、不要动与任务无关的文件**。

# 纪律
- 改之前先读原文件，基于真实内容改，禁止凭想象编辑。
- 优先用 edit_file 做最小改动，不要整文件重写。
- 保持原有缩进、引号风格、换行符。

# 你的产出
逐条列出：改了哪个文件、改了什么、为什么这么改。`
  },
  reviewer: {
    title: '审查员',
    emoji: '🧐',
    kinds: ['read'],
    system: `你是**审查员**子代理，只读，专职挑错。
你不能改任何文件、不能执行命令，只能读取和搜索。

# 你的产出
按严重程度排序，最多 5 条：
🔴 严重（崩溃 / 逻辑错 / 数据丢失）｜🟡 中等（边界 / 笔误 / 类型不一致）｜🟢 建议（可读性 / 命名）
每条给出：文件:行号 → 问题 → 建议改法。无问题就只回「未见明显问题」。`
  },
  tester: {
    title: '测试员',
    emoji: '🧪',
    kinds: ['read', 'exec'],
    system: `你是**测试员**子代理，负责运行验证并如实汇报。
你可以读文件、执行命令（跑测试、语法检查、构建），**不要修改任何文件**。

# 纪律
- 只跑验证类命令（test / lint / build / --version / node --check 之类），禁止安装、部署、删除、推送。
- 命令失败要把真实报错原文贴出来（截取关键 20 行），不要粉饰。

# 你的产出
跑了什么命令、退出码、通过/失败数量、失败的具体报错。`
  },
  researcher: {
    title: '调研员',
    emoji: '📚',
    kinds: ['read'],
    extra: ['web_search', 'current_time'],
    system: `你是**调研员**子代理，负责查资料并给出有据可依的结论。
你可以联网搜索和读本地文件，**不能写文件、不能执行命令**。

# 纪律
- 每个关键结论后面标注来源（网址或文件路径），没有来源的推测必须写明「推测」。
- 信息冲突时并列呈现，不要只挑一个。

# 你的产出
要点式结论 + 来源清单。`
  },
  planner: {
    title: '规划员',
    emoji: '🗺️',
    kinds: ['read'],
    system: `你是**规划员**子代理，负责把目标拆成可执行步骤。
你可以读文件了解现状，**不要修改任何东西**。

# 你的产出
有序步骤清单，每步写清：做什么、改哪个文件/模块、完成判据。控制在 8 步以内。`
  },
  generalist: {
    title: '通用助手',
    emoji: '🦊',
    kinds: ['read', 'edit'],
    system: `你是**通用子代理**，独立完成被指派的这一件事。
你可以读写文件，但不要执行命令，也不要扩展任务范围。

# 你的产出
做了什么、结果如何、有什么需要主代理注意的。`
  }
};

const ROLE_NAMES = Object.keys(ROLES);

/** 未知角色一律落到 generalist，绝不因为拼错角色名就失败 */
function resolveRole(role) {
  const key = String(role || '').trim().toLowerCase();
  if (ROLES[key]) return { key, def: ROLES[key] };
  // 常见别名兜底
  const alias = {
    explore: 'explorer', search: 'explorer', finder: 'explorer', reader: 'explorer',
    code: 'coder', coding: 'coder', developer: 'coder', implementer: 'coder', writer: 'coder',
    review: 'reviewer', critic: 'reviewer', auditor: 'reviewer',
    test: 'tester', qa: 'tester', verifier: 'tester',
    research: 'researcher', search_web: 'researcher',
    plan: 'planner', architect: 'planner',
    general: 'generalist', worker: 'generalist', assistant: 'generalist'
  };
  if (alias[key] && ROLES[alias[key]]) return { key: alias[key], def: ROLES[alias[key]] };
  return { key: 'generalist', def: ROLES.generalist };
}

/**
 * 计算某角色可用的工具名集合。
 * @param {string} roleKey 角色
 * @param {Array<{name:string,kind:string}>} all 全量工具定义
 * @param {Array<string>} [override] 显式指定的工具名（仍受角色白名单与全局黑名单约束）
 */
function allowedToolNames(roleKey, all, override) {
  const { key, def } = resolveRole(roleKey);
  const kinds = new Set(def.kinds || ['read']);
  const extra = new Set(def.extra || []);
  const deny = new Set(def.deny || []);
  const names = [];
  for (const t of all || []) {
    if (!t || !t.name) continue;
    if (GLOBAL_DENY.has(t.name)) continue;
    if (deny.has(t.name)) continue;
    const kind = t.kind || 'read';
    if (kinds.has(kind) || extra.has(t.name)) names.push(t.name);
  }
  if (Array.isArray(override) && override.length) {
    const want = new Set(override.map((n) => String(n)));
    const filtered = names.filter((n) => want.has(n));
    // override 命中为空时忽略 override（否则子代理会一个工具都没有，必然失败）
    if (filtered.length) return { role: key, names: filtered };
  }
  return { role: key, names };
}

/** 把任意值安全转成给模型看的字符串并截断 */
function clip(text, limit) {
  const s = text === undefined || text === null
    ? ''
    : (typeof text === 'string' ? text : (() => { try { return JSON.stringify(text); } catch (_) { return String(text); } })());
  const max = limit || MAX_TOOL_OUTPUT;
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…（已截断，共 ${s.length} 字）`;
}

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** 规范化一个子代理规格；task 缺失返回 null（由调用方过滤） */
function normalizeSpec(raw, i) {
  if (!raw || typeof raw !== 'object') return null;
  const task = String(raw.task || raw.goal || raw.prompt || '').trim();
  if (!task) return null;
  const { key } = resolveRole(raw.role);
  const rawDeps = raw.dependsOn || raw.depends_on || raw.deps || [];
  return {
    name: String(raw.name || raw.id || `${key}-${i + 1}`).trim().slice(0, 40),
    role: key,
    task: task.slice(0, 4000),
    context: String(raw.context || raw.background || '').slice(0, 6000),
    tools: Array.isArray(raw.tools) ? raw.tools.map((t) => String(t)) : null,
    dependsOn: (Array.isArray(rawDeps) ? rawDeps : [rawDeps]).map((d) => String(d || '').trim()).filter(Boolean),
    maxSteps: clampInt(raw.maxSteps || raw.max_steps, 0, 0, HARD_MAX_STEPS)
  };
}

/** 判断一个对象是否已经过 normalizeSpec 处理（避免把裸对象当成合法规格直接跑） */
function isNormalized(s) {
  return !!(s && typeof s === 'object'
    && typeof s.name === 'string' && s.name
    && typeof s.role === 'string' && ROLES[s.role]
    && typeof s.task === 'string' && s.task
    && Array.isArray(s.dependsOn));
}

/** 批量规范化 + 去重命名 + 数量上限 */
function normalizeSpecs(list) {
  const arr = Array.isArray(list) ? list : (list ? [list] : []);
  const out = [];
  const used = new Set();
  for (let i = 0; i < arr.length && out.length < MAX_MEMBERS; i++) {
    const s = normalizeSpec(arr[i], i);
    if (!s) continue;
    let name = s.name;
    let n = 2;
    while (used.has(name)) name = `${s.name}-${n++}`;
    used.add(name);
    s.name = name;
    out.push(s);
  }
  return out;
}

/**
 * 依赖图拓扑分批：返回 [[spec,...], [spec,...]]，批内可并行。
 * 指向不存在成员的依赖会被忽略；存在环时，环上的成员被放进最后一批（降级为「无依赖并行」而非直接失败）。
 */
function topoStages(specs) {
  const byName = new Map(specs.map((s) => [s.name, s]));
  const pending = new Map(specs.map((s) => [s.name, new Set(s.dependsOn.filter((d) => byName.has(d) && d !== s.name))]));
  const stages = [];
  const done = new Set();
  let guard = 0;
  while (pending.size && guard++ < MAX_MEMBERS + 2) {
    const ready = [];
    for (const [name, deps] of pending) {
      let ok = true;
      for (const d of deps) if (!done.has(d)) { ok = false; break; }
      if (ok) ready.push(name);
    }
    if (!ready.length) {
      // 存在环：剩余成员一次性放行，避免死锁
      stages.push(Array.from(pending.keys()).map((n) => byName.get(n)));
      break;
    }
    stages.push(ready.map((n) => byName.get(n)));
    for (const n of ready) { pending.delete(n); done.add(n); }
  }
  return stages;
}

/** 构造子代理的系统提示词 */
function buildSubagentSystem(spec, allowedNames, extraSystem) {
  const { def } = resolveRole(spec.role);
  const toolLine = allowedNames.length
    ? `\n# 你可用的工具\n${allowedNames.join('、')}\n（列表之外的工具你一律无权调用，调用会被拒绝。）`
    : '\n# 你可用的工具\n（本次没有可用工具，请直接基于已知信息给结论。）';
  return [def.system, toolLine, COMMON_RULES, extraSystem ? '\n# 主代理附加约定\n' + extraSystem : ''].join('\n');
}

/** 构造子代理的首条用户消息 */
function buildSubagentUser(spec, upstream) {
  const parts = [`# 你的任务\n${spec.task}`];
  if (spec.context) parts.push(`# 背景信息\n${spec.context}`);
  if (upstream && upstream.length) {
    const blocks = upstream.map((u) => `## 来自「${u.name}」（${u.roleTitle}）\n${clip(u.summary, 1200)}`).join('\n\n');
    parts.push(`# 前置子代理已完成的产出（请基于它继续，不要重复劳动）\n${blocks}`);
  }
  parts.push('现在开始。需要信息就调用工具，拿到足够信息后直接输出最终结论。');
  return parts.join('\n\n');
}

class SubagentRunner {
  /**
   * @param {object} opts
   * @param {function} opts.callModel  ({messages, tools, spec}) => {content, toolCalls:[{id,name,rawArgs}]}
   * @param {function} opts.execute    (name, args, {spec}) => string | Promise<string>
   * @param {function} opts.listTools  () => [{name, kind, ...}]  全量工具定义
   * @param {function} [opts.onEvent]  事件回调，用于向 UI 推进度（异常自动吞掉）
   * @param {function} [opts.isCancelled] () => boolean，主会话取消时中止
   * @param {object}   [opts.limits]  {maxSteps,maxToolCalls,timeoutMs,concurrency}
   * @param {string}   [opts.extraSystem] 附加到每个子代理系统提示词末尾的约定
   */
  constructor(opts) {
    opts = opts || {};
    this.callModel = opts.callModel;
    this.execute = opts.execute;
    this.listTools = opts.listTools || (() => []);
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    this.isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : (() => false);
    this.extraSystem = opts.extraSystem || '';
    const l = opts.limits || {};
    this.limits = {
      maxSteps: clampInt(l.maxSteps, DEFAULT_MAX_STEPS, 1, HARD_MAX_STEPS),
      maxToolCalls: clampInt(l.maxToolCalls, DEFAULT_MAX_TOOL_CALLS, 1, HARD_MAX_TOOL_CALLS),
      // 下限放到 200ms：既方便离线测试构造超时场景，也让「快速探路」类调用能设很短的墙钟
      timeoutMs: clampInt(l.timeoutMs, DEFAULT_TIMEOUT, 200, HARD_TIMEOUT),
      concurrency: clampInt(l.concurrency, DEFAULT_CONCURRENCY, 1, HARD_CONCURRENCY)
    };
    this._limiter = createLimiter(this.limits.concurrency);
  }

  _emit(type, payload) {
    if (!this.onEvent) return;
    try { this.onEvent(Object.assign({ type }, payload || {})); } catch (_) {}
  }

  /**
   * 派生并运行一个子代理（隔离上下文）。
   * 任何异常都被收敛成 ok:false 的结果对象，绝不向主流程冒泡。
   */
  async spawn(spec, upstream) {
    const started = Date.now();
    const s = isNormalized(spec) ? spec : normalizeSpec(spec, 0);
    if (!s) {
      return { name: 'invalid', role: 'generalist', roleTitle: '通用助手', task: '', ok: false, summary: '', steps: 0, toolCalls: [], durationMs: 0, stopReason: 'error', error: '子代理规格缺少 task' };
    }
    const { def } = resolveRole(s.role);
    const all = (() => { try { return this.listTools() || []; } catch (_) { return []; } })();
    const { names } = allowedToolNames(s.role, all, s.tools);
    const allowSet = new Set(names);
    const toolDefs = (all || []).filter((t) => t && allowSet.has(t.name));

    const result = {
      name: s.name,
      role: s.role,
      roleTitle: def.title,
      emoji: def.emoji,
      task: s.task,
      ok: false,
      summary: '',
      steps: 0,
      toolCalls: [],
      durationMs: 0,
      stopReason: 'error',
      error: ''
    };

    const maxSteps = s.maxSteps || this.limits.maxSteps;
    const deadline = started + this.limits.timeoutMs;
    const messages = [
      { role: 'system', content: buildSubagentSystem(s, names, this.extraSystem) },
      { role: 'user', content: buildSubagentUser(s, upstream) }
    ];

    this._emit('subagentStart', { name: s.name, role: s.role, roleTitle: def.title, emoji: def.emoji, task: s.task, tools: names.length });

    try {
      let toolBudget = this.limits.maxToolCalls;
      for (let step = 1; step <= maxSteps; step++) {
        if (this.isCancelled()) { result.stopReason = 'cancelled'; break; }
        if (Date.now() > deadline) { result.stopReason = 'timeout'; break; }
        result.steps = step;

        const res = await this.callModel({ messages, tools: toolDefs, spec: s, step });
        const content = (res && res.content) || '';
        const calls = (res && Array.isArray(res.toolCalls)) ? res.toolCalls : [];

        if (!calls.length) {
          result.summary = clip(content, MAX_SUMMARY);
          result.stopReason = 'done';
          result.ok = true;
          break;
        }

        messages.push({
          role: 'assistant',
          content: content || null,
          tool_calls: calls.map((c, i) => ({
            id: c.id || `sub_${step}_${i}`,
            type: 'function',
            function: { name: c.name, arguments: typeof c.rawArgs === 'string' ? c.rawArgs : JSON.stringify(c.args || {}) }
          }))
        });

        for (let i = 0; i < calls.length; i++) {
          const c = calls[i];
          const callId = c.id || `sub_${step}_${i}`;
          let out;
          let ok = true;
          if (toolBudget <= 0) {
            ok = false;
            out = '工具调用次数已用尽，请立刻基于已有信息输出最终结论，不要再调用工具。';
          } else if (!allowSet.has(c.name)) {
            ok = false;
            out = `你无权使用工具 ${c.name}。你的角色「${def.title}」只能用：${names.join('、') || '（无）'}。请换一种方式，或直接给结论。`;
          } else {
            toolBudget--;
            let args = c.args;
            if (args === undefined) {
              try { args = c.rawArgs ? JSON.parse(c.rawArgs) : {}; } catch (_) { args = {}; }
            }
            try {
              const raw = await this.execute(c.name, args || {}, { spec: s, role: s.role });
              out = clip(raw, MAX_TOOL_OUTPUT);
            } catch (e) {
              ok = false;
              out = `工具 ${c.name} 执行失败：${(e && e.message) || String(e)}`;
            }
            result.toolCalls.push({ name: c.name, args: args || {}, ok, output: clip(out, 600) });
            this._emit('subagentTool', { name: s.name, tool: c.name, ok, step });
          }
          messages.push({ role: 'tool', tool_call_id: callId, content: out });
        }

        if (step === maxSteps) result.stopReason = 'maxSteps';
      }

      // 步数/时间/预算耗尽却没结论：强制收尾一次（不给工具，逼它总结）
      if (!result.ok && result.stopReason !== 'cancelled') {
        const forced = await this._forceFinish(messages, s, deadline).catch(() => null);
        if (forced) {
          result.summary = clip(forced, MAX_SUMMARY);
          result.ok = true;
          if (result.stopReason === 'error') result.stopReason = 'maxSteps';
        }
      }
      if (!result.summary && !result.error) {
        result.error = result.stopReason === 'cancelled' ? '已取消' : '子代理未能给出结论';
      }
    } catch (e) {
      result.ok = false;
      result.stopReason = 'error';
      result.error = (e && e.message) || String(e);
    }

    result.durationMs = Date.now() - started;
    this._emit('subagentEnd', { name: s.name, role: s.role, ok: result.ok, stopReason: result.stopReason, steps: result.steps, durationMs: result.durationMs });
    return result;
  }

  /** 预算耗尽时的强制收尾：不给工具，只要一句结论 */
  async _forceFinish(messages, spec, deadline) {
    if (this.isCancelled()) return '';
    if (deadline && Date.now() > deadline + 30000) return '';
    const m = messages.concat([{
      role: 'user',
      content: '预算已用尽，**禁止再调用任何工具**。请立刻基于目前已获得的信息输出最终结论；信息不足就明确写出还缺什么，并以 `结果：失败（信息不足）` 结尾。'
    }]);
    const res = await this.callModel({ messages: m, tools: [], spec, step: -1 });
    return (res && res.content) || '';
  }

  /** 多个子代理并发执行（受并发上限约束），任一失败不影响其它 */
  async runParallel(specs, upstream) {
    const list = (Array.isArray(specs) && specs.length && specs.every(isNormalized)) ? specs : normalizeSpecs(specs);
    if (!list.length) return [];
    this._emit('subagentBatch', { count: list.length, concurrency: this.limits.concurrency });
    const settled = await Promise.all(list.map((s) => this._limiter.run(() => this.spawn(s, upstream))));
    return settled;
  }

  /**
   * Agent Team：按 dependsOn 拓扑分批，批内并行、批间串行，
   * 前置产出自动注入后置成员上下文。
   */
  async runTeam(team) {
    team = team || {};
    const specs = normalizeSpecs(team.members || team.agents || []);
    if (!specs.length) return { goal: team.goal || '', stages: [], results: [] };
    const stages = topoStages(specs);
    const results = [];
    const byName = new Map();
    for (let i = 0; i < stages.length; i++) {
      if (this.isCancelled()) break;
      const stage = stages[i];
      this._emit('teamStage', { index: i + 1, total: stages.length, members: stage.map((s) => s.name) });
      const upstreamFor = (s) => {
        const deps = s.dependsOn.filter((d) => byName.has(d)).map((d) => byName.get(d));
        // 无显式依赖时，把上一批的产出全部带上（团队协作的默认语义）
        if (deps.length) return deps;
        return i > 0 ? stages[i - 1].map((p) => byName.get(p.name)).filter(Boolean) : [];
      };
      const batch = await Promise.all(stage.map((s) => this._limiter.run(() => this.spawn(s, upstreamFor(s)))));
      for (const r of batch) { results.push(r); byName.set(r.name, r); }
    }
    return { goal: team.goal || '', stages: stages.map((st) => st.map((s) => s.name)), results };
  }

  describe() {
    return {
      roles: ROLE_NAMES,
      limits: Object.assign({}, this.limits),
      maxMembers: MAX_MEMBERS
    };
  }
}

/** 把子代理结果渲染成回灌给主代理的 Markdown */
function renderResults(results, opts) {
  opts = opts || {};
  const list = Array.isArray(results) ? results : [];
  if (!list.length) return '没有派生任何子代理（规格为空或缺少 task）。';
  const okCount = list.filter((r) => r.ok).length;
  const head = `## 子代理执行结果（${okCount}/${list.length} 成功${opts.goal ? '，目标：' + opts.goal : ''}）`;
  const body = list.map((r) => {
    const icon = r.ok ? '✅' : '❌';
    const meta = [`角色：${r.roleTitle || r.role}`, `轮数：${r.steps}`, `工具：${(r.toolCalls || []).length} 次`, `耗时：${Math.round((r.durationMs || 0) / 100) / 10}s`];
    if (r.stopReason && r.stopReason !== 'done') meta.push(`终止：${r.stopReason}`);
    const content = r.ok ? (r.summary || '(无内容)') : `执行失败：${r.error || r.stopReason || '未知原因'}`;
    return `### ${icon} ${r.emoji || ''}${r.name}\n> ${meta.join('｜')}\n\n${content}`;
  }).join('\n\n');
  const tail = okCount < list.length
    ? '\n\n⚠️ 有子代理未完成，请判断是自己补做、还是重新派生。'
    : '\n\n以上是子代理的最终结论（中间探索过程未进入你的上下文）。请据此继续。';
  return [head, body].join('\n\n') + tail;
}

/** 给系统提示词用的角色速查表 */
function renderRoleCatalog() {
  return ROLE_NAMES.map((k) => {
    const d = ROLES[k];
    return `- \`${k}\`（${d.emoji}${d.title}）：${(d.kinds || []).join('+')} 权限`;
  }).join('\n');
}

module.exports = {
  SubagentRunner,
  ROLES,
  ROLE_NAMES,
  GLOBAL_DENY,
  resolveRole,
  allowedToolNames,
  normalizeSpec,
  normalizeSpecs,
  isNormalized,
  topoStages,
  buildSubagentSystem,
  buildSubagentUser,
  renderResults,
  renderRoleCatalog,
  clip,
  MAX_MEMBERS,
  DEFAULT_MAX_STEPS,
  DEFAULT_CONCURRENCY
};
