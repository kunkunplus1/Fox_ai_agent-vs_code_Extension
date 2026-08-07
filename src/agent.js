'use strict';

const vscode = require('vscode');
const path = require('path');
const { chatOnce, chatNonStream, streamResponses, chatNonStreamResponses } = require('./client');
const anthropic = require('./anthropic');
const config = require('./config');
const tools = require('./tools');
const ws = require('./tools/workspace');
const ctxTools = require('./tools/context');
const undo = require('./undo');
const kb = require('./knowledgeBase');
const kbOrg = require('./knowledgeOrganizer');
const mcpAuthor = require('./tools/mcpAuthor'); // 自写 MCP 服务器：注入格式说明到系统提示词
const caps = require('./capabilities');
const harness = require('./harness');
const bridge = require('./extensionBridge');
const contextUsage = require('./contextUsage');
const { MemoryStore } = require('./memory');
const { UserSkillStore } = require('./skills');
const { PlanTaskStore } = require('./planTasks');
const projectScan = require('./projectScan');
const reviewer = require('./reviewer');
const { shouldAutoContinue } = require('./autoContinue');

const fs = require('fs');
const os = require('os');

// 工具名捕获组必须覆盖真实 MCP 命名空间里的连字符/点/斜杠/大写，
// 例如 mcp__fetch__fetch-url、mcp__io.github.ChromeDevTools/chrome-devtools-mcp__new_page。
// 早期版本用 [a-z_]+ 导致带特殊字符的工具名匹配失败、工具从不执行（表现为「返回空」）。
const TOOL_OPEN = /<fox:tool\s+name\s*=\s*["']([^\s"'<>]+)["']\s*>/i;
const TOOL_BLOCK = /<fox:tool\s+name\s*=\s*["']([^\s"'<>]+)["']\s*>\s*([\s\S]*?)\s*<\/fox:tool>/gi;
const TOOL_END = '</fox:tool>';

/** 写一条调试日志到 ~/.fox-ai/logs/agent-<name>.log，失败静默忽略 */
function writeAgentLog(name, lines) {
  try {
    const dir = path.join(os.homedir(), '.fox-ai', 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'agent-' + name + '.log');
    const prefix = new Date().toISOString() + ' [pid:' + process.pid + '] ';
    const text = (Array.isArray(lines) ? lines : [String(lines)])
      .map((l) => prefix + (typeof l === 'string' ? l : JSON.stringify(l)))
      .join('\n') + '\n';
    fs.writeFileSync(file, text, { flag: 'a' });
  } catch (_) { /* 日志写入失败不得影响主流程 */ }
}

/** 通用流式包装：把任意 streamX 函数包成 { promise, handle } */
function wrapStream(options, streamFn) {
  let handle;
  const promise = new Promise((resolve, reject) => {
    handle = streamFn(Object.assign({}, options, { onDone: resolve, onError: reject }));
  });
  return { promise, handle };
}

/**
 * 根据 cfg.transport 选择传输后端。
 *  - anthropic：走原生 Messages 协议（src/anthropic.js），只支持 chat，不支持 Responses。
 *  - openai（默认）：OpenAI 兼容 chat / responses 两种子模式。
 * 返回 { nonStream, once, responses }，once 为 null 时主循环用 wrapStream(streamResponses)。
 */
function selectBackend(cfg) {
  if (cfg.transport === 'anthropic') {
    return { nonStream: anthropic.chatNonStream, once: anthropic.chatOnce, responses: false };
  }
  const useResp = cfg.apiMode === 'responses';
  return {
    nonStream: useResp ? chatNonStreamResponses : chatNonStream,
    once: useResp ? null : chatOnce,
    responses: useResp
  };
}

class Cancelled extends Error {
  constructor() {
    super('已取消');
    this.name = 'Cancelled';
  }
}

/** 简单的取消令牌，传给耗时工具 */
function makeToken() {
  const listeners = [];
  return {
    cancelled: false,
    onCancelled(cb) {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    cancel() {
      if (this.cancelled) return;
      this.cancelled = true;
      for (const cb of listeners.slice()) {
        try {
          cb();
        } catch (_) {}
      }
    }
  };
}

function safeParseArgs(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  const text = String(raw).trim();
  try {
    return JSON.parse(text);
  } catch (_) {}
  // 容错：去掉 markdown 包裹、修剪尾部逗号
  const fenced = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(fenced);
  } catch (_) {}
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const slice = fenced.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(slice);
    } catch (_) {}
  }
  throw new Error('参数不是合法 JSON：' + text.slice(0, 200));
}

function buildExtensionCommandsSection() {
  const allowed = bridge.allowedCommands();
  if (!allowed.length) return '';
  const catalog = bridge.commandCatalog();
  const lines = [];
  for (const id of allowed) {
    const entry = catalog.find((c) => c.command === id);
    const title = entry ? entry.title : id;
    const ext = entry ? entry.extension : '';
    lines.push(`- ${title}（${id}${ext ? ' · ' + ext : ''}）`);
  }
  return `

【已授权的扩展命令（插件联动）】
用户已在「狐狸 AI · 环境与插件 · 插件联动」页面勾选下列命令。当用户明确要求「调用插件」「用插件做某事」或提到对应功能时，请使用 call_extension_command 工具，从下列命令中选择最匹配的一项调用：
${lines.join('\n')}

调用示例：
<fox:tool name="call_extension_command">
{"command": "${allowed[0]}"}
</fox:tool>`;
}

function buildSystemPrompt(cfg, envBrief, protocol, queryText) {
  const base = cfg.systemPrompt || '你是一位资深工程师，回答简洁准确。';
  const extSection = buildExtensionCommandsSection();

  if (protocol === 'chat') {
    return `${base}

【当前环境】
${envBrief}

（当前无法调用工具：可能是智能体模式未开启、当前协议/模型不支持 function calling，或 Responses 协议下工具调用被服务端拒绝。你只能基于用户提供的信息做文字回答，不要声称自己读取、修改或执行了任何操作。）`;
  }

  const structured = cfg.structuredOutput
    ? '\n【结构化输出】在总结、计划、任务清单、配置说明等场景，优先输出 JSON 或 YAML 等结构化格式，避免冗余自然语言描述。'
    : '';

  // DeepSeek + Responses API 下，web_search 是服务端内置的官方联网搜索（免费、免 key），
  // 主动提示模型“你有可用联网能力”，避免它误以为自己没有实时信息。
  const provider = cfg.provider || 'llamacpp';
  const apiMode = cfg.apiMode || 'chat';
  const nativeSearchHint = (provider === 'deepseek' && apiMode === 'responses')
    ? '\n【联网能力（重要）】当前为 DeepSeek Responses API 模式，你已具备服务端内置的官方联网搜索（web_search，由 DeepSeek 服务端自动执行，免费免 key）。当用户问到时效性、实时、最新资讯、排行、价格、当前事件、今天/本周/最新 等需要最新数据的问题时：\n1) 你必须先通过联网搜索获取真实最新信息，再据此回答；\n2) 严禁用 fetch / Chrome DevTools / 其他 MCP 去抓取实时数据——这些拿不到实时结果，只会得到过期或错误内容；\n3) 不要以“我没有实时信息”为由拒绝回答，联网搜索会被自动执行，你只需在回答里引用搜索到的内容。\n4) 【准确性要求】你必须严格基于联网搜索返回的真实结果来回答，禁止编造、臆测或把不相关的内容套到问题上。如果搜索结果里没有明确给出答案，就如实说明“搜索结果未直接提及”，并给出已检索到的相关线索，不要硬凑一个似是而非的答案。\n5) 【不要自己拼 URL】不要尝试用 open_page / fetch / 构造链接去“验证”搜索结果；官方 web_search 已经把可信结果返回给你，直接基于它回答即可。'
    : '';

  // 强制引用与溯源护栏（对应生产级方法论「生成必附来源、无依据输出信息不足」）。
  // 开启后，要求基于检索/文件/代码的内容必须标注来源；无可靠依据不得编造，须明确说信息不足。
  const citationGuard = cfg.guardrails && cfg.guardrails.forceCitation
    ? '\n【引用与溯源护栏（已强制开启）】' +
      '1) 凡是回答依据了【本地知识库参考】、文件内容、搜索结果、诊断/终端输出或代码，必须附上可核验的来源标记，' +
      '例如「（来源：知识库《xxx》/ 文件 src/a.js:12 / web_search 结果 / 终端输出）」，不得凭空给出无出处的事实。' +
      '2) 若用户问题超出上述任何可依据资料的范围、或检索/搜索未给出答案，必须如实说「信息不足，无法确认」，' +
      '严禁编造看似合理的细节、路径、版本号、数据或结论。' +
      '3) 当某结论与已知资料冲突时，以资料为准并说明冲突，不要掩盖不确定性。'
    : '';

  const common = `${base}

你现在是 VS Code 里的编程智能体「狐狸 AI」，可以直接读写用户工作区的文件、执行终端命令、读取报错信息。

【当前环境】
${envBrief}${structured}${nativeSearchHint}${citationGuard}

【工作准则】
1. 先了解再动手：修改任何文件前，必须先用 read_file 看过真实内容，不要凭空猜测代码。文件只需读取一次——如果已经读过、内容未变，不要反复读取同一个文件，直接基于已有信息推进任务。
2. 改动用 edit_file 做最小必要修改；只有新建文件或整体重写时才用 write_file。edit_file 支持 start_line/end_line 限定范围，以及 start_char/end_char 做字符级替换，优先用这些方式而不是重写整文件。
3. old_text 必须与原文逐字符一致（含缩进与空行），并且在文件里唯一；可先用 read_file 读一段，再在该范围内替换。
4. 执行命令必须是非交互式的（带上 -y、--yes 等），不要启动会一直挂着的进程（如开发服务器）。
5. 改完代码后，用 get_diagnostics 确认没有引入新的错误；用户提到“报错/跑不起来”时，先用 get_terminal_output 或 get_diagnostics 看真实错误再动手。
6. 一次只做一步，根据工具返回结果决定下一步。不要假设工具已经成功。
7. 任务完成后，用中文简明总结你改了什么、为什么改，不要复述整个文件内容。
8. 如果需求不清晰或有破坏性风险，先说明并询问用户，不要擅自大改。
9. 当用户询问当前时间、日期、天气、新闻、最新版本、实时数据等时效性信息时，必须调用 current_time 或 web_search 工具获取信息后再回答。绝对禁止直接说"我无法获取当前时间"或"我没有实时信息"。
10. 当你发现某类任务存在可复用的固定流程（如某项目的部署检查、特定代码规范校验），且尚无对应技能时，可用 create_skill 把它沉淀成用户技能，下次用 use_skill 激活执行；用户技能与自带能力隔开、只属于本扩展，写好后系统会自动校验结构与脚本语法。**重要：若某技能已存在（list_skills 可见）或你刚刚用 use_skill 激活了它，绝对不要再 create_skill 同名技能——直接按其指导执行，并用 create_plan_task 跟踪多步骤进度。**
11. 若你启动或指导用户使用了需要终端交互的程序（例如由 use_skill 激活的交互式脚本、游戏、REPL），必须在让用户输入后调用 get_terminal_output 读取终端最新输出，再根据输出继续交互；不要假设你知道用户输入了什么。
12. 面对需要多步骤完成的项目任务时，先用 create_plan_task 把任务拆成可见清单（pending / in_progress / completed）；每完成一步用 update_plan_task 更新状态，用户问“进度”“还剩哪些”时调用 list_plan_tasks。**注意：已通过 use_skill 激活匹配技能时，不要把该技能本身当任务去 create_skill，直接执行并用 create_plan_task 记录步骤。**
13. 编码类任务收尾时，除了系统已自动做的语法校验（node --check / 写后诊断），还应主动用 run_command 运行该项目的测试验证（如 package.json 的 test 脚本、pytest、go test、cargo test 等）；若项目没有测试，至少跑一次构建或类型检查。把测试结果写入最终总结。
14. 系统提示词中的【本地知识库参考】已包含用户整理好的知识库文件内容，回答相关问题时请优先基于其中信息，不要调用 find_files / search_text 去工作区“找知识库文件”，也不要因检索关键词未命中就声称没有知识库。
15. 保持谨慎：动手改文件或跑命令前，先想清楚影响范围，优先用可逆的最小改动；删除 / 覆盖 / 移动 / 重命名文件，以及 rm -rf、git reset --hard 这类不可逆命令，务必确认目标与后果，autoApprove 关闭时先征求用户同意。声称“完成”之前，必须用工具核实结果（get_diagnostics / 跑测试 / 读回文件），不要凭假设说成功；意图或风险拿不准时，先问清楚再动手，绝不瞎猜。
16. 当用户明确说“读 / 看 / 打开 / 检查某个文件”或提及具体文件名并要求了解其内容时，必须**立即调用 read_file** 去读真实内容，不要反问“你的意思是…？”、不要凭记忆猜测、不要编造文件内容。读完后再基于原文回答或继续操作。\n17. 自动代码审查：你每完成一轮代码写操作（edit_file / write_file / delete_file），系统会用只读的审查子代理对改动做一次检查，并把审查意见作为后续观察发回给你。若审查意见指出明显问题（尤其 🔴 严重项），请在本轮结束前据以修正，不要带着低级错误直接收尾；若审查认为无问题，正常继续即可。\\n18. 自我验证：输出结论或声称“完成”前，先自检——事实是否来自工具返回、有无编造路径/结果、是否真正回答了用户问题。剔除不准确或冗余信息。\n19. 安全自检双盲校验：调用 security_audit 做代码安全自检时，其结果仅供参考，**禁止作为修复的唯一依据**。当你据自检结论做了修复后，必须再调用只读的 referee_review（裁判 Agent）对比「修复前 HEAD 原版 vs 修复后工作区」的语义差异；若裁判判定「修复前后逻辑等价」（即自检疑似误报），必须**强制挂起转人工**，不得自行放行或忽略。` + (cfg.planAndExecute && cfg.planAndExecute.enabled ? `\n\n20. 规划确认模式已开启：面对需要多个步骤才能完成的任务（如新建或修改多个文件、跑测试、跨模块改动），先用 create_plan_task 把完整计划逐条列出（含每步目标），再调用 present_plan 把计划提交给用户确认；调用 present_plan 之后必须停止，不得执行任何写文件或执行命令的操作，耐心等待用户确认。用户确认后你再逐步执行，每完成一步用 update_plan_task 标记状态。执行过程中若需调整计划（增删步骤或改变目标），必须先调用 update_plan_task / create_plan_task 改好计划，再调用 revise_plan 并说明原因，等待用户再次确认后才继续，不得擅自偏离已确认的计划。` : '') + extSection + '\n\n' + mcpAuthor.MCP_AUTHORING_GUIDE;



  if (protocol === 'text') {
    return `${common}

【调用工具的方式】
你没有原生函数调用，请严格用下面这种格式调用工具，一次只调用一个：

<fox:tool name="工具名">
{"参数名": "参数值"}
</fox:tool>

工具块必须独立成段，里面是合法 JSON。写完 </fox:tool> 后立刻停止输出，等待我把结果发给你。
不需要调用工具时，直接用自然语言回答，绝对不要输出 <fox:tool> 标签。
收到工具返回后，必须基于返回内容整理成最终回答；如果工具返回为空、未找到数据或返回格式异常，要明确指出「工具返回为空/未找到」，不能留空。

【可用工具】
${tools.toTextManual(queryText, cfg)}`;
  }

  return common;
}

