'use strict';
const { TOOL_OPEN, TOOL_BLOCK, TOOL_END, findTagCloseIn, extractFoxToolBlocks, writeAgentLog, safeParseArgs, repairArgsJson, extractBalanced, collectJsonToolCandidates, parseTextCalls, validateTextCalls, stripToolBlocks } = require('./textParser');

const vscode = require('vscode');
const path = require('path');
const { chatOnce, chatNonStream, streamResponses, chatNonStreamResponses } = require('./client');
const anthropic = require('./anthropic');
const cacheControl = require('./cacheControl');
const config = require('./config');
const tools = require('./tools');
const weakModel = require('./weakModel');
const grammarProbe = require('./grammarProbe');
const ws = require('./tools/workspace');
const ctxTools = require('./tools/context');
const undo = require('./undo');
const kb = require('./knowledgeBase');
const kbOrg = require('./knowledgeOrganizer');
const caps = require('./capabilities');
const harness = require('./harness');
const bridge = require('./extensionBridge');
const contextUsage = require('./contextUsage');
const nativeSearch = require('./nativeSearch'); // 多厂商原生联网能力判定 + 引用收割（纯函数）
const { MemoryStore } = require('./memory');
const { UserSkillStore } = require('./skills');
const { PlanTaskStore } = require('./planTasks');
const projectScan = require('./projectScan');
const reviewer = require('./reviewer');
const { shouldAutoContinue, buildContinuePrompt, isStuckRepeat } = require('./autoContinue');
const reasoning = require('./reasoningParams'); // 深度思考：跨后端参数映射
const agentEvents = require('./agentEvents'); // 关键运行状态事件化：空轮/引导/续跑/final 可重放恢复
const prompts = require('./prompts'); // 提示词构建（buildSystemPrompt/buildDeepThinkingHint/buildExtensionCommandsSection）已迁至 src/prompts.js
const approvalPolicy = require('./approvalPolicy'); // 审批纯策略：autoApprove/alwaysAllow/kind 自动放行判定（可单测）

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// 动态附录哨兵：易变块（知识/环境/主题记忆/锚点/时间）每轮重注，用此哨兵防多步循环重复叠加。
const DYN_MARK = '狐狸AI·动态上下文';
// 稳定上下文哨兵：规则/技能/结构/任务/人格/扁平记忆等跨轮稳定块，首轮注入一次并烤回源，
// 之后随历史沉淀进缓存、每轮命中，不再每轮重烤成 miss。独立哨兵避免与易变块互相误判。
const STABLE_MARK = '狐狸AI·稳定上下文';
// 审查意见哨兵：每 step 随审查批次变化的临时修正建议，作为独立 append-only user 消息注入、
// 不烤回源、不进稳定前缀，避免污染 varAppendix（否则工具调用之间前缀断裂）。
const REVIEW_MARK = '狐狸AI·审查意见';

// —— 会话级缓存统计累加器（模块级，keyed by sessionId）——
// AgentSession 每轮用户提问都会重建，导致 this._cacheSession* 每轮归零；若直接用它算
// 「会话累计命中率」会把早前的冷启动轮（含预热请求）丢掉、显示值虚高，与 DeepSeek 官方口径对不上。
// 这里用模块级 Map 跨轮次累计，让「会话累计命中率」与官方账单口径一致（含冷启动，真实偏低才真实）。
// ⚠️ 分母必须累计 total（cached + miss/非缓存输入 + creation），不能累计 prompt：
//   - Anthropic 系 promptTokens 即 input_tokens，只含「非缓存」部分（miss），分子 cached / 分母
//     只有 miss → 冷启动轮后命中轮会把命中率顶到 >100%（如 111%），与单轮口径矛盾。
//   - OpenAI 系 promptTokens 已含 cached（total=promptTokens），total 公式依然成立，全厂商兼容。
const sessionCacheStats = new Map();
function _accCache(key) {
  let a = sessionCacheStats.get(key);
  if (!a) { a = { cached: 0, prompt: 0, completion: 0, total: 0 }; sessionCacheStats.set(key, a); }
  return a;
}

// —— query 指纹与重叠率（易变块「变了才更新」缓存判据，对齐 DSH）——
// 中文按相邻二元组、英文按词、数字按连续串，组成 token 集合；忽略顺序、去重。
function _qFingerprint(q) {
  const s = String(q || '').toLowerCase();
  const cjk = s.match(/[\u4e00-\u9fff]/g) || [];
  const words = s.match(/[a-z0-9]+/g) || [];
  const toks = new Set();
  for (let i = 0; i < cjk.length - 1; i++) toks.add(cjk[i] + cjk[i + 1]);
  for (const w of words) toks.add(w);
  if (cjk.length === 1) toks.add(cjk[0]);
  return toks;
}
// 重叠率 = 交集 / min(两集合大小)。用 min 而非并集，短 query（"继续"）与长 query 少量重合时
// 也能判为「同一话题」而不误重检。返回值 0~1。
function _qOverlap(a, b) {
  if (!a || !b || !a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.min(a.size, b.size);
}

// —— 纯问候/闲聊判定（1.1.32：聊天轮直答，省「你好也调工具」的冤枉 token）——
// 命中条件：极短（≤10 字，与 isShortQuery 同阈值）+ 不含任何任务/时效性关键词。
// 时效性词（几点/时间/天气/新闻/日期/最新）必须排除——它们虽短但要调 current_time/web_search。
const CHATTER_BLOCK_RE = /帮我|请|读取|读一下|打开|查看|检查|运行|执行|搜索|查找|生成|创建|删除|移动|复制|安装|修复|报错|错误|为什么|如何|怎么|什么|几点|时间|天气|新闻|日期|最新|文件|代码|命令|测试|配置|设置|编译|构建|部署|分析|解释|推荐|优化|调试|写|git/;
function isChatter(query) {
  const q = String(query || '').trim();
  return q.length > 0 && q.length <= 10 && !CHATTER_BLOCK_RE.test(q);
}

// —— 内容指纹（易变大块「变了才更新」判据，1.1.15）——
// 对动态上下文候选文本做 SHA-1 指纹；空/无实质变化时返回 ''（视为未变化）。
function _contentFingerprint(text) {
  try {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return crypto.createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 16);
  } catch (_) {
    return String(text || '').length ? 'x' : '';
  }
}

// —— 模块级 LLM 并发限流 ——
// 跨所有 session / 可移动面板限制「同时飞向模型的请求数」。多个面板/会话同时跑任务时，
// 若不限制会瞬间并发多个 LLM 请求（主请求 + 审查子代理 + 多模态识图 + planner 子模型），
// 每个响应都可能带很长 reasoning / 工具结果，瞬时内存与 token 峰值很高。
// 用全局计数信号量把并发压到 MAX_CONCURRENT_LLM，超出则排队等待，避免同时撑爆。
const { createLimiter } = require('./concurrency');
const MAX_CONCURRENT_LLM = 2;
const llmLimiter = createLimiter(MAX_CONCURRENT_LLM);

// 工具名捕获组必须覆盖真实 MCP 命名空间里的连字符/点/斜杠/大写，
// 例如 mcp__fetch__fetch-url、mcp__io.github.ChromeDevTools/chrome-devtools-mcp__new_page。
// 早期版本用 [a-z_]+ 导致带特殊字符的工具名匹配失败、工具从不执行（表现为「返回空」）。
// 兼容模型输出 <fox:tool>（规范写法）、<foxtool>（吞冒号）、<tool> / <fox-tool> 等变体。
// （TOOL_OPEN/TOOL_BLOCK/findTagCloseIn/extractFoxToolBlocks 已迁至 src/textParser.js）

/**
 * 流式诊断专用日志：~/.fox-ai/logs/agent-stream.log，失败静默忽略。 */
