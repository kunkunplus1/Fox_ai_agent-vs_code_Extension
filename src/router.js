'use strict';
/**
 * src/router.js — 前置路由门控（轻量分类器）
 *
 * 思路（对应生产级落地方法论「多层路由门控」）：
 * 大部分简单查询无需调动智能体主循环（全量工具 schema + 多轮推理极烧 Token）。
 * 前置一个轻量判定：知识库已启用 + 问题短 + 无疑似动作意图 + 像问答 + 能检索到资料
 * → 直接走 RAG 直答（单次模型调用，不使用任何工具），跳过 agent.run()。
 *
 * 依赖（knowledgeBase / client）全部在函数体内延迟 require，
 * 使本模块在扩展宿主外也能被单元测试（避免顶层加载 vscode 模块）。
 */

// 动作意图：含这些词，基本是要「干活」（写/改/运行/执行…）或「怎么做」（how-to），不该走轻量 RAG
const ACTION_RE = /(写|改|创建|新建|生成|运行|执行|删除|移除|修复|实现|编译|构建|部署|安装|配置|调用|打开|读取文件|修改|重构|调试|测试|提交|推送|发送|启动|停止|杀进程|kill|启动服务|怎么|如何|怎样)/;
// 疑问特征：像「问答」而非「陈述/任务」，保守判定避免误路由
const QUESTION_RE = /(？|\?|什么|如何|怎么|怎样|为什么|为何|在哪|在哪里|是谁|哪个|哪些|定义|含义|意思|区别|作用|原理|怎么用|如何做|是否|能不能|有没有)/;
// 记忆/指令引用：用户引用「之前让我记住」「你记住的」→ 需要 get_memory 工具，不能被 RAG 拦截
const MEMORY_REF_RE = /之前.{0,4}(让|叫|请|要|和|给)(我|你).{0,6}(记住|记|说|讲|写|整|做|告诉)/i;

function plainText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n');
  }
  return '';
}

/**
 * 是否应路由到 RAG 直答（不进智能体）。
 * @returns {false | {query:string, ctx:string}} 命中返回 {query,ctx}，否则 false
 */
function shouldRoute(query, cfg) {
  const r = (cfg && cfg.routing) || {};
  const { appendLog } = require('./log');
  if (!r.gateEnabled) {
    appendLog('router', '[skip] gateEnabled=false');
    return false;
  }
  const kb = require('./knowledgeBase');
  if (!kb.isEnabled()) {
    appendLog('router', '[skip] knowledgeBase disabled');
    return false;
  }
  const q = plainText(query).trim();
  if (!q) {
    appendLog('router', '[skip] empty query');
    return false;
  }
  if (q.length > (r.maxQueryLen || 120)) {
    appendLog('router', '[skip] query too long len=' + q.length + ' > ' + (r.maxQueryLen || 120));
    return false;
  }
  if (/^\s*\//.test(q)) {
    appendLog('router', '[skip] slash command');
    return false;
  }
  // 记忆/指令引用：需要 get_memory 工具，不能被 RAG 拦截
  if (MEMORY_REF_RE.test(q)) {
    appendLog('router', '[skip] memory ref query=' + q.slice(0, 60));
    return false;
  }
  // 明确问答模式（纯定义/解释类：「是什么/什么是/什么意思/为什么/为何/含义/原理/区别/作用」）
  // 优先于动作意图，走 RAG 直答；注意 how-to 词（怎么/如何/怎样）已归入 ACTION_RE，
  // 不会再被误判为「明确问答」而导进 RAG 跳过真正该干活的 Agent。
  const isExplicitQuestion = /是什么|什么是|什么意思|为什么|为何|含义|原理|意思|区别|作用/i.test(q);
  if (ACTION_RE.test(q) && !isExplicitQuestion) {
    appendLog('router', '[skip] action intent query=' + q.slice(0, 60));
    return false;
  }
  if (!QUESTION_RE.test(q)) {
    appendLog('router', '[skip] not a question query=' + q.slice(0, 60));
    return false;
  }
  const ctx = kb.retrieve(q, 6000);
  if (!ctx || !ctx.trim()) {
    appendLog('router', '[skip] no retrieval result query=' + q.slice(0, 60));
    return false;
  }
  appendLog('router', '[route] query=' + q.slice(0, 60) + ' ctxLen=' + ctx.length);
  return { query: q, ctx };
}

/**
 * 基于检索资料生成一次简短直答（单次调用，禁用工具）。
 */
async function answerWithRag(query, ctx, cfg) {
  const client = require('./client');
  const { appendLog } = require('./log');
  const prompt =
    '你是知识库问答助手。仅基于下面【资料】用简体中文简洁回答用户问题；' +
    '不要调用任何工具、不要编造资料外内容；若资料无法回答，请直接说“资料中没有相关信息”。\n\n' +
    '【资料】\n' + ctx + '\n\n【用户问题】\n' + query;
  appendLog('router', '[rag-request] query=' + query.slice(0, 60) + ' ctxLen=' + ctx.length + ' model=' + (cfg.model || '?'));
  let res;
  try {
    res = await client.chatNonStream({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      maxTokens: 800,
      timeout: cfg.timeout || 60000
    });
  } catch (e) {
    appendLog('router', '[rag-error] ' + (e && e.message ? e.message : String(e)));
    throw e;
  }
  const content = (res && res.content ? String(res.content) : '').trim();
  const reasoning = (res && res.reasoning ? String(res.reasoning) : '').trim();
  appendLog('router', '[rag-response] contentLen=' + content.length + ' reasoningLen=' + reasoning.length + ' empty=' + (!content && !reasoning));
  return content || reasoning || '';
}

module.exports = { shouldRoute, answerWithRag, ACTION_RE, QUESTION_RE };