/**
 * 一次任务的执行会话
 */
class AgentSession {
  /**
   * @param {object} opts
   * @param {import('vscode').ExtensionContext} opts.context
   * @param {object} opts.cfg
   * @param {Array} opts.messages 共享的对话历史（会被就地追加）
   * @param {object} opts.ui 回调集合
   */
  constructor(opts) {
    this.context = opts.context;
    this.cfg = opts.cfg;
    this.messages = opts.messages;
    this.ui = opts.ui || {};
    this.alwaysAllow = opts.alwaysAllow || new Set();

    this.paused = false;
    this.cancelled = false;
    this.state = 'idle';
    this.stream = null;
    this.token = makeToken();
    this._resumeWaiters = [];
    this._pendingApproval = null;
    this.protocol = 'native';
    // 一旦因原生工具协议被服务端拒绝（如 MCP 大 schema 触发 400）而降级到文本协议，
    // 本会话后续轮次都保持文本协议，避免每轮先 400 再重试（见 run() 降级分支）。
    this._forceText = false;
    this.stepCount = 0;
    // 单条回复因 max_tokens 截断时，自动发「继续」重新调用的次数计数（防无限循环）
    this._continuesUsed = 0;
    // deepseek+responses 下，只要本会话触发过一次官方 web_search，就标记为「联网搜索会话」，
    // 后续所有轮次持续只给官方 web_search（保证搜索连续、不中途退回本地 fetch 绕圈），
    // 直到用户明确说「用本地/别联网/用 mcp」才解除。
    this._officialSearchStarted = false;

    // Harness（管理系统）：任务状态机 + 策略引擎
    this.taskManager = (opts.harness && opts.harness.taskManager) || null;
    this.policy = (opts.harness && opts.harness.policy) || null;
    this.task = null;
    this._pausedLogged = false;
    // 规划确认模式：模型提交/修订计划后，run() 会暂停并等待用户确认
    this._planPending = false;
    this._planRevised = '';
    // 自动代码审查：本轮代码写操作收集到这里，工具循环结束后触发一次 review
    this._pendingReview = [];
    this._reviewing = false;
    // 续跑：关联会话 id 与要复用的任务 id
    this.sessionId = opts.sessionId || null;
    this.resumeTaskId = opts.resumeTaskId || null;
    // 长期记忆（跨会话记住用户偏好/约定/教训）
    const gsDir = this.context ? this.context.globalStorageUri.fsPath : require('os').homedir();
    const c = config.conf();
    this.memory = new MemoryStore(gsDir, c.get('memory.storagePath', ''));
    this.skills = new UserSkillStore(gsDir, c.get('skills.storagePath', ''));
    this.planTasks = opts.planTasks || new PlanTaskStore(gsDir, { customDir: c.get('planTasks.storagePath', '') });
  }

  /* ---------- 控制 ---------- */