function streamLog(line) {
  try {
    const dir = path.join(os.homedir(), '.fox-ai', 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'agent-stream.log');
    fs.writeFileSync(file, new Date().toISOString() + ' [pid:' + process.pid + '] ' + line + '\n', { flag: 'a' });
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

// ===== 1.1.26 韧性常量（用户「增加重试与兜底逻辑」）=====
// 空响应（content 与 reasoning 全空）最大重试次数：指数退避 500ms → 1s → 2s，耗尽后明确报错终止。
// 旧行为：空响应与「空轮」混在一条计数上，空响应从不重试 API，直接走向收尾 = 会话中断。
const EMPTY_RESP_MAX_RETRY = 3;
// 1.1.26「同一资源反复访问」检测：读取类工具的「目标字段」与提醒阈值。
// 用法：同一工具 + 同一目标值累计调用达阈值时，注入一条非阻断的效率提醒（不拦截工具）。
const READ_TARGET_FIELD = {
  read_file: 'path', list_dir: 'path', find_files: 'path',
  search_text: 'glob', grep: 'path', search_codebase: 'query',
  read_terminal: 'id', get_diagnostics: 'path', index_codebase: 'path'
};
const READ_REPEAT_LIMIT = 8;
// 空轮（有正文但无工具块）最大连续轮次：每轮一次分级 nudge，超过才收尾。
// 旧值 2 太苛刻：模型常在「解释下一步」那一轮被误杀（日志实证——模型明说
// 「参数解析失败，我用合法 JSON 重建计划任务」却只因没吐工具块就被判死）。
// 取值 3 = 给 2 次 nudge 机会。不再往上加：分级提示（第 2 次已明令「禁止再写计划」
// 第 3 次「只准输出一个调用块」）约束力足够，继续加只是浪费 API 调用去骚扰已完成的对话。
const EMPTY_TURN_MAX = 3;

/**
 * 判断模型是否「开箱即用原生 function calling」。用于 toolProtocol='auto' 时在不撞 400 的前提下
 * 直接选对协议，提升对各类厂商/本地模型的适配性（增强③）。
 * 返回 true → 走 native（function calling）；false → 走 text（让模型以 <fox:tool> 输出，本地解析）。
 * 注意：anthropic 传输层自带 tool_use，统一按 native 处理；这里只针对 openai 兼容系。
 */
function modelSupportsNativeTools(cfg) {
  if (cfg.transport === 'anthropic') return true;
  // 网页版安全接入（WebAI2API 等浏览器自动化端点）不支持 function calling，
  // 必须走 text 协议（模型输出 <fox:tool> 标签，本地解析执行）。
  if (cfg.meta && cfg.meta.textOnly) return false;
  const model = String(cfg.model || '').toLowerCase();
  const provider = String(cfg.provider || '').toLowerCase();
  // 本地服务默认不走 native：llama.cpp / Ollama / LM Studio 等多数部署需要 --jinja 等
  // 额外配置才支持 function calling，默认走 text 协议更稳；需要原生 tools 可手动设置
  // foxAi.agent.toolProtocol='native'。
  if (cfg.meta && cfg.meta.local) return false;
  // 兜底： provider / model 名称里的本地标识
  const textOnlyProviders = ['ollama', 'lmstudio', 'localai', 'text-generation-webui', 'kobold', 'llama.cpp', 'llamacpp', 'tabbyapi'];
  if (textOnlyProviders.includes(provider)) return false;
  if (provider === 'local' || model.includes('.gguf') || model.endsWith('.gguf')) return false;
  // 显式声明不支持 function calling 的模型系列（只放常见小/旧模型，避免误伤带 provider 前缀的厂商模型）
  const textOnlyModels = [
    'qwen2:', 'qwen2.5:', 'qwen3:', 'qwen3.6', 'phi-', 'gemma-2b', 'gemma-4b',
    'codellama', 'vicuna', 'openchat', 'stablelm', 'dolly', 'starcoder',
    'wizardcoder', 'phind', 'deepseek-r1', 'deepseek-reasoner'
  ];
  for (const h of textOnlyModels) {
    if (model.includes(h)) return false;
  }
  // 某些推理模型（o1/o3 系列旧版）在 chat 接口不支持 tools；命中走 text 更稳
  if (/^o[13]-/.test(model)) return false;
  // 1.1.25（照 dsh 删改重构，用户「除 web 外全走原生」）：不再用「强制 text 教格式」换前缀缓存命中率——
  // 文本协议让模型纠结格式（<foxtool> vs [[tool:]] 自定义标签）、空轮回灌、会话莫名中断（日志实证）。
  // dsh 同样 DeepSeek 原生 function calling 一轮完成。主流云厂商（OpenAI/DeepSeek/SiliconFlow/Gemini/
  // Anthropic/GLM/ERNIE/Qwen-Turbo 等）统一 native。
  return true;
}

class Cancelled extends Error {
  constructor() {
    super('已取消');
    this.name = 'Cancelled';
  }
}

/** 模型额度/余额耗尽（含 402/403/429 限流）：需自动终止并保留记忆 */
class QuotaError extends Error {
  constructor(message) {
    super(message || '额度或余额不足');
    this.name = 'QuotaError';
    this.isQuota = true;
  }
}

/** 判断错误是否为额度/余额耗尽（含 402/403/429 限流）。供 run() 自动终止与测试复用 */
function isQuotaError(err) {
  const msg = String((err && err.message) || err || '');
  const status = (err && (err.status || err.httpStatus)) || 0;
  return /insufficient|balance|quota|exhaust|额度|余额|credit|too many requests|rate.?limit|\b402\b|\b403\b|\b429\b/i.test(msg)
    || [402, 403, 429].includes(Number(status));
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

/**
 * 跨厂商兼容的参数解析：各厂商模型（尤其本地 / 小模型）产出的「工具参数」常常不是严格 JSON，
 * 这里做多层容错修复，让同一套本地工具对所有模型都可用（增强③核心之一）。
 * 修复层级：标准 JSON → 去 markdown 包裹 → 修尾部逗号/单引号/未加引号键 → 行式 key:value 兜底。
 */

// ===== 宽松参数解析 / JSON 修复 / 平衡括号 / JSON 候选 =====


/**
 * read_file 去重用的「区间签名」：把 路径 + 行范围 + 字符范围 归一化成一个字符串。
 * 只有当「完全相同区间」被反复读取时才算重复；模型用不同 start_line/end_line 分区间读
 * （例如 1-300、547、530-168）属于不同的签名，不应被判为重复——否则刷新窗口/重载扩展后
 * 会话上下文丢失、模型需要重新取回文件内容时，会被误判「已读够」而卡死。
 * 注意：read_file 工具参数名是 start_line / end_line / start_char / end_char，不是 startLine/maxLength。
 */
function readFileSig(p, a) {
  const path = String(p || '').replace(/\\/g, '/');
  const num = (v) => (v === undefined || v === null || v === '') ? 0 : (parseInt(v, 10) || 0);
  const sl = num(a && a.start_line);
  const el = num(a && a.end_line);
  const sc = num(a && a.start_char);
  const ec = num(a && a.end_char);
  return path + '#' + sl + '#' + el + '#' + sc + '#' + ec;
}

// 提示词构建（buildExtensionCommandsSection / buildDeepThinkingHint / buildSystemPrompt）已迁至 src/prompts.js

/** 薄壳转发：buildSystemPrompt 已迁至 src/prompts.js（调用点零改动） */
function buildSystemPrompt(cfg, envBrief, protocol, queryText) {
  return prompts.buildSystemPrompt(cfg, envBrief, protocol, queryText);
}

/** 薄壳转发：buildDeepThinkingHint 已迁至 src/prompts.js */
function buildDeepThinkingHint(cfg) {
  return prompts.buildDeepThinkingHint(cfg);
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
    this._abortCtrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    this._resumeWaiters = [];
    this._pendingApproval = null;
    this.protocol = 'native';
    // 一旦因原生工具协议被服务端拒绝（如 MCP 大 schema 触发 400）而降级到文本协议，
    // 本会话后续轮次都保持文本协议，避免每轮先 400 再重试（见 run() 降级分支）。
    this._forceText = false;
    // 1.1.14：声称调用但无实际调用的回灌修正计数（限 2 次，防死循环）
    // 1.1.14：get_tools 首轮强制——是否已获取工具清单、强制回灌计数
    this._toolGuideFetched = false;
    this._guideNudges = 0;
    this._emptyStreak = 0;
    // 1.1.26 韧性加固：区分「空响应」与「空轮」——
    //   空响应 = 模型 content 与 reasoning 全空（服务端异常/限流抖动），应带指数退避重试 API；
    //   空轮   = 有正文但没工具块（模型在叙述而非执行），应 nudge 而不是重试。
    //   二者此前混在 _emptyStreak 一条路上：空响应被当空轮，重试机会为零 → 会话直接收尾中断。
    this._emptyRespRetries = 0;
    // 1.1.26：native 协议「只叙述不调工具」的对症开关。
    // 日志实证：protocol=native 下模型输出「我先看一下工作区里的题目文件」这类正文却从不发起
    // tool_calls（nativeCalls=0），连着 3 轮空轮收尾。text 协议时系统提示会强制教格式、模型照做；
    // native 下模型「自由」了反而不调。对策：空轮后的 nudge 轮强制 tool_choice，
    // Anthropic 用 'any'、OpenAI 兼容用 'required'（两者语义都是「本轮必须调用某个工具」）。
    this._forceToolChoice = false;
    // 1.1.26：native 空轮耗尽后是否已自动降级过 text（每会话只降一次，避免来回横跳）
    this._nativeDowngraded = false;
    // 1.1.15：恢复旧会话（重启服务/切换会话）时，若历史里已有 get_tools 成功记录，
    // 视为「工具清单已获取」，避免再强制模型重发一遍 get_tools 调用。
    // 1.1.19：恢复会话识别——历史里已有 get_tools 结果即视为「恢复」，_resumedSession=true。
    // 用户终止服务后再在原对话里继续聊天时，不会再重复发一次强制 get_tools 引导（原本会发）。
    this._resumedSession = false;
    // 1.1.19：textOnly（WebAI2API）新会话「前置 get_tools 引导」是否已发出（每会话一次）
    this._prependedGuide = false;
    // 1.1.19：首轮引导是否已摘除用户问题并把引导放在历史头部（引导写回源历史只允许一次）
    this._guideAtHead = false;
    try {
      const msgs = this.messages || [];
      // 注意：⚠️ 不能用「历史里有 user 消息」判定恢复会话——当前这条提问本身就是 user，
      // 若这么判，新会话也会被误判为「恢复」→ 前置 get_tools 引导被跳过、用户问题先发（样式错误）。
      // 只有历史里【已存在 get_tools 结果】才是真正的「恢复会话」（服务终止后在原对话续聊），
      // 此时工具清单早已拿到，不该再强制重发一遍 get_tools。
      for (const m of msgs) {
        if (!m) continue;
        // text 协议：工具结果以 [工具 get_tools 的结果] 的 user 消息存在
        if (typeof m.content === 'string' && /\[工具\s+get_tools\s*的结果\]/.test(m.content)) {
          this._toolGuideFetched = true;
          this._resumedSession = true;
          this._ev(agentEvents.EV.RESUMED, { source: 'text' });
          break;
        }
        // native 协议：工具结果以 role:'tool' + name 存在
        if (m.role === 'tool' && m.name === 'get_tools') {
          this._toolGuideFetched = true;
          this._resumedSession = true;
          this._ev(agentEvents.EV.RESUMED, { source: 'native' });
          break;
        }
      }
    } catch (_) {}
    // 1.1.14：只说不做/请求确认的回灌计数（限 2 次）
    // 1.1.15：textOnly（WebAI2API）动态上下文「内容哈希去重」缓存（见 _dynCache.env 位点）；
    // 1.1.14 的轮次降频（_dynTick/DYN_EVERY）已废弃，改为内容变化才注入。
    this._dynTick = 0;
    this.stepCount = 0;
    // 单条回复因 max_tokens 截断时，自动发「继续」重新调用的次数计数（防无限循环）
    this._continuesUsed = 0;
    // 续写防空转：上一轮续写的可见文本（用于检测原地重复）；续跑轮强制文本协议标记
    this._lastContinuedText = '';
    this._lenContinue = false;
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
    this._reviewPromise = null; // 当前正在跑的审查 Promise
    this._reviewResult = null; // 已完成的审查结果（供 _awaitReview 取走）
    this._reviewInjected = false; // 本轮审查是否已被注入 system 供主控参考
    this._reviewConsumed = false; // 本轮审查卡片是否已被 emit（避免 _doReview 与 _awaitReview 重复推送）
    this._reviewQuotaError = null; // 审查子代理遇到的配额错误，需冒泡给 run() 统一处理
    this._reviewId = null; // 当前这轮审查卡片的唯一 id，供前端 applyReview 对应
    // 产物（本次任务创建/修改/删除的文件）：任务完成时汇总成卡片展示
    this._artifacts = [];
    // 续跑：关联会话 id 与要复用的任务 id
    this.sessionId = opts.sessionId || null;
    this.resumeTaskId = opts.resumeTaskId || null;
    // ★ 会话进度摘要（对齐 DSH session-checkpoint）：重开/断点续跑时 chatView 把存档里的
    // progress 块传进来，模型凭它知道自己「上次干到哪、下一步做什么」，不再对当前上下文一片空白。
    // 运行期每条工具流水记进 _progressEntries，_renderProgressBlock() 渲染成紧凑块回灌请求尾部。
    this.sessionProgress = opts.sessionProgress || null;
    this._progressEntries = [];
    try {
      if (this.sessionProgress) {
        // 存档里的进度块是「【会话进度】…」渲染文本；拆回流水条目，让续跑的模型能直接看到
        this._progressEntries.push({
          t: Date.now(),
          tool: '_session_restore',
          text: '[会话恢复] 上次断点时已完成的进度：\n' + String(this.sessionProgress).slice(0, 1200)
        });
      }
    } catch (_) {}
    // 会话标识：每个会话固定一个 conversationId，仅作内部标识/日志关联使用，
    // 不注入任何 HTTP 头（已核实：DeepSeek 等 stateless API 不认 conversation id，缓存按前缀内容自动匹配）。
    this.conversationId = opts.conversationId || opts.sessionId || ('fox-' + crypto.randomBytes(8).toString('hex'));
    // 缓存命中监控状态
    this._cachePrefixHash = null;       // 本轮请求前缀（system+tools）SHA 指纹
    this._cacheDriftState = { baseline: null, prev: null }; // 前缀基线判定状态（见 src/cacheBaseline.js）
    this._cacheBaselineHash = null;     // 兼容字段：= _cacheDriftState.baseline（report 用）
    this._lastDriftWarnKey = null;      // 已告警过的漂移对（baseline→current），避免同一条反复刷屏
    this._stableBlock = null;           // 跨会话字节稳定的「稳定上下文块」（规则/技能/结构/任务/人格/扁平记忆），会话级冻结
    this._cachePrevHitRate = null;      // 上一轮命中率（用于「命中骤降」告警）
    this._cachePrevRequested = false;
    this._cacheWarmed = false;          // 预热是否已做过
    this._webResetSent = false;         // WebAI2API 文本协议：新建会话的重置信号是否已发过
    this._reviewResetSent = false;      // 审查子代理独立新会话信号是否已发过（每次审查首轮只发一次）
    // 1.1.27：审查提示去重（避免同一轮多次合并审查把「正在检查 / 未返回额外意见」刷屏）。
    // 每轮用户提问在 run() 里重置；_reviewNoticeSent 保证「正在检查」整轮只发一次，
    // _reviewHadOpinion 记录本轮是否出现过审查意见，有则不发「未返回额外意见」。
    this._reviewNoticeSent = false;
    this._reviewHadOpinion = false;
    // 1.1.19：审查新会话「前置 get_tools 引导」标记与结果缓存（两轮分离专用）
    this._reviewGuideSent = false;      // 审查引导轮是否已发过（幂等：每会话一次）
    this._reviewGuideResult = '';       // 引导轮 get_tools 结果（合并进真正的审查消息流）
    // 易变块指纹缓存（对齐 DSH「变了才更新」）：会话级缓存 RAG/主题记忆等 query 驱动块的
    // 结果，query 无实质变化时复用旧字节，避免每轮重检 → 每轮 miss 数千 token（命中率 71% 的主因）。
    this._dynCache = { kb: null, topicMem: null, env: null, diag: null };
    // textOnly（WebAI2API）会话级动态块防重复：mark → { fp }，同内容块本会话只发一次
    this._webBlockCache = new Map();
    // 1.1.15：恢复旧会话（重启服务/切换会话）时，历史里可能已带动态上下文块。
    // 预扫描历史里的【狐狸AI·动态上下文】块并记录其内容指纹，使恢复后的会话
    // 不会把这些块再发一遍（否则 _webBlockCache 为空 → 走"首次"分支重复追加）。
    try {
      const msgs = this.messages || [];
      for (const m of msgs) {
        if (!m) continue;
        const c = Array.isArray(m.content)
          ? (m.content.find((p) => p && p.type === 'text' && typeof p.text === 'string') || {}).text
          : (typeof m.content === 'string' ? m.content : null);
        if (!c) continue;
        const open = c.indexOf('【' + DYN_MARK + '】');
        if (open < 0) continue;
        const close = c.indexOf('【' + DYN_MARK + '·完】', open);
        if (close < 0) continue;
        const block = c.slice(open, close + ('【' + DYN_MARK + '·完】').length);
        if (!this._webBlockCache.has(DYN_MARK)) {
          this._webBlockCache.set(DYN_MARK, { fp: _contentFingerprint(block) });
        }
      }
    } catch (_) {}
    // 长期记忆（跨会话记住用户偏好/约定/教训）
    const gsDir = this.context ? this.context.globalStorageUri.fsPath : require('os').homedir();
    const c = config.conf();
    this.memory = new MemoryStore(gsDir, c.get('memory.storagePath', ''));
    // 结构化跨会话记忆：按主题分文件存 Markdown，按需加载而非全量注入
    this.topicMemory = opts.topicMemory || null;
    if (!this.topicMemory) {
      try {
        const { TopicMemory } = require('./memoryTopics');
        this.topicMemory = new TopicMemory({
          baseDir: c.get('memory.storagePath', '') || gsDir,
          enabled: c.get('memory.topics.enabled', true),
          budget: c.get('memory.topics.budget', 2500)
        });
      } catch (_) {
        this.topicMemory = null;
      }
    }
    this.skills = new UserSkillStore(gsDir, c.get('skills.storagePath', ''));
    this.planTasks = opts.planTasks || new PlanTaskStore(gsDir, { customDir: c.get('planTasks.storagePath', '') });
    // ---- 生命周期钩子（确定性策略，事件驱动，不依赖模型自觉）----
    this.hooks = opts.hooks || null;
    if (!this.hooks) {
      try {
        const { HookRunner } = require('./hooks');
        const folders = vscode.workspace.workspaceFolders;
        this.hooks = new HookRunner({
          workspaceRoot: folders && folders.length ? folders[0].uri.fsPath : '',
          enabled: c.get('hooks.enabled', true)
        });
      } catch (_) {
        this.hooks = null;
      }
    }
    // ---- Checkpoint 快照（写文件前自动存档，可一键回滚）----
    this.checkpoints = opts.checkpoints || null;
    if (!this.checkpoints) {
      try {
        const { CheckpointStore } = require('./checkpoints');
        const folders = vscode.workspace.workspaceFolders;
        this.checkpoints = new CheckpointStore({
          baseDir: gsDir,
          workspaceRoot: folders && folders.length ? folders[0].uri.fsPath : '',
          sessionId: this.sessionId,
          enabled: c.get('checkpoints.enabled', true),
          maxSnapshots: c.get('checkpoints.maxSnapshots', 200)
        });
      } catch (_) {
        this.checkpoints = null;
      }
    }
    // ---- 子代理 / 并行 agent（懒建：需要用到时才按当前 cfg 构造）----
    this._subagentRunner = null;
    this._subagentBatch = 0;
    // ---- 后台 / 异步 agent（懒建；store 跨会话共享，所以挂在 opts 上可注入）----
    this._background = opts.background || null;
    // ---- 工作链/正文物理隔离：本 run 的唯一消息 ID ----
    this.runId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    this.finalMsgId = 'final-' + this.runId;
    this.thinkingMsgId = null;
    this._thinkingBuffer = { text: '', reasoning: '', images: [] };
    this._finalStarted = false;
    this._finalStreamed = false; // 最终正文是否已实时流式推送（用于轮末避免重复 flush）
    this._inFinalPhase = false;
    // ---- 关键运行状态事件化（对齐 dsh：事件日志派生、一切可重放）----
    // AgentSession 每轮重建，空轮/引导/续跑/final 状态此前只活在实例字段，会话中断后
    // 恢复只能靠 messages 字符串猜测（脆弱）。现在统一从本会话事件日志重放重建，
    // 让重启后的会话正确接续（不会因计数归零而重发引导/空轮回灌）。
    try {
      const sessionKey = this.sessionId || this.conversationId;
      if (sessionKey) agentEvents.replayState(sessionKey, this);
    } catch (_) { /* 事件重放失败不影响主流程（保持默认状态） */ }
  }

  /**
   * 关键运行状态事件（事件化的统一出口）：写一行可重放事件日志 + 在内存里留痕。
   * 所有空轮/引导/续跑/final 状态变更都走这里，杜绝散落的裸字段手改。
   */
  _ev(ev, fields) {
    try {
      const sessionKey = this.sessionId || this.conversationId;
      if (sessionKey) agentEvents.logEvent(sessionKey, ev, fields);
    } catch (_) { /* 事件日志写入失败不影响主流程 */ }
  }

  /**
   * 拿到（或懒建）后台任务调度器。
   * 后台任务的存档是**跨会话**的，因此 store 与 runner 一次建好长期复用。
   */
  _bg() {
    if (this._background) return this._background;
    try {
      const bg = require('./background');
      const c = config.conf();
      const gsDir = this.context ? this.context.globalStorageUri.fsPath : require('os').homedir();
      const root = this._workspaceRoot();
      const store = new bg.BackgroundJobStore({
        baseDir: c.get('background.storagePath', '') || gsDir,
        maxJobs: c.get('background.maxHistory', 60)
      });
      // 上次 VS Code 被关掉时还在跑的任务，状态要修正，不能永远显示「进行中」
      store.markInterrupted();
      const runner = new bg.BackgroundRunner({
        store,
        workspaceRoot: root,
        git: root ? new bg.GitOps({ root }) : null,
        limits: {
          maxConcurrent: c.get('background.maxConcurrent', 2),
          timeoutMs: c.get('background.timeoutMs', 900000),
          allowMainWrites: c.get('background.allowMainWorkspaceWrites', false),
          keepWorktree: c.get('background.keepWorktree', false)
        },
        onEvent: (e) => this._onBackgroundEvent(e),
        runTask: (p) => this._backgroundRunTask(p)
      });
      this._background = { bg, store, runner };
    } catch (e) {
      try { require('./log').appendLog('background', '[init-fail] ' + ((e && e.message) || e)); } catch (_) {}
      this._background = null;
    }
    return this._background;
  }

  /**
   * 提交后台任务：**立即返回**，任务在后台跑，主对话不阻塞。
   * @returns {string} 给模型看的回执文本
   */
  runBackgroundAgent(req) {
    const c = config.conf();
    if (!c.get('background.enabled', true)) {
      return '后台任务功能已在设置中关闭（foxAi.background.enabled）。请在当前对话里直接完成。';
    }
    const h = this._bg();
    if (!h) return '后台任务调度器初始化失败，请改为在当前对话里直接完成。';
    const r = h.runner.submit({
      task: (req && req.task) || '',
      title: (req && req.title) || '',
      role: (req && req.role) || 'generalist',
      pr: !!(req && req.create_pr),
      timeoutMs: req && req.timeout_minutes ? Number(req.timeout_minutes) * 60000 : 0,
      sessionId: this.sessionId
    });
    if (!r.ok) return '后台任务未能提交：' + r.error;
    const job = r.job;
    this.emit('notice', { text: `🛰️ 已把「${job.title}」丢到后台跑（任务号 ${job.id}），你可以继续聊别的` });
    const L = [];
    L.push(`已提交后台任务 \`${job.id}\`：${job.title}`);
    L.push('任务在后台独立运行，**不会占用当前对话**。');
    L.push('用 background_jobs（action=get, id=' + job.id + '）随时查进度与结论。');
    L.push('现在请直接回复用户「已在后台开始处理」，然后继续处理用户的其它需求，**不要**在这里空等结果。');
    return L.join('\n');
  }

  /** 查询 / 取消 / 清理后台任务 */
  backgroundJobs(req) {
    const h = this._bg();
    if (!h) return '后台任务调度器不可用。';
    const bg = h.bg;
    const action = (req && req.action) || 'list';
    if (action === 'get') {
      const id = req && req.id;
      if (!id) return '查询单个任务需要提供 id。';
      const job = h.store.get(id);
      if (job) return bg.renderJob(job);
      // 子代理后台表里没有 → 回落到异步命令任务（run_command bg=true 提交）
      try {
        const term = require('./tools/terminal');
        if (term.asyncJobLoad && term.asyncJobLoad(id)) {
          return term.asyncCommandJobs({ action: 'get', id });
        }
      } catch (_) {}
      return '找不到后台任务 ' + id + '。用 action=list 看看有哪些。';
    }
    if (action === 'cancel') {
      const id = req && req.id;
      if (!id) return '取消任务需要提供 id。';
      let r = h.runner.cancel(id);
      if (!r.ok) {
        try {
          const term = require('./tools/terminal');
          const cr = term.asyncJobCancel && term.asyncJobCancel(id);
          if (cr && cr.ok) {
            this.emit('notice', { text: `🚫 已取消后台命令任务 ${id}` });
            return cr.queued ? `命令任务 ${id} 还在排队，已直接取消。` : `已取消命令任务 ${id}，进程树已终止。`;
          }
        } catch (_) {}
        return '取消失败：' + r.error;
      }
      this.emit('notice', { text: `🚫 已请求取消后台任务 ${id}` });
      return r.queued ? `任务 ${id} 还在排队，已直接取消。` : `已向任务 ${id} 发出取消请求，它会在当前这一步结束后停下。`;
    }
    if (action === 'clear') {
      let n = h.store.clearFinished();
      try {
        const term = require('./tools/terminal');
        if (term.asyncCommandJobs) n += (term.asyncCommandJobs({ action: 'clear' }).match(/已清理\s+(\d+)/) || [0, 0])[1] | 0;
      } catch (_) {}
      return n ? `已清理 ${n} 条已结束的后台任务记录。` : '没有可清理的已结束任务。';
    }
    const jobs = h.store.list({ limit: Number(req && req.limit) > 0 ? Number(req.limit) : 12 });
    const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued').length;
    const head = active ? `（${active} 个进行中）\n` : '';
    let body = head + bg.renderJobList(jobs);
    // list 时也附上异步命令任务（若无子代理任务或仅有少量时避免刷屏，最多 8 条）
    try {
      const term = require('./tools/terminal');
      const cmdText = term.asyncCommandJobs({ action: 'list' });
      if (/后台命令任务|进行中|暂无后台命令任务/.test(cmdText)) {
        const cmdLines = String(cmdText).split('\n').slice(0, 9);
        body += (jobs.length ? '\n\n' : '') + cmdLines.join('\n');
      }
    } catch (_) {}
    return body;
  }

  /** 后台任务事件 → UI 提示。后台任务的意义就是「别打扰你」，所以只在关键节点冒泡 */
  _onBackgroundEvent(e) {
    if (!e) return;
    try {
      if (e.type === 'jobStart') {
        this.emit('notice', { text: `🛰️ 后台任务开始：${e.title}（${e.id}）` });
      } else if (e.type === 'jobEnd') {
        const bits = [];
        if (e.changed) bits.push(`${e.changed} 个文件改动`);
        if (e.branch) bits.push('分支 ' + e.branch);
        if (e.prUrl) bits.push('PR ' + e.prUrl);
        const tail = bits.length ? '（' + bits.join(' · ') + '）' : '';
        this.emit('notice', {
          text: `${e.ok ? '✅' : '❌'} 后台任务${e.ok ? '完成' : '结束'}：${e.title}${tail}　用 background_jobs 查看结论（id=${e.id}）`
        });
      }
    } catch (_) {}
  }

  /**
   * 后台任务的实际执行体：复用子代理引擎，但工作目录指向独立 worktree。
   * 与主对话完全解耦——它自己的中间过程不进主上下文，只在结束时回流一条结论。
   */
  async _backgroundRunTask({ job, cwd, readOnly, onProgress, isCancelled }) {
    const sub = require('./subagents');
    const c = config.conf();
    const role = readOnly && (job.role === 'coder' || job.role === 'tester') ? 'explorer' : job.role;
    if (readOnly && role !== job.role) {
      onProgress('当前环境不允许后台写入，已降级为只读调研（角色 ' + role + '）');
    }
    let toolCalls = 0;
    const runner = new sub.SubagentRunner({
      listTools: () => tools.allTools(),
      isCancelled: () => isCancelled() || this.cancelled,
      extraSystem: this._backgroundExtraSystem(cwd, readOnly),
      limits: {
        // 后台任务不占用户注意力，可以给比子代理更宽的预算
        maxSteps: c.get('background.maxSteps', 14),
        maxToolCalls: c.get('background.maxToolCalls', 36),
        timeoutMs: c.get('background.timeoutMs', 900000),
        concurrency: 1
      },
      onEvent: (e) => {
        if (e && e.type === 'subagentTool') {
          toolCalls++;
          onProgress('第 ' + (e.step || toolCalls) + ' 步：' + e.tool + (e.ok === false ? '（失败）' : ''));
        }
      },
      callModel: (p) => this._subagentCallModel(p),
      execute: (name, args, meta) => this._backgroundExecute(name, args, meta, { cwd, readOnly, job })
    });
    const spec = sub.normalizeSpec({ name: job.title || job.id, role, task: job.task }, 0);
    const res = await runner.spawn(spec);
    return {
      ok: !!res.ok,
      summary: res.summary || '',
      error: res.ok ? '' : (res.stopReason || ''),
      steps: res.steps || 0,
      toolCalls: res.toolCalls || toolCalls,
      stopReason: res.stopReason || ''
    };
  }

  /** 后台任务的项目级约定：明确告诉它在哪个目录干活、能不能写 */
  _backgroundExtraSystem(cwd, readOnly) {
    const L = [];
    L.push('你是**后台任务**：用户此刻正在做别的事，看不到你的中间过程，只会看到你最后的结论。');
    if (cwd) L.push(`你的工作目录是：${cwd}。这是一份**独立签出的副本**，改这里不会影响用户正在编辑的文件。`);
    if (readOnly) {
      L.push('当前为**只读模式**：禁止写文件、禁止执行会改动磁盘的命令。只做调研并给出可执行的结论与改法建议。');
    } else {
      L.push('你可以在工作目录内自由修改文件，完成后你的改动会被打成补丁交给用户 review。');
    }
    L.push('禁止改动 node_modules、.git、dist、out 等目录。');
    L.push('结论要自包含：说明你做了什么、改了哪些文件、还有什么风险，用户不会追问你。');
    return L.join('\n');
  }

  /**
   * 后台任务的工具执行：把相对路径重定向到 worktree 副本，并强制只读约束。
   */
  async _backgroundExecute(name, args, meta, envInfo) {
    const kind = tools.kindOf(name);
    const isWrite = kind === 'edit' || kind === 'write' || kind === 'delete';
    if (envInfo.readOnly && (isWrite || kind === 'exec')) {
      throw new Error('后台任务当前为只读模式，不能执行写入或命令类工具。请把建议的改动写进结论。');
    }
    const hook = await this.fireHook('preToolUse', {
      tool: name, kind, args, cwd: envInfo.cwd, background: envInfo.job.id
    });
    if (hook.decision === 'deny') {
      throw new Error('被生命周期钩子拦截：' + (hook.reason || '不允许该操作'));
    }
    if (this.policy && (isWrite || kind === 'exec')) {
      const op = kind === 'exec' ? harness.OP.EXEC : harness.OP.WRITE;
      const popts = kind === 'exec' ? { command: args && args.command } : { path: args && args.path };
      let verdict = null;
      try { verdict = this.policy.evaluate(op, popts); } catch (_) { verdict = null; }
      if (verdict && verdict.decision === 'deny') {
        throw new Error('被安全策略拒绝：' + (verdict.reason || '高危操作'));
      }
      // 后台任务没有 UI 通道，需要人工确认的操作一律拒绝。
      // 在独立 worktree 里改文件是安全的（用户 review 补丁后才合并），
      // 但删库跑路级别的命令仍然过不了策略引擎这一关。
      if (verdict && verdict.decision === 'ask' && envInfo.job.workspace.mode !== 'worktree') {
        throw new Error('该操作需要用户确认，后台任务无法执行。请把这一步写进结论交给主对话执行。');
      }
    }
    const redirected = this._redirectArgsToCwd(args, envInfo);
    return tools.execute(name, redirected, {
      // 1.1.24（删减重构）：后台通道同样透传 toolName——否则 get_tools 在后台拿不到
      // _catalogLimit 目录豁免，被 4000 中间挖掉 → 后台任务一样空轮。
      toolName: name,
      maxToolOutput: 4000,
      sessionId: this.sessionId,
      background: envInfo.job.id,
      skipConfirm: true,
      // worktree 副本在工作区之外，需要显式放行越界写入
      outsideConfirmed: envInfo.job.workspace.mode === 'worktree'
    });
  }

  /** 把工具参数里的相对路径重写到后台任务自己的工作目录下 */
  _redirectArgsToCwd(args, envInfo) {
    const cwd = envInfo && envInfo.cwd;
    if (!cwd || !args || typeof args !== 'object') return args;
    if (!envInfo.job || !envInfo.job.workspace || envInfo.job.workspace.mode !== 'worktree') return args;
    const path0 = require('path');
    const out = Object.assign({}, args);
    for (const key of ['path', 'root', 'cwd']) {
      const v = out[key];
      if (typeof v !== 'string' || !v.trim()) continue;
      const raw = v.trim();
      if (path0.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) continue; // 绝对路径按原样，不擅自改写
      out[key] = path0.join(cwd, raw);
    }
    return out;
  }

  /**
   * 派生子代理执行任务（并行 / 组队），返回汇总 Markdown 回灌主上下文。
   * 子代理拥有**独立的 messages**，其中间探索过程不会进入主会话上下文。
   * 任何异常都收敛成文字结果，绝不打断主流程。
   */
  async spawnSubagents(req) {
    const sub = require('./subagents');
    const c = config.conf();
    if (!c.get('subagents.enabled', true)) {
      return '子代理功能已在设置中关闭（foxAi.subagents.enabled）。请自己完成该任务。';
    }
    const specs = sub.normalizeSpecs((req && req.agents) || []);
    if (!specs.length) return '没有可派生的子代理：每个 agent 必须带具体的 task。';
    const goal = (req && req.goal) || '';

    const batchId = ++this._subagentBatch;
    const runner = new sub.SubagentRunner({
      listTools: () => tools.allTools(),
      isCancelled: () => this.cancelled,
      extraSystem: this._subagentExtraSystem(),
      limits: {
        maxSteps: c.get('subagents.maxSteps', 6),
        maxToolCalls: c.get('subagents.maxToolCalls', 14),
        timeoutMs: c.get('subagents.timeoutMs', 180000),
        concurrency: c.get('subagents.concurrency', 3)
      },
      onEvent: (e) => this._onSubagentEvent(batchId, e),
      callModel: (p) => this._subagentCallModel(p),
      execute: (name, args, meta) => this._subagentExecute(name, args, meta)
    });

    const hasDeps = specs.some((s) => s.dependsOn && s.dependsOn.length);
    this.emit('notice', {
      text: `🧩 派生 ${specs.length} 个子代理${hasDeps ? '（按依赖分批协作）' : '（并行）'}：${specs.map((s) => s.name).join('、')}`
    });

    let results;
    try {
      if (hasDeps) {
        const out = await runner.runTeam({ goal, members: specs });
        results = out.results;
      } else {
        results = await runner.runParallel(specs);
      }
    } catch (e) {
      return `子代理编排失败：${(e && e.message) || String(e)}。请自己完成该任务。`;
    }
    const okCount = results.filter((r) => r.ok).length;
    this.emit('notice', { text: `🧩 子代理完成：${okCount}/${results.length} 成功` });
    return sub.renderResults(results, { goal });
  }

  /**
   * 任务收尾时从本轮对话里自动沉淀记忆（规则式抽取，零模型调用）。
   * 只抓用户明确的纠正 / 约定 / 偏好（「以后都用…」「不要…」「记住…」），闲聊一律不收。
   * 失败绝不影响主流程。
   */
  _harvestMemories() {
    if (!this.topicMemory) return;
    try {
      if (!config.conf().get('memory.topics.autoHarvest', true)) return;
      // 只看本轮新增的用户消息，避免整段历史被反复扫描
      const from = this._harvestMark || 0;
      const slice = this.messages.slice(from);
      this._harvestMark = this.messages.length;
      if (!slice.length) return;
      const r = this.topicMemory.autoHarvest(slice);
      if (r && r.written > 0) {
        this.emit('notice', { text: `🧠 已自动沉淀 ${r.written} 条长期记忆（可在记忆面板查看或编辑）` });
      }
    } catch (_) {}
  }

  /** 附加给每个子代理的项目级约定（工作区路径等） */
  _subagentExtraSystem() {
    const root = this._workspaceRoot();
    const lines = [];
    if (root) lines.push(`当前工作区根目录：${root}。文件路径一律用相对工作区的路径。`);
    lines.push('禁止改动 node_modules、.git、dist、out 等目录。');
    return lines.join('\n');
  }

  /** 子代理的模型调用：复用主会话后端与凭据，但不向 UI 推流、不写主上下文 */
  async _subagentCallModel({ messages, tools: toolDefs, spec }) {
    if (this.cancelled) throw new Cancelled();
    const cfg = this.cfg;
    const b = selectBackend(cfg);
    const options = {
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      messages,
      temperature: cfg.temperature,
      // 子代理产出的是结论摘要，不需要主代理那么大的输出预算
      maxTokens: Math.min(cfg.maxTokens || 2048, 2048),
      timeout: cfg.timeout,
      insecureHttpParser: cfg.insecureHttpParser,
      streamFormat: cfg.streamFormat,
      signal: this._abortCtrl ? this._abortCtrl.signal : undefined
    };
    if (toolDefs && toolDefs.length) options.tools = tools.toOpenAIToolsFrom(toolDefs);
    const res = await llmLimiter.run(() => b.nonStream(options));
    const raw = (res && res.toolCalls) || [];
    return {
      content: (res && res.content) || '',
      finishReason: (res && res.finishReason) || '',
      toolCalls: raw.map((tc) => ({
        id: tc.id,
        name: tc.name || (tc.function && tc.function.name),
        rawArgs: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {})
      })).filter((tc) => tc.name)
    };
  }

  /** 子代理的工具执行：走与主代理相同的 execute（含超时熔断），但结果不进主上下文 */
  async _subagentExecute(name, args, meta) {
    if (this.cancelled) throw new Cancelled();
    const c0 = config.conf();
    const kind = tools.kindOf(name);
    // 写/执行类仍要过策略引擎与钩子，子代理不是法外之地
    const hook = await this.fireHook('preToolUse', {
      tool: name, kind, args, cwd: this._workspaceRoot(),
      subagent: (meta && meta.spec && meta.spec.name) || ''
    });
    if (hook.decision === 'deny') {
      throw new Error('被生命周期钩子拦截：' + (hook.reason || '不允许该操作'));
    }
    if (this.policy && (kind === 'edit' || kind === 'write' || kind === 'delete' || kind === 'exec')) {
      const op = kind === 'exec' ? harness.OP.EXEC : harness.OP.WRITE;
      const popts = kind === 'exec' ? { command: args && args.command } : { path: args && args.path };
      let verdict = null;
      try { verdict = this.policy.evaluate(op, popts); } catch (_) { verdict = null; }
      if (verdict && verdict.decision === 'deny') {
        throw new Error('被安全策略拒绝：' + (verdict.reason || '高危操作'));
      }
      // 子代理没有 UI 交互通道，需要人工确认的操作一律退回主代理执行，
      // 绝不静默放行——否则「派个子代理」就成了绕过审批的后门。
      if (verdict && verdict.decision === 'ask' && !c0.get('subagents.autoApproveWrites', false)) {
        throw new Error('该操作需要用户确认，子代理无法执行。请把这一步的具体改动写进结论，交回主代理执行。');
      }
    }
    // Checkpoint：子代理写文件同样先存档，保证一键回滚覆盖它的改动
    if (this.checkpoints && (name === 'edit_file' || name === 'write_file' || name === 'delete_file') && args && args.path) {
      try {
        let before = null;
        try { before = await ws.readText(ws.resolveUri(args.path, { allowOutside: true })); } catch (_) { before = null; }
        await this.checkpoints.snapshot(args.path, before, {
          tool: name,
          title: '子代理 ' + ((meta && meta.spec && meta.spec.name) || '') + '：' + tools.titleOf(name, args),
          step: this.stepCount
        });
      } catch (_) {}
    }
    return tools.execute(name, args, {
      // 1.1.24（删减重构）：子代理通道同样透传 toolName，get_tools 目录豁免才能命中
      toolName: name,
      maxToolOutput: 4000,
      sessionId: this.sessionId,
      subagent: (meta && meta.spec && meta.spec.name) || '',
      skipConfirm: true
    });
  }

  /** 子代理事件 → UI 进度提示（尽量少刷屏：只报开始与结束） */
  _onSubagentEvent(batchId, e) {
    if (!e) return;
    if (e.type === 'subagentStart') {
      this.emit('notice', { text: `　${e.emoji || '•'} ${e.name}（${e.roleTitle}）开始：${String(e.task || '').slice(0, 60)}` });
    } else if (e.type === 'subagentEnd') {
      const s = (e.durationMs / 1000).toFixed(1);
      this.emit('notice', {
        text: `　${e.ok ? '✅' : '❌'} ${e.name} 结束（${e.steps} 轮 / ${s}s${e.stopReason && e.stopReason !== 'done' ? ' / ' + e.stopReason : ''}）`
      });
    } else if (e.type === 'teamStage') {
      this.emit('notice', { text: `　▸ 第 ${e.index}/${e.total} 批：${(e.members || []).join('、')}` });
    }
  }

  /**
   * 触发生命周期钩子；钩子系统本身异常绝不打断主流程。
   * @returns {Promise<{decision:string, reason:string, injects:string[], ran:number}>}
   */
  async fireHook(event, payload) {
    const fallback = { decision: 'allow', reason: '', injects: [], ran: 0, results: [] };
    if (!this.hooks) return fallback;
    try {
      return await this.hooks.fire(event, payload || {});
    } catch (e) {
      try {
        require('./log').appendLog('hooks', '[fire-error] event=' + event + ' ' + (e && e.message));
      } catch (_) {}
      return fallback;
    }
  }

  /** 当前工作区根目录（无工作区时返回空串） */
  _workspaceRoot() {
    try {
      const folders = vscode.workspace.workspaceFolders;
      return folders && folders.length ? folders[0].uri.fsPath : '';
    } catch (_) {
      return '';
    }
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
    try { if (this._abortCtrl) this._abortCtrl.abort(); } catch (_) {}
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

  /**
   * 方法论「限制思考-行动轮次」：达到硬性步数上限时的挂起处理。
   *
   * 旧实现直接 `return {reason:'max-steps'}`，run() 一返回 chatView 的 finally 就把
   * `this.session = null`，于是「暂停 / 继续 / 停止」按钮的 `if (this.session)` 全部落空
   * —— 表现就是界面卡在运行态、点什么都没反应。这里改为**就地真正挂起**：
   * 置 paused 并在 gate 上等待，run() 不返回、session 保持存活，三个按钮都有效；
   * 用户点「继续」即从断点接着跑，点「停止」则由 gate 抛 Cancelled 走正常取消流程。
   *
   * @param {string} queryText 本轮用户问题（供压缩器摘要用）
   * @param {string} envBrief  环境摘要
   * @param {number} used      已消耗的步数预算
   * @returns {Promise<boolean>} true=用户点了继续（追加预算续跑）；false=无法挂起，按旧逻辑返回
   */
  /**
   * 步数预算补充（自动或手动）后写回一条「续跑提示」消息。
   * 自动续跑与用户点「继续」共用同一段注入文案，保证模型拿到一致的断点续跑语义。
   */
  _pushResumePrompt(kind) {
    this.messages.push({
      role: 'user',
      content: `[系统] ${kind === 'auto' ? '已达到单轮步数上限，系统已自动为你追加预算继续推进' : '用户已确认继续'}。请从上次中断处接着做，先用一句话说明当前进度（已做了什么、卡在哪、下一步做什么），再继续推进；能收尾就尽快收尾。若你已完成的步骤足够达到目标，可直接收尾，不必硬跑满预算。`
    });
  }

  /**
   * 方法论「限制思考-行动轮次」：达到硬性步数上限时的挂起处理。
   *
   * 1.1.20 起支持**自动续跑**：默认不再干等用户手点「继续」——触发上限时若
   * `foxAi.agent.autoResume`（默认 true）开启，自动追加一轮预算并把「续跑提示」写回历史，
   * 模型带上断点信息直接继续；仅当自动续跑累计轮数达到上限（`foxAi.agent.autoResumeRounds`，
   * 默认 5）或开关关闭时才真正挂起等待用户确认。这样长任务不再每隔 N 步就被打断一次。
   * 用户手动「暂停」永远优先于自动续跑（paused 一经置位立即挂起）。
   *
   * @param {string} queryText 本轮用户问题（供压缩器摘要用）
   * @param {string} envBrief  环境摘要
   * @param {number} used      已消耗的步数预算
   * @returns {Promise<boolean>} true=可继续（已自动追加预算或用户已点继续）；false=无法挂起，按旧逻辑返回
   */
  async _hardStopPause(queryText, envBrief, used) {
    // 先尝试压缩上下文（丢弃长链路里无用的推理痕迹），给续跑腾出空间
    try {
      if (this.cfg.autoSummarize && this.cfg.autoSummarize.enabled) {
        await this._maybeAutoCompress(queryText, envBrief);
      }
    } catch (_) {}
    const { appendLog } = require('./log');
    // 1.1.20：自动续跑开关（默认开）——长任务达到步数上限时自动追加预算，不再干等用户
    const autoResume = !!(this.cfg.autoResume !== undefined ? this.cfg.autoResume : true);
    const autoResumeRounds = Math.max(1, Number(this.cfg.autoResumeRounds) || 5);
    if (this.cancelled) return false;

    // 用户已手动暂停：绝不自动续跑，直接挂起等「继续」
    if (this.paused) {
      this.emit('state', { state: 'paused' });
      if (this.task) {
        try { await this.taskManager.updateState(this.task.id, harness.TASK_STATES.PAUSED); } catch (_) {}
      }
      await new Promise((resolve) => this._resumeWaiters.push(resolve));
      if (this.cancelled) throw new Cancelled();
      this.paused = false;
      this._pausedLogged = false;
      if (this.task) {
        try { await this.taskManager.updateState(this.task.id, harness.TASK_STATES.RUNNING).catch(() => {}); } catch (_) {}
      }
      this.emit('state', { state: 'running' });
      appendLog('maxSteps', '[resume] budget+=' + (this.cfg.maxSteps || 0) + ' (manual)');
      this._pushResumePrompt('manual');
      return true;
    }

    // 自动续跑分支：开关开启且本会话自动续跑轮数未达上限 → 不挂起，直接续跑
    if (autoResume && (this._autoResumeCount || 0) < autoResumeRounds) {
      this._autoResumeCount = (this._autoResumeCount || 0) + 1;
      appendLog(
        'maxSteps',
        '[auto-resume] steps=' + used + ' round=' + this._autoResumeCount + '/' + autoResumeRounds +
        ' autoCompress=' + !!(this.cfg.autoSummarize && this.cfg.autoSummarize.enabled)
      );
      this.emit('notice', {
        text: `已达到 ${used} 步上限，正在自动续跑（${this._autoResumeCount}/${autoResumeRounds}轮）…如需人工干预可随时「暂停」。`
      });
      this._pushResumePrompt('auto');
      return true;
    }

    appendLog(
      'maxSteps',
      '[limit] steps=' + used + ' hold; autoCompress=' + !!(this.cfg.autoSummarize && this.cfg.autoSummarize.enabled) +
      ' autoResume=' + autoResume + ' rounds=' + (this._autoResumeCount || 0) + '/' + autoResumeRounds
    );
    if (this.cancelled) return false;
    this.emit('notice', {
      text: autoResume
        ? `已连续执行 ${used} 步仍未结束，自动续跑 ${autoResumeRounds} 轮后仍未能收尾，已暂停在断点。点上方「继续」可接着做（也可停止，或调大 foxAi.agent.maxSteps / foxAi.agent.autoResumeRounds）。`
        : `已连续执行 ${used} 步仍未结束，达到硬性上限，已暂停在断点。点上方「继续」即可接着做（也可停止，或调大 foxAi.agent.maxSteps）。`
    });
    this.emit('step', { kind: 'notice', title: `达到 ${used} 步上限，等待确认`, status: 'warn' });
    // 真正挂起：pause() + gate() —— run() 停在这里，session 不被回收
    this.paused = true;
    this.emit('state', { state: 'paused' });
    if (this.task) {
      try { await this.taskManager.updateState(this.task.id, harness.TASK_STATES.PAUSED); } catch (_) {}
    }
    await new Promise((resolve) => this._resumeWaiters.push(resolve));
    if (this.cancelled) throw new Cancelled();
    this.paused = false;
    this._pausedLogged = false;
    if (this.task) {
      try { await this.taskManager.updateState(this.task.id, harness.TASK_STATES.RUNNING).catch(() => {}); } catch (_) {}
    }
    this.emit('state', { state: 'running' });
    appendLog('maxSteps', '[resume] budget+=' + (this.cfg.maxSteps || 0));
    this._pushResumePrompt('manual');
    return true;
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
   * 会话级「任务进度摘要」：运行期维护一条紧凑的执行流水账（每步工具名 + 参数摘要 + 结果摘要），
   * 并随 checkpoint / 每次会话存档持久化。重开会话或断点续跑时，模型凭它知道自己「做过什么、做到哪、下一步做什么」，
   * 不再出现「重启后对当前上下文一片空白」。
   * @param {string} toolName 本步工具名（如 read_file / edit_file / run_command）
   * @param {object} args     工具参数
   * @param {string} output   工具结果摘要（截断后）
   */
  _recordProgress(toolName, args, output) {
    try {
      if (!this._progressEntries) this._progressEntries = [];
      const argKeys = (args && typeof args === 'object') ? Object.keys(args).filter((k) => !['content', 'new_text', 'old_text', 'text'].includes(k)) : [];
      let argHint = '';
      argHint = argKeys.map((k) => {
        let v = args[k];
        if (typeof v === 'string') v = v.length > 120 ? v.slice(0, 120) + '…' : v;
        return k + '=' + v;
      }).join(' ');
      if (argKeys.length) argHint = ' 参数: ' + argHint;
      const outText = String(output || '').replace(/<foxtool[\s\S]*?<\/foxtool>/gi, '').replace(/\s+/g, ' ').trim();
      const outStr = outText ? ' → ' + outText.slice(0, 240) : '';
      this._progressEntries.push({
        t: Date.now(),
        tool: toolName,
        text: toolName + argHint + outStr
      });
      // 只保留最近 80 条，避免无界增长
      if (this._progressEntries.length > 80) {
        this._progressEntries = this._progressEntries.slice(-80);
      }
    } catch (_) {}
  }

  /** 把进度流水账渲染成一个紧凑的会话进度块（供存档与恢复回灌） */
  _renderProgressBlock() {
    try {
      const entries = this._progressEntries || [];
      if (!entries.length) return '';
      const lines = entries.slice(-30).map((e) => '· ' + e.text);
      return '【会话进度】\n' + lines.join('\n');
    } catch (_) {
      return '';
    }
  }

  /**
   * L1 极速层：生成精简的项目文件树（仅目录/文件层级，≤ 约 1.5K token）。
   * 不再注入角色/代码骨架（那些改由 L2 read_file 按需读取），让「你好」这类轻问
   * 只带这一小块稳定上下文，前缀缓存命中、秒回。
   */
  _buildProjectContext() {
    try {
      const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
      if (!folder) return '';
      const tree = projectScan.renderFileTreeText(folder.uri.fsPath, 2, 120);
      return tree ? '【项目结构（文件树）】\n' + tree : '';
    } catch (_) {
      return '';
    }
  }

  /**
   * 收集「跨轮字节稳定的上下文块」：用户技能 / 项目根规则 / 项目结构 / 项目任务清单 / Agent 模式人格 / 扁平长期记忆。
   * 这些内容与当前 query 无关、在同一会话（乃至同项目跨会话）里字节稳定，应只在首轮注入一次并烤回源历史，
   * 之后随历史沉淀进 KV 缓存、每轮命中，避免每轮重烤成 miss（这正是 1.1.20 前移方案想解决的痛点，
   * 但 1.1.20 把它们塞进 system 前缀导致系统前缀变大、缓存预算压力下历史单元被挤占淘汰，反而回退命中率）。
   *
   * 任一来源异常 / 为空都不影响其余来源，绝不抛错阻断主流程。
   * @param {string} flatMemory 已取好的扁平长期记忆（稳定，避免重复调用）
   * @returns {string[]} 非空块数组（调用方用 '\n\n' 拼接，或逐块 push 进附录）
   */
  _collectStableParts(flatMemory) {
    const parts = [];
    // 用户技能：agent 自己编写的可复用工作流清单，跨会话稳定（对齐 DSH skill catalog：
    // 把可用技能摘要常驻上下文，模型每轮都知道有什么技能、需要时按名 use_skill 加载正文）
    try {
      let skillText = this.skills.renderForPrompt();
      // 内置技能目录（对齐 DSH bundled skill）：知识库检索始终可用（不需要知识库就绪，
      // 检索空知识库也返回空结果而不是报错），模型按需自主调取
      const builtin = '- _knowledge_base：知识库检索（内置技能。用户问题需要参考本地知识库文档时调用 use_skill 激活它，query 传用户问题的关键词，返回命中的知识内容；知识库为空时返回空结果）';
      const joined = skillText ? skillText + '\n' + builtin : '你拥有以下内置技能（agent 可直接按需调用 use_skill 激活）：\n' + builtin;
      parts.push('【技能目录】\n' + joined);
      // CLI 固定模板指令（省 token + 稳定）：长任务需要反复执行工具时，
      // 用本插件自带的 fox CLI（位于 fox-ai/src/cli/fox.js，命令名 fox），
      // 每次「一字不差地复述固定调用串」以命中 Prompt Cache，不要换措辞。
      const cliGuide =
        '【CLI 固定模板】（长任务省 token 关键）\n' +
        '需要反复执行工具（读文件/写文件/搜索/命令/技能/审计/转换/计划/记忆/时间）时，' +
        '用 fox CLI 代替自然语言描述，调用串固定为：\n' +
        '  fox <工具名> --json \'{"参数":"值"}\' [--full] [--cwd 目录]\n' +
        '- 每次复用同一调用串（一字不差），命中 Prompt Cache 不花重复 token；不要重新造句。\n' +
        '- 输出协议：成功 foxai-ok <工具> <耗时ms> [truncated]，失败 foxai-err <工具> <码> <摘要>（stderr）。\n' +
        '- 默认输出截断 8000 字符，需要全量时追加 --full；不要让模型反复「只看前 10 行」。\n' +
        '- 超时不挂死：默认 120s，可 --timeout 调；失败信息单行摘要，模型一次看懂，不来回重发。\n' +
        '- 可用工具清单：fox --list（35 个可独立执行）；编辑器绑定工具（诊断/编辑器上下文/预览等）不能用 CLI。';
      parts.push(cliGuide);
    } catch (_) {}
    // 项目根规则（CLAUDE.md / AGENTS.md / .cursorrules …）：懒加载 + mtime 缓存，跨会话稳定
    try {
      if (config.conf().get('projectRules.enabled', true)) {
        const rulesRoot = this._workspaceRoot();
        if (rulesRoot) {
          const projectRules = require('./projectRules');
          const rulesText = projectRules.renderForPrompt({
            root: rulesRoot,
            budget: config.conf().get('projectRules.budget', 6000)
          });
          if (rulesText) parts.push(rulesText);
        }
      }
    } catch (_) {}
    // 项目结构：自动扫描工作区概览，带内部签名缓存，跨会话稳定
    try {
      const projCtx = this._buildProjectContext();
      if (projCtx) parts.push('【项目结构】\n' + projCtx);
    } catch (_) {}
    // 注：「项目任务清单」已移出稳定块——它的状态（pending/in_progress/completed）每轮随模型推进变化，
    // 若留在稳定块则 system 前缀每轮漂移、整段缓存失效（命中率低的元凶之一）。
    // 任务清单现状由模型按需用 list_plan_tasks 查询（系统提示词已引导），对齐 DSH「todo 是工具、不进前缀」。
    // Agent 模式人格：非默认模式才注入（code 模式一字不加），稳定
    if (this.mode) {
      try {
        const suffix = require('./modes').renderForPrompt(this.mode);
        if (suffix) parts.push(suffix);
      } catch (_) {}
    }
    // 扁平长期记忆（用户偏好/约定/教训），稳定
    if (flatMemory) parts.push('【长期记忆】\n' + flatMemory);
    return parts;
  }

async run() {
    // 缓存能力点对点判定：决定预热是否执行、以及不支持的模型只提醒一次
    if (!this._cacheCapability) {
      try { this._cacheCapability = require('./client').getCacheCapability(this.cfg && this.cfg.meta, this.cfg && this.cfg.transport, this.cfg && this.cfg.model); } catch (_) { this._cacheCapability = { supported: true, kind: 'auto', provider: 'openai-compatible' }; }
    }
    if (this._cacheCapability && !this._cacheCapability.supported && !this._warnedCacheUnsupported) {
      this._warnedCacheUnsupported = true;
      this.emit('cacheUnsupported', { reason: this._cacheCapability.reason, provider: this._cacheCapability.provider, model: (this.cfg && this.cfg.model) || '' });
    }
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
      // 深度思考开关同理：聊天窗口顶部的芯片一点即生效，不用重开会话
      if (live && live.deepThinking) this.cfg.deepThinking = live.deepThinking;
    } catch (_) {}

    // ---- Agent 模式（code / architect / ask / debug）----
    // 每轮直读设置，切模式立刻生效、不用重建会话；模式定义是模块级常量，不占额外内存。
    this.mode = null;
    try {
      const modes = require('./modes');
      const c0 = config.conf();
      const modeId = c0.get('modes.current', modes.DEFAULT_MODE);
      if (modeId && modeId !== modes.DEFAULT_MODE) {
        this.mode = modes.resolveMode(modeId, c0.get('modes.overrides', null));
        // 每模式独立模型：架构用强模型、问答用便宜模型，只覆盖 model 字段
        const mm = modes.modelFor(modeId, c0.get('modes.models', null));
        if (mm && mm !== this.cfg.model) {
          this._modeModelFrom = this.cfg.model;
          this.cfg.model = mm;
          this.emit('notice', { text: `${this.mode.emoji} ${this.mode.label}模式：本轮改用模型「${mm}」` });
        }
      }
    } catch (_) { this.mode = null; }
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
    this._lastContinuedText = '';
    this._lenContinue = false;
    // 每轮用户提问重置审查注入状态（本轮新的审查结果才应被主控参考）
    this._reviewInjected = false;
    this._reviewConsumed = false;
    this._reviewResult = null;
    this._reviewQuotaError = null;
    // 1.1.27：每轮重置审查提示去重标记（本轮审查提示整轮只发一次）
    this._reviewNoticeSent = false;
    this._reviewHadOpinion = false;
    // 产物只统计「本轮用户提问」内的改动，避免把上一轮/上一任务的产物重复展示
    this._artifacts = [];

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
    } else if (!this.toolsEnabled) {
      this.protocol = 'chat';
    } else if (cfg.toolProtocol === 'text') {
      this.protocol = 'text';
    } else if (cfg.toolProtocol === 'native') {
      this.protocol = 'native';
    } else {
      // auto：按模型能力智能选协议，开箱即用兼容各厂商/本地模型（增强③）
      this.protocol = modelSupportsNativeTools(cfg) ? 'native' : 'text';
    }
    // 1.1.25（用户「除了 web 要用自定义，其他降级 text 也不能和 web 一样自定义」）：
    // 自定义工具标签（[[tool:]]）只为 WebAI2API 防风控而生，**只认 cfg.meta.textOnly**——
    // native 直连、以及 native 失败降级后的 text 直连，一律渲染标准 <foxtool>：
    // 降级 text 只是「把 text 协议当工具调用通道」，绝不是 WebAI2API，不需要也不应该
    // 附带网页风控用的自定义标签（否则直连模型又陷入 [[tool:]] vs <foxtool> 格式打架→空轮中断）。
    tools.setCustomTagMode(!!(this.cfg && this.cfg.meta && this.cfg.meta.textOnly));
    // 本地弱模型辅助模式（1.1.17）：决定是否进入弱模型适配逻辑（约束解码/检索/闭环/锚点）。
    // cfg.localWeak 由 config.resolve 计算（auto 下本地模型默认开）。
    this._weakLocal = !!(cfg.localWeak);
    this._weakArgRetries = 0;
    this._weakArgMax = 3;
    this._grammarStripped = false;
    this._grammarCap = null; // 本会话的 grammar 探测结论缓存（null=尚未探测）
    // 失败降级 / 自动 failover（1.1.20）：从配置取出，callModel 失败时按 triggers 切备用模型
    this._failover = cfg.failover || { enabled: false, triggers: new Set(), maxRetries: 0, targets: [] };
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

  // ===== 铁打前缀：system 只放「绝对静态」的基础系统提示词；其余内容分两类 =====
  let baseSystem = buildSystemPrompt(cfg, envBrief, this.protocol, queryText);
  // ===== RAG / 知识库「纯工具化」（对齐 DSH 工具式 RAG 的前缀缓存核心）=====
  // 关键认知：RAG 每轮注入 = 每轮把 4000+ token 拼进请求尾部 = 每轮纯 miss（命中率崩主因）。
  // DSH 的做法是「知识库检索是工具，模型按需调用」——知识内容不进每轮请求前缀。
  // 这里只发一行技能提示（几十字，非知识内容），模型需要时用 use_skill(_knowledge_base)
  // 按需检索；同话题后续轮次【完全不注入】，避免每轮重复 miss。话题切换用 query 指纹判定。
  const qFp = _qFingerprint(queryText);
  const isShortQuery = String(queryText || '').trim().length < 10;
  const topicSwitched = (fp, c) => !c || (!isShortQuery && _qOverlap(fp, c.fp) < 0.2);

  // 知识库技能提示（RAG 纯工具化，对齐 DSH）：知识内容绝不进请求前缀——模型需要时
  // 用 use_skill(name=_knowledge_base, query=…) 按需检索。只发一行技能提示，
  // 且仅首轮 / 话题明显切换才发；文件清单变化时补一行增量提醒，同话题无变化则完全不发
  // （知识库在工具清单与历史里，模型可回看，杜绝每轮重复粘贴）。
  let knowledgeText = '';
  {
    const c = this._dynCache.kb;
    if (topicSwitched(qFp, c)) {
      knowledgeText = await this._buildKnowledgeHint();
      let filesFp = '';
      try { filesFp = kb.filesFingerprint(kb.listKnowledgeFiles(this.sessionId)); } catch (_) {}
      this._dynCache.kb = { fp: qFp, text: knowledgeText, filesFp };
    } else if (c && c.filesFp) {
      // 同话题续轮：只对「文件清单变化」发一行增量（不重发提示全文，保住前缀缓存）
      let curFp = '';
      try { curFp = kb.filesFingerprint(kb.listKnowledgeFiles(this.sessionId)); } catch (_) {}
      if (curFp && curFp !== c.filesFp) {
        this._dynCache.kb = { ...c, filesFp: curFp };
        knowledgeText = '【知识库已更新】知识库文件清单已变化（新增/移除/整理产物刷新）。如需最新内容请用 use_skill(name=_knowledge_base, query=…) 按需检索。';
      }
      // 未变化：knowledgeText 保持空，不注入
    }
  }

  // 扁平长期记忆（稳定，仅随记忆文件变化）→ 进稳定块；主题记忆（查询相关，易变）→ 进易变块
  let flatMemory = '';
  try { flatMemory = this.memory.renderForPrompt(); } catch (_) {}
  let topicMem = '';
  try {
    if (this.topicMemory) {
      const c = this._dynCache.topicMem;
      // 1.1.15：主题记忆也走「内容哈希去重」——同话题后续轮次若检索结果与上次注入完全一致，
      // 则不重复注入（WebAI2API 网页整段粘贴最怕大块每轮重复）；内容变了（记忆文件更新/话题切换
      // 导致检索结果变化）才重发。缓存从 query 指纹改为内容指纹，比对的是「实际会注入的文本」。
      const rel = this.topicMemory.loadRelevant(queryText, { maxTopics: 3 });
      topicMem = (rel && rel.text) || '';
      const curFp = _contentFingerprint(topicMem);
      if (c && c.fp === curFp) {
        topicMem = ''; // 内容没变：本轮不注入，杜绝每轮重复粘贴
      } else {
        this._dynCache.topicMem = { fp: curFp };
      }
    }
  } catch (_) {}

  // 易变（每轮变动）附录收集器：知识库/环境/主题记忆/弱模型锚点/时间/审查，每轮随 query 重新生成注入，
  // 绝不写回 system、不烤回源（保持新鲜，避免历史污染），位于请求末尾、随轮 append-only。
  const dynParts = [];
  if (knowledgeText) dynParts.push(knowledgeText);
  // 1.1.15：textOnly（WebAI2API 本质是模拟点击网页、每轮整段粘贴）下，
  // 「易变大块」（深度思考/当前环境等）改为【内容哈希去重】注入：内容与上次注入完全一致则
  // 本轮整轮不发（不是每 N 轮发一次，而是「只有内容变了才发一次」，见 dynOk 逻辑）；
  // 内容一旦变化（切思考开关/换文件/环境变更）立即重发，保证模型始终持有最新状态。
  // 普通模型保持每轮注入（有前缀缓存红利，不受影响）。
  const isWebText = !!(cfg.meta && cfg.meta.textOnly);
  const dynOk = !isWebText || (() => {
    const acc = this._dynCache.env; // 复用预留位点：{ fp: 内容指纹 }
    const cur = _contentFingerprint([
      (() => { try { return buildDeepThinkingHint(cfg); } catch (_) { return ''; } })(),
      envBrief || '',
      (() => { try { return ctxTools.activeFileDiagnosticsBrief(); } catch (_) { return ''; } })()
    ].join('\n'));
    if (acc && acc.fp === cur) return false; // 内容没变：整轮不发，杜绝重复粘贴
    this._dynCache.env = { fp: cur };
    return true;
  })();
  // 深度思考提示词兜底：放动态附录（每轮随开关刷新），避免写进 system 导致「切换思考开关→前缀漂移→缓存失效」
  if (dynOk) {
    try {
      const thinkHint = buildDeepThinkingHint(cfg);
      if (thinkHint) dynParts.push('【深度思考】\n' + thinkHint);
    } catch (_) {}
  }
  // 弱本地模型防注意力漂移锚点（1.1.16）：由 queryText 派生、每轮都变 → 只在动态附录，不污染可缓存前缀
  if (this.protocol === 'text' && (cfg.meta && cfg.meta.local) && queryText) {
    try {
      const anchor = weakModel.buildAnchor(queryText);
      if (anchor) dynParts.push(`【⚓ 核心任务·始终牢记】${anchor}\n\n【⚓ 再次提醒·核心任务】你刚才要完成的是：${anchor}。请围绕它作答，不要跑题。`);
    } catch (_) {}
  }
  // 环境信息：随用户操作变化，作为动态附录注入到最后一条 user 消息尾部，不影响前缀缓存命中率。
  // 1.1.18e（对齐 DSH runtime-context snapshot）：环境块是「快照」而非「追加的历史」——
  // 头部明确「本快照取代先前所有快照」，防止模型把几轮前打开的旧文件/旧工作区当最新状态；
  // envBrief 从有到无时（旧模型可能不再产生环境信息）发一条「环境已清空」，
  // 让模型知道先前的环境快照已失效（DSH 的 CLEARED 语义：none supersedes earlier）。
  if (dynOk) {
    const envHead = '【当前环境·最新快照】\n这份环境快照取代先前所有环境快照；以下列出的才是当前真实状态：';
    if (envBrief) dynParts.push(envHead + '\n' + envBrief);
    else if (this._prevEnvInjected) dynParts.push('【当前环境】已清空：先前注入的环境快照不再生效，不要引用旧的工作区/打开的文件的描述。');
  }
  this._prevEnvInjected = !!envBrief;
  // L1 极速层（易变部分）：当前激活文件的 Diagnostics 摘要（前 3 个 Error），每轮随 query 刷新。
  // 极小（≤ 几百 token），放进动态附录尾部，不破坏可缓存的稳定前缀；让用户切文件后模型立刻知道新文件的报错。
  try {
    const diagBrief = ctxTools.activeFileDiagnosticsBrief();
    if (diagBrief) dynParts.push('【当前文件报错】\n' + diagBrief);
  } catch (_) {}
  // 主题记忆（查询相关，易变）→ 每轮注入
  if (topicMem) dynParts.push('【长期记忆】\n' + topicMem);
  // 对明确的时间查询，取真实时间——只进 dynamicAppendix（user 消息），绝不进 system
  let timeInfo = '';
  if (/现在几点|当前时间|今天几号|今天日期|几点了|什么时间|几点钟/i.test(queryText)) {
    try {
      const ti = await tools.execute('current_time', {}, { maxToolOutput: 500 });
      if (ti) timeInfo = ti;
    } catch (_) {}
  }
  if (timeInfo) dynParts.push('【当前时间信息】\n' + timeInfo);
  // L3 批处理模式（用户主动触发）：检测 /fix_all、/review 等指令，注入「并行分批 + 关注文件尾部报错」提示。
  // 仅在命中时才注入（不进 stable，避免污染可缓存前缀）；这是对抗长上下文注意力衰减的关键。
  const batchHint = buildBatchModeHint(queryText);
  if (batchHint) dynParts.push(batchHint);
  // 1.1.32：纯问候/闲聊轮直答护栏——极短且无任务意图时追加一行提示，让模型直接文字回复、
  // 不调任何工具（含 get_tools/联网/时间查询）。只进动态附录、不写回 system，前缀缓存基线不受影响。
  if (isChatter(queryText)) {
    dynParts.push('【纯对话轮】本轮用户只是问候/闲聊/简短回应：请直接文字回复，不要调用任何工具（包括 get_tools、联网搜索、时间查询）。');
  }
  // ★ 会话进度回灌（对齐 DSH goal_round「Treat current workspace/tool results as authoritative」）：
  // 把本会话已执行的工具流水账（上一步做了什么、结果如何）注入请求尾部，模型凭此知道自己干到哪，
  // 断点续跑/重开会话时不再「对当前上下文一片空白」。只有非空才注入，避免空块污染动态附录。
  try {
    const progressBlock = this._renderProgressBlock();
    if (progressBlock) dynParts.push(progressBlock);
  } catch (_) {}

  // —— 稳定上下文块：规则/技能/结构/任务/人格/扁平记忆，跨轮字节稳定。
  // 首轮（源历史尚无稳定哨兵）注入一次并烤回 this.messages 源，之后随历史沉淀进缓存、每轮命中，
  // 不再每轮重烤成 miss（这正是 1.1.20 前移方案想解决的痛点，但 1.1.20 把它们塞进 system 前缀
  // 导致系统前缀变大、缓存预算压力下历史单元被挤占淘汰，反而回退命中率）。
  // 用独立哨兵【狐狸AI·稳定上下文】包裹，源与下发副本都烤入，保证冻结历史与下发逐字节一致、跨轮前缀命中。
  // 开关关闭则退化为每轮注入（旧行为），功能不丢。
  const stableEnabled = config.conf().get('stableContext.enabled', true);
  // 会话级冻结：稳定块首轮算好后复用，下个会话构造函数把 _stableBlock 重置为 null 自动刷新
  if (this._stableBlock === null) {
    this._stableBlock = stableEnabled ? this._collectStableParts(flatMemory).join('\n\n') : '';
  }
  // ★ 稳定块前移进 system 前缀（而非每条 user 消息尾部）：会话内字节稳定，整段吃 DeepSeek
  // 公共前缀缓存红利——所有请求（含单轮/浅会话）的 system 部分直接命中，不再让每条 user
  // 消息额外承担这整块的必 miss。1.1.20 也曾前移但当时 varAppendix 未烤回源、历史前缀断裂
  // 导致回退；1.1.22 已烤回 var 使历史稳定，此时前移 stable 不再重复该 bug。
  if (this._stableBlock) baseSystem = baseSystem + '\n\n' + this._stableBlock;
  // 开关关闭：稳定块退化为每轮注入 user（1.1.19 旧行为），功能不丢
  if (!stableEnabled) {
    this._collectStableParts(flatMemory).forEach((p) => dynParts.push(p));
  }

    let downgraded = false;

    try {
      const maxSteps = this.toolsEnabled ? Math.max(1, cfg.maxSteps) : 1;
      // 步数预算可续：达到硬性上限时不直接 return（那会让 chatView 把 session 置空、
      // 导致暂停/继续/停止按钮全部失效），而是就地真正挂起，等用户点「继续」再追加一轮预算。
      let stepBudget = maxSteps;
      for (let step = 0; ; step++) {
        if (step >= stepBudget) {
          const resumed = await this._hardStopPause(queryText, envBrief, stepBudget);
          if (!resumed) return { finished: false, reason: 'max-steps' };
          stepBudget += maxSteps;
        }
        await this.gate();
        this.stepCount = step + 1;
        this.deltaSeen = false;
        this.reasoningSeen = false;
        this._estDeltaChars = 0;
        this.thinkingMsgId = 'thinking-' + this.runId + '-' + this.stepCount;
        this._thinkingBuffer = { text: '', reasoning: '', images: [] };
        // 1.1.26：正文气泡也随轮推进（对齐 WorkBuddy「正文随时间变」）——
        // 之前 finalMsgId 整个 run 固定一个，多轮工具循环的每段正文都叠进最早的同一个气泡，
        // 用户看正文必须滑回最上面。现在与 thinkingMsgId 同款：每轮换新 id，
        // 前端按 id 聚合自然就是「每轮一段新正文卡」，思考 → 工具 → 正文 → 再思考 → 再正文逐轮铺开。
        // _finalStarted 同步每轮重置，让每轮都发 assistantStart 建新正文锚点（否则新 id 无锚点，正文会丢）。
        this.finalMsgId = 'final-' + this.runId + '-' + this.stepCount;
        this._finalStarted = false;
        this.state = 'thinking';
        this.emit('state', { state: 'thinking', step: this.stepCount, thinkingMsgId: this.thinkingMsgId });

        // 等待本轮可能触发的代码审查结果（限时，默认 8s）。
        // 若审查在限时内完成，把摘要注入 system 供主控参考，主控的最终回答会自然吸纳这些意见；
        // 若超时，主控先回答，审查完成后异步弹出 review 卡片，用户可一键应用。
        const reviewTimeout = (cfg.review && typeof cfg.review.injectTimeout === 'number')
          ? cfg.review.injectTimeout
          : 8000;
        const reviewSnapshot = await this._awaitReview(reviewTimeout);
        const reviewInjectText = (reviewSnapshot && reviewSnapshot.text)
          ? '【本轮代码审查意见】\n' + reviewSnapshot.text +
            '\n请把这些意见纳入当前思考；若认同，在最终回答中说明你将如何修正。'
          : '';

        // ★ 铁打前缀：system 始终等于静态 baseSystem（不掺任何每轮变动内容）；
        // 易变附录（知识库/环境/主题记忆/锚点/时间/审查）追加到最后一条 user 消息【尾部】，
        // 位于请求末尾、随轮 append-only，用动态哨兵检测杜绝重复叠加，绝不污染可缓存的静态前缀；
        // 稳定块（规则/技能/结构/任务/人格/扁平记忆）首轮注入一次、烤回源历史后随轮命中，
        // 用独立 stable 哨兵包裹，不进 system、不放大系统前缀（避免 1.1.20 缓存预算回退）。
        const system = baseSystem;
        // 易变附录（每轮用户提问稳定，含 RAG/环境/报错/主题记忆等，不含每 step 变化的审查意见）
        const varAppendix = dynParts.filter(Boolean).join('\n\n');
        // 稳定块已前移进 system 前缀（见上方 _stableBlock 拼接），此处不再注入 user 消息。
        const preparedHistory = await this.prepareHistory();
        // 1.1.19：textOnly（WebAI2API）新会话首轮「前置 get_tools 引导」（对齐样品.md 三步分离）——
        // ★ 网页端（WebAI2API）是「模拟点击」：它把请求里的 messages 拼成虚拟上下文整段粘贴进
        // 网页输入框。若把 system+历史+当前问题一次性发出，网页里只会出现一条「巨型用户消息」，
        // 用户问题混在历史段里不独立成条（用户实测「顺序对了但消息没发出去」的根因）。
        // 因此改为【三步独立请求】，每次只带一条 user 消息（不带 system/历史）：
        //   ① 发强制 get_tools 引导（新会话信号 fox_new_session 只在第一步带）
        //   ② 模型输出工具调用 → 本地执行 get_tools → 把工具结果作为独立消息发出
        //   ③ 发用户真实问题（含动态上下文）→ 模型带着工具清单正式回答
        // 网页对话里即呈现样品.md 的独立三条：引导 → 工具结果 → 真实问题。
        // 恢复会话（服务终止后在原对话续聊 / 切换会话）时 _resumedSession=true，跳过。
        let _webGuideResult = null;
        const isWebTextSess = !!(cfg.meta && cfg.meta.textOnly);
        if (isWebTextSess && !this._resumedSession && !this._toolGuideFetched && !this._prependedGuide) {
          this._prependedGuide = true;
          this._ev(agentEvents.EV.PREPENDED_GUIDE, {});
          const b = selectBackend(cfg);
          const mkOpts = (messages) => ({
            baseUrl: cfg.baseUrl,
            apiKey: cfg.apiKey,
            model: cfg.model,
            messages,
            temperature: cfg.temperature,
            maxTokens: cfg.maxTokens,
            timeout: cfg.timeout,
            insecureHttpParser: cfg.insecureHttpParser,
            streamFormat: cfg.streamFormat,
            signal: this._abortCtrl ? this._abortCtrl.signal : undefined
          });
          try {
            // 1.1.32：引导轮可视化——get_tools 动作卡推进会话栏/工作链（对齐样品.md「模型先输出 get_tools」），
            // 结果一并展示（卡片折叠区），引导失败则卡片标错，不再静默无痕。
            const guideUiId = 'guide-' + Date.now().toString(36);
            let _guideEnded = false;
            const guideEnd = (ok, output) => {
              if (_guideEnded) return;
              _guideEnded = true;
              this.emit('toolEnd', { id: guideUiId, ok, output });
            };
            this.emit('toolStart', { id: guideUiId, name: 'get_tools', kind: 'read', title: '🧰 获取工具', args: {}, preview: null });
            // ① 引导轮（独立消息）
            // ★ 1.1.19 修复：fox_new_session 只在【真·新会话】时带（messages 无历史 = 用户刚点新建会话），
            // 同一会话继续对话（有历史）时【不带】——否则每次提问都让网页「新对话」，之前的会话被冲掉、
            // 每次都重新 get_tools（用户实测「每发一句 web 就来一次获取工具」的根因）。
            // 判定：preparedHistory 里除当前提问外还有历史 user 消息 = 同会话继续。
            const _histUsers = preparedHistory.filter((m) => m && m.role === 'user');
            const _isFreshSession = _histUsers.length <= 1;
            const guideBody = { role: 'user', content: '[系统] 本任务的第一步必须先调用 get_tools 获取可用工具清单（这是固定格式要求）。请立即只输出下面这一个工具调用块，不要附加任何解释：\n\n' + tools.wrapToolCall('get_tools', '{}') };
            // ★ 1.1.19：三步引导第①步若带了 fox_new_session（真·新会话），必须同步置 _webResetSent=true——
            // 否则三步引导绕过 _request 后，主循环后续轮次（如工具结果回填后的继续请求）会因 _webResetSent
            // 仍为 false 而再次携带 fox_new_session → 网页每轮工具调用都「新对话」冲掉会话（日志里 list_dir
            // 工具结果带 foxNewSession=true 的根因）。
            if (_isFreshSession) this._webResetSent = true;
            const g1 = await llmLimiter.run(() => b.nonStream(Object.assign(mkOpts([guideBody]), {
              extraBody: _isFreshSession ? { fox_new_session: true } : {}
            })));
            const g1Text = (g1 && (g1.content != null ? g1.content : g1.text)) || '';
            // 解析 get_tools 工具块并本地执行。
            // ★ 必须用 parseTextCalls（内部先 normalizeToolTags）——模型常输出自定义符号
            //   [[tool:get_tools]]{}[[/tool]]，TOOL_BLOCK 只认 <fox:tool> XML 格式会解析失败
            //   → get_tools 不执行、工具结果不发、直接跳去发用户消息（用户实测「没按样品.md」的根因）。
            let toolFeed = '';
            const gCalls = parseTextCalls(g1Text, this._toolNameSet());
            const gCall = gCalls && gCalls.find((c) => String(c.name).toLowerCase() === 'get_tools');
            if (gCall) {
              let gargs = {};
              try { gargs = JSON.parse(gCall.rawArgs || '{}'); } catch (_) {}
              const out = await tools.execute('get_tools', gargs, { token: this.token, toolName: 'get_tools' });
              this._toolGuideFetched = true;
              this._ev(agentEvents.EV.TOOL_GUIDE_FETCHED, {});
              toolFeed = '[工具 get_tools 的结果]\n' + String(out) + '\n\n请根据结果继续，或给出最终回答。';
              guideEnd(true, String(out).slice(0, 800));
              // ★ 1.1.19 修复：get_tools 结果【写回 this.messages 源历史】——
              // 每次提问都新建 AgentSession，构造函数扫描 messages 里是否有 [工具 get_tools 的结果]
              // 来判定「已获取清单」（_resumedSession）。若不写回，同会话第二次提问扫不到 →
              // _resumedSession=false → 又触发三步引导 + 网页反复 get_tools（用户实测每句一次）。
              // 写回后：同会话继续时构造函数扫到 → 跳过三步引导，只走正常主循环（网页会话历史自带清单）。
              this.messages.push({ role: 'user', content: toolFeed });
            }
            // ② 工具结果轮（独立消息；引导没产出调用则跳过本步）
            if (toolFeed) {
              await llmLimiter.run(() => b.nonStream(mkOpts([{ role: 'user', content: toolFeed }])));
            }
            // ③ 真实问题轮：把本轮用户提问作为独立消息发出，
            //    并附上动态上下文（深度思考/环境/记忆等，对齐样品.md 用户消息后的【狐狸AI·动态上下文】）
            const lastU = preparedHistory.slice().reverse().find((m) => m && m.role === 'user');
            const userContent = lastU
              ? (typeof lastU.content === 'string' ? lastU.content
                : (Array.isArray(lastU.content) ? lastU.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n') : ''))
              : '';
            if (userContent) {
              let finalContent = userContent;
              if (varAppendix) {
                finalContent = userContent + '\n\n' + this._wrapAppendix(varAppendix, DYN_MARK);
                // 同步记录 webBlockCache 指纹，避免后续轮重复注入同内容动态块
                if (this._webBlockCache) this._webBlockCache.set(DYN_MARK, { fp: _contentFingerprint(varAppendix) });
              }
              _webGuideResult = await llmLimiter.run(() => b.nonStream(mkOpts([{ role: 'user', content: finalContent }])));
            }
          } catch (_) {
            // 三步引导失败不影响主流程：回落到主循环正常 payload（模型可能缺清单，但至少问题能发出去）
            guideEnd(false, '获取工具清单失败，已回落主流程');
          }
        }
        if (varAppendix) {
          this._injectDynamicAppendix(preparedHistory, varAppendix, DYN_MARK);
          // ★ 关键修复（1.1.22）：易变附录必须同步烤回 this.messages 源历史，否则源里该 user 消息是裸的、
          // 下一轮重建历史时它在「附录位置」接的是 assistant 回复，与本轮下发（接附录）前缀对不上 →
          // 每个 user 边界缓存断裂、RAG/记忆/环境等大块每轮纯 miss。烤回后该 user 消息逐字节冻结，
          // 后续轮次作为历史命中前缀缓存，把每轮必 miss 的大块变成「仅首次出现时 miss、之后全命中」。
          // 1.1.14：textOnly（WebAI2API）不烤回源——网页浏览器自带会话历史，无前缀缓存需求，
          // 烤回源反而让动态块在历史里每轮累积重复粘贴；普通 text（DeepSeek/本地）仍烤回源吃缓存红利。
          if (!isWebText) this._bakeAppendixIntoSource(varAppendix, DYN_MARK);
        }
        // 审查意见（每 step 随审查批次变化）**不进 varAppendix**——否则 varAppendix 每 step 漂移，
        // 工具调用之间的前缀断裂（命中率到不了 harness「第三次调用 99%」）。改为独立 append-only
        // user 消息追加到请求末尾：作为「新内容」自然 miss，不破坏稳定前缀，也不烤回源（审查意见是
        // 临时的修正建议，不该沉淀进历史）。
        if (reviewInjectText) {
          preparedHistory.push({ role: 'user', content: this._wrapAppendix(reviewInjectText, REVIEW_MARK) });
        }
        // 遥测用上下文快照（与下发内容一致，不进模型）
        const memoryText = (topicMem || '') + (flatMemory ? (topicMem ? '\n\n' : '') + flatMemory : '');
        let planTaskText = '';
        try { planTaskText = this.planTasks.renderForPrompt(); } catch (_) {}
        this._emitContextUsage({
          baseSystem,
          memoryText,
          planTaskText,
          knowledgeText,
          protocol: this.protocol,
          history: preparedHistory,
          maxTokens: cfg.maxTokens,
          contextWindow: cfg.contextWindow
        });
        // ★ 注：textOnly（WebAI2API）首轮「前置 get_tools 引导」已在 prepareHistory() 之后、
        // _injectDynamicAppendix 之前执行过一次（见上方 1940-1956 段落），此处不复述，避免重复。        
        const payload = [{ role: 'system', content: system }].concat(preparedHistory);
        const useNative = this.protocol === 'native';

        let result;
        try {
          // 长度截断续跑轮：强制文本协议（不给工具），让模型只续写正文、不被工具调用带偏
          // 首轮三步引导（_webGuideResult）已把真实问题发给模型并拿到回复 → 直接复用，
          // 不再重复走 callModel（否则网页里用户问题会再发一遍）。
          result = _webGuideResult || await this.callModel(payload, useNative, this._lenContinue ? [] : undefined);
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
            // 只重建静态 baseSystem；知识库检索文本与动态附录（记忆/任务/审查/稳定块）
            // 由主循环统一注入到最后一条 user 消息，绝不写回 system —— system 始终等于
            // baseSystem，铁打不变、可缓存。
            baseSystem = buildSystemPrompt(cfg, envBrief, this.protocol) + (this._stableBlock ? '\n\n' + this._stableBlock : '');
            // 复用首轮已缓存的知识库技能提示（同轮 query 未变），不重复生成、不重复 miss
            knowledgeText = (this._dynCache.kb && this._dynCache.kb.text) || await this._buildKnowledgeHint();
            this.emit('notice', {
              text: '当前模型不支持原生函数调用，已自动切换为文本协议模式继续。'
            });
            step--;
            continue;
          }
          throw err;
        }

        // 续跑轮强制文本协议只作用于当轮请求，立即复位（避免影响后续正常轮）
        this._lenContinue = false;

        if (this.cancelled) throw new Cancelled();

        // 文本协议：某些模型会把 <fox:tool> 标签放在 reasoning 里而不是 content 里，
        // 导致 content 看起来为空、工具没被解析。因此把 content + reasoning 一起作为解析源。
        const textSource =
          this.protocol === 'text'
            ? String(result.content || '') + '\n' + String(result.reasoning || '')
            : String(result.content || '');

        // ===== 1.1.26 韧性加固④：每轮原始返回落盘 =====
        // 排查「空轮/中断」的第一手证据：模型本轮到底说了什么、有没有吐工具块。
        // 重点看 hasToolTag —— 为 false 说明模型压根没按格式输出（用户「重点看是否有 Action 字样
        // 如果没有说明解析失败，需要加强输出格式约束」）。
        try {
          const _raw = String(textSource || '');
          const _hasTag = /<(fox:?tool|fox-tool|tool)\s+name\s*=/i.test(_raw) || /\[\[tool:/i.test(_raw);
          appendLog('agent', `[turn-raw] step=${step} protocol=${this.protocol} len=${_raw.length} hasToolTag=${_hasTag} `
            + `contentLen=${String(result.content || '').length} reasoningLen=${String(result.reasoning || '').length} `
            + `nativeCalls=${this.protocol === 'native' ? (result.toolCalls || []).length : '-'} `
            + `head=${JSON.stringify(_raw.slice(0, 160))}`);
        } catch (_) { /* 日志绝不影响主流程 */ }

        const calls =
          this.protocol === 'native'
            ? (result.toolCalls || []).map((c) => ({ id: c.id, name: c.name, rawArgs: c.arguments }))
            : this.protocol === 'text'
            ? parseTextCalls(textSource, this._toolNameSet())
            : [];

        // 单轮工具调用数超限（1.1.39）：把「被截断」的事实回传模型，不再静默丢弃。
        // 模型会以为超出的调用已执行，实际丢了 → 必须显式提示，让它继续逐个输出。
        if (Array.isArray(calls) && calls._truncated) {
          const truncated = calls._truncated;
          delete calls._truncated; // 元信息不进执行队列
          if (calls.length) {
            this.messages.push({
              role: 'user',
              content: `[系统提示] 你上一轮一次性输出了超过 ${truncated} 个工具调用，超出的部分已被丢弃。请严格遵守「一次只调用一个工具」：先观察已执行结果，然后继续逐个输出下一个工具调用块。`
            });
            this.emit('notice', { text: `检测到单轮工具调用超过 ${truncated} 个，已提示模型逐个执行` });
          }
        }

        // —— 本地弱模型辅助模式（1.1.17）：闭环校验 + 自动修复 ——
        // 文本协议下，解析出的工具调用先做 JSON Schema 校验（类型/必填/枚举）。
        // 失败不发错误，而是把具体报错作为「反思提示」追加进下一轮 payload 让模型自我修正，
        // 最多重试 2~3 次；连续失败转降级模式（仅执行校验通过的调用），绝不卡死。
        // 1.1.39：textOnly（WebAI2API 网页版接入）同样启用参数校验，畸形 JSON 有闭环兜底。
        const textNeedsArgCheck = this._weakLocal || (this.cfg && this.cfg.meta && this.cfg.meta.textOnly);
        if (this.protocol === 'text' && textNeedsArgCheck && calls.length) {
          const checked = validateTextCalls(calls);
          if (checked.invalid.length) {
            if (this._weakArgRetries < this._weakArgMax) {
              this._weakArgRetries++;
              this.messages.push({
                role: 'user',
                content: `[系统·参数校验未通过] 你刚才的工具调用参数不符合要求，请修正后重新只输出正确的工具调用块，不要重复错误。\n${checked.report}`
              });
              this.emit('notice', { text: `参数校验未通过，已把错误反馈给模型自我修正（${this._weakArgRetries}/${this._weakArgMax}）…` });
              continue; // 重新请求模型
            }
            // 超过重试上限：降级模式，仅执行合法调用，并提示用户
            this.emit('notice', { text: `工具调用参数多次无法自我修正，已转入降级模式：仅执行校验通过的调用。` });
            calls = checked.valid;
          }
        }

        // 可见正文与思考分离（1.1.18m）：textSource 是 content+reasoning 拼接，仅用于
        // parseTextCalls 解析工具块（部分模型把 <fox:tool> 藏在 reasoning 里）；但**显示正文**
        // 必须只取 content，否则 reasoning 的思考尾巴（如「第13行有…用户要求…已完成」）
        // 会拼进最终回答气泡（网页原文 vs 插件显示差异的根源）。
        // 兜底：模型把完整答案放在 thinking 而 content 为空时，才用 reasoning 剥块后作正文
        //（此时 reasoning 就是答案本体而不是思考过程）。
        const rawContent = String(result.content || '');
        // 1.1.32：展示路径保留 STEP 边界标记（keepStepMark=true）——前端 renderAssistant 要靠它把
        // 一轮输出切成「文本段→💭思考卡 / 工具段→🖥️动作卡 / 最后一段→正文」（DSH 式三通道）。
        // 此前未传该参数（默认 falsy）导致标记被剥光、前端只切出 1 段，三通道卡片永不出现。
        // 注意：回灌历史绝不保留标记（见下方 messages.push，另外剥成纯正文）。
        let visibleText = this.protocol === 'text' ? stripToolBlocks(rawContent, true) : rawContent;
        // 兜底：content 为空而 reasoning 非空（模型把完整答案写在思考里）→ 用 reasoning 作正文
        if (this.protocol === 'text' && !String(visibleText).trim() && String(result.reasoning || '').trim()) {
          visibleText = stripToolBlocks(String(result.reasoning), true);
        }
        // 1.1.26 韧性加固③（用户「确保即使流式文本为空白，也能从最终消息中提取有效内容作为兜底」）：
        // 三级内容兜底链 content → reasoning → 流式累积文本。
        // 流式已把正文逐字推给用户、但轮末 result.content 聚合为空时（传输中断/聚合失败），
        // 用 onDelta 累积的 _finalStreamedText 兜底，保证「用户看到的」与「进历史的」一致，
        // 不会显示有内容却在历史里变成空消息（下一轮模型就不知道自己说过什么）。
        if (!String(visibleText).trim() && String(this._finalStreamedText || '').trim()) {
          const fb = String(this._finalStreamedText || '');
          visibleText = this.protocol === 'text' ? stripToolBlocks(fb, true) : fb;
          appendLog('agent', `[content-fallback] result.content 为空，用流式累积文本兜底 len=${fb.length}`);
        }

        // 模型生成图片：暂存到本轮缓冲区，最终随 channel（thinking/final）统一发出
        const resultImages = Array.isArray(result.images) ? result.images : [];
        this._thinkingBuffer.images = this._thinkingBuffer.images.concat(resultImages);

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
          // 文本协议：保存去掉工具标签后的可见文本；若 content 为空但 reasoning 有内容，也能记录下来。
          // 1.1.32：展示版 visibleText 带 \u0002STEP: 边界标记（供前端切三通道卡片），回灌历史必须是
          // 纯正文——否则模型下一轮会照抄标记、在正文里输出「STEP:xxx」（08-29 已踩过的坑）。
          const historyText = stripToolBlocks(visibleText, false);
          const m = { role: 'assistant', content: historyText };
          if (resultImages.length) m.images = resultImages;
          this.messages.push(m);
        } else if (result.content) {
          const m = { role: 'assistant', content: result.content };
          if (resultImages.length) m.images = resultImages;
          this.messages.push(m);
        }

        // 本轮产出合法工具调用 → 解除「强制 tool_choice」（模型已回到工具循环，无需再施压）
        if (calls.length) this._forceToolChoice = false;

        if (!calls.length) {
          // ===== 1.1.26 韧性加固①：空响应带指数退避重试 =====
          // 先分清两种「没有工具调用」，二者此前共用 _emptyStreak 一条路，导致空响应从不重试：
          //   A. 空响应 —— content 与 reasoning 全空。这不是「模型在叙述」，而是服务端异常/
          //      限流抖动/模型名写错，值得重试 API（500ms → 1s → 2s）而不是立刻收尾。
          //   B. 空轮   —— 有正文但没工具块。模型在描述计划而非执行，该 nudge 而不是重试。
          // 流式累积文本也算「有输出」：流式已把正文推给用户、但轮末聚合 result.content 为空时
          //（传输中断/聚合失败），不能误判成空响应去重试，否则白白多花 API 调用还冲掉已显示内容。
          const _streamFallback = String(this._finalStreamedText || '').trim();
          const _hasAnyOutput = String(result.content || '').trim() || String(result.reasoning || '').trim() || _streamFallback;
          if (!_hasAnyOutput) {
            if (this._emptyRespRetries < EMPTY_RESP_MAX_RETRY) {
              this._emptyRespRetries += 1;
              const delay = Math.min(8000, 500 * Math.pow(2, this._emptyRespRetries - 1));
              appendLog('agent', `[empty-resp] 模型返回完全空内容（content 与 reasoning 均空），退避重试 ${this._emptyRespRetries}/${EMPTY_RESP_MAX_RETRY} delay=${delay}ms model=${cfg.model || '?'}`);
              this.emit('notice', { text: `模型返回空响应，${(delay / 1000).toFixed(1)}s 后重试（${this._emptyRespRetries}/${EMPTY_RESP_MAX_RETRY}）…` });
              await this._sleep(delay);
              step--; // 重试本轮（与 native 降级分支同一重试模式）
              continue;
            }
            // 重试耗尽：明确报错终止，绝不静默收尾（用户「重试失败后给出明确报错」）
            appendLog('agent', `[empty-resp] 连续 ${EMPTY_RESP_MAX_RETRY} 次空响应，明确报错终止 model=${cfg.model || '?'}`);
            this.state = 'done';
            this.emit('notice', {
              text: `模型连续 ${EMPTY_RESP_MAX_RETRY} 次返回空响应，已停止。\n常见原因：1) 模型名不存在或已下架；2) API Key 无效/额度耗尽；3) 服务端不稳定。\n当前模型：${cfg.model || '未配置'}。可尝试切换模型，或稍后重试。`
            });
            break;
          }
          // ===== 有输出 → 走下面的 nudge（空轮）逻辑 =====
          // 1.1.14：拦截「声称已调用工具但实际无任何调用」的角色扮演式输出。
          // 网页接入（WebAI2API）模型在 1.1.14 函数样式容错之后，学会了连函数样式都不输出，
          // 直接用「我已使用 write_file 创建了…」「我成功调用了 list_dir」这类完成式叙述冒充执行。
          // 系统没收到任何可解析调用（既无 <foxtool> 也无 read_file("路径") 样式）→ 没有任何操作发生。
          // 这里回灌修正提示，迫使模型输出真实调用；限 2 次避免死循环。
          // 1.1.14：仅对 text 协议生效——native（原生 function calling）/chat 模型有原生工具通道或本就不带工具，
          // 正常回答里出现「请确认…」「我将执行…」属于普通对话，不应被这套文本兜底误拦。
          // 1.1.23：裸参数段保活（对齐 dsh 稳定性，治「新会话还会中断」的第二变体）。
          // STEP 修复后模型不再输出 STEP:，但长会话里仍会把工具参数「裸写」成
          // `command: "powershell -NoProfile ..."` / `argv: [...]` / `path: "..."` 这类
          // 键=值段落（没有 <foxtool> 外壳、没有 STEP: 前缀、不是完成式叙述、不是请求确认），
          // 四级 nudge 里 step/claim/ask 全不命中 → 空轮 → 静默 final = 用户看到的「还是断」。
          // 这里检测「参数键=值 + 已知工具名出现在可疑上下文」的裸参数段，回灌修正提示，限 2 次。
          const needGuide = !this._toolGuideFetched && this.cfg && this.cfg.meta && this.cfg.meta.textOnly
            && (this.cfg.toolGuideMode === 'on' || this.cfg.toolGuideMode === 'auto');
          if (needGuide && (this._guideNudges || 0) < 2) {
            this._guideNudges = (this._guideNudges || 0) + 1;
            this._ev(agentEvents.EV.GUIDE_NUDGE, { count: this._guideNudges });
            // 首轮精简：模型第一轮往往只会输出一大段"分析/方案"而没有任何工具调用——这段对任务
            // 无价值还占历史。直接移除该轮 assistant 消息，让下一轮从「请先调用 get_tools」的
            // 系统提示干净开始，省掉一问一答的浪费轮次（1.1.14）。
            if (step === 0) {
              for (let i = this.messages.length - 1; i >= 0; i--) {
                const mm = this.messages[i];
                if (mm && mm.role === 'assistant') { this.messages.splice(i, 1); break; }
              }
            }
            this.messages.push({
              role: 'user',
              content: `[系统] 本任务的第一步必须先调用 get_tools 获取可用工具清单（这是固定格式要求）。你刚才没有输出任何工具调用。请立即只输出下面这一个工具调用块，不要附加任何解释：\n\n${tools.wrapToolCall('get_tools', '{}')}`
            });
            this.emit('notice', { text: `已强制模型先调用 get_tools 获取工具清单（第 ${this._guideNudges}/2 次）` });
            appendLog('agent', `[guide-nudge] textOnly 首轮未调 get_tools，强制回灌 (${this._guideNudges}/2)`);
            continue;
          }
          // 1.1.14：拦截「只说不做 + 请求确认」——模型输出方案/征求确认（"请确认是否执行""确认后我将写入"）
          // 却没有输出任何工具调用。回灌"直接执行"提示，限 2 次避免死循环。
          // 1.1.14：仅 text 协议生效，native/chat 不误拦（理由同上）。
          // ★ 统一空轮契约（减法重构）：解析器只认标准 <foxtool> 块（保留 JSON/截断格式容错）。
          //   模型本轮没产出合法调用块——无论写的是计划文 / 裸参数段 / STEP 占位 / 声称已调用 / 请求确认，
          //   都走同一条路：有可见文本先当普通回复展示（绝不静默）→ 连续空轮计数 +1 → 回灌统一提示 → 连续 2 轮收尾。
          // 1.1.32 修复：native 协议下「输出正文但不调工具」= 模型已完成任务/纯聊天给出答案
          //（原生 function calling 用「不调工具」表达结束）。已执行过工具、或本就是纯闲聊时，
          // 直接收尾，不 nudge 强制继续调工具——否则模型被反复 nudge 反复调工具，正文糊成一团
          // + 审批「已允许」刷屏（safe_operation 问一次「工作区有什么」输出 5 段正文的根因）。
          // 首轮既没调工具、也非闲聊的「空话」仍走 nudge/降级 text 兜底（治「该调工具却不调」）。
          const _nativeAnswerDone = this.protocol === 'native' && !this._nativeDowngraded
            && String(result.content || '').trim()
            && (this.messages.some((m) => m && m.role === 'tool') || isChatter(queryText));
          this._emptyStreak = (_nativeAnswerDone ? EMPTY_TURN_MAX : ((this._emptyStreak || 0) + 1));
          this._ev(agentEvents.EV.EMPTY_TURN, { streak: this._emptyStreak });
          appendLog('agent', `[empty-turn] 本轮无合法工具调用块（连续 ${this._emptyStreak} 轮）${this._emptyStreak >= EMPTY_TURN_MAX ? '，达到上限直接收尾' : `，分级 nudge 第 ${this._emptyStreak} 次`}`);
          if (this._emptyStreak >= EMPTY_TURN_MAX) {
            // 1.1.26 自适应协议降级（用户「每个厂商都要看官方文档进行适配」）：
            // 官方资料实证——DeepSeek 系列「工具调用能力相对较弱，不建议用于 Tool Calling」，
            // 硅基流动官方 Claude Code 预设默认配的也是 Kimi-K2.6 而非 DeepSeek。
            // 日志实证：native 下 nativeCalls=0、连空 3 轮、强制 tool_choice=any 仍唤不起调用；
            // 而同一模型在 text 协议下（系统提示词强制教 <foxtool> 格式）反而能照做并成功调用。
            // 因此 native 空轮耗尽时不再直接收尾中断，而是降级 text 再给一轮机会。
            if (this.protocol === 'native' && !this._nativeDowngraded && this.toolsEnabled && !_nativeAnswerDone) {
              this._nativeDowngraded = true;
              this._forceText = true;
              this.protocol = 'text';
              this._emptyStreak = 0;
              this._forceToolChoice = false;
              baseSystem = buildSystemPrompt(cfg, envBrief, this.protocol) + (this._stableBlock ? '\n\n' + this._stableBlock : '');
              tools.setCustomTagMode(!!(this.cfg && this.cfg.meta && this.cfg.meta.textOnly));
              appendLog('agent', '[proto-downgrade] native 连续空轮耗尽（模型未产生任何 tool_calls）→ 自动降级 text 协议重试');
              this.emit('notice', { text: '模型在原生工具协议下未产生工具调用，已自动切换为文本协议继续（常见于工具调用能力较弱的模型）。', internal: true });
              continue;
            }
            appendLog('agent', `[empty-turn] 连续 ${EMPTY_TURN_MAX} 轮无合法工具调用，进入 final 收尾（不静默）`);
          } else {
const emptyGuide = this.protocol === 'text'
            ? '\n\n[系统] 你本轮没有输出合法的工具调用块，你的文字已作为普通回复展示。若任务还需继续，唯一可靠的执行方式是输出上面那种完整的工具调用块（<foxtool> 包裹合法 JSON，一次一次，写完立刻停止）；若你认为任务已完成，请直接给出最终结论即可。'
            : '';
            // 1.1.25：native 路径空轮时绝不回灌「输出文本工具块」的格式提示——
            // 原生 function calling 的工具调用来自 API 的 tool_calls 字段，模型输出纯文本即是合法回复，
            // 教 <foxtool>/[[tool:]] 格式只会与原生调用语义冲突（dsh 一轮完成的根因对照）。
            // 1.1.26 分级 nudge（用户「实现轻推机制，强制模型产生输出」）：
            //   第 1 次温和给格式；第 2 次明令禁止再写计划；第 3 次只准输出一个调用块。
            //   实测根因场景：模型说「参数解析失败，我用合法 JSON 重建」却只吐说明不吐调用块，
            //   旧版统一提示对它毫无压力，第 2 轮即被判死 → 会话中断。
            const sample = tools.wrapToolCall('工具名', '{"参数名": "参数值"}');
            let nudgeText;
            if (this.protocol !== 'text') {
              nudgeText = '[系统] 本轮你没有调用任何工具。若任务还需继续，请直接继续完成；若任务已完成，请给出最终结论。';
            } else if (this._emptyStreak === 1) {
              nudgeText = '[系统] 本轮没有检测到工具调用块。若你需调用工具，唯一可靠的格式是：' + sample + emptyGuide;
            } else if (this._emptyStreak === 2) {
              nudgeText = '[系统] 这是第 2 轮没有工具调用。请停止描述计划或解释——直接输出一个工具调用块：' + sample +
                '\n不要任何前言、分析与说明文字。若任务确实已完成，请直接给出最终结论。';
            } else {
              nudgeText = '[系统] 第 3 次提醒：立刻只输出一个工具调用块，形式为 ' + sample +
                ' 。不要输出分析、计划或说明。若你认为任务已完成，请直接给出最终结论并结束。';
            }
            // native 协议下「模型只叙述不调工具」的对症手段：下一轮强制 tool_choice，
            // 光靠文本提示压不住——模型会继续礼貌地描述计划而不发起调用。
            if (this.protocol === 'native') this._forceToolChoice = true;
            this.messages.push({ role: 'user', content: nudgeText });
            this.emit('notice', { text: `模型本轮未输出合法工具调用块（连续 ${this._emptyStreak}/${EMPTY_TURN_MAX} 轮），已分级回灌提示`, internal: true });
            continue;
          }

          // final 阶段：禁止再触发工具调用，把最终答案统一推送进主正文
          this._inFinalPhase = true;
          this._ev(agentEvents.EV.FINAL_PHASE, { streak: this._emptyStreak });
          this.state = 'done';
          if ((!visibleText || !String(visibleText).trim()) && !resultImages.length) {
            const modelHint = cfg.model ? `当前模型：${cfg.model}` : '当前模型名未配置';
            this.emit('notice', {
              text: `模型没有返回任何内容。${modelHint}。\n常见原因：1) 模型名不存在；2) API Key 无效；3) 该模型不支持 function calling。可尝试在设置里切换 foxAi.agent.toolProtocol（native/text/auto）。`
            });
          }

          // ---- 输出截断自动继续 ----
          const maxContinues = Math.max(0, Number(cfg.maxContinues) || 3);
          let willAutoContinue = shouldAutoContinue(result, cfg, this._continuesUsed);
          // 可见正文为空时分两种情况：
          // 1) 思考（reasoning）有内容但被截断 → 是「思考吃光输出预算、正文没空间」，应续跑补正文
          //    （续跑轮已关闭思考），否则任务卡死在原地；
          // 2) 思考也为空 → 模型真没返回任何东西，跳过续跑，避免白耗 3 次空转。
          const _reasoningOnly = !String(visibleText || '').trim() && !!String(result.reasoning || '').trim();
          if (willAutoContinue && !String(visibleText || '').trim() && !_reasoningOnly) {
            willAutoContinue = false;
            appendLog('agent', `[auto-continue-skip-empty] finishReason=${result.finishReason} 可见正文与思考均为空，跳过自动继续`);
          }
          if (willAutoContinue) {
            // 非推进检测：若本轮续写内容几乎全落在上一轮文本里，说明模型原地重复空转，
            // 提前停止自动续跑（不再白白耗光 3 次），明确提示用户手动处理。
            if (this._lastContinuedText && isStuckRepeat(this._lastContinuedText, visibleText)) {
              appendLog('agent', `[auto-continue-stuck] finishReason=${result.finishReason} 续写原地重复，提前停止`);
              this.emit('notice', { text: `自动续写检测到输出在原地重复、无法推进，已停止自动续跑。如需继续请手动发送「继续」，或检查是否已达到模型单次输出上限。` });
              willAutoContinue = false;
            } else {
              this._continuesUsed++;
              this._ev(agentEvents.EV.CONTINUE_USED, { count: this._continuesUsed });
              this._lastContinuedText = visibleText;
              appendLog('agent', `[auto-continue] finishReason=${result.finishReason} count=${this._continuesUsed}/${maxContinues} contentLen=${String(visibleText || '').length}`);
              this.emit('notice', { text: `模型输出达到长度上限，正在自动继续（${this._continuesUsed}/${maxContinues}）…` });
              // 静默插入 continue 提示：回传上一轮截断处的末尾原文，让模型从正确位置续写；
              // 不触发 UI 用户消息，只追加到历史供下次请求使用。
              // 正文空但思考被截断时，改为明确要求「直接输出最终答案」，避免模型接着思考又截断。
              const _contMsg = _reasoningOnly
                ? '你上一轮的思考过程因达到长度上限被截断，但还没输出最终答案。现在请直接输出完整的最终答案正文，不要再输出思考过程、不要调用任何工具。'
                : buildContinuePrompt(visibleText || String(result.reasoning || ''), {
                    // 1.1.18g：续轮锚定整体目标（DSH goal_round 中文本土化）——
                    // 取 planTaskText（当前任务清单）作目标上下文，让截断续写不脱离任务主线
                    goalText: planTaskText ? this.planTasks.renderForPrompt() : '',
                    round: this._continuesUsed + 1
                  });
              this.messages.push({ role: 'user', content: _contMsg });
              // 标记下一轮请求强制文本协议（不给工具），让模型只续写正文
              // 1.1.24 例外：半截工具块续写（buildContinuePrompt 已给出「补完工具块」提示）
              // 必须保留工具协议，否则模型被 _lenContinue 禁止输出工具 → 无法补闭合标签 →
              // 下一轮 parseTextCalls 依旧 count=0 → 空轮 ×2 → 会话中断（对齐 dsh 续轮收口）。
              const _halfTool = /<(fox:?tool|fox-tool|tool|function)\s+name\s*=\s*["'][^"']+["']\s*>[^]*$/i.test(visibleText || '')
                || /\[\[tool:[^\]]*\]\][^]*$/i.test(visibleText || '');
              if (!_halfTool) this._lenContinue = true;
              this._ev(agentEvents.EV.LEN_CONTINUE, { count: this._continuesUsed });
            }
          }
          const truncated = result.finishReason === 'length' || result.finishReason === 'incomplete';
          if (truncated && this._continuesUsed >= maxContinues) {
            appendLog('agent', `[auto-continue-limit] finishReason=${result.finishReason} reached max ${maxContinues}`);
            this.emit('notice', { text: `已自动继续 ${maxContinues} 次，输出仍被模型长度限制截断。如需继续，请手动发送「继续」。` });
          }

          // 最终答案统一使用同一个 finalMsgId；仅在第一次 final 时发 assistantStart
          if (!this._finalStarted) {
            this.emit('assistantStart', { channel: 'final', msg_id: this.finalMsgId });
            this._finalStarted = true;
            this._ev(agentEvents.EV.FINAL_STARTED, {});
          }
          // 最终答案的思考过程（深度思考）渲染进主气泡顶部的「已思考」折叠面板，
          // 与最终正文同属 final 通道：物理隔离于右侧工作链，但思考过程对用户可见。
          const finalReasoning = result.reasoning || this._thinkingBuffer.reasoning || '';
          if (finalReasoning && String(finalReasoning).trim()) {
            this.emit('reasoning', { text: finalReasoning, channel: 'final', msg_id: this.finalMsgId });
          }
          // 实时流式已在 onDelta 中逐字推送（含 DeepSeek reasoningGate 的延时内容：客户端
          // gate 会把缓冲正文按 20 字/16ms 重放完，onDelta 已覆盖全文）。因此只要实时流式发生过
          // （this._finalStreamed===true），就绝不再补发整段，否则最终正文会被原样追加两遍
          // （deepseek+responses 下 _reasoningGate 恒为 true，旧守卫 `!(_finalStreamed && !_reasoningGate)`
          // 会被恒置真而强制补发，正是正文重复两遍的根因）。
          if (visibleText && String(visibleText).trim() && !this._finalStreamed) {
            this.emit('text', { text: visibleText, channel: 'final', msg_id: this.finalMsgId });
            streamLog('endFlush FULL protocol=' + this.protocol + ' len=' + String(visibleText).length + ' (no live delta)');
          } else if (visibleText && String(visibleText).trim() && this._finalStreamed) {
            // 已实时推过：用「去空白前缀包含」判定是否真缺段（1.1.16 修正）。
            // 旧实现对长度敏感（pushed 只累计非空正文 vs visible 含空白全量）→ 恒差空白 →
            // TailFIX 每次误触发把后半段整体补发 → 用户看到「三分之一后一次性输出」。
            // 判定基准统一为「去空白正文」：pushedNoWs 与 visibleNoWs 都是非空白字符。
            //  - pushedNoWs 是 visibleNoWs 的前缀 → 流式已覆盖全部正文（只缺空白，无感知）→ 不补；
            //  - 不是前缀 → 中间真缺段 → 从「visible 中首个不匹配位置」补发剩余非空正文。
            const visibleNoWs = String(visibleText).replace(/\s+/g, '');
            const pushedNoWs = this._estDeltaPushChars || 0; // 非空口径（onDelta 按非空白累计）
            const streamedFull = this._finalStreamedText || '';
            if (pushedNoWs > 0 && visibleNoWs.startsWith(String(streamedFull).replace(/\s+/g, ''))) {
              // 前缀匹配：流式已覆盖正文全部（仅空白差异）→ 不补，绝不重复
            } else if (pushedNoWs > 0 && !visibleNoWs.startsWith(String(streamedFull).replace(/\s+/g, ''))) {
              // 真缺段：从头找「visibleNoWs 中 streamedNoWs 之后的部分」补发（去空白坐标，不重复）
              const streamedNoWs = String(streamedFull).replace(/\s+/g, '');
              const tail = visibleNoWs.slice(streamedNoWs.length);
              if (tail && String(tail).trim()) {
                this.emit('text', { text: tail, channel: 'final', msg_id: this.finalMsgId });
                streamLog('endFlush TAIL-FIX real-miss streamedNoWs=' + streamedNoWs.length +
                  ' visibleNoWs=' + visibleNoWs.length + ' tail=' + tail.length);
              }
            }
          }
          streamLog('endFlush protocol=' + this.protocol + ' type=' + (this.protocol === 'text' ? 'text' : 'native') +
            ' finalStreamed=' + !!this._finalStreamed + ' deltaCount=' + (this._streamDeltaCount || 0) +
            ' pushed=' + (this._estDeltaPushChars || 0) + ' visible=' + (visibleText ? String(visibleText).length : 0));
          for (const img of resultImages) {
            this.emit('image', { src: img.src, alt: img.alt || '模型生成图片', channel: 'final', msg_id: this.finalMsgId });
          }
          if (!willAutoContinue) {
            this.emit('assistantEnd', { channel: 'final', msg_id: this.finalMsgId, done: true });
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
            // 结构化记忆自动沉淀：规则式抽取用户的纠正 / 约定 / 偏好，零模型调用、不额外花钱
            this._harvestMemories();
            this.emit('step', { kind: 'done', title: '完成', status: 'ok' });
            // 任务完成：汇总本轮产物（创建/修改/删除的文件 + Token 用量）给用户一张成果卡片，可一键导出报告
            if (this._artifacts && this._artifacts.length) {
              const acc = _accCache(this.sessionId || this.conversationId);
              const sessionHitRate = acc.total > 0 ? Math.round((acc.cached / acc.total) * 100) : 0;
              this.emit('artifact', {
                files: this._artifacts.map((a) => ({ path: a.path, op: a.op, added: a.added || 0, removed: a.removed || 0 })),
                title: (this.task && this.task.title) || '',
                text: String(visibleText || ''),
                sessionHitRate,
                cachedTokens: acc.cached,
                promptTokens: acc.prompt,
                completionTokens: acc.completion
              });
            }
            return { finished: true, text: visibleText };
          }

          // 自动继续：继续下一轮，仍使用同一 finalMsgId
          continue;
        }

        // 存在工具调用：本轮属于 thinking，内容进工作链面板，不污染主正文
        this.emit('assistantStart', { channel: 'thinking', msg_id: this.thinkingMsgId });
        const turnReasoning = result.reasoning || this._thinkingBuffer.reasoning || '';
        if (turnReasoning && String(turnReasoning).trim()) {
          this.emit('reasoning', { text: turnReasoning, channel: 'thinking', msg_id: this.thinkingMsgId });
        }
        if (visibleText && String(visibleText).trim()) {
          this.emit('text', { text: visibleText, channel: 'thinking', msg_id: this.thinkingMsgId });
        }
        for (const img of resultImages) {
          this.emit('image', { src: img.src, alt: img.alt || '模型生成图片', channel: 'thinking', msg_id: this.thinkingMsgId });
        }
        this.emit('assistantEnd', { channel: 'thinking', msg_id: this.thinkingMsgId, done: false });

        // 逐个执行工具
        for (const call of calls) {
          await this.gate();
          await this.handleToolCall(call);
          if (this.cancelled) throw new Cancelled();
        }
        // 运行中检查点：每批工具执行完即通知 chatView debounce 落盘（Bug④ 重载恢复兜底）
        this.emit('checkpoint');

        // 循环护栏连续命中：本批工具结果全部落盘后再补一条强提醒，
        // 避免把 user 消息插进 tool 结果中间（Anthropic 的 tool_result 必须紧跟）。
        if (this._loopNudge) {
          this._loopNudge = false;
          this.messages.push({
            role: 'user',
            content: '[系统] 已多次检测到重复或环状的工具调用，说明当前思路在原地打转。请立刻停止这条链路：先用一段话总结「已知什么、还差什么、卡在哪」，然后要么用一个明显不同的新方案继续，要么直接给出结论并说明未完成的部分。禁止再用相同参数重试同一工具。'
          });
        }

        // 自动代码审查：本轮有代码写操作则在后台异步触发（不阻塞主代理最终回复，与主回复并行执行）
        if (this._pendingReview.length) {
          this._runCodeReview();
        }

        // 规划确认门（对齐 DSH goal-round-driver：计划即内部状态，不再停顿等用户）
        // present_plan/revise_plan 只把计划展示给用户看（面板可见），不设确认门。
        // 仅当用户显式开启 foxAi.planAndExecute.confirmGate 时才真正暂停等待确认。
        if (this._planPending) {
          const plan = this.planTasks ? this.planTasks.list() : [];
          this.emit('planPending', { plan, revised: !!this._planRevised, reason: this._planRevised });
          if (this.cfg.planAndExecute && this.cfg.planAndExecute.confirmGate) {
            if (this.task) {
              try { await this.taskManager.updateState(this.task.id, harness.TASK_STATES.AWAITING).catch(() => {}); } catch (_) {}
            }
            return { finished: false, reason: 'plan-pending', plan };
          }
          this._planPending = false; // 无确认门：计划已展示，直接继续执行
        }
      }

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
        this.emit('step', { kind: 'error', title: '已取消', status: 'error' });
        return { finished: false, reason: 'cancelled' };
      }
      // 额度/余额耗尽（含 402/403/429 限流）：自动终止并保留记忆，避免主模型报错后审查子代理再用同一 Key 空转
      // 也包括审查子代理在后台遇到的配额错误（_reviewQuotaError）。
      if (isQuotaError(err) || this._reviewQuotaError) {
        this.state = 'error';
        this._quotaExhausted = true;
        this.cancelled = true; // 让仍在后台的审查子代理（_silentCall / _runCodeReview）立即退出
        try { if (this._abortCtrl) this._abortCtrl.abort(); } catch (_) {}
        const qmsg = String((this._reviewQuotaError && this._reviewQuotaError.message) || (err && err.message) || err || '');
        this.emit('notice', {
          text: '⚠️ 模型额度/余额不足，已自动停止并保留本次对话：' + qmsg.split('\n')[0].slice(0, 160)
        });
        if (this.task) {
          try { await this.taskManager.updateState(this.task.id, harness.TASK_STATES.FAILED); } catch (_) {}
        }
        this.emit('step', { kind: 'error', title: '额度/余额不足', status: 'error' });
        throw new QuotaError(qmsg);
      }
      this.state = 'error';
      if (this.task) {
        try {
          await this.taskManager.appendStep(this.task.id, { kind: 'error', error: String(err && err.message) });
          await this.taskManager.updateState(this.task.id, harness.TASK_STATES.FAILED);
        } catch (_) {}
      }
      this.emit('step', { kind: 'error', title: '执行出错', status: 'error' });
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
  _reviewSummary(name, args, before, after) {
    const cut = (s, n) => (s == null ? '' : String(s).length > n ? String(s).slice(0, n) + `…（已截断，共 ${String(s).length} 字）` : String(s));
    const path = args.path || '';
    if (name === 'delete_file') {
      const scope = args.start_line ? ` 删除行 ${args.start_line}-${args.end_line || args.start_line}` : '';
      return `删除文件/范围：${path}${scope}`;
    }
    // 优先展示“文件真实改动”（before/after 取自磁盘），避免模型给错 old/new 参数时审查被误导
    if (before != null && after != null) {
      const stat = ws.diffStat(before, after);
      const scope = args.start_line ? `（限定行 ${args.start_line}-${args.end_line || args.start_line}）` : '';
      if (stat.added === 0 && stat.removed === 0) {
        return `修改 ${path}${scope}：实际未产生内容差异（无变化）。`;
      }
      // unifiedPreview 带 1 索引行号：删除行标原行号、新增行标新行号，错位处「原→新」，
      // 让审查/自检能直接看出「想让第 15 行变成 X、实际落到第 14/16 行」这类落点偏差。
      return `修改 ${path}${scope}（+${stat.added} -${stat.removed}）：\n${cut(ws.unifiedPreview(before, after), 1600)}`;
    }
    if (name === 'write_file') {
      return `整体写入 ${path}（共 ${String(args.content || '').length} 字）：${cut(args.content, 800)}`;
    }
    // 兜底：拿不到真实快照时，才回退到模型声明的参数
    const oldT = args.old_text ? cut(args.old_text, 400) : '';
    const newT = cut(args.new_text, 400);
    const scope = args.start_line ? `（限定行 ${args.start_line}-${args.end_line || args.start_line}）` : '';
    return `修改 ${path}${scope}：\n- 旧：${oldT}\n- 新：${newT}`;
  }

  /** 审查用 before 快照：读取文件当前磁盘内容（供命令行写文件 diff 对比） */
  async _reviewBeforeRead(path) {
    try {
      return await ws.readText(ws.resolveUri(path, { allowOutside: true }));
    } catch (_) {
      return null;
    }
  }

  /**
   * 1.1.19：检测「命令行写文件」类命令——run_command 被当绕过 edit_file/write_file 的替代通道时，
   * 用 shell 重定向/文本替换命令直接改文件。识别特征：
   *   - 输出重定向：> / >> 写文件（echo x > f、cat > f、printf > f、: > f 清空）
   *   - 原地编辑：sed -i、perl -pi、awk 重定向、tee f（覆盖）
   *   - 复制/移动覆盖：copy /y、cp -f 到工作区、mv 覆盖
   *   - Windows 空文件：type nul > f、copy nul f
   * 命中即视为「命令行改文件」，需记录 diff 并提示审查。
   */
  _isCmdFileWrite(cmd) {
    const c = String(cmd || '');
    if (!c) return false;
    // 排除明显的读/查命令
    if (/\b(cat|type|more|less|head|tail|grep|find|dir|ls)\b/.test(c) && !/[>|]\s*[\w\\/.\-]+\.\w{1,10}/.test(c)) {
      // 只有读命令且无重定向 → 不是写文件
      if (!/>>?\s*[\w\\/.\-]/.test(c)) return false;
    }
    // 输出重定向到 .文件（echo x > f.txt / cat > f / : > f）
    if (/>>?\s*["']?[\w\\/:.\-]+\.\w{1,10}["']?\s*$/.test(c)) return true;
    if (/>>?\s*["']?[\w\\/:.\-]+\.\w{1,10}["']?\s+&&/.test(c)) return true;
    // sed -i / perl -pi 原地编辑
    if (/\bsed\s+(-[a-z]*i[a-z]*)\b/.test(c)) return true;
    if (/\bperl\s+-[a-z]*pi[a-z]*\b/.test(c)) return true;
    if (/\bpython\s+(-c|-m)\b[\s\S]*\b(open\s*\(|\.write\s*\()/.test(c)) return true;
    // tee 覆盖写文件
    if (/\btee\b/.test(c) && /[\w\\/.\-]+\.\w{1,10}/.test(c)) return true;
    // cp -f / mv 覆盖工作区文件（排除明显系统路径）
    if (/\b(cp|move|mv|copy)\b[\s\S]*(\.\w{1,10})[\s\S]*(\.\w{1,10})/.test(c) &&
        !/\b(cp|mv|copy)\b[\s\S]*(\/usr\/|\/bin\/|system32|c:\\windows)/i.test(c)) return true;
    return false;
  }

  /** 不向 UI 推送的静默模型调用（用于审查子代理等内部请求） */
  async _silentCall(messages, opts) {
    opts = opts || {};
    if (this.cancelled) throw new Cancelled();
    const cfg = this.cfg;
    const b = selectBackend(cfg);
    const isReview = !!opts.review;
    // 点1（审查独立会话·方案C 隔离标签页）：审查走 WebAI2API 网页端时，首轮捎带 fox_isolate 信号，
    // 让远端「开临时标签页」跑审查——【不切换主会话标签页】，审完自动关闭临时页回到主会话。
    // 相比旧 fox_new_session（点「新对话」会把主页面切走、审完回不来，主对话上下文被污染），
    // 隔离标签页对所有模型网址通用（Worker 层实现，不依赖网页「新对话」按钮/侧边栏结构），
    // 且幂等：只给每次审查的第一轮带（审查只一轮，天然只发一次），主代理完全不受影响。
    const isWebText = !!(cfg.meta && cfg.meta.textOnly);
    const extraBody = {};
    // 幂等：同一次审查只发一次隔离信号（后续轮/复用不再开新页，避免重复开空标签页）
    if (isReview && isWebText && !this._reviewResetSent) {
      // fox_isolate=true → WebAI2API Worker 开临时标签页跑审查，主会话不动
      // 兼容保留 fox_new_session=false（明确告诉适配器不要点「新对话」切走主页面）
      extraBody.fox_isolate = true;
      extraBody.fox_new_session = false;
      this._reviewResetSent = true;
    }
    // ★ 1.1.19 审查新会话「两轮分离」（对齐样品.md）：
    // 审查走 WebAI2API 专用新会话时，第一轮只发「强制 get_tools」引导（不带审查问题），
    // 拿到工具清单回填后，第二轮才真正发审查 diff —— 与主对话首轮行为完全一致。
    // 幂等：_reviewGuideSent 只允许一次；审查只一轮，天然只补一次。
    if (isReview && isWebText && !this._reviewGuideSent) {
      this._reviewGuideSent = true;
      const guideMsg = {
        role: 'user',
        content: '[系统] 本会话的第一步必须先调用 get_tools 获取可用工具清单（这是固定格式要求）。请立即只输出下面这一个工具调用块，不要附加任何解释：\n\n' + tools.wrapToolCall('get_tools', '{}')
      };
      // 先发引导轮：审查问题暂不发出（留到引导完成后）
      const guideOnly = [guideMsg];
      try {
        const guideRes = await llmLimiter.run(() => b.nonStream({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.model,
          messages: guideOnly,
          temperature: cfg.temperature,
          maxTokens: isReview ? Math.min(cfg.maxTokens || 1024, 1024) : cfg.maxTokens,
          timeout: isReview ? Math.min(cfg.timeout || 60000, 60000) : cfg.timeout,
          insecureHttpParser: cfg.insecureHttpParser,
          streamFormat: cfg.streamFormat,
          extraBody,
          signal: this._abortCtrl ? this._abortCtrl.signal : undefined
        }));
        const guideText = (guideRes && (guideRes.content != null ? guideRes.content : guideRes.text)) || '';
        // 解析 get_tools 工具块：成功则执行并回填「[工具 get_tools 的结果]」，让第二轮的审查消息带上工具清单
        // ★ 与主循环三步引导同款修复：必须用 parseTextCalls（内部先 normalizeToolTags）——
        // 模型常输出自定义符号 [[tool:get_tools]]{}[[/tool]]，TOOL_BLOCK 只认 <fox:tool> XML 格式
        // 会解析失败 → 审查拿不到工具清单。
        const gCalls = parseTextCalls(String(guideText), this._toolNameSet());
        const gCall = gCalls && gCalls.find((c) => String(c.name).toLowerCase() === 'get_tools');
        if (gCall) {
          let args = {};
          try { args = JSON.parse(gCall.rawArgs || '{}'); } catch (_) {}
          const out = await tools.execute('get_tools', args, { token: this.token, toolName: 'get_tools' });
          // 存到独立字段，不污染主代理历史 this.messages；由下方合并进真正的审查消息流
          this._reviewGuideResult = `[工具 get_tools 的结果]\n${out}\n\n请根据结果继续，或给出最终回答。`;
          this._toolGuideFetched = true;
          this._ev(agentEvents.EV.TOOL_GUIDE_FETCHED, {});
        }
      } catch (_) {
        // 引导轮失败不影响审查主体：直接进入下方正常审查流程（审查消息仍会发出）
      }
      // 引导完成后，把 get_tools 结果并进审查消息（插到审查 user 之前），
      // 真正的审查请求同一条消息流里带上工具清单，模型拿清单再审。
      if (this._reviewGuideResult) {
        const merged = [];
        let userIdx = -1;
        for (let i = 0; i < messages.length; i++) {
          if (messages[i] && messages[i].role === 'user') { userIdx = i; break; }
        }
        const guideResult = { role: 'user', content: this._reviewGuideResult };
        if (userIdx >= 0) {
          for (let i = 0; i < userIdx; i++) merged.push(messages[i]);
          merged.push(guideResult);
          for (let i = userIdx; i < messages.length; i++) merged.push(messages[i]);
        } else {
          merged.push(guideResult);
          merged.push(...messages);
        }
        messages = merged;
      }
    }
    return llmLimiter.run(() => b.nonStream({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      messages,
      temperature: cfg.temperature,
      // 审查子代理：缩短输出与等待上限，显著提升响应速度（不拖慢主代理）
      maxTokens: isReview ? Math.min(cfg.maxTokens || 1024, 1024) : cfg.maxTokens,
      timeout: isReview ? Math.min(cfg.timeout || 60000, 60000) : cfg.timeout,
      insecureHttpParser: cfg.insecureHttpParser,
      streamFormat: cfg.streamFormat,
      extraBody,
      signal: this._abortCtrl ? this._abortCtrl.signal : undefined
    }));
  }

  /**
   * 调用“任意候选模型”（Best-of-N 多模型对比用）。与 _silentCall 不同，这里走候选自己的
   * provider/model/baseUrl/apiKey，而不是当前会话的主模型。复用 selectBackend + llmLimiter，
   * 确保并发受全局 LLM 信号量约束，不堆内存。返回 { ok, text, error }。
   */
  async callCandidate(c, req) {
    if (this.cancelled) throw new Cancelled();
    const transport = (c && c.transport) || 'openai';
    const messages = [];
    if (req && req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: (req && req.prompt) ? req.prompt : '' });
    const baseUrl = c.baseUrl || this.cfg.baseUrl;
    const apiKey = c.apiKey || this.cfg.apiKey;
    const model = c.model || this.cfg.model;
    const temperature = (req && typeof req.temperature === 'number') ? req.temperature
      : (c.temperature != null ? c.temperature : this.cfg.temperature);
    const maxTokens = Math.min(this.cfg.maxTokens || 4096, 4096);
    const timeout = Math.min(this.cfg.timeout || 120000, 120000);
    const doCall = transport === 'anthropic'
      ? () => anthropic.chatNonStream({ baseUrl, apiKey, model, messages, temperature, maxTokens, timeout, insecureHttpParser: this.cfg.insecureHttpParser })
      : () => chatNonStream({ baseUrl, apiKey, model, messages, temperature, maxTokens, timeout, insecureHttpParser: this.cfg.insecureHttpParser });
    const r = await llmLimiter.run(doCall);
    const text = (r && (r.content != null ? r.content : r.text)) || '';
    return { ok: !!(r && !r.error) && !!text, text, error: (r && r.error) ? r.error : '' };
  }

  /** 自动代码审查：本轮有代码写操作后触发一次只读审查子代理（后台异步，不阻塞主代理回复） */
  _runCodeReview() {
    if (this.cancelled) { this._reviewing = false; return; }
    if (this._reviewing) return; // 正在跑：新改动累积在 _pendingReview，本轮结束会自动再触发一次（合并审查）
    const changed = this._pendingReview;
    if (!changed.length) return;
    this._pendingReview = [];
    if (!this.cfg.review || !this.cfg.review.enabled) return;

    this._reviewConsumed = false; // 新的一次审查，结果尚未被消费/emit
    this._reviewId = 'review-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const promise = this._doReview(changed);
    this._reviewPromise = promise;
    promise.then(
      () => { if (this._reviewPromise === promise) this._reviewPromise = null; },
      () => { if (this._reviewPromise === promise) this._reviewPromise = null; }
    );
    return promise;
  }

  async _doReview(changed) {
    this._reviewing = true;
    let result = null;
    try {
      if (this.cancelled) return null;
      // 1.1.27：整轮只发一次「正在检查」，避免多次合并审查刷屏
      if (!this._reviewNoticeSent) {
        this._reviewNoticeSent = true;
        this.emit('notice', { text: '🔍 审查子代理正在检查本次改动…', internal: true });
      }
      const { ok, text } = await reviewer.runReview({
        silentCall: (m) => this._silentCall(m, { review: true }),
        cfg: this.cfg,
        changed
      });
      if (this.cancelled) return null;
      const reviewText = (text && String(text).trim()) || '';
      if (ok && reviewText) {
        result = { files: changed.map((c) => c.path).filter(Boolean), text: reviewText };
        this._reviewResult = result;
      } else {
        // 1.1.27：仅当本轮尚未出现过任何审查意见、且这是最后一轮合并审查时才提示「未返回额外意见」，避免刷屏
        if (!this._reviewHadOpinion && this._pendingReview.length === 0) {
          this.emit('notice', { text: '（审查子代理未返回额外意见）', internal: true });
        }
      }
    } catch (e) {
      // 用户取消 / 请求被中止：直接退出，不再把“失败”当成需回应的审查意见
      if (this.cancelled || e instanceof Cancelled || /请求已取消|abort/i.test(String((e && e.message) || ''))) {
        return null;
      }
      // 配额耗尽：记录到 _reviewQuotaError 并取消主任务，由 run() catch 统一处理自动终止 + 保留记忆
      if (e && e.isQuota) {
        this._reviewQuotaError = e;
        this.cancel();
        this.emit('notice', { text: '⚠️ 模型额度/余额不足，已自动停止审查子代理。', internal: true });
        return null;
      }
      this.emit('notice', { text: '自动代码审查失败：' + String((e && e.message) || e).split('\n')[0], internal: true });
    } finally {
      // 先保存结果并 emit（如果还没被 _awaitReview 消费），再触发下一次审查，
      // 避免 finally 内启动的新审查抢占 _reviewConsumed 导致本次卡片漏发。
      if (result) {
        result.id = this._reviewId;
        this._reviewResult = result;
        this._reviewHadOpinion = true; // 本轮已出现过审查意见，不再提示「未返回额外意见」
        if (!this._reviewConsumed) {
          this._reviewConsumed = true;
          this.emit('review', result);
        }
      }
      this._reviewing = false;
      // 审查期间可能又有新改动累积，自动再触发一次（合并多次改动只审一遍批次，避免并发重入）
      if (!this.cancelled && this._pendingReview.length) {
        this._runCodeReview().catch(() => {});
      }
    }
    return result;
  }

  /** 限时等待当前审查子代理结果；若等到了非空结果，标记为已注入并 emit review 卡片 */
  async _awaitReview(ms) {
    // 审查已经完成且结果还在：直接注入，不重复阻塞。
    if (this._reviewResult && this._reviewResult.text && !this._reviewInjected) {
      this._reviewInjected = true;
      if (!this._reviewConsumed) {
        this._reviewConsumed = true;
        this._reviewResult.id = this._reviewId;
        this.emit('review', this._reviewResult);
      }
      return this._reviewResult;
    }
    if (!this._reviewPromise) return null;
    const p = this._reviewPromise;
    const timer = new Promise((resolve) => setTimeout(resolve, ms));
    const winner = await Promise.race([p.catch(() => null), timer]);
    if (winner && winner.text && !this._reviewInjected) {
      this._reviewInjected = true;
      if (!this._reviewConsumed) {
        this._reviewConsumed = true;
        winner.id = this._reviewId;
        this.emit('review', winner);
      }
      return winner;
    }
    return null;
  }

  /** 发送前清洗历史：图片按模型能力降级 / 老图片丢弃 */
  async prepareHistory() {
    const cfg = this.cfg;
    const history = this.trimHistory();
    // 本地弱模型辅助模式（1.1.17）：上下文窗口一长，弱模型注意力严重分散。
    // 只保留最近 N 轮对话（默认 2 轮），其余截断，显著降低噪声。
    let trimmedHistory = history;
    if (this._weakLocal && cfg.weakHistoryRounds) {
      const keep = Math.max(2, Number(cfg.weakHistoryRounds) * 2);
      if (history.length > keep) trimmedHistory = history.slice(-keep);
    }
    const vision = caps.supportsVision(cfg.model, cfg.visionMode, {
      visionModels: cfg.visionModels,
      textOnlyModels: cfg.textOnlyModels
    });
    this._visionUsed = vision;
    let messages = trimmedHistory;
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

  /**
   * 把「动态附录」（知识库/记忆/技能/任务/模式/根规则/项目结构/时间/审查）追加到历史里
   * 「最后一条 user 消息（即当前轮提问）」的【尾部】，而不是写进 system、也不插在头部。
   * 这样 system 前缀始终固定、可缓存；动态内容位于请求末尾、随轮自然 append-only，不污染静态前缀。
   * 关键点：用哨兵【狐狸AI·动态上下文】检测「是否已含附录」，多步循环/跨轮绝不重复叠加；
   * 源 this.messages 与下发副本都只注入一次，保证冻结历史与下发逐字节一致，跨轮前缀才能命中。
   * @param {Array} history prepareHistory() 返回的（已 sanitize 的）消息数组
   * @param {string} appendix 已用 '\n\n' 拼接好的动态内容；为空则不动
   */
  /**
   * 把「动态附录」（知识库/记忆/技能/任务/模式/根规则/项目结构/时间/审查/锚点）注入到历史里
   * 「最后一条 user 消息（即当前轮提问）」的前面，而不是写进 system。
   * 这样 system 前缀始终固定、可缓存；动态内容位于请求尾部、随轮自然 append-only，不污染静态前缀。
   * 关键点：深拷贝最后一条 user 消息再改，绝不改动 this.messages 共享历史（否则跨轮会累积重复）。
   *
   * 【跨轮前缀缓存一致性（1.1.16）】：仅把附录塞进「本次下发的副本」会导致冻结历史里的同一 user
   * 消息是裸的（无附录），而下发时带附录 → 下一轮前缀在 user 边界处对不上、缓存从 user 起断裂，
   * 命中率被卡在 70%+。因此这里额外把附录「烤进」this.messages 的源 user 消息：一旦烤过即视为已带
   * 附录，用内容前缀检测防多步循环重复叠加；下一轮该消息以「带附录」形态进入历史，前缀与本轮下发
   * 完全一致 → 整段历史都能命中前缀缓存（命中率冲 98%+）。
   */

  // 附录用固定哨兵包裹，便于可靠检测「该 user 消息是否已含附录」，
  // 彻底摆脱对自定义属性的依赖（prepareHistory 链路可能丢属性）。
  // 必须追加到 user 消息【尾部】：官方规则要求易变内容后置，且缓存单元在
  // 用户输入末尾落盘——只有尾部字节稳定，跨轮前缀才能命中。
  // mark 决定用哪套哨兵：DYN_MARK（易变块，每轮重注）/ STABLE_MARK（稳定块，首轮注入一次）。
  _wrapAppendix(a, mark) {
    const m = mark || DYN_MARK;
    // 注意：块本身不带前导 \n\n，分隔符由 _applyAppendix 在「首次追加」时补、原地替换时不补
    return '【' + m + '】\n' + a + '\n【' + m + '·完】';
  }
  _hasMark(m, mark) {
    const MARK = '【' + (mark || DYN_MARK) + '】';
    if (!m || m.content == null) return false;
    if (Array.isArray(m.content)) {
      return m.content.some((c) => c && c.type === 'text' && typeof c.text === 'string' && c.text.includes(MARK));
    }
    return typeof m.content === 'string' && m.content.includes(MARK);
  }

  /**
   * 把附录块（哨兵包裹）合并进一条消息的 content：
   * 已含同 mark 块则【替换】其内容为最新（覆盖降级重算/多步刷新场景），否则【追加】到尾部。
   * 多模态（content 为数组）时操作最后一个文本块。保证幂等且永不重复叠加。
   */
  _applyAppendix(content, appendix, mark) {
    const block = this._wrapAppendix(appendix, mark);
    const MARK_OPEN = '【' + mark + '】';
    const MARK_CLOSE = '【' + mark + '·完】';
    if (Array.isArray(content)) {
      let idx = -1;
      for (let i = content.length - 1; i >= 0; i--) {
        const c = content[i];
        if (c && c.type === 'text' && typeof c.text === 'string' && c.text.includes(MARK_OPEN)) { idx = i; break; }
      }
      if (idx >= 0) {
        const other = content.filter((_, i) => i !== idx);
        return other.concat([{ type: 'text', text: block }]);
      }
      return content.concat([{ type: 'text', text: block }]);
    }
    if (typeof content === 'string') {
      // 已含同 mark 块 → 仅原地替换【mark】…【mark·完】子串（块不含前导 \n\n，块前分隔已存在），保证幂等
      const start = content.indexOf(MARK_OPEN);
      if (start >= 0) {
        const end = content.indexOf(MARK_CLOSE, start);
        if (end >= 0) return content.slice(0, start) + block + content.slice(end + MARK_CLOSE.length);
      }
      // 首次追加：补 \n\n 分隔符
      return content + '\n\n' + block;
    }
    return (content == null ? '' : String(content)) + '\n\n' + block;
  }

  _injectDynamicAppendix(history, appendix, mark) {
    if (!appendix || !history || !history.length) return;
    // textOnly（WebAI2API）：会话级防重复——同内容动态块本会话只发一次，避免网页对话历史里
    // 动态块（深度思考/长期记忆/项目约定等）每轮重复累积（网页模拟点击会把整段历史重新粘贴）。
    // 关键认知：WebAI2API 网页自带会话历史——之前注入的块模型始终能在历史里看到，
    // 所以同内容块【直接不注入】即可，不需要"检查历史是否已有再决定补不补"（text 协议不烤回源，
    // this.messages 里根本没有块，任何历史检查都会误判"没有"→重复注入；工具结果也是 user 角色，
    // 每条新 user 都会成为"最后一条"→ 块跟着每条工具结果重复出现，正是日志里看到的现象）。
    // 普通 API 不启用：前缀缓存红利下每轮替换语义本身不重复，且烤回源依赖该语义。
    const isWebText = !!(this.cfg && this.cfg.meta && this.cfg.meta.textOnly);
    if (isWebText && this._webBlockCache && this._webBlockCache.has(mark)) {
      const sent = this._webBlockCache.get(mark);
      const curFp = _contentFingerprint(appendix);
      if (sent.fp === curFp) {
        // 内容没变：本会话已发过同内容块 → 本轮【直接不注入】（网页历史里有，模型能看到）
        return;
      }
      // 内容变了：更新指纹，正常追加（_applyAppendix 替换语义保证同 mark 不叠加）
      this._webBlockCache.set(mark, { fp: curFp });
    } else if (isWebText && this._webBlockCache && !this._webBlockCache.has(mark)) {
      this._webBlockCache.set(mark, { fp: _contentFingerprint(appendix) });
    }
    // 找最后一条 user 角色消息（当前轮提问）。工具结果用 role:'tool'，不会误判。
    let idx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i] && history[i].role === 'user') { idx = i; break; }
    }
    if (idx < 0) {
      // 兜底：历史里没有 user 消息，直接追加一条承载附录（哨兵包裹）
      history.push({ role: 'user', content: this._wrapAppendix(appendix, mark) });
      return;
    }
    const m = history[idx];
    const clone = Object.assign({}, m);
    // 同 mark 块存在则【替换】为最新（降级重算后内容变化也能对齐），否则追加；绝不重复叠加。
    clone.content = this._applyAppendix(m.content, appendix, mark);
    history[idx] = clone;
  }

  /** 把附录烤进 this.messages 里最后一条 user 源消息，使冻结历史与下发逐字节一致（同 mark 块替换语义） */
  _bakeAppendixIntoSource(appendix, mark) {
    if (!this.messages || !this.messages.length) return;
    let oi = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i] && this.messages[i].role === 'user') { oi = i; break; }
    }
    if (oi < 0) return;
    const om = this.messages[oi];
    this.messages[oi] = Object.assign({}, om, { content: this._applyAppendix(om.content, appendix, mark) });
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
    const r = await llmLimiter.run(async () => {
      if (v.transport === 'anthropic') return anthropic.chatNonStream(opts);
      if (v.apiMode === 'responses') return chatNonStreamResponses(opts);
      return chatNonStream(opts);
    });
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

  /**
   * 服务端不认识深度思考参数（reasoning_effort / enable_thinking / thinking …）时，
   * 去掉思考参数用非流式重试一次，避免因为一个可选参数把整轮对话打死。
   */
  async retryWithoutReasoning(err, options) {
    if (this._noReasoningRetried) return null;
    if (!options || !options.extraBody) return null;
    if (!reasoning.looksLikeReasoningRejection(err)) return null;

    this._noReasoningRetried = true;
    console.log('[fox-ai] server rejected reasoning params, retry without them:', err && err.message);
    this.emit('notice', { text: '当前模型不接受深度思考参数，已自动去掉思考参数重试一次。（可在设置里关闭 foxAi.deepThinking.enabled）' });

    const eb = Object.assign({}, options.extraBody);
    for (const k of ['reasoning', 'reasoning_effort', 'enable_thinking', 'thinking_budget', 'thinking']) delete eb[k];
    const opt2 = Object.assign({}, options);
    if (Object.keys(eb).length) opt2.extraBody = eb; else delete opt2.extraBody;
    try {
      const b = selectBackend(this.cfg);
      return await b.nonStream(opt2);
    } catch (_) {
      return null;
    }
  }

  /**
   * 本地模型（llama.cpp / Ollama / LM Studio 等）对带 tools / stop 的请求直接返回空时，
   * 再尝试一次不带任何工具参数的纯对话调用。很多本地 GGUF（尤其社区量化/合并版）
   * 不支持 function calling，甚至对 stop sequence 都会沉默；在 llamaserve 里能聊是
   * 因为那里走的是纯 chat。这里的兜底让它在狐狸 AI 里至少能文字回复。
   */
  async retryWithoutGrammar(err, options) {
    if (this._grammarStripped) return null;
    if (!options || !options.extraBody || options.extraBody.grammar === undefined) return null;
    const msg = String((err && err.message) || '');
    // 服务端不认 grammar / guided / response_format / json_schema，或返回 400 / Bad Request
    if (!/grammar|guided|response_format|json_schema|400|bad request|invalid.*param/i.test(msg)) return null;

    this._grammarStripped = true;
    const eb = Object.assign({}, options.extraBody);
    delete eb.grammar;
    const opt2 = Object.assign({}, options);
    if (Object.keys(eb).length) opt2.extraBody = eb; else delete opt2.extraBody;
    this.emit('notice', { text: '当前本地模型服务端不支持 grammar 约束解码，已自动关闭该选项重试（不影响其它弱模型优化）。' });
    console.log('[fox-ai] retryWithoutGrammar: dropped grammar, retrying', msg.slice(0, 100));
    try {
      const b = selectBackend(this.cfg);
      if (this.cfg.forceNonStream || this.streamBroken) {
        return await this.fallbackIfLocalEmpty(await b.nonStream(opt2), opt2);
      }
      const { promise, handle } = b.responses ? wrapStream(opt2, streamResponses) : b.once(opt2);
      this.stream = handle;
      return await this.fallbackIfLocalEmpty(await promise, opt2);
    } catch (_) {
      return null;
    }
  }

  /** 可取消等待（对齐 dsh llm-retry cancellableDelay）——薄壳，实现在 netRetry.js */
  async _sleep(ms) {
    const netRetry = require('./netRetry');
    if (this.cancelled) return false;
    return netRetry.sleep(ms, this._abortCtrl);
  }

  /** 网络错误指数退避（对齐 dsh retryPolicy）——薄壳，实现在 netRetry.js */
  _networkRetryDelay(attempt, retryAfterMs) {
    return require('./netRetry').networkRetryDelay(attempt, retryAfterMs);
  }

  /** 是否网络类错误——薄壳，实现在 netRetry.js */
  _isNetworkError(err) {
    return require('./netRetry').isNetworkError(err);
  }

  /**
   * 网络错误指数退避重试（对齐 dsh llm-retry）：限流/超时/断连/5xx 时按 retryPolicy 退避重试。
   * @param {Function} fn 发起请求的函数（每次重试重新调用）
   * @param {number} maxRetries 最大重试次数（默认 3）
   * @returns 成功结果；全部失败则抛最后一次错误
   */
  async _withNetworkRetry(fn, maxRetries) {
    const max = maxRetries === undefined ? 3 : maxRetries;
    let lastErr = null;
    for (let attempt = 1; attempt <= max + 1; attempt++) {
      if (this.cancelled) throw lastErr || new Error('请求已取消');
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt > max || !this._isNetworkError(err)) throw err;
        const delay = this._networkRetryDelay(attempt, err && err.retryAfterMs);
        this.emit('notice', { text: `网络/限流错误（${err.code || err.message}），${delay}ms 后重试（${attempt}/${max}）…` });
        // 1.1.25 修复：appendLog 必须 require('./log') 引入——之前裸调用漏 import，
        // 网络重试真正耗尽（持续 5xx）时 ReferenceError → 任务直接崩溃而非正常失败收尾。
        require('./log').appendLog('agent', `[net-retry] attempt=${attempt}/${max} delay=${delay}ms code=${err.code || '?'} msg=${String(err.message || '').slice(0, 100)}`);
        const ok = await this._sleep(delay);
        if (!ok) throw err; // 用户取消
      }
    }
    throw lastErr;
  }

  /**
   * 判断本次是否应向本地弱模型注入 grammar 约束解码。
   * 三态（由 foxAi.agent.localConstrainedDecoding 控制）：
   *   - 'off' / false：永不注入、不探测；
   *   - 'force' / true：强制注入、不探测（靠运行时 rejection 兜底）；
   *   - 'auto'（默认）：先探测服务端是否支持 grammar，支持才注入，否则跳过（绝不卡死）。
   * 探测结论按 baseUrl 缓存，整个扩展进程内同端点只探一次；本会话再存到 this._grammarCap
   * 避免重复探测。探测异常一律「保守跳过」，绝不因探测把对话卡住。
   * @param {object} cfg
   * @returns {Promise<boolean>}
   */
  async _grammarAllowed(cfg) {
    const mode = grammarProbe.grammarMode(cfg.localConstrainedDecoding);
    if (mode === 'off') return false;
    if (mode === 'force') return true;
    // auto：需要探测
    if (this._grammarCap === null) {
      try {
        const cap = await grammarProbe.grammarSupported({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.model,
          timeout: grammarProbe.PROBE_TIMEOUT
        });
        this._grammarCap = cap;
        if (!cap.supported) {
          this.emit('notice', {
            text: '本地服务端不支持 grammar 约束解码（探测：' + (cap.reason || 'unsupported') +
              '），弱模型模式已跳过该选项（工具检索/闭环校验/锚点等优化仍生效）。'
          });
        }
        console.log('[fox-ai] grammar probe:', JSON.stringify(cap));
      } catch (e) {
        // 探测本身异常：保守跳过，不卡对话
        this._grammarCap = { supported: false, source: 'error', reason: String((e && e.message) || '').slice(0, 120) };
      }
    }
    return !!(this._grammarCap && this._grammarCap.supported);
  }

  async fallbackIfLocalEmpty(result, options) {
    if (!result || !result.empty) return result;
    const cfg = this.cfg;
    if (!cfg.meta || !cfg.meta.local) return result;
    if (this._localEmptyFallbackDone) return result;
    this._localEmptyFallbackDone = true;

    this.emit('notice', { text: `本地模型「${cfg.model || 'unknown'}」对工具调用无响应，尝试以纯对话模式返回一次…` });
    const opt2 = Object.assign({}, options);
    delete opt2.tools;
    delete opt2.toolChoice;
    delete opt2.stop;
    delete opt2.stopMarker;
    // 本地模型用非流式更稳，避免流式解析再卡一轮
    try {
      const b = selectBackend(cfg);
      const r = await b.nonStream(opt2);
      if (r && !r.empty) {
        console.log('[fox-ai] local empty fallback succeeded, contentLen=', (r.content || '').length);
        return Object.assign({}, r, { _localFallback: true });
      }
    } catch (e) {
      console.log('[fox-ai] local empty fallback also failed:', e && e.message);
    }
    return result;
  }

  /**
   * 在单个端点上发起一次模型请求（含既有的「参数级降级」兜底：去 grammar / 去图 / 去思考 / 非流式）。
   * 与旧 callModel 的两段请求逻辑等价，但端点（baseUrl/apiKey/model）由 targetCfg 决定，
   * 从而支持 failover 切到备用模型。isPrimary=false 时去掉 grammar（不假设备用模型支持约束解码，避免卡死）。
   * @param {object} options 已构建好的请求选项（含 messages/tools/extraBody 等）
   * @param {object} targetCfg 端点配置：必须含 baseUrl/apiKey/model，以及 selectBackend 需要的 transport/apiMode
   * @param {boolean} forceNonStream 是否强制非流式
   * @param {boolean} isPrimary 是否主模型（决定是否保留已注入的 grammar）
   */
  async _requestEndpoint(options, targetCfg, forceNonStream, isPrimary) {
    const opt = Object.assign({}, options, {
      baseUrl: targetCfg.baseUrl,
      apiKey: targetCfg.apiKey,
      model: targetCfg.model
    });
    // 原生联网（Responses 的 web_search_call）结果含真实 URL：透传给前端 harvest，
    // 让模型回复里的 [^n] 引用角标补全成可点击链接（本地 web_search 工具走 toolUpdate 已覆盖）。
    opt.onSearchResults = (text) => this.emit('searchSources', { text });
    // 会话标识：conversationId 仅作内部标识传递，不注入 HTTP 头
    //（stateless API 的上下文缓存按请求前缀内容自动匹配，不依赖 conversation id）。
    opt.conversationId = this.conversationId;
    // 缓存命中监控：usage 回调里抽取命中率并检测前缀漂移。
    opt.onUsage = (usage) => this._onCacheUsage(usage);
    // 计算本轮请求前缀指纹（system 内容 + 工具定义），用于检测前缀漂移导致整段缓存失效。
    const sysMsg = (Array.isArray(opt.messages) && opt.messages[0] && opt.messages[0].role === 'system') ? opt.messages[0].content : '';
    const prefixStr = (typeof sysMsg === 'string' ? sysMsg : JSON.stringify(sysMsg)) + '\u0000' + JSON.stringify(opt.tools || []);
    this._cachePrefixHash = crypto.createHash('sha256').update(prefixStr).digest('hex').slice(0, 16);
    // —— 前缀缓存「强制保留本会话缓存副本」指令（按厂商）——
    // 只把官方支持的缓存指令（OpenRouter 请求头 / OpenAI gpt-5.6+ 请求体）随请求发出；
    // 其余厂商走稳定前缀自动命中。指令随 opt 透传给传输层（client.js）并入请求头/体。
    if (this.cfg && this.cfg.cacheControl && this.cfg.cacheControl.enabled !== false) {
      opt.cacheControl = cacheControl.getCacheDirective({
        transport: targetCfg.transport,
        baseUrl: targetCfg.baseUrl,
        model: targetCfg.model,
        conversationId: this.conversationId,
        prefixHash: this._cachePrefixHash,
        enabled: true,
        retention: (this.cfg.cacheControl && this.cfg.cacheControl.retention) || '24h',
        meta: targetCfg.meta
      });
      if (opt.cacheControl && (opt.cacheControl.provider === 'openrouter' || opt.cacheControl.provider === 'openai')) {
        streamLog('cacheControl ' + opt.cacheControl.provider +
          ' headers=' + JSON.stringify(opt.cacheControl.headers) +
          ' body=' + JSON.stringify(opt.cacheControl.body));
      }
    } else {
      opt.cacheControl = null;
    }
    // 切到非主模型时，不假设它支持 grammar 约束解码，去掉以免卡死
    if (!isPrimary && opt.extraBody && opt.extraBody.grammar) {
      const eb = Object.assign({}, opt.extraBody);
      delete eb.grammar;
      if (Object.keys(eb).length) opt.extraBody = eb;
      else delete opt.extraBody;
    }
    const b = selectBackend(targetCfg);
    const useResp = b.responses;
    streamLog('requestEndpoint protocol=' + this.protocol +
      ' transport=' + (targetCfg.transport || '') +
      ' apiMode=' + (targetCfg.apiMode || '') +
      ' forceNonStream=' + !!forceNonStream +
      ' streamBroken=' + !!this.streamBroken +
      ' useResp=' + !!useResp +
      ' model=' + String(targetCfg.model || ''));

    // WebAI2API 文本协议（浏览器自动化）：
    //  1) 不发送 warmup 的 "ping" 探测——它会作为真实聊天消息打进 DeepSeek，污染上下文、浪费 token；
    //  2) 新会话首条消息携带 fox_new_session 信号，让远端点击「新对话」重置浏览器会话。
    const isWebText = !!(targetCfg.meta && targetCfg.meta.textOnly);
    if (isWebText && !this._webResetSent && isPrimary) {
      opt.extraBody = Object.assign({}, opt.extraBody, { fox_new_session: true });
      this._webResetSent = true;
    }

    // 缓存预热（默认关闭，设置 foxAi.cacheWarmup.enabled 开启）：新会话首轮先发一个
    // 只含 system+tools、max_tokens=1 的请求，把「铁打前缀」提前灌进服务商缓存，
    // 使随后真实的（大体量）请求能直接命中前缀缓存。
    // 注：WebAI2API 文本协议不走 API 前缀缓存（本质是浏览器自动化），且 warmup 的 "ping" 会变成真实聊天消息，故跳过。
    const warmupEnabled = (() => { try { return config.conf().get('cacheWarmup.enabled', false); } catch (_) { return false; } })();
    if (warmupEnabled && !this._cacheWarmed && isPrimary && this._cacheCapability && this._cacheCapability.supported && !isWebText) {
      await this._warmupCache(opt, useResp, b, targetCfg);
    }

    if (forceNonStream || this.streamBroken) {
      streamLog('requestEndpoint → NON-STREAM (forceNonStream=' + !!forceNonStream + ' streamBroken=' + !!this.streamBroken + ')');
      try {
        return await this.fallbackIfLocalEmpty(await b.nonStream(opt), opt);
      } catch (err) {
        // 1.1.24（对齐 dsh llm-retry）：网络/限流错误优先指数退避重试，再走参数协商降级链
        if (this._isNetworkError(err)) {
          try {
            const r = await this._withNetworkRetry(async () => b.nonStream(opt), 3);
            return await this.fallbackIfLocalEmpty(r, opt);
          } catch (netErr) { if (!this._isNetworkError(netErr)) throw netErr; err = netErr; }
        }
        const retriedGrammar = await this.retryWithoutGrammar(err, opt);
        if (retriedGrammar) return retriedGrammar;
        const retried = await this.retryWithoutImages(err, opt);
        if (retried) return retried;
        const retriedNoThink = await this.retryWithoutReasoning(err, opt);
        if (retriedNoThink) return retriedNoThink;
        throw err;
      }
    }

    const { promise, handle } = useResp ? wrapStream(opt, streamResponses) : b.once(opt);
    this.stream = handle;
    try {
      return await this.fallbackIfLocalEmpty(await promise, opt);
    } catch (err) {
      // 1.1.24（对齐 dsh llm-retry）：网络/限流错误优先指数退避重试，再走参数协商降级链
      if (this._isNetworkError(err)) {
        try {
          const retriedNet = await this._withNetworkRetry(async () => {
            const p2 = useResp ? wrapStream(opt, streamResponses) : b.once(opt);
            this.stream = p2.handle;
            return p2.promise;
          }, 3);
          return await this.fallbackIfLocalEmpty(await retriedNet, opt);
        } catch (netErr) { if (!this._isNetworkError(netErr)) throw netErr; err = netErr; }
      }
      // 服务端不认 grammar 约束解码 → 去掉参数重试一次（弱模型模式优雅降级）
      const retriedGrammar = await this.retryWithoutGrammar(err, opt);
      if (retriedGrammar) return retriedGrammar;
      // 服务端明确拒收图片 → 记住这个模型不支持读图，去图重试一次
      const retriedNoImg = await this.retryWithoutImages(err, opt);
      if (retriedNoImg) return retriedNoImg;
      // 服务端不认深度思考参数 → 去掉思考参数重试一次
      const retriedNoThink = await this.retryWithoutReasoning(err, opt);
      if (retriedNoThink) return retriedNoThink;
      // 流式响应被截断/解析失败时，用非流式再试一次
      if (err && err.canRetryNonStream) {
        console.log('[fox-ai] fallback to non-stream because:', err.message);
        // 1.1.15：用户主动取消/中止（abort）不算「流式解析失败」——强停只是打断本次流，
        // 若因此置 streamBroken，整会话三种协议全部降级非流式、且永不恢复（用户实测「三协议都不流式」根因）。
        // 权威判据用 this.cancelled：agent.cancel()（1303-1311）只由用户强停触发，会置 this.cancelled=true
        // 并 abort _abortCtrl / stream.abort()——流式错误只要发生在 cancelled 状态下，一律不算解析失败，
        // 不置全局降级；onDelta 复位逻辑（3159）还会在下一轮真实 delta 到达时自动恢复流式。
        if (this.cancelled) {
          console.log('[fox-ai] stream aborted by user, keep streaming enabled for next turn');
        } else {
          this.streamBroken = true; // 本次会话后续都走非流式，避免反复撞墙
          this.emit('notice', { text: '流式响应解析失败，已自动改用非流式请求…' });
        }
        // 部分厂商（通义）非流式禁止开思考，这里按非流式重新映射一次思考参数
        const rpNs = reasoning.buildReasoningParams(targetCfg, { stream: false });
        if (opt.extraBody) {
          for (const k of ['reasoning', 'reasoning_effort', 'enable_thinking', 'thinking_budget', 'thinking']) delete opt.extraBody[k];
          Object.assign(opt.extraBody, rpNs.extraBody || {});
        } else if (rpNs.extraBody && Object.keys(rpNs.extraBody).length) {
          opt.extraBody = Object.assign({}, rpNs.extraBody);
        }
        try {
          let r = await b.nonStream(opt);
          r = await this.fallbackIfLocalEmpty(r, opt);
          // 非流式成功且非空，直接返回（不再把原始流式错误抛出去）
          if (r && !(r.empty && !r.toolCalls.length)) return r;
          // 非流式返回空：说明问题不是网络，而是模型/参数，抛非流式的结果让上层判断
          if (r && r.empty) return r;
        } catch (fallbackErr) {
          console.log('[fox-ai] non-stream also failed:', fallbackErr.message);
          const retried = await this.retryWithoutImages(fallbackErr, opt);
          if (retried) return retried;
          const retried2 = await this.retryWithoutReasoning(fallbackErr, opt);
          if (retried2) return retried2;
          // 不在这里私自降级到 chat，统一交给 run() 的降级分支处理：
          // Chat 协议会降到 text 协议（仍有工具说明），Responses 协议只能降到 chat。
          throw fallbackErr;
        }
      }
      throw err;
    }
  }

  /** 缓存命中监控回调：解析 usage 里的缓存命中 token，计算命中率，检测前缀漂移与命中骤降。 */
  _onCacheUsage(usage) {
    if (!this._cacheCapability) {
      try { this._cacheCapability = require('./client').getCacheCapability(this.cfg && this.cfg.meta, this.cfg && this.cfg.transport, this.cfg && this.cfg.model); } catch (_) { this._cacheCapability = { supported: true, kind: 'auto', provider: 'openai-compatible' }; }
    }
    if (this._cacheCapability && !this._cacheCapability.supported) {
      if (!this._warnedCacheUnsupported) { this._warnedCacheUnsupported = true; this.emit('cacheUnsupported', { reason: this._cacheCapability.reason, provider: this._cacheCapability.provider, model: (this.cfg && this.cfg.model) || '' }); }
      return;
    }
    let stats = null;
    try { stats = require('./client').extractCacheStats(usage); } catch (_) { stats = null; }
    if (!stats) return;
    const prefixHash = this._cachePrefixHash || '';
    // 前缀基线自愈：区分「一次性跳变（如 MCP 工具晚加载）」与「持续漂移」，避免残前缀基线导致永久误报。
    const driftRes = require('./cacheBaseline').classifyPrefixDrift(this._cacheDriftState, prefixHash);
    this._cacheBaselineHash = driftRes.baseline;
    const driftByHash = driftRes.drift;
    const prevHit = this._cachePrevHitRate;
    const hitDrop = this._cachePrevRequested && prevHit != null && prevHit > 0.05 && stats.hitRate < 0.01;
    this._cachePrevHitRate = stats.hitRate;
    this._cachePrevRequested = true;
    // 会话级累计命中率：用模块级累加器跨轮次累计（含冷启动轮），与官方账单口径一致
    const acc = _accCache(this.sessionId || this.conversationId);
    acc.cached += stats.cachedTokens;
    acc.prompt += stats.promptTokens;
    acc.completion += stats.completionTokens;
    // 分子分母同口径（与单轮 total 一致）：分母累计 cached + 非缓存输入 + 缓存写入，
    // 否则 Anthropic 系 promptTokens 只含 miss，分子 cached 会顶出 >100% 的虚假累计命中率。
    acc.total += (typeof stats.totalTokens === 'number' && stats.totalTokens > 0) ? stats.totalTokens : (stats.cachedTokens + stats.promptTokens);
    const sessionHitRate = acc.total > 0 ? acc.cached / acc.total : 0;
    // —— 1.1.18：自适应历史预算（对齐 DSH token-budget retention）——
    // 硅基流动等中转厂商实测「前缀缓存命中率极低（cached≈0）」时，若仍按 DeepSeek 同款
    // maxHistoryTokens 预算全量发历史，每轮都全量计费 → 消耗显著高于有缓存红利的厂商。
    // 这里按「连续低命中轮次」动态收窄历史预算（默认上限 60k → 低命中第 1 轮 24k、第 2 轮 12k、
    // 第 3 轮 6k，每轮少发历史少计费）；命中率回到 >40% 则立即回弹（对齐 DSH「预算保留随实际压力」）。
    if (this._cacheAdaptiveInitial == null) {
      this._cacheAdaptiveInitial = (this.cfg && this.cfg.maxHistoryTokens) || 60000;
      this._cacheLowHitStreak = 0;
    }
    const lowHit = stats.hitRate < 0.05 && stats.cachedTokens < 100;
    if (lowHit) {
      this._cacheLowHitStreak = (this._cacheLowHitStreak || 0) + 1;
      if (this._cacheLowHitStreak >= 2 && this.cfg) {
        const steps = [24000, 12000, 6000];
        const budget = steps[Math.min(this._cacheLowHitStreak - 2, steps.length - 1)];
        if ((this.cfg.maxHistoryTokens || 60000) !== budget) {
          this.cfg.maxHistoryTokens = budget;
          this.emit('notice', { text: `⚠️ ${this._cacheCapability ? this._cacheCapability.provider : ''} 前缀缓存连续 ${this._cacheLowHitStreak} 轮低命中（<5%），已自动收窄历史预算至 ${budget} 以控制消耗；命中恢复后自动回弹。`, internal: true });
        }
      }
    } else {
      this._cacheLowHitStreak = 0;
      if (this.cfg && this._cacheAdaptiveInitial && (this.cfg.maxHistoryTokens || 0) !== this._cacheAdaptiveInitial) {
        this.cfg.maxHistoryTokens = this._cacheAdaptiveInitial;
      }
    }
    const report = {
      conversationId: this.conversationId,
      prefixHash,
      baselineHash: this._cacheBaselineHash,
      cachedTokens: stats.cachedTokens,
      promptTokens: stats.promptTokens,
      completionTokens: stats.completionTokens,
      hitRate: Math.round(stats.hitRate * 1000) / 1000,
      sessionHitRate: Math.round(sessionHitRate * 1000) / 1000,
      sessionCachedTokens: acc.cached,
      sessionPromptTokens: acc.prompt,
      driftByHash,
      hitDrop,
      lowHitStreak: this._cacheLowHitStreak || 0,
      adaptiveBudget: (this.cfg && this.cfg.maxHistoryTokens) || 0
    };
    this.emit('cacheStats', report);
    console.log('[fox-ai] prompt-cache stats', JSON.stringify(report));
    if (driftByHash) {
      // 同一条漂移（baseline→current）只提示一次，避免每轮刷屏；自愈后基线已更新，不会再进这里。
      const key = this._cacheBaselineHash + '>' + prefixHash;
      if (key !== this._lastDriftWarnKey) {
        this._lastDriftWarnKey = key;
        this.emit('notice', { text: '⚠️ 请求前缀哈希与本会话基线不一致（' + this._cacheBaselineHash + ' → ' + prefixHash + '），前缀缓存将整段失效，请检查系统提示词/工具定义是否被改动。', internal: true });
      }
    } else if (hitDrop) {
      this.emit('notice', { text: '⚠️ 缓存命中率骤降：上一轮 ' + Math.round(prevHit * 100) + '% 命中，本轮 <1%，前缀缓存可能已被驱逐或失效。', internal: true });
    }
  }

  /** 缓存预热：发一个极简请求（仅 system + tools，max_tokens=1）把前缀灌进服务商缓存。失败静默忽略。 */
  async _warmupCache(opt, useResp, b, targetCfg) {
    if (this._cacheWarmed) return;
    this._cacheWarmed = true;
    try {
      const sysMsg = (Array.isArray(opt.messages) && opt.messages[0] && opt.messages[0].role === 'system') ? opt.messages[0].content : '';
      const warmOpt = Object.assign({}, opt, {
        baseUrl: targetCfg.baseUrl,
        apiKey: targetCfg.apiKey,
        model: targetCfg.model,
        // 带一条最小 user 消息让请求结构完整：部分服务商（含 DeepSeek 前缀缓存）对「只有 system、无 user」的
        // 探针请求不落缓存，导致预热白做。ping 与真实首条 user 消息不同，但前缀仍从 system 起算、可命中。
        messages: [
          { role: 'system', content: typeof sysMsg === 'string' ? sysMsg : JSON.stringify(sysMsg) },
          { role: 'user', content: 'ping' }
        ],
        tools: opt.tools || [],
        toolChoice: undefined,
        maxTokens: 4,
        stream: false,
        onDelta: null, onReasoning: null, onToolCallStart: null, onDone: null, onError: null, onSearchResults: null, onUsage: null
      });
      delete warmOpt.extraBody;
      console.log('[fox-ai] cache warmup priming conversation ' + this.conversationId);
      await b.nonStream(warmOpt);
      console.log('[fox-ai] cache warmup done');
      // 预热是冷启动（0 命中）：把它的输入 token 计入会话累计的 total 分母（cache 写入量），
      // 与累计口径一致（分母=total=cached+miss+creation）；原 acc.prompt 累加会漏掉分母、顶虚高命中率。
      const acc = _accCache(this.sessionId || this.conversationId);
      const warmPrompt = contextUsage.estimateTokens(typeof sysMsg === 'string' ? sysMsg : JSON.stringify(sysMsg))
        + contextUsage.estimateTokens('ping')
        + contextUsage.estimateTokens(JSON.stringify(opt.tools || []));
      acc.prompt += warmPrompt;
      acc.total += warmPrompt;
    } catch (e) {
      console.log('[fox-ai] cache warmup failed (ignored):', e && e.message);
    }
  }

  /** 构造 failover 端点列表：首位为主模型（cfg 本身），其后为配置里的备用模型（本地或云端）。 */
  _failoverEndpoints() {
    const cfg = this.cfg;
    const list = [Object.assign({}, cfg, { name: 'primary', isPrimary: true })];
    if (this._failover && this._failover.enabled) {
      for (const t of this._failover.targets) {
        list.push({
          name: t.name,
          baseUrl: t.baseUrl,
          apiKey: t.apiKey,
          model: t.model,
          local: t.local,
          isPrimary: false,
          // 备用模型统一走 OpenAI 兼容 chat 协议（覆盖本地 llama.cpp / Ollama 与各类云端兼容服）
          transport: 'openai',
          apiMode: 'chat'
        });
      }
    }
    return list;
  }

  /** 把错误归类成 failover 触发类型；返回 'other' 表示不应触发切换。 */
  _errClass(err) {
    if (!err) return 'other';
    const m = String(err.message || '').toLowerCase();
    if (err.status === 429) return 'rateLimit';
    if (m.includes('timeout') || m.includes('etimedout') || m.includes('请求超时')) return 'timeout';
    if (m.includes('econnrefused') || m.includes('enotfound') || m.includes('econn') || m.includes('连接') || m.includes('refused') || m.includes('dns')) return 'connection';
    if (err.status && err.status >= 500) return 'serverError';
    if (m.includes('500') || m.includes('502') || m.includes('503') || m.includes('504') || m.includes('internal server error') || m.includes('bad gateway') || m.includes('gateway timeout') || m.includes('service unavailable')) return 'serverError';
    if (m.includes('429') || m.includes('rate limit') || m.includes('too many requests')) return 'rateLimit';
    return 'other';
  }

  /** 该错误是否匹配配置的 failover 触发条件（未启用或类型不命中均返回 false）。 */
  _isFailoverError(err) {
    if (!this._failover || !this._failover.enabled) return false;
    const cls = this._errClass(err);
    if (cls === 'other') return false;
    return this._failover.triggers.has(cls);
  }

  /** 发起一次模型调用（默认流式，解析失败时自动非流式兜底） */
  async callModel(payload, useNative, toolsOverride) {
    return llmLimiter.run(async () => {
    const cfg = this.cfg;
    const isDeepResp = cfg.provider === 'deepseek' && cfg.apiMode === 'responses';
    // 1.1.26：_finalStreamedText 语义修正为「本轮」流式累积文本。
    // 此前它只在 onDelta 里累加、从不重置 → 跨轮累积整个会话的正文，导致：
    //   ① 轮末 TailFIX 用「累积全文」与「本轮 visible」比 startsWith → 判定长期失效；
    //   ② 内容兜底链取到的不是本轮文本（会把历史正文当本轮输出）。
    // 每轮发起请求前清零，让它真正表示「本轮模型流式吐了什么」。
    this._finalStreamedText = '';
    const queryForTools = (() => {
      if (!Array.isArray(payload)) return '';
      const u = payload.slice().reverse().find((m) => m && m.role === 'user');
      if (!u) return '';
      if (typeof u.content === 'string') return u.content;
      if (Array.isArray(u.content)) return u.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
      return '';
    })();
    const openAiTools = tools.toOpenAITools(queryForTools, cfg);
    // DeepSeek 非 reasoner 模型经 Responses API 开 reasoning 时，content 会被 gate 缓存后延时释放，
    // 此时最终正文不能完全靠 onDelta 实时流式覆盖，轮末仍需补发 flush（否则可能漏字）。
    this._reasoningGate = cfg.apiMode === 'responses' && /deepseek/.test(String(cfg.providerId || cfg.provider || cfg.baseUrl || '').toLowerCase()) && !/reasoner|r1/.test(cfg.model);
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
      // DeepSeek 非 reasoner 模型（v4-flash 等）通过 Responses API 开启 reasoning 时，
      // reasoning_text 与 output_text 会交错到达，导致“思考没结束就回答”。开启 gate
      // 后 reasoning 活跃期间 content 先缓存，等静默窗口（300ms）后再释放。
      reasoningGate: cfg.apiMode === 'responses' && /deepseek/.test(String(cfg.providerId || cfg.provider || cfg.baseUrl || '').toLowerCase()) && !/reasoner|r1/.test(cfg.model),
      onDelta: (t) => {
        if (!t) return;
        this.deltaSeen = true;
        // 自愈：流式 delta 真实到达 = 本连接流式正常 → 解除历史降级（streamBroken 置位后若
        // 某次流式实际成功，不应让本会话永久停留在非流式；否则「abort/偶发截断后整会话不流式」）。
        if (this.streamBroken) {
          this.streamBroken = false;
          console.log('[fox-ai] stream recovered, restore streaming');
          this.emit('notice', { text: '流式已恢复，重新启用实时输出…' });
        }
        this._thinkingBuffer.text += t;
        this._estDeltaChars = (this._estDeltaChars || 0) + String(t).length;
        if (this._estDeltaChars % 100 < String(t).length || this._estDeltaChars < 100) {
          this._emitContextUsageDelta(this._estDeltaChars);
        }
        // 实时流式：native 与 text 协议都把最终正文增量逐字推到 final 通道（text 先剥掉
        // <fox:tool> 工具块，只推可见正文，避免工具调用标签裸流到主对话栏）。
        // 非流式 provider（forceNonStream/streamBroken）不在此流式——它们根本没走 onDelta。
        // 1.1.16：text 协议此前被 protocol!=='text' 整体关掉实时推送（轮末一次性蹦出），
        // 用户实测「三协议都不流式」的根因；现在 text 协议也实时推（剥块后正文）。
        const streaming = !(cfg.forceNonStream || this.streamBroken);
        if (streaming) {
          let pushText = t;
          if (this.protocol === 'text') {
            // text 协议增量剥离（1.1.16）：维护跨 chunk 的「未闭合块缓冲」。
            // 工具块可能被 chunk 边界切成两半（<fox:tool ...> 在 A、内容在 B、</fox:tool> 在 C），
            // 单 chunk 正则只能删完整闭合块 → 半截块会漏推成正文。算法：先把累积缓冲拼上增量，
            // 再看「完整闭合块」之外是否有未闭合开标签——如果有，整体压缓冲不推；
            // 否则推全部（剥掉完整闭合块与残留未闭合尾）。
            // 1.1.18 步骤流：剥除工具块时保留 \u0002STEP:<name>\u0002 边界标记（与 stripToolBlocks 同款），
            // 让前端把实时思考流切成「💭 思考 / 🖥️ 工具」分步卡片，而不是整段糊在一起。
            // 1.1.18b：流式路径必须先 normalizeToolTags —— TOOL_BLOCK 只认 <fox:tool> XML 格式，
            // 自定义符号 [[tool:name]]{json}[[/tool]] 不归一化会原样裸流到思考/回答气泡
            //（stripToolBlocks 轮末有归一化，但流式 onDelta 漏了，用户实测仍看到工具调用原文）。
            const buf = (this._textStripBuf || '') + t;
            const norm = tools.normalizeToolTags(buf);
            const cleaned = norm.replace(TOOL_BLOCK, (_m, _a, name) => '\u0002STEP:' + name + '\u0002')
              .replace(/<(fox:?tool|fox-tool|tool)[\s\S]*$/i, '')
              .replace(/\[\[tool:[\s\S]*$/i, '')
              .trim();
            const rawNoClosed = norm.replace(TOOL_BLOCK, '');
            const hasOpen = /<(fox:?tool|fox-tool|tool)[\s\S]*$/i.test(rawNoClosed) || /\[\[tool:[\s\S]*$/i.test(norm);
            if (hasOpen) {
              // 工具块还没闭合：把整段压入缓冲，等后续 chunk 闭合后再推正文
              this._textStripBuf = buf;
              streamLog('onDelta buffered (unclosed tool block) bufLen=' + buf.length + ' t=' + JSON.stringify(String(t).slice(0, 40)));
              this._textBuffered = true;
              return;
            }
            this._textStripBuf = '';
            pushText = cleaned;
          }
          if (!pushText) { streamLog('onDelta skipped (empty after strip) protocol=' + this.protocol + ' t=' + JSON.stringify(String(t).slice(0, 60))); return; }
          // _estDeltaPushChars 按「非空白字符」累计：与轮末 TailFIX 的 visibleNoWs 口径一致，
          // 空格/换行在剥离 .trim() 时被去掉，不算入「已推正文量」，避免「已推 vs 全量」恒差空白。
          this._estDeltaPushChars = (this._estDeltaPushChars || 0) + String(pushText).replace(/\s+/g, '').length;
          if (!this._finalStarted) {
            this._finalStarted = true;
            this._ev(agentEvents.EV.FINAL_STARTED, {});
            this.emit('assistantStart', { channel: 'final', msg_id: this.finalMsgId });
          }
          this._finalStreamed = true;
          if (!this._streamDeltaCount) this._streamDeltaCount = 0;
          this._streamDeltaCount++;
          if (this._streamDeltaCount <= 3 || this._streamDeltaCount % 50 === 0) {
            streamLog('onDelta push #' + this._streamDeltaCount + ' protocol=' + this.protocol +
              ' len=' + String(pushText).length + ' total=' + this._estDeltaPushChars);
          }
          this._finalStreamedText = (this._finalStreamedText || '') + pushText;
          this.emit('text', { text: pushText, channel: 'final', msg_id: this.finalMsgId });
        }
      },
      onReasoning: (t) => {
        this.reasoningSeen = true;
        this._thinkingBuffer.reasoning += t;
        // 实时流式：把思考过程逐字推到 thinking 通道（右侧工作链「调用模型」步骤卡片），
        // 让用户即时看到模型在思考什么，而不是等整轮结束才一次性蹦出（「看不到即时工作」的根因）。
        // 1.1.16：text 协议此前被 protocol!=='text' 整体关掉实时推送（轮末一次性蹦出），
        // 现在 text 协议剥掉 <fox:tool> 块后也实时推思考增量；非流式 provider 不在此流式。
        // text 协议 reasoning 剥离（1.1.16）：同样维护跨 chunk 未闭合块缓冲，避免半截块漏推。
        // 1.1.18b：与 onDelta 同款，先 normalizeToolTags 归一化自定义符号 [[tool:...]]，
        // 否则思考过程里的工具调用标签会原文裸流到工作链思考卡。
        if (this.protocol === 'text') {
          const rBuf = (this._reasonStripBuf || '') + String(t || '');
          const rNorm = tools.normalizeToolTags(rBuf);
          const rCleaned = rNorm.replace(TOOL_BLOCK, '').replace(/<(fox:?tool|fox-tool|tool)[\s\S]*$/i, '')
            .replace(/\[\[tool:[\s\S]*$/i, '').trim();
          const rRaw = rNorm.replace(TOOL_BLOCK, '');
          const rHasOpen = /<(fox:?tool|fox-tool|tool)[\s\S]*$/i.test(rRaw) || /\[\[tool:[\s\S]*$/i.test(rNorm);
          if (rHasOpen) { this._reasonStripBuf = rBuf; return; }
          this._reasonStripBuf = '';
          t = rCleaned;
        }
        const reasoningStreamable = !(cfg.forceNonStream || this.streamBroken) &&
          (this.protocol !== 'text' || (String(t || '').trim().length > 0));
        if (reasoningStreamable) {
          // stream:true 标记这是「实时增量」：只用于工作链即时滚动，不落盘 transcript（避免增量膨胀），
          // 轮末的全量 reasoning（无 stream 标记）才落盘，供重载/切换会话后恢复「已思考」内容。
          this.emit('reasoning', { text: t, channel: 'thinking', msg_id: this.thinkingMsgId, stream: true });
        }
      },
      onToolCallStart: (name) => this.emit('toolPending', { name })
    };

    // —— 深度思考：按当前 provider/传输/协议映射成各家的思考参数 ——
    // 走 extraBody 通道并入请求体，四个后端入口（chat 流/非流、responses 流/非流、anthropic）都支持。
    const willStream = !(cfg.forceNonStream || this.streamBroken);
    // 续跑轮（长度截断自动继续）：关闭深度思考，让模型专注续写正文、不再生成超长 reasoning 吃光
    // 输出预算导致再次截断（日志里 finishReason=incomplete + reasoning 截断后反复续跑空转的根因）。
    // 关闭后 Responses 模式不再下发 reasoning 参数、chat 模式下发 thinking:disabled，均等价于「本轮不思考」。
    const reasoningCfg = this._lenContinue
      ? Object.assign({}, cfg, { deepThinking: Object.assign({}, cfg.deepThinking, { enabled: false }) })
      : cfg;
    const rp = reasoning.buildReasoningParams(reasoningCfg, { stream: willStream });
    this._reasoningPlan = rp;
    if (rp.extraBody && Object.keys(rp.extraBody).length) {
      options.extraBody = Object.assign({}, options.extraBody, rp.extraBody);
      if (rp.temperature != null) options.temperature = rp.temperature;
      if (rp.minMaxTokens > 0 && !(options.maxTokens > rp.minMaxTokens)) options.maxTokens = rp.minMaxTokens;
      console.log('[fox-ai] deepThinking', rp.enabled ? 'ON' : 'OFF', 'strategy=', rp.strategy, rp.reason, JSON.stringify(rp.extraBody));
    } else if (rp.enabled) {
      console.log('[fox-ai] deepThinking ON (prompt-fallback) strategy=', rp.strategy, rp.reason);
    }

    // —— 多厂商原生联网（服务端执行）：按 provider/apiMode 注入对应请求参数 ——
    // 1) 通义百炼 Chat：enable_search:true + search_options.enable_source:true（结果在 chunk 顶层 search_info.search_results）
    // 2) 向 options 透传 nativeSearchProvider，供后端（anthropic.js 注入 server tool web_search_20250305）识别。
    //    Responses 家族（OpenAI/DeepSeek/通义）与 Chat 工具式（智谱/Kimi）的原生工具已由 toOpenAITools 注入，无需此处处理。
    const nsProvider = nativeSearch.nativeSearchProvider(cfg);
    if (nsProvider) options.nativeSearchProvider = nsProvider;
    if (nsProvider === 'chat' && nativeSearch.isChatNativeFlagSearch(cfg)) {
      options.extraBody = Object.assign({}, options.extraBody);
      options.extraBody.enable_search = true;
      options.extraBody.search_options = Object.assign({}, options.extraBody.search_options, { enable_source: true });
      console.log('[fox-ai] native chat search: dashscope enable_search injected');
    }

    // —— 本地弱模型辅助模式（1.1.17/1.1.19）：约束解码 ——
    // 文本协议 + 弱模型时，向请求体注入通用 GBNF grammar，让模型只能输出「自然语言」
    // 或「<foxtool name="..">{合法 JSON}</foxtool>」，从根源消灭缺引号/缺括号等格式错误。
    // 1.1.19 起：默认（localConstrainedDecoding='auto'）先探测服务端是否支持 grammar，
    // 支持才注入；不支持/挂起则跳过（绝不卡死）。显式 false 永不注入，true 强制注入。
    // 若服务端不认 grammar（报 400/不支持），retryWithoutGrammar 仍会自动去掉该参数重试一次。
    if (this._weakLocal && this.protocol === 'text' && cfg.localConstrainedDecoding !== false && !this._grammarStripped) {
      const allow = await this._grammarAllowed(cfg);
      if (allow) {
        options.extraBody = Object.assign({}, options.extraBody);
        options.extraBody.grammar = weakModel.TEXT_TOOL_GRAMMAR;
        console.log('[fox-ai] weak-mode constrained decoding: grammar injected (server supported)');
      } else {
        // 服务端不支持/挂起：记住本会话不再注入，避免重复探测与卡顿
        this._grammarStripped = true;
        console.log('[fox-ai] weak-mode grammar skipped: server does not support it (probe said no)');
      }
    }

    // —— 动态工具注册（按模型条件性注入）——
    // deepseek + responses：toOpenAITools 已「排除本地 web_search、注入原生 {type:'web_search'}」，
    //   绝对不会出现同名本地函数与原生工具抢路由；其余模型/模式则只给普通 function 工具（含本地 web_search）。
    // 这样热切换模型时各自安好：DeepSeek 走官方联网，其他模型走本地 web_search。
    if (useNative || isDeepResp) {
      options.tools = toolsOverride || openAiTools;
      // 1.1.26 治「native 协议下模型只叙述不调工具」（日志实证 nativeCalls=0 连空 3 轮）：
      // 空轮后的 nudge 轮强制 tool_choice —— 语义「本轮必须调用某个工具」。
      // 两后端写法不同：Anthropic 用 'any'，OpenAI 兼容用 'required'（client.js 直接透传）。
      if (this._forceToolChoice) {
        options.toolChoice = cfg.transport === 'anthropic' ? 'any' : 'required';
        try {
          require('./log').appendLog('agent', '[force-tool-choice] 空轮 nudge 轮强制 tool_choice=' + options.toolChoice +
            ' protocol=' + this.protocol + ' tools=' + (options.tools || []).length);
        } catch (_) { /* 日志绝不影响主流程 */ }
      }
    } else if (this.protocol === 'text') {
      options.stopMarker = TOOL_END;
    }

    // —— 时效性提问：Responses 原生联网厂商（DeepSeek / OpenAI / 通义百炼 responses）下
    //    只用 toolChoice 在「首轮」强制触发官方 web_search；tools 字段始终等于 openAiTools（字节稳定）。
    //    （1.1.30+ 前缀缓存稳定：网络类本地工具已由 toOpenAITools 统一剔除，不再按「时效性」二次替换 tools，
    //      否则时效轮与普通轮的 tools 字段不同 → 整段前缀缓存漂移、命中率骤降。）
    if (isDeepResp || nativeSearch.isResponsesNativeSearch(cfg)) {
      const dec = computeOfficialSearch(payload, this._officialSearchStarted, openAiTools);
      if (dec) {
        this._officialSearchStarted = dec.started;
        if (dec.toolChoice) options.toolChoice = dec.toolChoice;
        else delete options.toolChoice;
        console.log('[fox-ai] official web_search forced (this turn), query=', String(dec.query || '').slice(0, 50), 'forceChoice=', !!dec.toolChoice);
      } else {
        delete options.toolChoice;
        // 非时效 / 用户要本地工具：保留完整工具集（含本地 file 工具 + 官方 web_search）
        console.log('[fox-ai] official web_search not forced this turn, full tools kept (', (openAiTools.length), 'tools )');
      }
    }

    // —— 失败降级 / 自动 failover（1.1.20）——
    // 主模型（endpoints[0]）调用失败时，按配置的错误类型（超时/连接/服务端错误/限流/空响应）
    // 自动切换到备用模型（endpoints[1..]）。备用可是本地或云端，UI 自由配置。
    // 默认 failover 关闭 → endpoints 仅主模型，行为与旧版完全一致（无回归）。
    const endpoints = this._failoverEndpoints();
    const forceNonStream = cfg.forceNonStream || this.streamBroken;
    let lastErr = null;
    for (let i = 0; i < endpoints.length; i++) {
      const ep = endpoints[i];
      try {
        const r = await this._requestEndpoint(options, ep, forceNonStream, i === 0);
        // 配置开启 emptyResponse 触发、主模型返回空、且还有备用 → 切备用
        if (r && r.empty && i < endpoints.length - 1 && this._failover.enabled && this._failover.triggers.has('emptyResponse')) {
          this.emit('notice', { text: `主模型「${ep.name}」返回空响应，自动切换到备用「${endpoints[i + 1].name}」…` });
          lastErr = new Error('empty response from ' + ep.name);
          continue;
        }
        return r;
      } catch (err) {
        lastErr = err;
        // 已到最后一条或 failover 未启用 → 原样抛出
        if (i >= endpoints.length - 1 || !this._failover.enabled) throw err;
        // 仅当错误类型命中触发条件才切换，否则原样抛出（避免无意义重试）
        if (!this._isFailoverError(err)) throw err;
        this.emit('notice', { text: `模型「${ep.name}」调用失败（${this._errClass(err)}），自动切换到备用「${endpoints[i + 1].name}」…` });
        // 继续下一个端点
      }
    }
    throw lastErr;
    });
  }

  /** 解析文本协议里的工具调用（增强：兼容 <foxtool> / <function> / 裸 JSON 多格式） */
  /** 已知工具名集合（小写），供 parseTextCalls 过滤误判；含工具别名（如 get_memory 的 recall_memory） */
  _toolNameSet() {
    try {
      const list = (typeof tools !== 'undefined' && tools.allTools) ? tools.allTools() : [];
      const names = (list || []).map((t) => String(t.name).toLowerCase());
      // 1.1.39：纳入 aliases，模型用别名调用（如 recall_memory）不会被 knownTools 过滤丢弃
      for (const t of (list || [])) {
        if (Array.isArray(t.aliases)) {
          for (const a of t.aliases) names.push(String(a).toLowerCase());
        }
      }
      return names;
    } catch (_) { return []; }
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
      const r = await llmLimiter.run(() => client.chatNonStream({
        baseUrl: cfg.planner.baseUrl || live.baseUrl,
        apiKey: live.apiKey,
        model: plannerModel,
        messages: [{ role: 'system', content: opts.system }, ...msgs],
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        timeout: plannerTimeout
      }));
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
    return llmLimiter.run(() => client.chatNonStream({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      messages,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens
    })).then((r) => (r && r.content) ? r.content : '');
  }

  /** 执行单个工具（含审批、结果回填） */
  /**
   * 把一次工具调用压成稳定签名（键排序、深度/长度截断），用于循环检测。
   * @param {string} name
   * @param {any} args
   * @returns {string}
   */
  _toolSignature(name, args) {
    const stable = (v, depth) => {
      if (v === null || typeof v !== 'object') {
        try { return JSON.stringify(v); } catch (_) { return '"?"'; }
      }
      if (depth > 3) return '"…"';
      if (Array.isArray(v)) return '[' + v.slice(0, 12).map((x) => stable(x, depth + 1)).join(',') + ']';
      return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k], depth + 1)).join(',') + '}';
    };
    let s;
    try { s = stable(args, 0); } catch (_) { s = String(args); }
    // 1.1.26b：签名长度从 300 提到 600——write_file/edit_file 的 content 差异常出现在
    // 参数尾段（如「你好」 vs 「\n\n\n\n\n你好」），截到 300 会把差异截掉，导致
    // 「参数已变化」的合法重写也被 loop-guard 误判为同名同参（日志实证 blocks 1→5）。
    return name + '|' + String(s).slice(0, 600);
  }

  /**
   * 通用工具循环护栏（零模型开销，纯本地判断）。
   * 覆盖两种最常见的失控形态：
   *   1) 同一工具 + 同一参数在最近 8 次里出现 ≥3 次（原地打转）；
   *   2) 周期为 2 或 3 的环状调用，如 A→B→A→B→A→B（互相触发）。
   * 命中时不抛错，只把「别再重复了」当作工具结果回给模型，并在连续命中时
   * 置 `_loopNudge`，由主循环在本批工具执行完后补一条强提醒，逼它收敛出结论。
   *
   * @param {string} name 工具名
   * @param {any} args 已解析的参数
   * @returns {{text:string, reason:string, suggest:string}|null} 命中返回拦截信息，否则 null
   */
  _loopGuardCheck(name, args) {
    // 这些工具本身就是「反复小步推进」的语义，重复调用是正常的，不参与循环检测
    const EXEMPT = new Set(['update_plan_task', 'set_plan_tasks', 'present_plan', 'revise_plan', 'save_memory', 'checkpoint_create']);
    if (EXEMPT.has(name)) return null;

    if (!this._toolSigHistory) this._toolSigHistory = [];
    const sig = this._toolSignature(name, args);
    const hist = this._toolSigHistory;
    let hit = '';

    // 写文件类工具：签名不同 = 模型在尝试不同内容/不同参数（如 「你好」 vs 「\n\n\n\n\n你好」），
    // 这是合法推进，不是空转。只有签名完全相同才算 repeat。1.1.26b 修复误拦。
    const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'insert_text', 'replace_text', 'append_file', 'patch_file']);
    if (WRITE_TOOLS.has(name)) {
      // 形态一（写文件版）：只认「签名完全相同」的重复
      const sameExact = hist.slice(-8).filter((s) => s === sig).length;
      if (sameExact >= 2) hit = 'repeat';  // 即使写文件，连续 3 次一模一样也是空转
      // 形态二：环状调用（周期 2 / 3）也按原逻辑，但写文件不会走环状
      if (!hit) {
        const seq = hist.concat(sig);
        for (const p of [2, 3]) {
          const need = p * 3;
          if (seq.length < need) continue;
          const tail = seq.slice(-need);
          let cyclic = true;
          for (let i = 0; i + p < need; i++) {
            if (tail[i] !== tail[i + p]) { cyclic = false; break; }
          }
          if (cyclic && new Set(tail).size > 1) { hit = 'cycle-' + p; break; }
        }
      }
      hist.push(sig);
      if (hist.length > 16) hist.shift();
      if (!hit) return null;
      this._loopBlocks = (this._loopBlocks || 0) + 1;
      if (this._loopBlocks >= 2) this._loopNudge = true;
      this.emit('notice', {
        text: `检测到工具「${name}」重复调用（${hit === 'repeat' ? '同名同参' : '环状'}），已拦截以免空转。`
      });
      const text = hit === 'repeat'
        ? `已拦截：工具 ${name} 在最近几步里用完全相同的参数重复调用过 ${sameExact + 1} 次（参数和内容一模一样），结果不会变。请直接用已经拿到的结果继续，或换一个不同的思路/参数。`
        : `已拦截：检测到 ${name} 与其他工具在来回循环调用（周期 ${hit.slice(-1)}），没有产生新信息。请停止这条链路，基于现有信息给出结论或换方案。`;
      return {
        text,
        reason: '重复/环状工具调用',
        suggest: '不要再用相同参数重试。若信息已足够就直接作答；确实缺信息就换工具或换参数，并说明你改变了什么。'
      };
    }
    hist.push(sig);

    // 形态一：原地打转（同名同参）
    const sameInWindow = hist.slice(-8).filter((s) => s === sig).length;
    if (sameInWindow >= 2) hit = 'repeat';

    // 形态二：环状调用（周期 2 / 3）
    if (!hit) {
      const seq = hist.concat(sig);
      for (const p of [2, 3]) {
        const need = p * 3;
        if (seq.length < need) continue;
        const tail = seq.slice(-need);
        let cyclic = true;
        for (let i = 0; i + p < need; i++) {
          if (tail[i] !== tail[i + p]) { cyclic = false; break; }
        }
        // 全都一样的情况已由形态一覆盖，这里只认「不同工具交替」
        if (cyclic && new Set(tail).size > 1) { hit = 'cycle-' + p; break; }
      }
    }

    hist.push(sig);
    if (hist.length > 16) hist.shift();

    // 形态三：同一资源被「读取类工具」反复访问（1.1.26）
    // 前两种形态都要求「签名相同/成环」，而模型在大文件里分段爬行时每个区间参数都不同
    // （start_line 120→230→340…），签名不同、不成环 → 护栏完全失效。日志实证：1678 行文件
    // 被 read_file 连读 11 轮仍未读完，思考长度 463 → 6759 → 27233 字符，最后空轮收尾。
    // 这里单独按「目标资源」计数：同一文件/同一查询被同一工具访问超过阈值即提醒换策略。
    // 注意：这是**非阻断**提醒（只注入一条系统消息），不拦截工具——模型可能确实需要继续读。
    if (!hit) {
      const field = READ_TARGET_FIELD[name];
      const target = field && args ? String(args[field] || '').trim() : '';
      if (target) {
        if (!this._toolTargetCounts) this._toolTargetCounts = new Map();
        const key = name + '|' + target;
        const n = (this._toolTargetCounts.get(key) || 0) + 1;
        this._toolTargetCounts.set(key, n);
        if (n >= READ_REPEAT_LIMIT) {
          hit = 'over-read';
          try {
            require('./log').appendLog('agent', `[loop-guard] over-read tool=${name} target=${target.slice(0, 80)} count=${n}`);
          } catch (_) {}
          // 每达到阈值提醒一次，之后每隔 READ_REPEAT_LIMIT 次再提醒，避免刷屏
          if (n === READ_REPEAT_LIMIT || n % READ_REPEAT_LIMIT === 0) {
            this.messages.push({
              role: 'user',
              content: `[系统·效率提醒] 你已对「${target}」连续调用 ${name} ${n} 次。这种逐段通读会持续挤占上下文、` +
                '并让后续推理质量下降。请改用一次性处理策略：\n' +
                '1) 用 run_command 跑一段脚本（Node/Python）直接解析该文件并写出结果，而不是反复读片段；\n' +
                '2) 或用 search_text / search_codebase 按关键词精确定位需要的部分；\n' +
                '3) 若确实需要通读，请一次读取尽可能大的区间，并尽快进入产出阶段。'
            });
          }
          return null; // 非阻断：不拦截，让工具正常执行
        }
      }
    }

    if (!hit) return null;

    this._loopBlocks = (this._loopBlocks || 0) + 1;
    try {
      require('./log').appendLog('agent', `[loop-guard] ${hit} tool=${name} blocks=${this._loopBlocks} sig=${sig.slice(0, 120)}`);
    } catch (_) {}
    if (this._loopBlocks >= 2) this._loopNudge = true;
    this.emit('notice', {
      text: `检测到工具「${name}」重复调用（${hit === 'repeat' ? '同名同参' : '环状'}），已拦截以免空转。`
    });

    const text = hit === 'repeat'
      ? `已拦截：工具 ${name} 在最近几步里用完全相同的参数重复调用过 ${sameInWindow + 1} 次，结果不会变。请直接用已经拿到的结果继续，或换一个不同的思路/参数。`
      : `已拦截：检测到 ${name} 与其他工具在来回循环调用（周期 ${hit.slice(-1)}），没有产生新信息。请停止这条链路，基于现有信息给出结论或换方案。`;
    return {
      text,
      reason: '重复/环状工具调用',
      suggest: '不要再用相同参数重试。若信息已足够就直接作答；确实缺信息就换工具或换参数，并说明你改变了什么。'
    };
  }

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

    // —— 通用循环护栏：任何工具（含 skill / MCP / 子代理）陷入重复或环状调用时刹车 ——
    // 长任务里最常见的失控形态：同一 MCP 工具带同一参数反复调、或 A→B→A→B 来回打转，
    // 把步数和 token 全烧光却毫无进展。这里做纯本地、零模型开销的检测。
    {
      const guard = this._loopGuardCheck(name, args);
      if (guard) {
        this.emit('toolEnd', { id: 'tool-' + callId, ok: false, output: guard.text, rejected: true });
        this.pushToolResult(callId, name, guard.text, true, { reason: guard.reason, suggest: guard.suggest });
        return;
      }
    }

    // —— 重复读取去重：同一文件「相同区间」连续读 3 次以上 → 拒绝 ——
    // 注意：刷新窗口 / 重载扩展后会话上下文会丢失，模型需要重新读取文件才能拿回内容。
    // 因此不能按「文件路径」一刀切拦截，否则模型用不同区间（如 1-300、547、530-168）反复重读
    // 也会被误判为重复而卡死。这里只拦截「完全相同区间反复读」的死循环；不同区间的读取一律放行，
    // 刷新后恢复上下文不受阻。
    if (name === 'read_file' && args && args.path) {
      if (!this._readFileHistory) this._readFileHistory = [];
      const sig = readFileSig(args.path, args);
      // cacheDedup（只读工具结果会话内去重，对齐 DSH「工具结果极小」）：同一文件「同区间」且
      // 「内容未变」（mtime/size 签名相同）时，第二次起返回极短占位，不把完整文件内容重新塞进上下文，
      // 缩小每轮不可缓存的增量、拉高命中率。文件被改动（mtime/size 变）视为新调用，绝不返回旧内容。
      const dedupEnabled = (() => { try { return config.conf().get('cacheDedup.enabled', true); } catch (_) { return true; } })();
      if (dedupEnabled) {
        let contentSig = '';
        try {
          const st = fs.statSync(args.path);
          if (st) contentSig = Math.floor(st.mtimeMs) + ':' + st.size;
        } catch (_) {}
        if (contentSig) {
          const key = sig + '|' + contentSig;
          if (this._readFileHistory.some((r) => r.key === key)) {
            const range = (args.start_line || args.end_line || args.start_char || args.end_char) ? '（指定区间）' : '（全文）';
            this.pushToolResult(callId, name,
              `文件 ${args.path} ${range}内容未变，本会话已读取过（见上方），无需重复读取，请直接基于已读内容继续。`,
              true, { reason: '重复读取未变更文件（已去重）', suggest: '内容与之前一致，直接使用已读内容。' });
            return;
          }
        }
      }
      const recent = this._readFileHistory.slice(-6).filter((r) => r.sig === sig).length;
      if (recent >= 3) {
        const range = (args.start_line || args.end_line || args.start_char || args.end_char)
          ? `（start_line=${args.start_line || 1}, end_line=${args.end_line || '到末尾'}）`
          : '（全文）';
        this.pushToolResult(callId, name,
          `文件 ${args.path} 的同一区间${range}你已连续读取 ${recent} 次，内容未变。` +
          `若你是因刷新窗口 / 重载丢失了上下文，请用不同的 start_line / end_line 重新读取（分区间读取不会被判定为重复）；否则请直接基于已读内容继续，不要对同一区间反复读取。`,
          true, {
            reason: '同一区间重复读取，无新信息',
            suggest: '确认该区间内容是否已在上下文中；若需更多内容请读取其他区间，不要对同一区间反复读取。'
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

    // ---- Agent 模式门控（架构 / 问答模式的文件与工具限制）----
    // 这是最外层的硬约束：模式说不行就是不行，压过 autoApprove 与策略引擎。
    // 默认 code 模式下 this.mode 为 null，这段直接跳过，零开销。
    if (this.mode) {
      let mv = { allowed: true };
      try {
        mv = require('./modes').isToolAllowed(this.mode, { name, kind, path: args && args.path });
      } catch (_) { mv = { allowed: true }; }
      if (!mv.allowed) {
        this.emit('toolEnd', { id: uiId, ok: false, output: mv.reason, rejected: true });
        this.pushToolResult(callId, name, mv.reason, true, {
          reason: '当前 Agent 模式不允许该操作',
          suggest: '不要重试同一操作。按当前模式的职责继续（架构模式只出方案与文档，问答模式只解释不改动），或提示用户切换模式。'
        });
        if (this.task) {
          try { await this.taskManager.appendStep(this.task.id, { kind: 'tool', name, decision: 'mode-deny', reason: mv.reason }); } catch (_) {}
        }
        return;
      }
    }

    // ---- Harness：策略引擎拦截危险写/执行 ----
    let skipApprove = false;

    // ---- Auto Mode：LLM 分类门控（allow / deny / ask），默认关 ----
    // 仅对“需要审批的动作”（写/改/删/执行）生效；读/查类工具已由 autoApprove 处理，零开销跳过。
    // 规则快路径命中即返回；LLM 兜底分类按 tool+参数 指纹缓存，不重复烧模型。
    // 此处只置 skipApprove 或拦截返回；策略引擎(policy)与 preToolUse 钩子的硬约束仍在其后执行，
    // 因此“人工规约(hook ask) > 策略引擎 > Auto Mode 自动放行”的优先级天然成立。
    if (config.conf().get('autoMode.enabled', false)) {
      const AM_KINDS = { edit: 1, write: 1, delete: 1, exec: 1 };
      if (AM_KINDS[kind]) {
        try {
          const autoMode = require('./autoMode');
          const amRes = await autoMode.classify(name, kind, args, {
            config: config.conf().get('autoMode', {}) || {},
            llm: async (prompt) => {
              const r = await this._silentCall([{ role: 'user', content: prompt }]);
              return typeof r === 'string' ? r : (r && r.text ? r.text : (r && r.content ? r.content : ''));
            }
          });
          if (amRes.decision === 'deny') {
            const amMsg = amRes.reason ? ('Auto Mode 判定拒绝：' + amRes.reason) : 'Auto Mode 判定该操作不安全而拒绝';
            this.emit('toolEnd', { id: uiId, ok: false, output: amMsg, rejected: true });
            this.pushToolResult(callId, name, amMsg, true, {
              reason: 'Auto Mode（LLM 分类门控）判定该操作不安全',
              suggest: '不要重复尝试同一操作；若确需执行，请在设置关闭 Auto Mode 或将其加入 autoMode.allow 名单，并先与用户确认。'
            });
            if (this.task) {
              try { await this.taskManager.appendStep(this.task.id, { kind: 'tool', name, decision: 'auto-mode-deny', reason: amMsg }); } catch (_) {}
            }
            return;
          }
          if (amRes.decision === 'allow') {
            skipApprove = true;
            if (amRes.reason) this.emit('notice', { text: '🤖 Auto Mode：自动放行（' + amRes.reason + '）' });
          }
          // ask → 不置 skipApprove，走下方正常审批流
        } catch (_) { /* Auto Mode 异常不影响主流程，按默认审批 */ }
      }
    }

    if (this.policy) {
      let op = null;
      const popts = { label: title };
      if (kind === 'edit' || kind === 'write' || kind === 'delete') {
        op = harness.OP.WRITE;
        popts.path = args.path;
      } else if (kind === 'exec') {
        op = harness.OP.EXEC;
        // argv 模式拼回字符串再交给策略引擎（1.1.22）：防策略只看 command 而 argv 绕过
        popts.command = Array.isArray(args && args.argv) && args.argv.length
          ? args.argv.join(' ')
          : args.command;
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

    // ---- 生命周期钩子 preToolUse：用户自定义的确定性安全门 ----
    // deny → 直接阻断；ask → 强制人工确认（可覆盖 autoApprove / 策略引擎的 auto）；allow → 显式放行。
    const preHook = await this.fireHook('preToolUse', {
      tool: name,
      kind,
      args,
      cwd: this._workspaceRoot ? this._workspaceRoot() : undefined
    });
    if (preHook.decision === 'deny') {
      const hookMsg = preHook.reason || '被生命周期钩子阻止';
      this.emit('toolEnd', { id: uiId, ok: false, output: hookMsg, rejected: true });
      this.pushToolResult(callId, name, hookMsg, true, {
        reason: '用户配置的 preToolUse 钩子阻止了该操作',
        suggest: '这是项目的硬性规约，不要重复尝试同一操作；改换方案或询问用户。'
      });
      if (this.task) {
        try { await this.taskManager.appendStep(this.task.id, { kind: 'tool', name, decision: 'hook-deny', reason: hookMsg }); } catch (_) {}
      }
      return;
    }
    if (preHook.decision === 'ask') {
      skipApprove = false; // 钩子要求人工确认，压过一切自动放行
      if (preHook.reason) this.emit('notice', { text: '🪝 ' + preHook.reason });
    }
    if (preHook.decision === 'allow' && preHook.ran > 0) skipApprove = true;

    // use_skill 始终先询问用户（用前询问），不被 autoApprove 跳过；
    // import_skill 从外部下载代码入库，同样强制先询问，不被 autoApprove 跳过
    if (name === 'use_skill' || name === 'import_skill') skipApprove = false;
    if (preHook.decision === 'ask') skipApprove = false;

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
      // 1.1.24：把工具名透传给 execute → _catalogLimit/_truncate，
      // 否则 get_tools 的「目录整条目/完整注入」分支拿不到 toolName 永远不命中，
      // 被通用 4000 上限「头60%+尾40%+中间省略」挖掉中间工具 → 模型照抄空名 → 空轮中断。
      toolName: name,
      maxToolOutput: this.cfg.maxToolOutput,
      blockedCommands: this.cfg.blockedCommands,
      recordUndo: (e) => undo.record(e),
      memory: this.memory,
      topicMemory: this.topicMemory,
      skills: this.skills,
      planTasks: this.planTasks,
      context: this.context,
      // 子代理派生入口：spawn_subagent 工具通过它拿到主会话的模型凭据与工具执行链路
      spawnSubagents: (req) => this.spawnSubagents(req),
      // 后台任务入口：提交后立刻返回，不阻塞当前对话
      runBackgroundAgent: (req) => this.runBackgroundAgent(req),
      backgroundJobs: (req) => this.backgroundJobs(req),
      onStream: (chunk) => this.emit('toolStream', { id: uiId, text: chunk }),
      // 生图工具用它把生成的图片直接渲染到聊天 UI（复用 0.8.42 的 image 渲染链路）
      emitImage: (img) => this.emit('image', img || {}),
      // 产出物预览：preview_artifact 工具触发 → chatView 在旁边开预览面板（HTML/图片/Markdown/PDF）
      emitArtifact: (art) => this.emit('artifact', art || {}),
      outsideConfirmed,
      skipConfirm: extSkipConfirm,
      // Best-of-N 多模型对比：把“调用任意候选模型”与“评委 LLM（复用 _silentCall）”能力暴露给工具层
      callModel: (c, req) => this.callCandidate(c, req),
      llm: (m, o) => this._silentCall(m, o),
      askUser: (req) => this.askUser(req),
      sessionId: this.sessionId
    };

    try {
      // 编辑类工具执行前，先把文件真实内容读出来作为审查用的“before”快照。
      // 关键：审查必须基于“文件实际状态”，而非模型传给工具的 old_text/new_text 参数——
      // 否则模型给出错误/虚假编辑（如 +0 -0 自我替换、又把 $$eval 改回 $eval）时，审查子代理会被骗，
      // 基于“模型声称的改动”而非“文件真实内容”给意见，造成误导循环。
      let _reviewBefore = null;
      if (name === 'edit_file' || name === 'write_file' || name === 'delete_file') {
        try { _reviewBefore = await ws.readText(ws.resolveUri(args.path, { allowOutside: true })); } catch (_) { _reviewBefore = null; }
        // Checkpoint：写入前把文件真实内容存档，供「一键回滚」还原
        if (this.checkpoints) {
          try {
            await this.checkpoints.snapshot(args.path, _reviewBefore, {
              tool: name,
              title,
              step: this.stepCount
            });
          } catch (_) {}
        }
      }
      // ---- 冲突感知：写前比对，若文件自读取后被外部修改则暂停等人工裁决 ----
      if (config.conf().get('conflictWatch.enabled', true) && (name === 'edit_file' || name === 'write_file')) {
        try {
          const cw = require('./conflictWatch');
          const cUri = ws.resolveUri(args.path, { allowOutside: true });
          let cStat = null;
          try { cStat = await vscode.workspace.fs.stat(cUri); } catch (_) { cStat = null; }
          if (cStat) {
            const verdict = cw.check(args.path, cStat.mtime, cStat.size);
            if (verdict.conflict) {
              const msg = '⚠️ 冲突感知：文件「' + args.path + '」自你上次读取后已被外部（很可能是你本人）修改'
                + '（上次 mtime=' + new Date(verdict.snapshot.mtime).toISOString() + '，当前 mtime=' + new Date(verdict.current.mtime).toISOString() + '）。'
                + '为避免覆盖你的改动，本次 ' + name + ' 已暂停。请先 read_file 读取最新内容，再决定如何合并，不要盲目覆盖。';
              this.emit('toolEnd', { id: uiId, ok: false, output: msg, rejected: true });
              this.pushToolResult(callId, name, msg, true, {
                reason: '冲突感知：文件在读取后被外部修改，已暂停写操作等待人工裁决',
                suggest: '先 read_file 最新内容，再决定如何合并；不要盲目覆盖。'
              });
              if (this.task) { try { await this.taskManager.appendStep(this.task.id, { kind: 'tool', name, decision: 'conflict-pause', reason: msg }); } catch (_) {} }
              return;
            }
          }
        } catch (_) { /* 冲突感知异常不阻断正常写入 */ }
      }

      // ---- 未读禁止写（硬门控）：写已存在文件前必须已读过真实内容 ----
      // 冲突感知只处理「读过之后文件变了」；本门控处理「压根没读过」——模型凭空臆测直接
      // edit_file/write_file 覆盖，正是「堆屎山（代码层/结构层）」的头号来源。
      // 规则：edit_file 必须已读；write_file 对已存在文件必须已读（新建文件无需读）。
      // 配置 foxAi.conflictWatch.requireRead 默认 true；关掉即回到纯提示词软引导。
      if (
        config.conf().get('conflictWatch.requireRead', true) &&
        (name === 'edit_file' || name === 'write_file')
      ) {
        try {
          const cw = require('./conflictWatch');
          const reqUri = ws.resolveUri(args.path, { allowOutside: true });
          let reqStat = null;
          try { reqStat = await vscode.workspace.fs.stat(reqUri); } catch (_) { reqStat = null; }
          const needRead = name === 'edit_file' || (reqStat !== null);
          if (needRead && !cw.hasRead(args.path)) {
            const msg = '⚠️ 未读禁止写：你要修改的文件「' + args.path + '」在本会话中尚未被 read_file 读取过。'
              + '为防凭空臆测覆盖、造成代码/结构越改越乱，本次 ' + name + ' 已拦截。'
              + '请先用 read_file 读取该文件真实内容（如文件较大可带 start_line/end_line 分段读，或先 search_text 定位目标），确认现状后再修改。';
            this.emit('toolEnd', { id: uiId, ok: false, output: msg, rejected: true });
            this.pushToolResult(callId, name, msg, true, {
              reason: '未读禁止写：该文件本会话尚未读过，先 read_file 再看手修改',
              suggest: '先 read_file 读取真实内容，再决定改哪里；不要凭记忆或猜测直接覆盖。'
            });
            if (this.task) { try { await this.taskManager.appendStep(this.task.id, { kind: 'tool', name, decision: 'require-read', reason: msg }); } catch (_) {} }
            return;
          }
        } catch (_) { /* 门控异常不阻断正常写入（与冲突感知一致） */ }
      }

      const output = await tools.execute(name, args, execCtx);
      // 1.1.14：get_tools 成功执行即视为「工具清单已获取」，解除首轮强制
      if (name === 'get_tools') {
        this._toolGuideFetched = true;
        this._ev(agentEvents.EV.TOOL_GUIDE_FETCHED, {});
      }
      // ★ 1.1.19 命令行写文件防护：run_command 可能被模型当作「绕过 edit_file/write_file 的替代通道」
      // （工具不可用/嫌审批麻烦时直接用 echo>、sed -i、copy 等改文件），此类改动：
      //   ① 绕过「未读禁止写/冲突感知」硬门控；② 不记录 diff → 审查看不到、UI 不显示改了什么。
      // 这里在命令执行后检测写文件特征，把改动记进 _pendingReview（供审查与 UI 展示），
      // 并追加观察提示，让模型知道「命令行改文件同样会被审查」。
      if (name === 'run_command') {
        // argv 模式同样要拼回字符串检查（1.1.22）：避免「命令行写文件」防护被 argv 数组绕过
        const cmdStr = Array.isArray(args && args.argv) && args.argv.length
          ? args.argv.join(' ')
          : String((args && args.command) || '');
        if (this._isCmdFileWrite(cmdStr) && this._pendingReview) {
          try {
            const cw = require('./conflictWatch');
            // 工作区内可能被命令改动的目标文件：优先取显式路径参数，否则扫描最近快照
            let target = null;
            const mPath = cmdStr.match(/[\w\\/.\-]+\.\w{1,10}/g);
            if (mPath) {
              for (const p of mPath.reverse()) {
                const cand = p.replace(/^["']|["']$/g, '');
                try {
                  const u = ws.resolveUri(cand, { allowOutside: true });
                  const st = await vscode.workspace.fs.stat(u);
                  if (st && st.type === vscode.FileType.File) { target = cand; break; }
                } catch (_) {}
              }
            }
            if (!target && cw.lastWritten && cw.lastWritten.path) target = cw.lastWritten.path;
            if (target) {
              const before = await this._reviewBeforeRead(target);
              const after = await ws.readText(ws.resolveUri(target, { allowOutside: true })).catch(() => null);
              const existing = this._pendingReview.find((c) => c.path === target);
              const summary = this._reviewSummary('run_command(命令行写文件)', { command: cmdStr, path: target }, before, after);
              if (existing) { existing.summary = summary; existing.op = '命令行写文件'; }
              else this._pendingReview.push({ name: 'run_command', op: '命令行写文件', path: target, summary });
              // 追加观察：命令行改文件同样会被记录与审查，后续不再需要靠命令行绕审批
              output = String(output) + '\n\n[观察] 检测到该命令可能修改了文件「' + target + '」。' +
                '命令行改文件同样会进入改动记录与代码审查（与 edit_file/write_file 同等对待），' +
                '且不受「未读禁止写」门控约束——如非必要请改用 edit_file/write_file 完成文件修改。';
              // 刷新冲突感知快照：命令改的文件视为「agent 自己写入」，避免下一轮误判为外部修改
              if (config.conf().get('conflictWatch.enabled', true)) {
                try {
                  const u = ws.resolveUri(target, { allowOutside: true });
                  let st = null; try { st = await vscode.workspace.fs.stat(u); } catch (_) { st = null; }
                  if (st) cw.noteWrite(target, st.mtime, st.size);
                } catch (_) {}
              }
            }
          } catch (_) {}
        }
      }
      this.emit('toolEnd', { id: uiId, ok: true, output });
      // ★ 会话进度快照（对齐 DSH checkpoint-policy）：每个工具执行完即记一条进度流水，
      // 模型重启/断点续跑时凭「上一步做了什么」的紧凑摘要知道自己干到哪，不用重新读历史。
      try { this._recordProgress(name, args, output); } catch (_) {}
      // 本地联网搜索类工具（web_fetch / browser / mcp 抓取类 / 原生 web_search 等）的返回里若含网址，
      // 抽出来喂给前端 harvest，使回答里的引用角标能带上可点击链接（与官方联网搜索同机制）。
      try {
        if (NETWORK_ONLY_TOOL_RE.test(name) && output && /https?:\/\//.test(String(output))) {
          const urls = String(output).match(/https?:\/\/[^\s，。；、）)】\]]+/g) || [];
          const seen = new Set();
          const lines = [];
          let i = 0;
          for (const u of urls) {
            if (seen.has(u)) continue;
            seen.add(u);
            i++;
            const host = u.replace(/^https?:\/\//, '').split('/')[0] || u;
            lines.push('[' + i + '] ' + host + '\nURL: ' + u);
          }
          if (lines.length) this.emit('searchSources', { text: lines.join('\n') });
        }
      } catch (_) {}
      // ---- 冲突感知：read_file 成功后记录快照，供后续写前比对 ----
      if (name === 'read_file' && args && args.path && config.conf().get('conflictWatch.enabled', true)) {
        try {
          const cw = require('./conflictWatch');
          const rUri = ws.resolveUri(args.path, { allowOutside: true });
          let rStat = null;
          try { rStat = await vscode.workspace.fs.stat(rUri); } catch (_) { rStat = null; }
          if (rStat) cw.recordRead(args.path, rStat.mtime, rStat.size);
        } catch (_) { /* 快照记录失败不影响读结果 */ }
      }
      // ---- Harness：自动验证层 ----
      let finalOutput = output;
      const verifyNote = await this._autoVerify(name, args, output);
      if (verifyNote) finalOutput = output + '\n\n[自动验证] ' + verifyNote;
      // ---- 生命周期钩子 postToolUse：自动 lint / 格式化 / 追加观察 ----
      const postHook = await this.fireHook('postToolUse', { tool: name, kind, args, output: String(output || '') });
      if (postHook.injects.length) finalOutput = finalOutput + '\n\n' + postHook.injects.join('\n');
      if (postHook.decision === 'deny' && postHook.reason) {
        finalOutput = finalOutput + '\n\n[钩子告警] ' + postHook.reason;
      }
      const okMeta = {};
      if (name === 'run_command') {
        const cm = String(output).match(/退出码\s*(\-?\d+)/);
        if (cm) okMeta.okNote = `命令退出码 ${cm[1]}`;
      }
      // ---- 记录改动，供自动代码审查使用 ----
      // 记录“文件真实内容”的 before/after，而非模型声明参数；同文件多轮编辑合并为一条。
      if (name === 'edit_file' || name === 'write_file' || name === 'delete_file') {
        let after = null;
        if (name !== 'delete_file') {
          try { after = await ws.readText(ws.resolveUri(args.path, { allowOutside: true })); } catch (_) { after = null; }
          // 冲突感知：写入成功后刷新该文件快照，避免把 agent 自己的写入当成“外部修改”
          if (config.conf().get('conflictWatch.enabled', true)) {
            try {
              const cw = require('./conflictWatch');
              const aUri = ws.resolveUri(args.path, { allowOutside: true });
              let aStat = null; try { aStat = await vscode.workspace.fs.stat(aUri); } catch (_) { aStat = null; }
              if (aStat) cw.noteWrite(args.path, aStat.mtime, aStat.size);
            } catch (_) {}
          }
        }
        const summary = this._reviewSummary(name, args, _reviewBefore, after);
        const existing = this._pendingReview.find((c) => c.path === args.path);
        if (existing) {
          // 合并同文件：before 保留首轮、after 取最新，避免重复条目让审查模型困惑
          existing.after = after;
          existing.summary = summary;
          existing.op = name === 'write_file' ? '新增/覆盖' : name === 'delete_file' ? '删除' : '修改';
        } else {
          this._pendingReview.push({
            name,
            path: args.path,
            op: name === 'write_file' ? '新增/覆盖' : name === 'delete_file' ? '删除' : '修改',
            before: _reviewBefore,
            after,
            summary
          });
        }
        // 记录产物（任务完成后统一展示）：按路径去重合并，同文件多轮编辑只保留最新操作
        const artifactOp = name === 'delete_file'
          ? '删除'
          : (name === 'write_file' && _reviewBefore == null ? '新增' : name === 'write_file' ? '覆盖' : '修改');
        const ds = ws.diffStat(_reviewBefore || '', name === 'delete_file' ? '' : (after || ''));
        const artExisting = this._artifacts.find((x) => x.path === args.path);
        if (artExisting) {
          artExisting.op = artifactOp;
          artExisting.name = name;
          artExisting.added = ds.added;
          artExisting.removed = ds.removed;
        } else {
          this._artifacts.push({ name, path: args.path, op: artifactOp, added: ds.added, removed: ds.removed });
        }
      }
      // 记录 read_file 调用（用于去重）—— 成功执行后存档，按「路径+区间」签名区分，避免不同区间被误判为重复；
      // key 额外带 mtime/size 内容签名，供 cacheDedup 判断「文件是否被改动过」（改了则视为新调用，绝不返回旧内容）。
      if (name === 'read_file' && args && args.path) {
        if (!this._readFileHistory) this._readFileHistory = [];
        let contentSig = '';
        try {
          const st = fs.statSync(args.path);
          if (st) contentSig = Math.floor(st.mtimeMs) + ':' + st.size;
        } catch (_) {}
        this._readFileHistory.push({
          path: args.path,
          sig: readFileSig(args.path, args),
          key: readFileSig(args.path, args) + '|' + contentSig,
          time: Date.now()
        });
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
      const rawBefore = await ws.readText(uri);
      const result = ws.previewEditFile(args, rawBefore);
      return {
        path: ws.relative(uri),
        existed: true,
        stat: ws.diffStat(result.before, result.after),
        text: ws.unifiedPreview(result.before, result.after),
        before: result.before,
        after: result.after
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
    // 纯策略判定已迁至 src/approvalPolicy.js（可单测、可在 headless/测试环境复用），
    // approve() 只保留「依赖实例状态」的 UI 交互部分（this.state/this.ui/this._pendingApproval）。
    const kind = req.kind;
    const auto = approvalPolicy.decideApproval(this.cfg, this.alwaysAllow, req.name, kind);
    if (auto === 'approve') return 'approve';
    // 越权风控（1.1.39）：没有审批 UI 时绝不静默放行高危操作（写/执行/删除）。
    // 只读类在上面已放行；其余一律返回 reject（由 handleToolCall 拦截并回传模型），
    // 宁可少做不可越权——UI 缺失属架构异常，不能退化为「默认放行」。
    if (typeof this.ui.requestApproval !== 'function') return kind === 'read' ? 'approve' : 'reject';

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
    // 审批决策已出，立即恢复运行状态，避免状态栏长时间卡在“等待你确认操作…”
    this.state = 'running';
    this.emit('state', { state: 'running' });
    if (decision === 'always') {
      this.alwaysAllow.add(req.name);
      return 'approve';
    }
    return decision;
  }

  /** 向用户澄清（clarify 工具）：弹窗让用户点选建议或自行输入补充要求，返回用户答复文本。 */
  async askUser(req) {
    if (typeof this.ui.requestClarify !== 'function') return null;
    const id = 'cl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    return await new Promise((resolve) => {
      this.ui.requestClarify({ id, question: req.question, options: req.options || [] }, (answer) => {
        resolve(answer == null ? '' : String(answer));
      });
    });
  }

  pushToolResult(callId, name, output, isError, meta) {
    meta = meta || {};
    // 1.1.24（删减重构）：截断收敛到单一真相源 tools/execute → _truncate。
    // 这里曾对 execute 已截断的结果再做一次「头60%+尾40%+中间省略」二次截断：
    // get_tools 目录若走完整/整条目，会被这层再挖一遍中间工具 → 空轮中断；
    // 且对 read_file 等大输出，execute 已按 maxToolOutput 截完，这里再截纯重复。
    // 删除二次截断，文本原样进入消息历史（trimHistory 只做防撑爆的兜底 clamp）。
    let text = String(output == null ? '' : output);
    // —— 1.1.26（对齐 dsh compaction-tool-result-pruner）：源头结果裁剪 ——
    // fox-ai「每次会话 100% 卡死」根因：read_file 等大结果（可达 30000 字）原样进历史，
    // 读几段就撑到 100% → 压缩触发时 retainTokens 尾部预算被几条大结果占满 → compressible≈0
    // →「可压缩消息不足」→ 不压 → 模型丢已读记忆重读 → 死循环。
    // dsh 做法：工具结果超 thresholdChars(8192) 在进历史前就裁成 头 headChars(4096) + 标记 + 尾 tailChars(1024)，
    // 历史里永远没有大块头 → 上下文不会几分钟就 100%。
    // 与 1.1.24 删除的「二次截断」区别：旧的是「execute 截完后再挖一遍」（get_tools 被二次挖洞）；
    // 新的是「源头一刀 + 目录豁免 + 带显式裁剪标记 + read_file 分段续读提示」，语义完全不同。
    if (!isError && text.length > 8192) {
      const isCatalog = name === 'get_tools' || name === 'get_tool_catalog';
      if (!isCatalog) {
        const head = text.slice(0, 4096);
        const tail = text.slice(-1024);
        const hint = (name === 'read_file')
          ? '\n\n[结果中间已裁] read_file 完整结果超预算，中间已省略（原始文件仍在磁盘）。'
            + '如需中间内容，请继续用 start_line/end_line 分段读取剩余区间；每段结果都会保留头尾，'
            + '不同区间不会被判为重复读取。'
          : '\n\n[... tool result middle pruned ...]（工具结果中间已裁剪；如需完整内容请用更精准的检索/分段重新获取）';
        text = head + hint + '\n' + tail;
      }
      // 目录类工具（get_tools）豁免：目录完整性是硬语义——整条目/完整返回，
      // 绝不让中间工具从模型视野消失（否则空轮中断）。
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
   * 知识库注入（统一入口，1.1.33）。
   *
   * 情况一：只配了「整理模型」→ retrieveAsync 内部检测到向量模型未启用，
   *         直接走原来的同步 BM25 / 整理模式全量注入，行为与旧版一字不差。
   * 情况二：整理模型 + 向量模型都配了 → 向量模型先做语义召回（前置），
   *         整理模型继续负责产出笔记（在后），向量只读它的产物。
   * 任何异常都回退到同步版，保证知识库永不因向量服务抖动而失效。
   * @param {string} baseSystem 静态系统提示词
   * @param {string} queryText 当前用户提问
   * @returns {Promise<string>} 注入知识库参考后的提示词（未命中则原样返回）
   */
  /**
   * 知识库技能提示（RAG 纯工具化，对齐 DSH 1.1.25）。
   * dsh（deepseek-harness）权威模型：知识库本身是「工具」（inbox/use_skill 式按需调取），
   * 不进每轮请求前缀——每轮灌 4000+ token 知识 = 前缀膨胀 + 缓存命中率崩 + 外层截断时知识残缺。
   * 这里只返回一行技能提示（几十字），agent 需要时自行调用
   * use_skill(name=_knowledge_base, query=…) 按需检索。
   * @returns {Promise<string>} 技能提示文本（独立返回，不含 baseSystem，零差集）
   */
  async _buildKnowledgeHint() {
    try {
      const fileCount = kb.listKnowledgeFiles(this.sessionId).length;
      return fileCount > 0
        ? '【知识库技能】检测到知识库已就绪（' + fileCount + ' 个文档）。'
          + '当用户问题需要参考知识库文档时，请调用 use_skill 激活内置技能「知识库检索」'
          + '（use_skill name=_knowledge_base，query 传用户问题的关键词）获取相关知识后再回答；'
          + '若问题与知识库无关，直接回答即可，无需调取。'
        : '【知识库技能】知识库为空（尚未整理文档）。不需要调用 use_skill(_knowledge_base)，直接基于通用知识回答。';
    } catch (_) {
      return '【知识库技能】知识库已就绪。需要参考时用 use_skill 激活「知识库检索」（name=_knowledge_base）。';
    }
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
    const msgs = this.messages || [];

    // —— 1.1.18e：保留侧从「最近 N 条」升级为「token 预算」（对齐 DSH retainTokens）——
    // DSH（deepseek-harness）compaction 默认 retainRatio=0.16：压缩时从尾部倒数累加 token，
    // 够保留预算就停（并向前回退到不切断工具对边界），而不是固定保留最近 N 条消息。
    // fox-ai 之前的 keepRecent 只按条数保留：工具输出可能一条就几 K token，条数够了但 token
    // 可能还是巨多 → 低命中厂商（中转 cached≈0）每轮仍发大量历史、纯 miss 计费。
    // 这里改为「token 预算保留」：默认保留最近 16%（retainTokens 未配置时按上下文窗口估算），
    // 并让低命中厂商（连续低命中缓存）自动把保留预算收窄 60%~90%，每轮少发历史、少 miss。
    const { estimateMessages } = contextUsage;
    const keep = Math.max(2, as.keepRecent || 6);
    // token 预算：显式 retainTokens 优先，否则取 keepRecent 条消息的 token 量（向后兼容），
    // 否则按上下文窗口 16%（DSH retainRatio）估算，兜底 6k。
    let retainTokens = 0;
    if (as.retainTokens > 0) {
      retainTokens = as.retainTokens;
    } else if (as.keepRecent && as.keepRecent > 0) {
      const tail = msgs.slice(Math.max(0, msgs.length - keep));
      retainTokens = estimateMessages(tail);
    } else if (cw > 0) {
      retainTokens = Math.max(2000, Math.round(cw * 0.16));
    } else {
      retainTokens = 6000;
    }
    // 低命中厂商自动收窄（衔接 _onCacheUsage 的自适应预算逻辑）：
    // 连续低命中轮次（缓存命中<5% 且 cached<100）时按阶梯把保留 token 预算收窄，
    // 让中转厂商每轮少发历史；命中恢复后回弹到基础值。
    const lowStreak = this._cacheLowHitStreak || 0;
    if (lowStreak >= 2) {
      const shrinkSteps = [0.6, 0.75, 0.9];
      const shrink = shrinkSteps[Math.min(lowStreak - 2, shrinkSteps.length - 1)];
      retainTokens = Math.max(1200, Math.round(retainTokens * (1 - shrink)));
    }
    // 保留预算至少留最近 2 条（防压缩时把刚发的话也裁掉）
    const tailMin = estimateMessages(msgs.slice(Math.max(0, msgs.length - 2)));
    retainTokens = Math.max(retainTokens, tailMin);
    // 从尾部倒数累加 token 找「保留起点」（对齐 DSH selectCompactableRange：累计到 retainTokens）
    let keepFrom = msgs.length;
    let accTok = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const t = estimateMessages([msgs[i]]);
      if (accTok + t > retainTokens) break;
      accTok += t;
      keepFrom = i;
    }
    // 向前回退避免切断 tool 对（assistant(tool_calls)+tool 结果必须一起保留）
    while (keepFrom > 0 && msgs[keepFrom - 1] && msgs[keepFrom - 1].role === 'tool') keepFrom--;
    if (keepFrom > 0 && msgs[keepFrom - 1] && msgs[keepFrom - 1].role === 'assistant' && msgs[keepFrom - 1].tool_calls) {
      const ids = new Set(msgs[keepFrom - 1].tool_calls.map((t) => t.id));
      let i = keepFrom;
      while (i < msgs.length && msgs[i] && msgs[i].role === 'tool' && ids.has(msgs[i].tool_call_id)) i++;
      if (i > keepFrom) keepFrom = i; // 该 assistant 的 tool 结果都在保留区，整对保留
    }
    const compressible = keepFrom;
    this._lastRetainTokens = retainTokens;
    this._lastKeepFrom = keepFrom;

    // 触发条件（满足其一即可）：
    //  A. 配置了上下文窗口且占用超阈值（防超窗口）——默认阈值 0.75。
    //     此时不再受 compressible<4 限制：防止单条/少量超大消息把上下文撑爆，
    //     却因「消息轮数不够」而永远不被压缩。
    //  B. 未配置上下文窗口时，按对话轮数触发（累计约 6 条可压缩消息 ≈ 每 3 轮做一次增量摘要），
    //     保证能力⑥「每 3 轮摘要」在没填 contextWindow 时也能达成，而不是永远不压缩。
    const threshold = as.threshold > 0 ? as.threshold : 0.75;
    let should = false;
    let reason = '';
    let dataBefore = null;
    if (cw) {
      const baseSys = buildSystemPrompt(this.cfg, envBrief || '', this.protocol);
      const toolsText = this.protocol === 'native'
        ? JSON.stringify(tools.toOpenAITools())
        : tools.toTextManual();
      // 与面板 _emitContextUsage 统一口径：包含系统提示词、工具定义、历史、预留输出槽
      dataBefore = contextUsage.measureContext({
        baseSystem: baseSys,
        toolsText,
        history: msgs,
        maxTokens: this.cfg.maxTokens || 0,
        contextWindow: cw
      });
      if (dataBefore.percentage / 100 >= threshold) { should = true; reason = 'usage'; }
    } else if (compressible >= 6) {
      should = true;
      reason = 'turn-based';
    }
    const usedPct = dataBefore ? Math.round(dataBefore.percentage) : 0;
    this._ctxStepSeq = (this._ctxStepSeq || 0) + 1;
    // 1.1.18e：记录保留预算供日志/面板展示（对齐 DSH retainTokens 语义）
    const retainInfo = as && (as.retainTokens || this._lastRetainTokens)
      ? ` retain=${this._lastRetainTokens || as.retainTokens}`
      : '';
    const statusStep = (title, detail) => this.emit('step', {
      id: 'ctx-' + Date.now() + '-' + this._ctxStepSeq,
      kind: 'system_status',
      stepType: 'system_status',
      title: title || '上下文状态',
      detail,
      status: 'ok',
      group: 'info',
      timestamp: Date.now()
    });
    if (!should) return;
    if (compressible < 1) {
      // 已超阈值但没有可压缩的对话消息：占用主要来自固定开销（系统提示词、工具定义、知识库等）
      const denom = dataBefore.contextWindow || cw || 1;
      const fixedPct = dataBefore ? Math.round(((dataBefore.totalMeasured - dataBefore.historyTokens) / denom) * 100) : 0;
      appendLog('autoSummarize', '[skip] no compressible messages; fixed cost dominates ~' + fixedPct + '%');
      statusStep('上下文状态', `上下文已用约 ${usedPct}%，但可压缩的对话消息不足。当前占用主要由系统提示词、工具定义、知识库/任务/记忆等固定开销构成，无法通过压缩释放。如需减少占用，可关闭不用的 MCP/工具或缩小知识库范围。`);
      return;
    }

    // 取较早消息去压缩，保留最近 keep 条
    const { clampMessage } = require('./messageSanitize');
    // 1.1.24（删减重构）：clamp 只是「防单条超大消息撑爆压缩输入」的内存兜底，
    // 不再用 8000 硬砍——否则 get_tools 完整目录历史（可达数万字）被压缩路径挖掉中间工具，
    // 与 _truncate 的中间省略同罪。上限提到与 trimHistory 同口径的 128000，目录可完整进入压缩。
    const toCompress = msgs.slice(0, compressible).map((m) => clampMessage(m, 128000));
    appendLog('autoSummarize', '[compress] used%=' + usedPct + ' threshold%=' + Math.round(threshold * 100) + ' compressible=' + toCompress.length + ' reason=' + reason);
    statusStep('上下文压缩', `上下文已用约 ${usedPct}%，正在把较早的 ${toCompress.length} 条对话压缩进知识库-2…`);

    try {
      const out = await kbOrg.summarizeConversation(this.context, toCompress, {
        onLog: (t) => { try { statusStep('上下文压缩', '[知识库-2] ' + t); } catch (_) {} },
        sessionId: this.sessionId,
        protocol: this.protocol
      });
      if (out) {
        kb.invalidate(); // 重新索引，把新摘要纳入 RAG
        msgs.splice(0, compressible); // 就地裁剪，保持数组引用一致（chatView 同步看到）
        appendLog('autoSummarize', '[ok] compressed=' + toCompress.length + ' file=' + out);

        // 压缩完成后立即刷新上下文用量面板：用统一口径重新计算，让用户看到「对话消息」部分已释放
        if (dataBefore) {
          try {
            const dataAfter = contextUsage.measureContext({
              baseSystem: dataBefore.raw.baseSystem,
              toolsText: dataBefore.raw.toolsText,
              history: msgs,
              maxTokens: this.cfg.maxTokens || 0,
              contextWindow: cw
            });
            dataAfter.compressMeta = this._buildCompressMeta();
            this.emit('contextUsage', dataAfter);
          } catch (_) {}
        }

        statusStep('上下文压缩', `已把较早 ${toCompress.length} 条对话压缩进知识库-2，上下文已释放；后续回答会结合检索到的摘要继续。`);
      }
    } catch (e) {
      const reason = String(e.message || '').split('\n')[0];
      appendLog('autoSummarize', '[fail] ' + reason);
      // —— 零 token 兜底（关键修复 Bug④）——
      // 当没有「上下文整理」的 API Key、或可达性/配额问题时，远程摘要必然失败。
      // 若只 emit 通知就 return，会陷入「每次都失败、messages 持续膨胀、重载易丢内容」的死循环。
      // 这里做一次性本地裁剪：把最早 compressible 条对话就地折叠成一条系统标记，不调用任何模型，
      // 既不费 token，也保证上下文有界、存档可控、重载可见。
      try {
        const collapse = Math.max(1, compressible);
        const dropped = msgs.slice(0, collapse);
        msgs.splice(0, collapse);

        // —— 1.1.18：本地折叠存档 + 语义要点提取（对齐 DSH checkpoint 思想）——
        // 旧实现只 splice 丢消息 + 插一条无语义系统标记 → 模型完全不知道旧任务做了什么，
        // 长任务折叠后模型只能看到「[本地折叠]」，导致对话「变成 @文件引用」（模型被迫让用户
        // 贴文件/找不到旧内容）。现在：① 从被折叠消息提取语义要点（用户意图/工具调用/文件路径/
        // 结论）；② 落盘折叠档案到 ~/.fox-ai/compacted/<sessionId>-<ts>.json；③ 折叠标记携带
        // 要点摘要 + 档案路径，后续轮次模型能看到「旧任务做了什么、去哪检索」，不再一片空白。
        let archivePath = '';
        let summaryText = '';
        try {
          const points = [];
          // text 协议下工具结果是无 name 字段的 user 消息，工具名藏在 content 前缀「[工具 X 的结果]」里。
          // 折叠摘要必须解析出真实工具名，否则 read_file 结果被折叠成「工具[]」，模型不知道已读过什么 → 重读死循环。
          const TOOL_RESULT_RE = /^\[工具\s+([\w.:-]+)\s+的结果\]/;
          // 读取类工具：返回的是「内容 / 定位 / 目录」——模型"看到内容"的来源。
          // 折叠时对它们生成【已读锚点】，明确告知已读范围，防止模型误以为没读而重复 read_file 同分段。
          const READ_TOOLS = new Set(['read_file', 'list_dir', 'glob', 'grep', 'search_text', 'find_files', 'index_codebase', 'query_code_graph', 'read_terminal', 'get_diagnostics', 'retrieve_knowledge']);
          for (const m of dropped) {
            if (!m || !m.role) continue;
            const c = typeof m.content === 'string' ? m.content : m.content ? JSON.stringify(m.content) : '';
            if (!c || !c.trim()) continue;
            const s = c
              .replace(/<foxtool[\s\S]*?<\/foxtool>/gi, '')
              .replace(/\[\[tool:[\s\S]*?\[\/tool\]\]/gi, '')
              .trim();
            if (!s) continue;
            // text 协议工具结果消息 role=user 但 content 以「[工具 X 的结果]」开头。
            // 必须最先检测此前缀：否则折叠时被当成普通用户消息截 160 字，模型不知道已读过什么 → 重读死循环。
            const prefixName = TOOL_RESULT_RE.exec(s) ? TOOL_RESULT_RE.exec(s)[1] : '';
            const isToolResult = !!prefixName || m.role === 'tool';
            if (isToolResult) {
              const name = String(m.name || m.toolName || '').slice(0, 30) || prefixName;
              const body = s.replace(/^\[工具\s+[\w.:-]+\s+的结果\]\s*/, '').trim();
              const paths = (body.match(/[A-Za-z]:[\\/:][^\s"']+|(?:\/[\w.-]+){2,}/g) || []).slice(0, 4);
              const pathHint = paths.length ? ' 文件:' + paths.join(',') : '';
              if (READ_TOOLS.has(name)) {
                // 读取类工具：生成【已读锚点】——模型读到这一行就知道"已读过哪些文件哪个范围"，无需重读
                points.push('【已读】' + name + pathHint + '（内容已折叠，无需重读同区间；可检索引用）');
              } else {
                points.push('工具[' + (name || '工具') + ']: ' + body.slice(0, 120) + pathHint);
              }
            } else if (m.role === 'user') points.push('用户: ' + s.slice(0, 160));
            else if (m.role === 'assistant') points.push('结论: ' + s.slice(-240));
          }
          if (points.length) {
            const compactDir = path.join(os.homedir(), '.fox-ai', 'compacted');
            if (!fs.existsSync(compactDir)) fs.mkdirSync(compactDir, { recursive: true });
            const ts = Date.now();
            archivePath = path.join(compactDir, (this.sessionId || 'session') + '-' + ts + '.json');
            fs.writeFileSync(archivePath, JSON.stringify({
              ts,
              sessionId: this.sessionId || '',
              reason: String(reason || '').slice(0, 80),
              droppedCount: dropped.length,
              summary: points.slice(0, 60),
              rawDropped: dropped.map((m) => ({
                role: m.role,
                name: m.name || '',
                content: String(m.content || '').slice(0, 2000)
              }))
            }, null, 2), 'utf8');
            summaryText = points.slice(0, 30).map((p) => '· ' + p).join('\n');
            appendLog('autoSummarize', '[fallback-local][archive] ' + archivePath + ' summaryPoints=' + points.length);
          }
        } catch (ae) {
          appendLog('autoSummarize', '[fallback-local][archive-err] ' + String(ae && ae.message || ae));
        }

        const note = {
          role: 'system',
          content: `[本地折叠] 因自动压缩不可用（${reason.slice(0, 80)}），已在本机把最早的 ${dropped.length} 条对话就地折叠以释放上下文空间。`
            + (archivePath ? `\n折叠档案：${archivePath}` : '')
            + (summaryText ? `\n折叠前要点：\n${summaryText}` : '\n原始内容未做语义摘要（存档失败），如需完整回顾请改用带有效 API Key 的上下文整理。')
            + `\n【重要】折叠前已完成的「读取类工具」（read_file / list_dir / glob / grep / search_text 等）在上面要点中以【已读】标记列出——这些文件内容已读取过，无需重复调用 read_file 读取同一文件或同一行号区间；如需引用内容，请基于要点中的路径结论继续，或使用检索类工具定位新信息。`
        };
        msgs.unshift(note);
        appendLog('autoSummarize', '[fallback-local] collapsed=' + dropped.length);
        if (dataBefore) {
          try {
            const dataAfter = contextUsage.measureContext({
              baseSystem: dataBefore.raw.baseSystem,
              toolsText: dataBefore.raw.toolsText,
              history: msgs,
              maxTokens: this.cfg.maxTokens || 0,
              contextWindow: cw
            });
            dataAfter.compressMeta = this._buildCompressMeta();
            this.emit('contextUsage', dataAfter);
          } catch (_) {}
        }
      } catch (e2) {
        appendLog('autoSummarize', '[fallback-local][err] ' + String(e2 && e2.message || e2));
      }
      // 同一会话内只提示一次，避免每步刷屏
      if (!this._autoSummaryDisabledNoticed) {
        this._autoSummaryDisabledNoticed = true;
        statusStep('上下文压缩', '上下文自动压缩当前不可用（缺少有效的「上下文整理」API Key 或调用失败），已改为本机零 token 折叠旧消息来释放空间；设置有效的 API Key 后才会恢复语义摘要。');
      }
    }
  }

  /** 裁剪历史，保证 tool 消息不与对应的 assistant 分离 */
  _emitContextUsage(parts) {
    try {
      this._lastContextParts = parts;
      const toolsText = parts.protocol === 'native'
        ? JSON.stringify(tools.toOpenAITools())
        : tools.toTextManual();
      // 缓存工具定义文本：流式期间 _emitContextUsageDelta 每 ~100 字触发一次，
      // 每次都重序列化全量工具 schema（sanitizeSchema × N + 排序）非常浪费 CPU，
      // 而 tools 字段已字节稳定（toOpenAITools 对云端固定全集），缓存完全安全。
      this._lastToolsText = toolsText;
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
      data.compressMeta = this._buildCompressMeta();
      this.emit('contextUsage', data);
    } catch (_) {}
  }

  _buildCompressMeta() {
    try {
      return contextUsage.buildCompressMeta(this.cfg && this.cfg.autoSummarize, (this.messages || []).length);
    } catch (_) {
      return null;
    }
  }

  /** 基于本轮输出长度增量，实时估算+重推上下文用量 */
  _emitContextUsageDelta(extraChars) {
    try {
      if (!this._lastContextParts) return;
      const parts = this._lastContextParts;
      const extraTokens = Math.max(1, Math.round(extraChars / 2));
      const history = [...(parts.history || [])];
      history.push({ role: 'assistant', content: '█'.repeat(Math.min(extraChars, 200)) });
      const toolsText = this._lastToolsText || (parts.protocol === 'native'
        ? JSON.stringify(tools.toOpenAITools())
        : tools.toTextManual());
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
      data.compressMeta = this._buildCompressMeta();
      this.emit('contextUsage', data);
    } catch (_) {}
  }

  trimHistory() {
    const { trimHistory: clean, stripOldImageBase64 } = require('./messageSanitize');
    const cfg = this.cfg || {};
    // 运行期就地释放超出保留窗口的历史图片 base64，避免几 MB 的大字符串常驻 this.messages。
    // 只清「更早的图片」，最近 keepImageTurns 轮的图片仍保留供模型回看。
    if (Array.isArray(this.messages) && this.messages.length) {
      try {
        const removed = stripOldImageBase64(this.messages, cfg.keepImageTurns || 1);
        if (removed && !this._warnedImageFree) {
          this._warnedImageFree = true;
          this.emit('notice', { text: `已释放 ${removed} 张较早图片的 base64（移出上下文以省内存），如需重看请重新上传。` });
        }
      } catch (_) {
        // 清理失败不应阻断正常发送
      }
    }
    return clean(this.messages, this.protocol, cfg.maxHistory || 20, {
      // 1.1.24（删减重构）：maxBytesPerMessage 不再复用 maxToolOutput（4000）——
      // 那会把 get_tools 完整目录（整条目/完整注入）历史再挖一遍中间工具 → 空轮中断。
      // 这里只做「防单条消息撑爆内存」的兜底 clamp，截断已收敛到 execute → _truncate 单一真相源。
      maxBytesPerMessage: cfg.maxMessageBytesPerMsg || 128000,
      maxTotalBytes: cfg.maxMessageBytes || 1024 * 1024,
      maxHistoryTokens: cfg.maxHistoryTokens || 0
    });
  }

  /**
   * 就地裁剪 this.messages，防止关闭自动压缩时消息数组无限增长。
   * 保留最近 N 条（含 tool 对），丢弃更早的消息。
   */
  _compactMessages() {
    const cfg = this.cfg || {};
    // 历史 token 预算（前缀缓存优化）：优先按 token 预算裁剪源历史（窗口大、低频、前缀稳定、命中率高）；
    // 未配置 token 预算才退回固定条数（旧行为）。裁剪同样不能切断 assistant(tool_calls)+tool 结果对。
    const tokenBudget = cfg.maxHistoryTokens > 0 ? cfg.maxHistoryTokens : 0;
    if (tokenBudget > 0) {
      const { estimateTokens, messageText } = require('./contextUsage');
      let totalTok = 0;
      for (const m of this.messages) totalTok += estimateTokens(messageText(m)) + 4;
      if (totalTok <= tokenBudget) return;
      let start = 0;
      while (totalTok > tokenBudget && start < this.messages.length - 4) {
        const removed = this.messages[start];
        let removeCount = 1;
        if (removed.role === 'assistant' && removed.tool_calls) {
          const ids = new Set(removed.tool_calls.map((t) => t.id));
          let i = start + 1;
          while (i < this.messages.length && this.messages[i].role === 'tool' && ids.has(this.messages[i].tool_call_id)) { i++; removeCount++; }
        }
        for (let i = 0; i < removeCount && start < this.messages.length; i++) {
          totalTok -= estimateTokens(messageText(this.messages[start])) + 4;
          this.messages.splice(start, 1);
        }
      }
      while (this.messages.length && this.messages[0].role === 'tool') this.messages.shift();
      return;
    }
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
 * @param {boolean} officialSearchStarted 历史参数（保留签名兼容）；1.1.17 起不再用于「永久粘连」
 * @param {Array} [openAiTools] 当前完整工具集（含 web_search + 全部合法 function 工具），用于
 *   在强制官方搜索时合并「核心本地文件/诊断/终端工具」，避免误触发时文件能力被剥。
 * @returns {null | {tools:Array, toolChoice:Object|undefined, started:boolean, query:string}}
 *   - null 表示本次不应强制「仅官方搜索」模式：交还完整工具集（含本地 file 工具 + web_search）
 *   - 否则返回「官方 web_search + 除纯联网抓取类以外的全部本地能力工具」的混合集：首轮强制 tool_choice 触发联网，
 *     后续轮放开（auto），模型既能官方联网、又能用任意本地能力工具（生图/识图/沙盒/技能/记忆/文件/终端…），
 *     杜绝「只剩 web_search 」或「白名单漏写导致某能力工具被剥」的 Bug（1.1.30 起改为反向过滤）。
 *
 * 关键约束与 1.1.17/1.1.18/1.1.19/1.1.30 修复（对应伙伴反馈「智能体模式下没有工具能用」）：
 *   1) 1.1.17 修复永久粘连：仅「本次请求本身」时效才强制官方搜索；非时效追问返回 null 交还完整集。
 *   2) 1.1.18 修复泛指词误触发：从时效正则移除「当前/现在/此刻/现阶段」，否则「当前有什么工具」
 *      也被误判为时效、强制 web_search-only，模型便脑补出 search/open_page/find_in_page 等不存在的工具。
 *   3) 1.1.19 双保险：即使本分支被触发，也不再只发 web_search，而是「web_search + 核心本地 file 工具」
 *      （read_file/write_file/edit_file/list_dir/run_command/get_diagnostics 等），从根本上保证文件操作能力
 *      永不被剥；仅排除可能用于抓网页的网络类本地工具（mcp__* / fetch 等），仍以官方 web_search 承担联网。
 *   4) 1.1.30 通用防掉工具（根治「白名单漏写 → 能力被剥」）：1.1.19 的「核心本地 file 工具」仍是一份
 *      写死白名单，新增工具（如 generate_image 生图）若漏写就会在时效分支被剥掉。本版改为**反向过滤**——
 *      只剔除与官方 web_search 重复的「纯联网抓取类工具」（mcp__* / web_fetch / fetch-url / browser 等），
 *      其余一切本地能力工具（生图 / 识图 / 沙盒 / 技能 / 记忆 / 文件 / 终端 / 诊断 …）一律保留。
 *      今后新增任何本地能力工具都会自动保留，不再出现漏写白名单导致能力丢失的回归。
 */
// 纯联网抓取类工具（与官方 web_search 能力重复，本地搜索工具 URL 收割也复用此正则判定）
const NETWORK_ONLY_TOOL_RE = /^(mcp__|web_fetch|fetch[_-]?url|browser|scrape|crawl|open_page|find_in_page)|web_search$/i;

function computeOfficialSearch(payload, officialSearchStarted, openAiTools) {
  const lastUser = [...payload].reverse().find((m) => m && m.role === 'user');
  const ut = lastUser
    ? (typeof lastUser.content === 'string' ? lastUser.content : (lastUser.content || []).map((c) => (c && c.text) || '').join(''))
    : '';
  const timely = /(今天|今日|昨天|明天|本周|本月|今年|最新|最近|实时|新闻|排行|排名|榜单|股价|价格|汇率|天气|赛事|发布会|更新|发布|刚刚|怎么查|怎么看|哪里可以|202[0-9]年|202[0-9]-)/.test(ut);
  // 用户明确表达「想用本地工具 / 不要官方联网」时，交还完整工具集（含本地 file 工具）
  const userWantsLocal = /(用\s*mcp|用\s*本地|本地\s*工具|别\s*联网|不要\s*联网|关闭\s*搜索|关掉\s*搜索|自己\s*搜|用\s*fetch|直接\s*fetch|别\s*用\s*官方)/i.test(ut);

  // —— 1.1.17 修复：官方搜索「仅当次时效」而非「永久粘连」 ——
  // 旧逻辑：officialSearchStarted 一旦置真，后续所有轮次都被覆盖为仅 [{type:'web_search'}]，
  // 导致 read_file/edit_file/write_file 被永久剥夺。
  // 新逻辑：仅当「本次请求本身」时效（且用户没明确要本地工具）才强制 web_search；
  // 否则返回 null → 调用方保留完整工具集（toOpenAITools 已含 web_search + 全部本地 file 工具），
  // 模型既能在需要时主动用官方联网，又不会再丢失本地工具。
  if (!timely || userWantsLocal) return null;

  // 本次确实时效性 → 强制官方 web_search，并保留「除纯联网抓取类以外的全部本地能力工具」。
  //
  // 1.1.30 通用防掉工具方案（根治「白名单漏写 → 工具被剥」）：
  //   上游 toOpenAITools 在 deepseek+responses 下已用正则剔除 MCP/含非法字符的网络抓取类工具，
  //   进入本函数的 openAiTools 已只剩有独立能力的本地 function 工具。官方 web_search 只替代
  //   「联网检索」这一种能力，绝不应当顺手剥掉生图 / 识图 / 沙盒 / 技能 / 记忆 / 文件 / 终端 / 诊断等
  //   任何其他能力。因此这里改为「只排除与官方搜索重复的纯联网抓取工具，其余全部保留」。
  //   好处：今后新增任何本地能力工具都会自动保留，不会再出现 generate_image 被漏写白名单而丢失的回归。
  const NETWORK_ONLY = NETWORK_ONLY_TOOL_RE;
  // 原生联网工具有 web_search / web_search_2025_08_26 两种形态，前置注入时避免重复
  const isNativeSearchTool = (t) => t.type === 'web_search' || t.type === 'web_search_2025_08_26';
  const localTools = (openAiTools || []).filter((t) => {
    if (isNativeSearchTool(t)) return false; // 原生联网工具，统一在下方前置注入，避免重复
    const n = (t.function && t.function.name) || t.name || '';
    if (!n) return false;
    return !NETWORK_ONLY.test(n); // 仅剔除「纯联网抓取、与官方 web_search 重复」的工具
  });
  const hasAssistantReply = [...payload].reverse().some((m) => m && m.role === 'assistant');
  // 与 toOpenAITools 保持一致：DeepSeek Responses 走 web_search_2025_08_26，其余走 web_search
  const existingSearchTool = (openAiTools || []).find(isNativeSearchTool);
  const searchToolType = existingSearchTool ? existingSearchTool.type : 'web_search';
  return {
    tools: [{ type: searchToolType }].concat(localTools),
    // 首轮（还没有任何助手回复）强制触发官方联网；后续轮放开 tool_choice（=auto），
    // 允许模型基于已搜到的内容直接作答 / 再搜一次 / 或用任意本地能力工具，避免死循环。
    toolChoice: hasAssistantReply ? undefined : { type: searchToolType },
    started: true,
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

/**
 * L3 批处理模式检测（用户主动触发）：命中 /fix_all、/review 等指令时返回一段提示，
 * 强制模型「并行分批 + 关注文件尾部最新报错」，对抗长上下文里的注意力衰减。
 * 未命中返回空串。纯函数，可离线单测。
 * @param {string} query 当前用户输入
 */
function buildBatchModeHint(query) {
  const q = String(query || '');
  if (!/(^|\s)[#\/](fix_all|fixall|review|fix)/i.test(q)) return '';
  return `【批处理模式已触发（${q.trim().slice(0, 40)}）】
- 这是一个批量任务：请用工具并行推进，每次处理 3-5 个文件，一批完成后再继续下一批。
- 优先关注每个文件【尾部】的最新报错——上下文变长后注意力会衰减，尾部报错最关键，不要只看开头。
- 先用 get_diagnostics 拉全量诊断，分批读文件、分批修复，最后统一跑一次测试/构建验证。`;
}

module.exports = { AgentSession, Cancelled, QuotaError, isQuotaError, buildSystemPrompt, computeOfficialSearch, _isMultiStepTask, buildBatchModeHint, buildDeepThinkingHint, isChatter };