  pause() {
    if (this.cancelled || this.paused) return;
    this.paused = true;
    this.emit('state', { state: 'pausing' });
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    const waiters = this._resumeWaiters.splice(0);
    for (const w of waiters) w();
    this.emit('state', { state: this.state });
  }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.paused = false;
    this.token.cancel();
    if (this.stream) {
      try {
        this.stream.abort();
      } catch (_) {}
    }
    if (this._pendingApproval) {
      this._pendingApproval('reject-cancel');
      this._pendingApproval = null;
    }
    const waiters = this._resumeWaiters.splice(0);
    for (const w of waiters) w();
    this.emit('state', { state: 'cancelled' });
  }

  emit(type, payload) {
    if (typeof this.ui[type] === 'function') this.ui[type](payload);
  }

  /**
   * 规划确认模式：用户已在面板里点「确认执行」。
   * 推送一条系统消息告知模型开始执行，并继续 run() 跑完计划。
   * @returns {Promise<{finished:boolean, reason?:string, text?:string}>}
   */
  async approvePlan() {
    if (this.cancelled) throw new Cancelled();
    const wasRevised = !!this._planRevised;
    this._planPending = false;
    this._planRevised = '';
    const tip = wasRevised
      ? '用户已确认修订后的计划，请按最新【项目任务清单】继续逐步执行，不要偏离目标。'
      : '用户已确认计划，请严格按【项目任务清单】逐步执行，每完成一步用 update_plan_task 标记；不要偏离计划目标。';
    this.messages.push({ role: 'user', content: '[系统] ' + tip });
    if (this.task) {
      try { await this.taskManager.updateState(this.task.id, harness.TASK_STATES.RUNNING, { force: true }).catch(() => {}); } catch (_) {}
    }
    return this.run();
  }

  /** 暂停闸口：暂停时在此挂起，取消时抛出 */
  async gate() {
    if (this.cancelled) throw new Cancelled();
    if (this.paused) {
      this.state = 'paused';
      if (this.task && !this._pausedLogged) {
        this._pausedLogged = true;
        this.taskManager.updateState(this.task.id, harness.TASK_STATES.PAUSED).catch(() => {});
      }
      this.emit('state', { state: 'paused' });
      await new Promise((resolve) => this._resumeWaiters.push(resolve));
      if (this.cancelled) throw new Cancelled();
      if (this.task) {
        this.taskManager.updateState(this.task.id, harness.TASK_STATES.RUNNING).catch(() => {});
      }
      this._pausedLogged = false;
      this.emit('state', { state: 'running' });
    }
  }

  /* ---------- 主循环 ---------- */

  /** 从对话历史里取一个简短任务标题 */
  _deriveTaskTitle() {
    const fu = this.messages.find((m) => m.role === 'user' && typeof m.content === 'string');
    if (fu) return fu.content;
    const fany = this.messages.find((m) => m.role === 'user');
    if (fany) return '（含附件）任务';
    return '对话';
  }

  /** 新建一个任务并标记为运行中，带上关联会话 id */
  async _createTask(title) {
    const task = await this.taskManager.createTask({
      type: this.toolsEnabled ? 'agent' : 'chat',
      title: String(title).replace(/\s+/g, ' ').slice(0, 80),
      sessionId: this.sessionId
    });
    await this.taskManager.updateState(task.id, harness.TASK_STATES.RUNNING);
    return task;
  }

  /**
   * 扫描当前工作区，生成供 agent 使用的项目结构概览文本（含多语言拆分指导）。
   * 使用缓存版本避免每轮重扫；可选注入代码骨架（L1 摘要）。
   * 与行内补全共用 projectScan.renderProjectContext，保证上下文一致。
   */
  _buildProjectContext() {
    try {
      const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
      if (!folder) return '';
      const cfg = this.cfg || {};
      return projectScan.renderProjectContext(folder.uri.fsPath, null, {
        maxChars: 4000,
        actionable: true,
        maxRoles: 40,
        includeSkeleton: cfg.projectSkeleton !== false,
        skeletonMaxFiles: 20,
        includeNeighbors: false
      });
    } catch (_) {
      return '';
    }
  }

  _buildSkeletonSummary(root, proj) {
    try {
      const mainFiles = (proj.languages || [])
        .map((l) => l.mainPath && require('path').relative(root, l.mainPath))
        .filter(Boolean);
      const map = projectScan.buildSkeletonMap(root);
      const keys = Object.keys(map);
      if (!keys.length) return '';
      const lines = [];
      // 优先输出主入口文件
      for (const f of mainFiles) {
        if (map[f]) {
          lines.push(`📄 ${f}\n${map[f]}`);
          delete map[f];
        }
      }
      // 再输出其它文件，按路径排序，限制数量
      const rest = Object.keys(map).sort().slice(0, 20);
      for (const f of rest) lines.push(`📄 ${f}\n${map[f]}`);
      if (Object.keys(map).length > rest.length) {
        lines.push(`… 还有 ${Object.keys(map).length - rest.length} 个文件未展示`);
      }
      return lines.join('\n\n');
    } catch (_) {
      return '';
    }
  }

  async run() {
    // 增量刷新运行时可能被用户改过的配置项（上下文窗口上限、自动压缩开关），
    // 让改动在当前会话即时生效，不必重启或 Reload Window。
    // 只覆盖这两个字段，不动 baseUrl/model 等（避免覆盖会话创建时传入的值）。
    try {
      const live = await config.resolve(this.context);
      if (live && live.contextWindow != null) this.cfg.contextWindow = live.contextWindow;
      if (live && live.autoSummarize) this.cfg.autoSummarize = live.autoSummarize;
      // 同步 API 协议字段，让聊天窗口的「chat / responses」切换、以及切 provider 即时生效，
      // 无需重建会话。否则 this.cfg 是会话创建时缓存的值，UI 切了协议也不会真正改变后续请求。
      if (live && live.apiMode != null) this.cfg.apiMode = live.apiMode;
      if (live && live.transport != null) this.cfg.transport = live.transport;
    } catch (_) {}
    const cfg = this.cfg;
    const { appendLog } = require('./log');
    const exp = [];
    if (cfg.planner && cfg.planner.enabled) exp.push('planner');
    if (cfg.routing && cfg.routing.gateEnabled) exp.push('router');
    if (cfg.tools && cfg.tools.dynamicSubset && cfg.tools.dynamicSubset.enabled) exp.push('toolSelect');
    if (cfg.selfConsistency && cfg.selfConsistency.enabled) exp.push('selfConsistency');
    if (cfg.tools && cfg.tools.globalTimeout && cfg.tools.globalTimeout.enabled) exp.push('timeoutGuard');
    if (cfg.guardrails && cfg.guardrails.forceCitation) exp.push('forceCitation');
    if (cfg.autoSummarize && cfg.autoSummarize.enabled) exp.push('autoSummarize');
    if (exp.length) appendLog('experiment', '[enabled] ' + exp.join(','));
    this.toolsEnabled = cfg.agentEnabled !== false;
    // 每次进入 run() 都清空规划暂停标志（批准后续跑会再置位）
    this._planPending = false;
    this._planRevised = '';
    // 规划-执行分离：每个任务只规划一次
    this._planned = false;
    // 双重验证：已校验过的 callId 集合，避免循环校验
    if (!this._scVerified) this._scVerified = new Set();
    // 每次用户提问都重置自动继续计数
    this._continuesUsed = 0;

    // ---- Harness：任务状态机 ----
    if (this.taskManager) {
      try {
        const ttl = this._deriveTaskTitle();
        if (this.task) {
          // 本次会话已建过任务（含规划确认续跑），直接复用，避免重复建任务
          await this.taskManager.updateState(this.task.id, harness.TASK_STATES.RUNNING, { force: true }).catch(() => {});
        } else if (this.resumeTaskId) {
          // 续跑模式：优先复用已有任务，不新建，步骤继续追加
          const { appendLog } = require('./log');
          const existing = await this.taskManager.getTask(this.resumeTaskId);
          if (existing) {
            this.task = existing;
            appendLog('checkpoint', '[agent-resume] reuse taskId=' + this.task.id + ' steps=' + (this.task.steps ? this.task.steps.length : 0));
            await this.taskManager.updateState(this.task.id, harness.TASK_STATES.RUNNING, { force: true });
            await this.taskManager.appendStep(this.task.id, { kind: 'resume', text: '任务续跑开始' });
          } else {
            appendLog('checkpoint', '[agent-resume] taskId=' + this.resumeTaskId + ' 未找到，新建任务');
            this.task = await this._createTask(ttl);
          }
        } else {
          this.task = await this._createTask(ttl);
        }
      } catch (_) {
        this.task = null;
      }
    }
    const isDeepResp = cfg.provider === 'deepseek' && cfg.apiMode === 'responses';
    // 若本会话已因「原生工具协议被服务端拒绝（如 MCP 大 schema 触发 400）」而降级过，
    // 后续轮次保持文本协议，避免每轮都先 400 再重试（降级分支见下方 catch）。
    // Responses 协议同样支持 text 降级：通过 instructions 注入工具说明，让模型输出 <fox:tool>。
    // 例外：DeepSeek Responses API 必须走 native 才能触发官方 {type:'web_search'} 原生联网；
    // 一旦降级为 text，模型只会输出 <fox:tool> 调用本地工具，永远调不到官方联网，因此禁止降级。
    if (isDeepResp) {
      this.protocol = 'native';
    } else if (this._forceText) {
      this.protocol = 'text';
    } else {
      this.protocol = !this.toolsEnabled ? 'chat' : cfg.toolProtocol === 'text' ? 'text' : 'native';
    }
    const envBrief = await ctxTools.environmentBrief();

    // 取最后一条用户消息作为知识库检索查询
    const lastUser = this.messages.slice().reverse().find((m) => m.role === 'user');
    const queryText = lastUser
    ? (typeof lastUser.content === 'string'
        ? lastUser.content
        : lastUser.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'))
    : '';

  // ---- 架构·规划-执行分离：轻量规划器（默认关） ----
  // 在真正进入执行主循环前，用一次低成本调用把需求拆成 DAG 步骤，
  // 思考与执行解耦，避免长链路里「边想边错」。失败则静默跳过，不影响主流程。
  try {
    if (cfg.planner && cfg.planner.enabled && !this._planned) {
      await this._runPlanner();
    }
  } catch (_) {}

  // 上下文超限自动压缩：先把较早的对话压进知识库-2，再构建系统提示词（让新摘要可被本次检索）
  try {
    await this._maybeAutoCompress(queryText, envBrief);
  } catch (_) {}

  let baseSystem = buildSystemPrompt(cfg, envBrief, this.protocol, queryText);
    const beforeKb = baseSystem;
    let system = kb.augmentSystemPrompt(baseSystem, queryText);
    let knowledgeText = '';
    if (system.length > beforeKb.length) {
      knowledgeText = system.slice(beforeKb.length).replace(/^\n+/, '');
    }

    // 长期记忆：把用户偏好/约定/教训注入系统提示词
    let memoryText = '';
    try {
      memoryText = this.memory.renderForPrompt();
    } catch (_) {}
    if (memoryText) system += '\n\n【长期记忆】\n' + memoryText;

    // 用户技能：把 agent 自己编写的可复用工作流清单注入系统提示词
    let skillText = '';
    try {
      skillText = this.skills.renderForPrompt();
    } catch (_) {}
    if (skillText) system += '\n\n【用户技能】\n' + skillText;

    // 项目任务清单：把当前可见任务注入系统提示词
    let planTaskText = '';
    try {
      planTaskText = this.planTasks.renderForPrompt();
    } catch (_) {}
    if (planTaskText) system += '\n\n【项目任务清单】\n' + planTaskText;

    // 项目结构：自动扫描工作区并注入概览，让 agent 始终知道文件布局；
    // 多语言项目会明确提示「按语言拆分、每个职责一个文件」地写入。
    const projCtx = this._buildProjectContext();
    if (projCtx) system += '\n\n【项目结构】\n' + projCtx;

    // 对明确的时间查询，直接把当前时间注入 system，避免模型“装傻”
    if (/现在几点|当前时间|今天几号|今天日期|几点了|什么时间|几点钟/i.test(queryText)) {
      try {
        const timeInfo = await tools.execute('current_time', {}, { maxToolOutput: 500 });
        if (timeInfo) system += '\n\n【当前时间信息】\n' + timeInfo;
      } catch (_) {}
    }

    let downgraded = false;

    try {
      const maxSteps = this.toolsEnabled ? Math.max(1, cfg.maxSteps) : 1;
      for (let step = 0; step < maxSteps; step++) {
        await this.gate();
        this.stepCount = step + 1;
        this.deltaSeen = false;
        this.reasoningSeen = false;
        this._estDeltaChars = 0;
        this.state = 'thinking';
        this.emit('state', { state: 'thinking', step: this.stepCount });

        const preparedHistory = await this.prepareHistory();
        this._emitContextUsage({
          baseSystem,
          memoryText,
          skillText,
          planTaskText,
          knowledgeText,
          protocol: this.protocol,
          history: preparedHistory,
          maxTokens: cfg.maxTokens,
          contextWindow: cfg.contextWindow
        });
        const payload = [{ role: 'system', content: system }].concat(preparedHistory);
        const useNative = this.protocol === 'native';

        let result;
        try {
          result = await this.callModel(payload, useNative);
        } catch (err) {
          // 模型不支持 tools（或 MCP 大 schema 触发 400）→ 自动降级到文本协议再试一次
          // DeepSeek Responses API 必须保持 native 才能触发官方 {type:'web_search'} 原生联网；
          // 降级到 text 后模型只会输出 <fox:tool> 调用本地工具，永远调不到官方联网，因此禁止降级。
          if (useNative && !isDeepResp && !downgraded && (this.looksLikeToolUnsupported(err) || (err && err.status === 400))) {
            downgraded = true;
            // 跨轮持久化：本会话后续轮次都走文本协议，不再每轮先 400 再重试。
            // Responses 协议同样降级到 text：通过 instructions 注入文本化工具说明，
            // 让模型用 <fox:tool> 块输出调用，客户端解析执行；不再直接落到无工具的 chat。
            this._forceText = true;
            this.protocol = 'text';
            baseSystem = buildSystemPrompt(cfg, envBrief, this.protocol);
            system = kb.augmentSystemPrompt(baseSystem, queryText);
            knowledgeText = system.length > baseSystem.length ? system.slice(baseSystem.length).replace(/^\n+/, '') : '';
            if (memoryText) system += '\n\n【长期记忆】\n' + memoryText;
            if (skillText) system += '\n\n【用户技能】\n' + skillText;
            if (planTaskText) system += '\n\n【项目任务清单】\n' + planTaskText;
            const projCtx2 = this._buildProjectContext();
            if (projCtx2) system += '\n\n【项目结构】\n' + projCtx2;
            this.emit('notice', {
              text: '当前模型不支持原生函数调用，已自动切换为文本协议模式继续。'
            });
            step--;
            continue;
          }
          throw err;
        }

        if (this.cancelled) throw new Cancelled();

        // 文本协议：某些模型会把 <fox:tool> 标签放在 reasoning 里而不是 content 里，
        // 导致 content 看起来为空、工具没被解析。因此把 content + reasoning 一起作为解析源。
        const textSource =
          this.protocol === 'text'
            ? String(result.content || '') + '\n' + String(result.reasoning || '')
            : String(result.content || '');

        const calls =
          this.protocol === 'native'
            ? (result.toolCalls || []).map((c) => ({ id: c.id, name: c.name, rawArgs: c.arguments }))
            : this.protocol === 'text'
            ? this.parseTextCalls(textSource)
            : [];

        const visibleText =
          this.protocol === 'text' ? this.stripToolBlocks(textSource) : result.content;

        // 模型生成图片：推到 UI 并保存进历史（存档时会剥离 base64）
        const resultImages = Array.isArray(result.images) ? result.images : [];
        for (const img of resultImages) {
          this.emit('image', { src: img.src, alt: img.alt || '模型生成图片' });
        }

        // 记录 assistant 消息
        if (this.protocol === 'native') {
          const msg = { role: 'assistant', content: result.content || '' };
          if (calls.length) {
            msg.tool_calls = calls.map((c) => ({
              id: c.id || 'call_' + Math.random().toString(36).slice(2, 10),
              type: 'function',
              function: { name: c.name, arguments: c.rawArgs || '{}' }
            }));
          }
          // Responses 模式 / Anthropic 模式下，把模型当轮产生的 reasoning 一并存进消息。
          // - DeepSeek 等 Responses 实现要求多轮时把上一轮 assistant 的 reasoning 回传。
          // - Anthropic(claude) 的 extended thinking 同理需要回传 thinking 块。
          // 仅这两种传输附加，避免污染普通 chat/completions 的消息结构。
          if ((cfg.apiMode === 'responses' || cfg.transport === 'anthropic') && result.reasoning && String(result.reasoning).trim()) {
            msg.reasoning = result.reasoning;
          }
          if (resultImages.length) msg.images = resultImages;
          if (msg.content || msg.tool_calls || msg.images) this.messages.push(msg);
        } else if (this.protocol === 'text' && visibleText) {
          // 文本协议：保存去掉工具标签后的可见文本；若 content 为空但 reasoning 有内容，也能记录下来
          const m = { role: 'assistant', content: visibleText };
          if (resultImages.length) m.images = resultImages;
          this.messages.push(m);
        } else if (result.content) {
          const m = { role: 'assistant', content: result.content };
          if (resultImages.length) m.images = resultImages;
          this.messages.push(m);
        }

        if (!calls.length) {
          this.state = 'done';
          if ((!visibleText || !String(visibleText).trim()) && !resultImages.length) {
            const modelHint = cfg.model ? `当前模型：${cfg.model}` : '当前模型名未配置';
            this.emit('notice', {
              text: `模型没有返回任何内容。${modelHint}。\n常见原因：1) 模型名不存在（DeepSeek 用 deepseek-chat）；2) API Key 无效；3) 该模型不支持 tools，可在设置里把 foxAi.agent.toolProtocol 改成 text。`
            });
          }
          // 非流式（或文本协议）下 onDelta 不会触发，需手动把完整文本/思考推给 UI，否则面板看不到回复
          if (visibleText && String(visibleText).trim() && !this.deltaSeen) {
            this.emit('text', { text: visibleText });
          }
          // 展示 reasoning 时也去掉工具标签，避免把 <fox:tool> 当思考内容显示
          const cleanReasoning = result.reasoning ? this.stripToolBlocks(result.reasoning) : '';
          if (cleanReasoning && String(cleanReasoning).trim() && !this.reasoningSeen) {
            this.emit('reasoning', { text: cleanReasoning });
          }

          // ---- 输出截断自动继续 ----
          // OpenAI chat.completions: finish_reason='length'; Responses API: 'incomplete'; Anthropic 已统一映射为 'length'
          const maxContinues = Math.max(0, Number(cfg.maxContinues) || 3);
          if (shouldAutoContinue(result, cfg, this._continuesUsed)) {
            this._continuesUsed++;
            appendLog('agent', `[auto-continue] finishReason=${result.finishReason} count=${this._continuesUsed}/${maxContinues} contentLen=${String(visibleText || '').length}`);
            this.emit('notice', { text: `模型输出达到长度上限，正在自动继续（${this._continuesUsed}/${maxContinues}）…` });
            // 静默插入 continue 提示：不触发 UI 用户消息，只追加到历史供下次请求使用
            this.messages.push({ role: 'user', content: '继续输出剩余内容，保持与上文连贯，不要重复已经输出的部分。' });
            continue;
          }
          const truncated = result.finishReason === 'length' || result.finishReason === 'incomplete';
          if (truncated && this._continuesUsed >= maxContinues) {
            appendLog('agent', `[auto-continue-limit] finishReason=${result.finishReason} reached max ${maxContinues}`);
            this.emit('notice', { text: `已自动继续 ${maxContinues} 次，输出仍被模型长度限制截断。如需继续，请手动发送「继续」。` });
          }

          this.emit('finalText', { text: visibleText });
          if (this.task) {
            try {
              await this.taskManager.appendStep(this.task.id, {
                kind: 'final',
                text: String(visibleText || '').slice(0, 200)
              });
              await this.taskManager.updateState(this.task.id, harness.TASK_STATES.COMPLETED);
            } catch (_) {}
          }
          // planner 生成的「执行计划」在任务完成后自动标记完成
          if (this._planTaskId && this.planTasks) {
            try { await this.planTasks.setStatus(this._planTaskId, 'completed'); } catch (_) {}
          }
          // 任务结束前尝试一次上下文压缩（防止戛然而止导致压缩永远不触发）
          try { await this._maybeAutoCompress(queryText, envBrief); } catch (_) {}
          return { finished: true, text: visibleText };
        }

        // 逐个执行工具
        for (const call of calls) {
          await this.gate();
          await this.handleToolCall(call);
          if (this.cancelled) throw new Cancelled();
        }

        // 自动代码审查：本轮有代码写操作则触发一次只读审查子代理
        if (this._pendingReview.length) {
          await this._runCodeReview();
        }

        // 规划确认模式：模型刚提交/修订了计划 → 暂停，等用户在面板确认后再继续
        if (this._planPending) {
          const plan = this.planTasks ? this.planTasks.list() : [];
          this.emit('planPending', { plan, revised: !!this._planRevised, reason: this._planRevised });
          if (this.task) {
            try { await this.taskManager.updateState(this.task.id, harness.TASK_STATES.AWAITING).catch(() => {}); } catch (_) {}
          }
          return { finished: false, reason: 'plan-pending', plan };
        }
      }

      // 方法论「限制思考-行动轮次」：达到硬性上限。若开启自动压缩，先触发一次状态总结器
      // 压缩上下文（丢弃长链路里无用的推理痕迹），再提示用户；否则直接挂起等待人工/续跑。
      try {
        if (this.cfg.autoSummarize && this.cfg.autoSummarize.enabled) {
          await this._maybeAutoCompress(queryText, envBrief);
        }
      } catch (_) {}
      const { appendLog } = require('./log');
      appendLog('maxSteps', '[limit] steps=' + cfg.maxSteps + ' paused; autoCompress=' + !!(this.cfg.autoSummarize && this.cfg.autoSummarize.enabled));
      this.emit('notice', {
        text: `已连续执行 ${cfg.maxSteps} 步仍未结束，已达硬性上限并暂停。需要的话说“继续”，或调大 foxAi.agent.maxSteps；上下文已尝试压缩以释放空间。`
      });
      // 任务挂起，等待从断点续跑（任务面板可一键续跑）
      if (this.task) {
        try { await this.taskManager.updateState(this.task.id, harness.TASK_STATES.PAUSED); } catch (_) {}
      }
      return { finished: false, reason: 'max-steps' };
    } catch (err) {
      if (err instanceof Cancelled || this.cancelled) {
        this.state = 'cancelled';
        this.messages.push({
          role: 'user',
          content: '[系统] 用户已取消本次任务，请停止当前操作，等待新的指示。'
        });
        if (this.task) {
          try { await this.taskManager.updateState(this.task.id, harness.TASK_STATES.CANCELLED); } catch (_) {}
        }
        return { finished: false, reason: 'cancelled' };
      }
      this.state = 'error';
      if (this.task) {
        try {
          await this.taskManager.appendStep(this.task.id, { kind: 'error', error: String(err && err.message) });
          await this.taskManager.updateState(this.task.id, harness.TASK_STATES.FAILED);
        } catch (_) {}
      }
      throw err;
    } finally {
      this.stream = null;
    }
  }

  /** 根据工具名与报错推断失败原因，给出反思建议，避免模型盲重试陷入循环 */
  _inferFailSuggest(name, msg) {
    const m = String(msg || '').toLowerCase();
    if (m.includes('enoent') || m.includes('no such file') || m.includes('not found') || m.includes('找不到') || m.includes('does not exist'))
      return '很可能是路径/文件不存在。请先用 list_dir 或 find_files 确认路径，或用 search_text 定位目标，不要凭记忆猜路径。';
    if (m.includes('eacces') || m.includes('eperm') || m.includes('permission') || m.includes('denied') || m.includes('权限'))
      return '可能是权限不足或被占用。不要反复重试，先询问用户是否授权，或换用不需要提权的做法。';
    if (m.includes('syntax') || m.includes('invalid') || m.includes('json') || m.includes('参数') || m.includes('unexpected'))
      return '可能是参数格式不合法。请检查参数类型与必填项，用合法 JSON 重新调用。';
    if (m.includes('timeout') || m.includes('etimedout') || m.includes('econn'))
      return '可能是超时或网络/连接问题。可重试一次，或换更简单/更快的命令，必要时询问用户。';
    if (m.includes('already') || m.includes('exists'))
      return '目标可能已经存在。请先检查现状，或改用覆盖/重命名，避免重复创建。';
    return '原因不明。建议先停下来反思：检查参数、路径与前置条件；若仍不确定，直接询问用户，不要盲目循环重试。';
  }

  /** 生成本次改动的摘要，供审查子代理阅读（截断过长的片段） */
  _reviewSummary(name, args) {
    const cut = (s, n) => (s == null ? '' : String(s).length > n ? String(s).slice(0, n) + `…（已截断，共 ${String(s).length} 字）` : String(s));
    if (name === 'delete_file') {
      const scope = args.start_line ? ` 删除行 ${args.start_line}-${args.end_line || args.start_line}` : '';
      return `删除文件/范围：${args.path}${scope}`;
    }
    if (name === 'write_file') {
      return `整体写入 ${args.path}（共 ${String(args.content || '').length} 字）：${cut(args.content, 800)}`;
    }
    // edit_file
    const oldT = args.old_text ? cut(args.old_text, 400) : '';
    const newT = cut(args.new_text, 400);
    const scope = args.start_line ? `（限定行 ${args.start_line}-${args.end_line || args.start_line}）` : '';
    return `修改 ${args.path}${scope}：\n- 旧：${oldT}\n- 新：${newT}`;
  }

  /** 不向 UI 推送的静默模型调用（用于审查子代理等内部请求） */
  async _silentCall(messages) {
    const cfg = this.cfg;
    const b = selectBackend(cfg);
    return b.nonStream({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      messages,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      timeout: cfg.timeout,
      insecureHttpParser: cfg.insecureHttpParser,
      streamFormat: cfg.streamFormat
    });
  }

  /** 自动代码审查：本轮有代码写操作后触发一次只读审查子代理 */
  async _runCodeReview() {
    if (this._reviewing) return;
    const changed = this._pendingReview;
    if (!changed.length) return;
    this._pendingReview = [];
    if (!this.cfg.review || !this.cfg.review.enabled) return;
    this._reviewing = true;
    try {
      this.emit('notice', { text: '🔍 正在用审查子代理检查本次代码改动…' });
      const { ok, text } = await reviewer.runReview({
        silentCall: (m) => this._silentCall(m),
        cfg: this.cfg,
        changed
      });
      const reviewText = (text && String(text).trim()) || '';
      if (ok && reviewText) {
        this.emit('review', { files: changed.map((c) => c.path).filter(Boolean), text: reviewText });
        this.messages.push({
          role: 'user',
          content: '[代码审查意见]\n' + reviewText + '\n\n请据此检查本次改动是否需要修正；若没有问题，直接继续或给出最终回答。'
        });
      } else {
        this.emit('notice', { text: '（审查子代理未返回额外意见）' });
      }
    } catch (e) {
      this.emit('notice', { text: '自动代码审查失败：' + String((e && e.message) || e).split('\n')[0] });
    } finally {
      this._reviewing = false;
    }
  }

  /** 发送前清洗历史：图片按模型能力降级 / 老图片丢弃 */
  async prepareHistory() {
    const cfg = this.cfg;
    const history = this.trimHistory();
    const vision = caps.supportsVision(cfg.model, cfg.visionMode, {
      visionModels: cfg.visionModels,
      textOnlyModels: cfg.textOnlyModels
    });
    this._visionUsed = vision;
    let messages = history;
    // 主模型不支持读图，但配置了第二个多模态模型：先借它把图片转成文字描述
    if (!vision && cfg.visionConfig && cfg.visionConfig.enabled && this._hasImages(history)) {
      try {
        const { messages: described, described: n } = await caps.describeImages(history, (url) => this._callSecondaryVision(url));
        messages = described;
        if (n) {
          // 把识别结果写回 this.messages，避免下一轮又对同一张历史图片重复识别
          const historyImageIdx = [];
          history.forEach((m, i) => { if (this._hasImages([m])) historyImageIdx.push(i); });
          const msgImageIdx = [];
          this.messages.forEach((m, i) => { if (this._hasImages([m])) msgImageIdx.push(i); });
          for (let k = 0; k < historyImageIdx.length && k < msgImageIdx.length; k++) {
            const hi = historyImageIdx[historyImageIdx.length - 1 - k];
            const mi = msgImageIdx[msgImageIdx.length - 1 - k];
            this.messages[mi] = Object.assign({}, this.messages[mi], { content: described[hi].content });
          }
          if (!this._warnedVision) {
            this._warnedVision = true;
            this.emit('notice', { text: `已用第二个多模态模型识别 ${n} 张图片，并把描述交给主模型「${cfg.model}」继续推理。` });
          }
        }
      } catch (e) {
        this.emit('notice', { text: '多模态识图失败，已退回忽略图片：' + String((e && e.message) || e).split('\n')[0] });
      }
    }
    const { messages: sanitized, degraded, trimmed } = caps.sanitizeMessages(messages, {
      vision,
      keepTurns: cfg.keepImageTurns
    });
    if (degraded && !this._warnedVision) {
      this._warnedVision = true;
      this.emit('notice', {
        text: `当前模型「${cfg.model}」被判定为不支持读图，已忽略图片（未配置多模态中转）。\n若想让它理解图片，请在设置里开启 foxAi.vision.enabled 并配置第二个多模态模型；或把模型名加进 foxAi.visionModels 强制发图。`
      });
    }
    if (trimmed && !this._warnedTrim) {
      this._warnedTrim = true;
      this.emit('notice', { text: `为省流量，已省略较早的 ${trimmed} 条历史图片，只保留最近一次上传的图片。` });
    }
    return sanitized;
  }

  /** 消息里是否含任意图片 */
  _hasImages(messages) {
    return (messages || []).some((m) => Array.isArray(m.content) && m.content.some(caps.isImagePart));
  }

  /** 用第二个多模态模型看一张图，返回文字描述 */
  async _callSecondaryVision(imageUrl) {
    const v = this.cfg.visionConfig;
    const prompt =
      '请简洁描述这张图片的关键内容：若是界面/截图，说明布局与可见文字；若含代码/文档，请转写其中文字；若是图表，说明趋势与数值。控制在 300 字以内。';
    const content = [{ type: 'text', text: prompt }];
    if (v.apiMode === 'responses') content.push({ type: 'input_image', image_url: imageUrl });
    else content.push({ type: 'image_url', image_url: { url: imageUrl } });
    const opts = {
      baseUrl: v.baseUrl,
      apiKey: v.apiKey,
      model: v.model,
      messages: [{ role: 'user', content }],
      maxTokens: v.maxTokens,
      timeout: v.timeout
    };
    const r =
      v.transport === 'anthropic'
        ? await anthropic.chatNonStream(opts)
        : v.apiMode === 'responses'
        ? await chatNonStreamResponses(opts)
        : await chatNonStream(opts);
    return (r && r.content) || '';
  }

  looksLikeToolUnsupported(err) {
    const m = String((err && err.message) || '').toLowerCase();
    // 这些 400 明显是「参数/多模态不兼容」，不是工具不支持，别乱降级
    if (
      m.includes('image_url') ||
      m.includes('image') ||
      m.includes('unknown variant') ||
      m.includes('context length') ||
      m.includes('too long') ||
      m.includes('max_tokens')
    ) {
      return false;
    }
    return (
      m.includes('tool') ||
      m.includes('function call') ||
      m.includes('jinja') ||
      m.includes('unsupported')
    );
  }

  /**
   * 服务端因为「不认识 image_url」而报错时：
   * 记住这个模型不能读图（本次运行内生效），把图片降级成文字后重试一次。
   * @returns 重试成功的结果，或 null（表示不是这类错误 / 无图可去）
   */
  async retryWithoutImages(err, options) {
    if (!caps.looksLikeVisionRejection(err)) return null;
    if (this._noImageRetried) return null;
    const hasImage = (options.messages || []).some(
      (m) => Array.isArray(m.content) && m.content.some(caps.isImagePart)
    );
    if (!hasImage) return null;

    this._noImageRetried = true;
    caps.markNoVision(this.cfg.model);
    console.log('[fox-ai] server rejected images, mark no-vision and retry:', this.cfg.model);
    this.emit('notice', {
      text: `服务端拒收图片，说明「${this.cfg.model}」确实不支持读图，已自动去掉图片重试。\n（本次运行内不再给它发图；想永久记住请把它加进设置 foxAi.textOnlyModels）`
    });

    const cleaned = caps.sanitizeMessages(options.messages, { vision: false, keepTurns: 0 });
    const opt2 = Object.assign({}, options, { messages: cleaned.messages });
    try {
      const b = selectBackend(this.cfg);
      return await b.nonStream(opt2);
    } catch (_) {
      return null;
    }
  }

  /** 发起一次模型调用（默认流式，解析失败时自动非流式兜底） */
  async callModel(payload, useNative, toolsOverride) {
    const cfg = this.cfg;
    const isDeepResp = cfg.provider === 'deepseek' && cfg.apiMode === 'responses';
    const queryForTools = (() => {
      if (!Array.isArray(payload)) return '';
      const u = payload.slice().reverse().find((m) => m && m.role === 'user');
      if (!u) return '';
      if (typeof u.content === 'string') return u.content;
      if (Array.isArray(u.content)) return u.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
      return '';
    })();
    const openAiTools = tools.toOpenAITools(queryForTools, cfg);
    console.log('[fox-ai] callModel', cfg.baseUrl, cfg.model, 'native=', useNative, 'isDeepResp=', isDeepResp, 'tools=', openAiTools.length, openAiTools.map((t) => (t.function && t.function.name) || t.type).join(','));
    const options = {
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      messages: payload,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      timeout: cfg.timeout,
      insecureHTTPParser: cfg.insecureHttpParser,
      streamFormat: cfg.streamFormat,
      onDelta: (t) => {
        this.deltaSeen = true;
        this.emit('text', { text: t });
        this._estDeltaChars = (this._estDeltaChars || 0) + String(t).length;
        if (this._estDeltaChars % 100 < String(t).length || this._estDeltaChars < 100) {
          this._emitContextUsageDelta(this._estDeltaChars);
        }
      },
      onReasoning: (t) => { this.reasoningSeen = true; this.emit('reasoning', { text: t }); },
      onToolCallStart: (name) => this.emit('toolPending', { name })
    };
    const b = selectBackend(cfg);
    const useResp = b.responses;

    // —— 动态工具注册（按模型条件性注入）——
    // deepseek + responses：toOpenAITools 已「排除本地 web_search、注入原生 {type:'web_search'}」，
    //   绝对不会出现同名本地函数与原生工具抢路由；其余模型/模式则只给普通 function 工具（含本地 web_search）。
    // 这样热切换模型时各自安好：DeepSeek 走官方联网，其他模型走本地 web_search。
    if (useNative || isDeepResp) {
      options.tools = toolsOverride || openAiTools;
    } else if (this.protocol === 'text') {
      options.stopMarker = TOOL_END;
    }

    // —— 时效性提问：deepseek+responses 下「只给原生搜索工具」并持续保持，彻底杜绝模型改用
    //    fetch / Chrome DevTools / MCP 代替官方联网，同时保证搜索连续不中途断掉 ——
    if (isDeepResp) {
      const dec = computeOfficialSearch(payload, this._officialSearchStarted);
      if (dec) {
        this._officialSearchStarted = dec.started;
        options.tools = dec.tools;
        if (dec.toolChoice) options.toolChoice = dec.toolChoice;
        else delete options.toolChoice;
        console.log('[fox-ai] official web_search session keep, query=', String(dec.query || '').slice(0, 50), 'forceChoice=', !!dec.toolChoice);
      }
    }

    // 强制非流式，或本次会话已确认流式不可用：直接走非流式
    if (cfg.forceNonStream || this.streamBroken) {
      try {
        return await b.nonStream(options);
      } catch (err) {
        const retried = await this.retryWithoutImages(err, options);
        if (retried) return retried;
        throw err;
      }
    }

    const { promise, handle } = useResp ? wrapStream(options, streamResponses) : b.once(options);
    this.stream = handle;
    try {
      return await promise;
    } catch (err) {
      // 服务端明确拒收图片 → 记住这个模型不支持读图，去图重试一次
      const retriedNoImg = await this.retryWithoutImages(err, options);
      if (retriedNoImg) return retriedNoImg;
      // 流式响应被截断/解析失败时，用非流式再试一次
      if (err && err.canRetryNonStream) {
        console.log('[fox-ai] fallback to non-stream because:', err.message);
        this.streamBroken = true; // 本次会话后续都走非流式，避免反复撞墙
        this.emit('notice', { text: '流式响应解析失败，已自动改用非流式请求…' });
        try {
          const r = await b.nonStream(options);
          // 非流式成功且非空，直接返回（不再把原始流式错误抛出去）
          if (r && !(r.empty && !r.toolCalls.length)) return r;
          // 非流式返回空：说明问题不是网络，而是模型/参数，抛非流式的结果让上层判断
          if (r && r.empty) return r;
        } catch (fallbackErr) {
          console.log('[fox-ai] non-stream also failed:', fallbackErr.message);
          const retried = await this.retryWithoutImages(fallbackErr, options);
          if (retried) return retried;
          // 不在这里私自降级到 chat，统一交给 run() 的降级分支处理：
          // Chat 协议会降到 text 协议（仍有工具说明），Responses 协议只能降到 chat。
          throw fallbackErr;
        }
      }
      throw err;
    }
  }

  /**
   * 判断最后一条 tool 角色消息对应的工具是否为官方 web_search。
   * 用于「时效性提问在 deepseek+responses 下始终只给官方联网」的逻辑：
   * 当官方搜索结果已回传、模型准备总结时，仍不许放开本地 fetch 等工具，避免绕圈。
   * @param {Array} messages 当前请求的消息列表
   * @returns {boolean}
   */
  _lastToolIsWebSearch(messages) {
    const lastTool = [...messages].reverse().find((m) => m && m.role === 'tool' && m.tool_call_id);
    if (!lastTool) return false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        const call = m.tool_calls.find((c) => c.id === lastTool.tool_call_id);
        if (call) return (call.function && call.function.name) === 'web_search';
      }
    }
    return false;
  }

  /** 解析文本协议里的工具调用 */
  parseTextCalls(content) {
    const out = [];
    const text = String(content || '');
    writeAgentLog('textcalls', [`parseTextCalls input len=${text.length}`, `head=${text.slice(0, 300).replace(/\s+/g, ' ')}`]);
    TOOL_BLOCK.lastIndex = 0;
    let m;
    while ((m = TOOL_BLOCK.exec(text)) !== null) {
      out.push({ id: 'text_' + out.length, name: m[1], rawArgs: m[2] });
      if (out.length >= 3) break;
    }
    if (!out.length) {
      // 处理被 stopMarker 截断、结尾缺少闭合标签的情况
      const open = TOOL_OPEN.exec(text);
      if (open) {
        const body = text.slice(open.index + open[0].length).replace(/<\/fox:tool>[\s\S]*$/, '');
        if (body.trim()) out.push({ id: 'text_0', name: open[1], rawArgs: body });
      }
    }
    writeAgentLog('textcalls', [`parseTextCalls output count=${out.length}`, `names=${out.map((c) => c.name).join(',')}`, `rawArgsPreview=${out.map((c) => String(c.rawArgs).slice(0, 100)).join(' | ')}`]);
    return out;
  }

  stripToolBlocks(content) {
    return String(content || '')
      .replace(TOOL_BLOCK, '')
      .replace(/<fox:tool[\s\S]*$/i, '')
      .trim();
  }

  /** 本地启发式：query 是否像多步骤任务（避免每次调 planner） */
  async _runPlanner() {
    this._planned = true;
    const cfg = this.cfg;
    if (!cfg.planner || !cfg.planner.enabled) return;
    const mode = cfg.planner.mode || 'auto';
    if (mode === 'off') return;

    const { appendLog } = require('./log');
    const lastUser = this.messages.slice().reverse().find((m) => m.role === 'user');
    const query = lastUser
      ? (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content))
      : '';
    if (!query) return;

    // —— auto 模式：先判断是否为多步骤任务，单步直接跳过 ——
    if (mode === 'auto' && !_isMultiStepTask(query)) {
      appendLog('planner', '[skip-auto] single-step queryLen=' + query.length);
      return;
    }

    const config = require('./config');
    const client = require('./client');
    const planner = require('./planner');

    // 默认用便宜小模型；plannerTimeout 默认 30s，上限 45s
    const plannerTimeout = Math.min((cfg.planner.timeoutMs || 30000), 45000);
    const plannerModel = cfg.planner.model || 'deepseek-chat'; // 不设就用便宜模型，不使用主模型（避免慢+贵）
    const callModel = async (msgs, opts) => {
      const live = await config.resolve(this.context);
      const r = await client.chatNonStream({
        baseUrl: cfg.planner.baseUrl || live.baseUrl,
        apiKey: live.apiKey,
        model: plannerModel,
        messages: [{ role: 'system', content: opts.system }, ...msgs],
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        timeout: plannerTimeout
      });
      return r && r.content ? r.content : '';
    };

    let steps;
    try {
      appendLog('planner', '[start] queryLen=' + query.length + ' model=' + plannerModel + ' mode=' + mode);
      steps = await planner.generatePlan(this.messages, cfg, callModel);
      appendLog('planner', '[ok] steps=' + (steps ? steps.length : 0) + (steps && steps.length ? ' titles=' + steps.map((s) => s.title).join(' | ') : ''));
    } catch (e) {
      const msg = (e && e.message ? e.message : String(e)).split('\n')[0];
      appendLog('planner', '[fail] ' + msg);
      this.emit('notice', { text: `〔规划器〕生成计划失败（${msg}），已降级为直接执行。` });
      // 降级：不阻塞，直接让主循环继续（无计划模式）
    }
    if (!steps || !steps.length) return;
    this._plan = steps;
    this.emit('plan', steps);
    this.emit('notice', { text: `已生成执行计划（${steps.length} 步），开始执行。` });
    // 写入「项目任务清单」，复用既有 UI 展示 DAG
    try {
      if (this.planTasks) {
        const desc = steps.map((s) => {
          const dep = s.dependsOn && s.dependsOn.length ? `（依赖：${s.dependsOn.join('、')}）` : '';
          const par = s.parallel ? '［并行］' : '';
          return `• ${s.title}${dep}${par}`;
        }).join('\n');
        const pt = await this.planTasks.create({ subject: '📋 执行计划', description: desc, status: 'in_progress' });
        if (pt && pt.id) this._planTaskId = pt.id;
      }
    } catch (_) {}
  }

  /** 双重验证：用不同温度再请模型推导一次同一决策（供 selfConsistency.verifyCall 使用） */
  _scCallModel(messages, opts) {
    const client = require('./client');
    const cfg = this.cfg;
    return client.chatNonStream({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      messages,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens
    }).then((r) => (r && r.content) ? r.content : '');
  }

  /** 执行单个工具（含审批、结果回填） */
  async handleToolCall(call) {
    const name = call.name;
    const callId = call.id || 'call_' + Math.random().toString(36).slice(2, 10);
    let args;
    try {
      args = safeParseArgs(call.rawArgs);
    } catch (e) {
      this.pushToolResult(callId, name, `参数解析失败：${e.message}\n请重新以合法 JSON 调用。`, true, {
        reason: '参数不是合法 JSON',
        suggest: '请用合法 JSON 重新调用该工具，注意字符串转义与引号。'
      });
      return;
    }

    const tool = tools.getTool(name);
    if (!tool) {
      this.pushToolResult(callId, name, `没有 ${name} 这个工具，请从可用列表里选。`, true, {
        reason: '工具名不存在',
        suggest: '请从可用工具列表中重新选择，不要编造工具名。'
      });
      return;
    }

    // —— 重复读取去重：同一文件连续读 3 次以上 → 拒绝 ——
    if (name === 'read_file' && args && args.path) {
      if (!this._readFileHistory) this._readFileHistory = [];
      const recent = this._readFileHistory.slice(-6).filter((r) => r.path === args.path).length;
      if (recent >= 3) {
        this.pushToolResult(callId, name, `文件 ${args.path} 已在最近 ${recent} 轮中多次读取，内容未变。请直接基于已有信息继续，不要重复读取同一文件。`, true, {
          reason: '已知信息未变，无需反复读取',
          suggest: '基于之前已读取的文件内容继续推进任务，不做无意义的重复操作。'
        });
        return;
      }
    }

    const kind = tool.kind;
    const title = tools.titleOf(name, args);
    const uiId = 'tool-' + callId + '-' + Date.now().toString(36);

    // 生成改动预览
    let preview = null;
    if (kind === 'edit') {
      preview = await this.buildPreview(name, args).catch(() => null);
    }

    this.emit('toolStart', { id: uiId, name, kind, title, args, preview });
    this.state = 'tool';

    // ---- Harness：策略引擎拦截危险写/执行 ----
    let skipApprove = false;
    if (this.policy) {
      let op = null;
      const popts = { label: title };
      if (kind === 'edit' || kind === 'write' || kind === 'delete') {
        op = harness.OP.WRITE;
        popts.path = args.path;
      } else if (kind === 'exec') {
        op = harness.OP.EXEC;
        popts.command = args.command;
      } else if (name === 'call_extension_command') {
        op = harness.OP.CALL_EXT;
        popts.command = args.command;
      }
      if (op) {
        const verdict = this.policy.evaluate(op, popts);
        if (verdict.decision === 'deny') {
          this.emit('toolEnd', { id: uiId, ok: false, output: verdict.reason, rejected: true });
          this.pushToolResult(callId, name, verdict.reason, true, {
            reason: '被策略引擎判定为危险操作而拒绝',
            suggest: '不要重复尝试同一操作，改为询问用户是否需要换一个更安全的做法。'
          });
          if (this.task) {
            try {
              await this.taskManager.appendStep(this.task.id, { kind: 'tool', name, op, decision: 'deny', reason: verdict.reason });
            } catch (_) {}
          }
          return;
        }
        if (verdict.decision === 'auto') skipApprove = true;
      }
    }

    // 插件联动：已加入白名单的命令跳过 fox-ai 这层审批，由扩展桥自己处理二次确认
    let extSkipConfirm = false;
    if (name === 'call_extension_command') {
      const allowed = bridge.isAllowed(args.command);
      if (allowed) {
        skipApprove = true;
        extSkipConfirm = config.conf().get('bridge.silentAllowed', false);
      }
    }

    // 工作区外写/删操作需三重确认（读操作不受影响）
    let outsideConfirmed = false;
    if (kind === 'edit') {
      const outsidePath = this._toolPathOutsideWorkspace(args);
      if (outsidePath) {
        if (ws.isSystemPath(outsidePath)) {
          this.emit('toolEnd', { id: uiId, ok: false, output: '系统敏感路径禁止写入', rejected: true });
          this.pushToolResult(callId, name, '系统敏感路径禁止写入', true, { reason: '目标路径属于系统敏感区域' });
          return;
        }
        const confirmed = await this.confirmOutsideWorkspace(outsidePath);
        if (!confirmed) {
          this.emit('toolEnd', { id: uiId, ok: false, output: '用户取消了工作区外操作', rejected: true });
          this.pushToolResult(callId, name, '已取消：工作区外写入/删除需用户确认。', true, { reason: '用户未通过三重确认' });
          return;
        }
        outsideConfirmed = true;
      }
    }

    // use_skill 始终先询问用户（用前询问），不被 autoApprove 跳过
    if (name === 'use_skill') skipApprove = false;

    const decision = skipApprove || name === 'save_memory' || name === 'get_memory'
      || name === 'present_plan' || name === 'revise_plan'
      ? 'approve'
      : await this.approve({ id: uiId, name, kind, title, args, preview });
    if (decision === 'reject' || decision === 'reject-cancel') {
      const msg = decision === 'reject-cancel' ? '用户取消了任务' : '用户拒绝了这次操作';
      this.emit('toolEnd', { id: uiId, ok: false, output: msg, rejected: true });
      this.pushToolResult(callId, name, `${msg}。请不要重复尝试同一操作，改为询问用户下一步怎么做。`, true, {
        reason: msg,
        suggest: '不要重复尝试同一操作，先询问用户下一步希望怎么做。'
      });
      if (this.task) {
        try { await this.taskManager.appendStep(this.task.id, { kind: 'tool', name, decision: 'reject' }); } catch (_) {}
      }
      return;
    }

    await this.gate();

    // ---- 幻觉·双重验证（Self-Consistency，默认关） ----
    // 对高风险工具，执行前用不同温度再请模型推导一次同一决策，不一致则暂停等人工复核。
    const sc = this.cfg.selfConsistency;
    if (sc && sc.enabled && !this._scVerified.has(callId)) {
      this._scVerified.add(callId);
      const { appendLog } = require('./log');
      try {
        const selfConsistency = require('./selfConsistency');
        appendLog('selfConsistency', '[start] tool=' + name + ' callId=' + callId);
        const verdict = await selfConsistency.verifyCall(call, this.messages, this.cfg, this._scCallModel.bind(this));
        appendLog('selfConsistency', '[verdict] tool=' + name + ' guarded=' + !!verdict.guarded + ' consistent=' + !!verdict.consistent + (verdict.reason ? ' reason=' + verdict.reason : ''));
        if (verdict.guarded && !verdict.consistent) {
          this.emit('toolEnd', { id: uiId, ok: false, output: '双重验证未通过', rejected: true });
          this.pushToolResult(callId, name, `双重验证未通过：两次决策不一致。${verdict.reason}\n请重新评估方案或先与用户确认，不要盲目重试同一操作。`, true, {
            reason: 'Self-Consistency 双重验证未通过',
            suggest: '重新评估方案或先与用户确认，不要盲目重试。'
          });
          if (this.task) {
            try { await this.taskManager.appendStep(this.task.id, { kind: 'tool', name, decision: 'sc-fail' }); } catch (_) {}
          }
          return;
        }
      } catch (e) {
        appendLog('selfConsistency', '[verify-fail-skip] tool=' + name + ' ' + (e && e.message ? e.message : String(e)));
        // 验证本身失败绝不阻断执行（如模型再推导异常），仅跳过校验
      }
    }

    const execCtx = {
      token: this.token,
      maxToolOutput: this.cfg.maxToolOutput,
      blockedCommands: this.cfg.blockedCommands,
      recordUndo: (e) => undo.record(e),
      memory: this.memory,
      skills: this.skills,
      planTasks: this.planTasks,
      context: this.context,
      onStream: (chunk) => this.emit('toolStream', { id: uiId, text: chunk }),
      // 生图工具用它把生成的图片直接渲染到聊天 UI（复用 0.8.42 的 image 渲染链路）
      emitImage: (img) => this.emit('image', img || {}),
      outsideConfirmed,
      skipConfirm: extSkipConfirm
    };

    try {
      const output = await tools.execute(name, args, execCtx);
      this.emit('toolEnd', { id: uiId, ok: true, output });
      // ---- Harness：自动验证层 ----
      let finalOutput = output;
      const verifyNote = await this._autoVerify(name, args, output);
      if (verifyNote) finalOutput = output + '\n\n[自动验证] ' + verifyNote;
      const okMeta = {};
      if (name === 'run_command') {
        const cm = String(output).match(/退出码\s*(\-?\d+)/);
        if (cm) okMeta.okNote = `命令退出码 ${cm[1]}`;
      }
      // ---- 记录改动，供自动代码审查使用 ----
      if (name === 'edit_file' || name === 'write_file' || name === 'delete_file') {
        this._pendingReview.push({
          name,
          path: args.path,
          op: name === 'write_file' ? '新增/覆盖' : name === 'delete_file' ? '删除' : '修改',
          summary: this._reviewSummary(name, args)
        });
      }
      // 记录 read_file 调用（用于去重）—— 成功执行后存档
      if (name === 'read_file' && args && args.path) {
        if (!this._readFileHistory) this._readFileHistory = [];
        this._readFileHistory.push({ path: args.path, time: Date.now() });
        if (this._readFileHistory.length > 12) this._readFileHistory.shift();
      }
      this.pushToolResult(callId, name, finalOutput, false, okMeta);
      // ---- 规划确认模式：模型提交/修订计划后暂停，等待用户在面板里确认 ----
      // 仅在开启规划确认模式时才暂停；关闭时 present_plan/revise_plan 仅作普通提示，不阻断执行。
      if ((name === 'present_plan' || name === 'revise_plan') && this.cfg.planAndExecute && this.cfg.planAndExecute.enabled) {
        this._planPending = true;
        this._planRevised = name === 'revise_plan' ? (args && args.reason) || '' : this._planRevised;
      }
      if (this.task) {
        try {
          await this.taskManager.appendStep(this.task.id, { kind: 'tool', name, op: kind, decision: 'approve', ok: true, verify: verifyNote || null });
        } catch (_) {}
      }
    } catch (e) {
      const msg = (e && e.message) || String(e);
      this.emit('toolEnd', { id: uiId, ok: false, output: msg });
      this.pushToolResult(callId, name, '执行失败：' + msg, true, {
        reason: '工具执行抛出异常：' + msg,
        suggest: this._inferFailSuggest(name, msg)
      });
      if (this.task) {
        try {
          await this.taskManager.appendStep(this.task.id, { kind: 'tool', name, op: kind, decision: 'approve', ok: false, error: msg });
        } catch (_) {}
      }
    }
  }

  /** 自动验证：命令退出码 / 写后诊断 */
  async _autoVerify(name, args, output) {
    try {
      if (name === 'run_command') {
        const m = String(output).match(/退出码\s*(\-?\d+)/);
        if (m) {
          const code = parseInt(m[1], 10);
          const v = harness.verifyCommand(code, '', output);
          return v.ok ? null : v.feedback;
        }
        return null;
      }
      if (name === 'write_file' || name === 'edit_file' || name === 'delete_file') {
        const uri = ws.resolveUri(args.path, { allowOutside: true });
        const parts = [];
        const d = await harness.verifyWriteDiagnostics((u) => vscode.languages.getDiagnostics(u), uri);
        if (!d.ok) parts.push(d.feedback);
        const n = harness.verifyNodeSyntax(uri.fsPath, this.cfg.nodePath);
        if (!n.ok) parts.push(n.feedback);
        const a = await this._verifyWithAI(uri.fsPath);
        if (a) parts.push(a);
        return parts.length ? parts.join('\n') : null;
      }
    } catch (_) {}
    return null;
  }

  /** AI 代码审查：把文件内容发给可自定义的模型做严格审查。默认关闭。 */
  async _verifyWithAI(filePath) {
    try {
      const v = this.cfg && this.cfg.verify;
      if (!v || !v.enabled) return null;
      if (!filePath) return null;
      const ext = (path.extname(filePath) || '').toLowerCase();
      if (!['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java'].includes(ext)) return null;
      let code = '';
      try { code = await ws.readText(ws.resolveUri(filePath, { forRead: true })); } catch (_) { return null; }
      if (!code || code.length > 20000) return null; // 太大跳过，避免 token 爆炸

      const providerId = v.provider || this.cfg.providerId;
      const model = v.model || config.modelName(providerId);
      const baseUrl = v.baseUrl || config.baseUrlFor(providerId);
      const apiKey = await config.getApiKey(this.context, providerId);

      const prompt =
        '你是一个严格的代码审查员。请审查下面这段源代码，只关注真实问题：\n' +
        '1) 语法/解析错误；2) 明显的运行时错误（如引用未定义变量、错误 API 用法）；\n' +
        '3) 逻辑 bug；4) 安全泄漏（密钥硬编码、命令注入等）。\n' +
        '如果代码没有问题，只回复一个单词：PASS。\n' +
        '如果有问题，先用一行写「FAIL」，然后逐条列出问题（带行号或片段），不要给修改后代码。\n\n' +
        '文件路径：' + filePath + '\n语言：' + ext.replace('.', '') + '\n\n代码：\n' + code;

      const res = await chatNonStream({
        baseUrl,
        apiKey,
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.0,
        maxTokens: 1024,
        timeout: 30000
      });
      const text = (res && res.content ? res.content : '').trim();
      if (!text || /^PASS\b/i.test(text)) return null;
      return '🔍 AI 代码审查未通过（模型：' + model + '）：\n' + text;
    } catch (_) {}
    return null;
  }

  async buildPreview(name, args) {
    if (name === 'write_file') {
      const uri = ws.resolveUri(args.path, { allowOutside: true });
      const existed = await ws.exists(uri);
      const before = existed ? await ws.readText(uri) : '';
      const after = String(args.content == null ? '' : args.content);
      return {
        path: ws.relative(uri),
        existed,
        stat: ws.diffStat(before, after),
        text: existed ? ws.unifiedPreview(before, after) : after.split('\n').slice(0, 40).map((l) => '+ ' + l).join('\n'),
        before,
        after
      };
    }
    if (name === 'edit_file') {
      const uri = ws.resolveUri(args.path, { allowOutside: true });
      const before = await ws.readText(uri);
      const oldText = String(args.old_text || '');
      const newText = String(args.new_text == null ? '' : args.new_text);
      const after = args.replace_all ? before.split(oldText).join(newText) : before.replace(oldText, newText);
      return {
        path: ws.relative(uri),
        existed: true,
        stat: ws.diffStat(before, after),
        text: ws.unifiedPreview(before, after),
        before,
        after
      };
    }
    if (name === 'delete_file') {
      const uri = ws.resolveUri(args.path, { allowOutside: true });
      return { path: ws.relative(uri), existed: true, stat: { added: 0, removed: 0 }, text: '（整个文件将被移入回收站）' };
    }
    return null;
  }

  /** 解析工具参数中的 path，若在工作区外则返回绝对路径，否则返回 null */
  _toolPathOutsideWorkspace(args) {
    try {
      const uri = ws.resolveUri(args.path, { allowOutside: true });
      return ws.isOutsideWorkspace(uri) ? uri.fsPath : null;
    } catch (_) {
      return null;
    }
  }

  /** 工作区外写/删操作的确认（级别由配置决定） */
  async confirmOutsideWorkspace(filePath) {
    const level = (this.cfg && this.cfg.workspace && this.cfg.workspace.outsideEditConfirm) || 'triple';
    if (level === 'off') return true;

    const short = path.basename(filePath);
    // 第一重：模态警告
    const first = await vscode.window.showWarningMessage(
      `即将修改工作区外的文件：${short}\n路径：${filePath}`,
      { modal: true },
      level === 'single' ? '确认修改' : '继续（还需确认）'
    );
    const proceedLabel = level === 'single' ? '确认修改' : '继续（还需确认）';
    if (first !== proceedLabel) return false;
    if (level === 'single') return true;

    if (level === 'triple') {
      // 第二重：预填完整路径，打开即显示地址（可直接复制核对），回车即确认，免去手敲粘贴出错
      const input = await vscode.window.showInputBox({
        value: filePath,
        prompt: '已预填完整路径：直接回车确认，或复制核对后再回车',
        placeHolder: filePath,
        validateInput: (value) => {
          const normalizedInput = (value || '').replace(/\\/g, '/').trim().toLowerCase();
          const normalizedTarget = filePath.replace(/\\/g, '/').trim().toLowerCase();
          return normalizedInput === normalizedTarget ? null : '路径不匹配，请保持预填路径不变再回车';
        }
      });
      if (!input) return false;
    }

    // 最终确认
    const final = await vscode.window.showWarningMessage(
      `最后确认：真的要修改工作区外的 ${short} 吗？\n此操作可能影响系统或个人文件。`,
      { modal: true },
      '确认修改'
    );
    return final === '确认修改';
  }

  /** 询问用户是否允许 */
  async approve(req) {
    const mode = this.cfg.autoApprove || 'read';
    const kind = req.kind;
    if (this.alwaysAllow.has(req.name)) return 'approve';
    if (mode === 'all') return 'approve';
    if (mode === 'edit' && kind !== 'exec') return 'approve';
    if (mode === 'read' && kind === 'read') return 'approve';
    if (typeof this.ui.requestApproval !== 'function') return 'approve';

    this.state = 'awaiting-approval';
    this.emit('state', { state: 'awaiting-approval' });
    const decision = await new Promise((resolve) => {
      this._pendingApproval = resolve;
      this.ui.requestApproval(req, (d) => {
        if (this._pendingApproval) {
          this._pendingApproval = null;
          resolve(d);
        }
      });
    });
    if (decision === 'always') {
      this.alwaysAllow.add(req.name);
      return 'approve';
    }
    return decision;
  }

  pushToolResult(callId, name, output, isError, meta) {
    meta = meta || {};
    let text = String(output == null ? '' : output);
    const cfg = this.cfg || {};
    const maxToolOutput = cfg.maxToolOutput || 8000;
    if (text.length > maxToolOutput) {
      text = text.slice(0, maxToolOutput) + `\n…（输出已截断，原 ${text.length} 字）`;
    }
    const status = isError ? 'error' : 'ok';
    let observe;
    if (isError) {
      const reason = meta.reason || '执行失败';
      // 去重/已存在类错误 → 不要引导反思，直接禁止重试
      const isDuplicate = /已存在|无需重复|完全相同/i.test(reason) || /已存在|无需重复|完全相同/i.test(text.slice(0, 500));
      const suggest = meta.suggest
        || (isDuplicate
          ? '该操作已被系统明确拒绝（内容重复/已存在），【绝对不允许】再次尝试同一工具。你必须立即换用其他方式完成任务，或直接询问用户。'
          : '请先反思：失败可能是参数错误、路径/文件不存在、命令不可用或权限不足。不要盲目重试同一操作；建议检查参数与路径、换用更稳妥的工具（如先用 search_text 定位），仍无法确定时直接询问用户。');
      observe = `\n\n[观察摘要] 工具 ${name} 执行失败（status=error）：${reason}。\n[反思] ${suggest}`;
    } else {
      const okNote = meta.okNote ? ' ' + meta.okNote : '';
      observe = `\n\n[观察摘要] 工具 ${name} 执行成功（status=ok）。${okNote}`;
    }
    const payload = text + observe;
    if (this.protocol === 'native') {
      this.messages.push({
        role: 'tool',
        tool_call_id: callId,
        name,
        content: payload
      });
    } else {
      this.messages.push({
        role: 'user',
        content: `[工具 ${name} 的结果]\n${payload}\n\n请根据结果继续，或给出最终回答。`
      });
    }
    // 防止历史无限膨胀：关闭自动压缩时也定期就地清理
    this._compactMessages();
  }

  /**
   * 上下文超限自动压缩：用量占比超过阈值时，把较早的对话用「整理 AI」压缩成摘要写入
   * 「知识库-2」，并就地裁剪历史（splice，保持与 chatView 共享的数组引用一致），
   * 立即释放上下文；同时 invalidate 知识库缓存，让新摘要可被后续检索。
   * @param {string} queryText 当前用户提问（暂未用于压缩，保留以对齐签名）
   * @param {string} envBrief 环境简述（用于估算系统提示词固定开销）
   */
  async _maybeAutoCompress(queryText, envBrief) {
    const as = this.cfg.autoSummarize || {};
    const { appendLog } = require('./log');
    if (!as.enabled) return;
    const cw = this.cfg.contextWindow || 0;
    const keep = Math.max(2, as.keepRecent || 6);
    const msgs = this.messages || [];
    const compressible = msgs.length - keep;
    if (compressible < 4) return; // 早期消息太少，不值得压缩

    // 触发条件（满足其一即可）：
    //  A. 配置了上下文窗口且占用超阈值（防超窗口）——默认阈值 0.75
    //  B. 未配置上下文窗口时，按对话轮数触发（累计约 6 条可压缩消息 ≈ 每 3 轮做一次增量摘要），
    //     保证能力⑥「每 3 轮摘要」在没填 contextWindow 时也能达成，而不是永远不压缩。
    const threshold = as.threshold > 0 ? as.threshold : 0.75;
    let should = false;
    let reason = '';
    if (cw) {
      const baseSys = buildSystemPrompt(this.cfg, envBrief || '', this.protocol);
      const toolsText = this.protocol === 'native'
        ? JSON.stringify(tools.toOpenAITools())
        : tools.toTextManual();
      const fixedTokens = contextUsage.estimateTokens(baseSys) + contextUsage.estimateTokens(toolsText) + 800;
      const used = contextUsage.estimateMessages(msgs) + fixedTokens;
      if (used / cw >= threshold) { should = true; reason = 'usage'; }
    } else if (compressible >= 6) {
      should = true;
      reason = 'turn-based';
    }
    if (!should) return;

    // 取较早消息去压缩，保留最近 keep 条
    const toCompress = msgs.slice(0, compressible);
    appendLog('autoSummarize', '[compress] used%=' + Math.round((used / cw) * 100) + ' threshold%=' + Math.round(threshold * 100) + ' compressible=' + toCompress.length);
    this.emit('notice', {
      text: `上下文已用约 ${Math.round((used / cw) * 100)}%，正在把较早的 ${toCompress.length} 条对话压缩进知识库-2…`
    });

    try {
      const out = await kbOrg.summarizeConversation(this.context, toCompress, {
        onLog: (t) => { try { this.emit('notice', { text: '[知识库-2] ' + t }); } catch (_) {} }
      });
      if (out) {
        kb.invalidate(); // 重新索引，把新摘要纳入 RAG
        msgs.splice(0, compressible); // 就地裁剪，保持数组引用一致（chatView 同步看到）
        try { this.emit('autoSummary', { file: out, count: toCompress.length }); } catch (_) {}
        appendLog('autoSummarize', '[ok] compressed=' + toCompress.length + ' file=' + out);
        this.emit('notice', {
          text: `已把较早 ${toCompress.length} 条对话压缩进知识库-2，上下文已释放；后续回答会结合检索到的摘要继续。`
        });
      }
    } catch (e) {
      appendLog('autoSummarize', '[fail] ' + String(e.message).split('\n')[0]);
      this.emit('notice', { text: '自动压缩失败：' + String(e.message).split('\n')[0] });
    }
  }

  /** 裁剪历史，保证 tool 消息不与对应的 assistant 分离 */
  _emitContextUsage(parts) {
    try {
      this._lastContextParts = parts;
      const toolsText = parts.protocol === 'native'
        ? JSON.stringify(tools.toOpenAITools())
        : tools.toTextManual();
      const data = contextUsage.measureContext({
        baseSystem: parts.baseSystem,
        memoryText: parts.memoryText,
        skillText: parts.skillText,
        planTaskText: parts.planTaskText,
        knowledgeText: parts.knowledgeText,
        toolsText,
        history: parts.history,
        maxTokens: parts.maxTokens,
        contextWindow: parts.contextWindow
      });
      this.emit('contextUsage', data);
    } catch (_) {}
  }

  /** 基于本轮输出长度增量，实时估算+重推上下文用量 */
  _emitContextUsageDelta(extraChars) {
    try {
      if (!this._lastContextParts) return;
      const parts = this._lastContextParts;
      const extraTokens = Math.max(1, Math.round(extraChars / 2));
      const history = [...(parts.history || [])];
      history.push({ role: 'assistant', content: '█'.repeat(Math.min(extraChars, 200)) });
      const toolsText = parts.protocol === 'native'
        ? JSON.stringify(tools.toOpenAITools())
        : tools.toTextManual();
      const data = contextUsage.measureContext({
        baseSystem: parts.baseSystem,
        memoryText: parts.memoryText,
        skillText: parts.skillText,
        planTaskText: parts.planTaskText,
        knowledgeText: parts.knowledgeText,
        toolsText,
        history,
        maxTokens: parts.maxTokens,
        contextWindow: parts.contextWindow
      });
      data.estOutputChars = extraChars;
      this.emit('contextUsage', data);
    } catch (_) {}
  }

  trimHistory() {
    const { trimHistory: clean } = require('./messageSanitize');
    const cfg = this.cfg || {};
    return clean(this.messages, this.protocol, cfg.maxHistory || 20, {
      maxBytesPerMessage: cfg.maxToolOutput || 8000,
      maxTotalBytes: cfg.maxMessageBytes || 1024 * 1024
    });
  }

  /**
   * 就地裁剪 this.messages，防止关闭自动压缩时消息数组无限增长。
   * 保留最近 N 条（含 tool 对），丢弃更早的消息。
   */
  _compactMessages() {
    const cfg = this.cfg || {};
    const limit = Math.max(10, (cfg.maxHistory || 20) * 2);
    if (this.messages.length <= limit) return;
    let start = this.messages.length - limit;
    while (start > 0 && this.messages[start - 1] && this.messages[start - 1].role === 'tool') start--;
    if (start > 0 && this.messages[start - 1] && this.messages[start - 1].role === 'assistant' && this.messages[start - 1].tool_calls) {
      start--;
    }
    if (start > 0) this.messages.splice(0, start);
    // 清理开头孤立 tool
    while (this.messages.length && this.messages[0].role === 'tool') this.messages.shift();
  }
}

/**
 * 计算 DeepSeek Responses 官方联网（web_search）在本次请求里该如何注入工具。
 * 纯函数，便于离线测试（不触碰网络 / vscode）。
 * @param {Array} payload 当前对话消息数组
 * @param {boolean} officialSearchStarted 本会话是否已经进入「仅官方搜索」模式
 * @returns {null | {tools:Array, toolChoice:Object|undefined, started:boolean, query:string}}
 *   - null 表示本次不应进入「仅官方搜索」模式（未触发 / 已被用户解除）
 *   - 否则返回只含 [{type:'web_search'}] 的工具集：首轮强制 tool_choice 触发，后续轮放开（auto）
 *
 * 关键约束（对应伙伴反馈的格式问题）：
 *   1) 一旦进入该模式，**绝不**把本地 function 工具（fetch / MCP 等）和 web_search 混发，
 *      否则模型会挑本地工具去抓网页 → 大陆网络抓不到 → 空 →「断掉 / 牛头不对马嘴」。
 *   2) 工具集是完整对象 [{type:'web_search'}]，不是字符串占位符。
 */
function computeOfficialSearch(payload, officialSearchStarted) {
  const lastUser = [...payload].reverse().find((m) => m && m.role === 'user');
  const ut = lastUser
    ? (typeof lastUser.content === 'string' ? lastUser.content : (lastUser.content || []).map((c) => (c && c.text) || '').join(''))
    : '';
  const timely = /(今天|今日|昨天|明天|本周|本月|今年|最新|最近|现在|当前|实时|新闻|排行|排名|榜单|股价|价格|汇率|天气|赛事|发布会|更新|发布|刚刚|此刻|现阶段|怎么查|怎么看|哪里可以|202[0-9]年|202[0-9]-)/.test(ut);
  // 用户明确表达「想用本地工具 / 不要官方联网」时，解除官方搜索会话标记，允许本地工具
  const userWantsLocal = /(用\s*mcp|用\s*本地|本地\s*工具|别\s*联网|不要\s*联网|关闭\s*搜索|关掉\s*搜索|自己\s*搜|用\s*fetch|直接\s*fetch|别\s*用\s*官方)/i.test(ut);
  let started = officialSearchStarted;
  if (timely) started = true;
  if (userWantsLocal) started = false;
  if (!started) return null;
  const hasAssistantReply = [...payload].reverse().some((m) => m && m.role === 'assistant');
  return {
    tools: [{ type: 'web_search' }],
    // 首轮（还没有任何助手回复）强制触发官方联网；后续轮放开 tool_choice（=auto），
    // 允许模型基于已搜到的内容直接作答或再搜一次，避免死循环，同时仍只给官方 web_search。
    toolChoice: hasAssistantReply ? undefined : { type: 'web_search' },
    started,
    query: ut
  };
}

/** 本地启发式：判断用户请求是否为多步骤任务。
 * 单步（跳过 planner）：简单问答、单命令、单文件操作。
 * 多步（启用 planner）：含多个动作词/串联词/逗号分隔的长需求。 */
function _isMultiStepTask(query) {
  const q = String(query || '').trim();
  if (!q || q.length < 8) return false;
  // 1. 长需求：80+ 字符大概率是多步骤
  if (q.length > 80) return true;
  // 2. 串联词：并且/然后/接着/再/也/还/最后/之后/同时
  const connectors = /并且|然后|接着|再(?!就是|一次|换|来|见|看看|想想|搜搜|等等|单独|多|不|没|搞)/;
  if (connectors.test(q)) return true;
  // 3. 逐个/逐一/分别/每个都/各 → 批量任务
  if (/逐个|逐一|分别|每个.{0,2}都|每一条|各/.test(q)) return true;
  // 4. 2+ 个动作关键词
  const actionWords = q.match(/写|改|创建|新建|生成|运行|执行|删除|移除|部署|编译|安装|配置|重构|测试|构建/g);
  if (actionWords && actionWords.length >= 2) return true;
  // 5. 含「总结/汇总/报告」等产出词 + 动作词
  if ((/总结|汇总|报告|文档/i.test(q)) && (actionWords && actionWords.length >= 1)) return true;
  return false;
}

module.exports = { AgentSession, Cancelled, buildSystemPrompt, computeOfficialSearch, _isMultiStepTask };
