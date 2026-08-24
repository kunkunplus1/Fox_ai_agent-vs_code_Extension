'use strict';

/**
 * 审查子代理（Code Review Sub-Agent）
 * 只读、不改文件、不执行命令。基于主代理本轮产生的代码改动 diff 摘要，
 * 用一次静默模型调用生成审查意见。结果由主代理作为后续观察追加，供其修正。
 */

const REVIEW_SYSTEM = `你是一位资深代码审查员。请基于给出的代码改动 diff，给出简洁、聚焦的审查意见，帮助发现低级错误与结构性隐患。

# 规则
1. 只能阅读改动 diff，**禁止修改文件、执行命令、调用工具**。
2. 只输出 Markdown，不要寒暄。
3. 按严重程度排序：🔴 严重（报错 / 崩溃 / 逻辑错误 / 数据丢失 / 结构被破坏）｜🟡 中等（边界、笔误、类型不一致、隐患）｜🟢 建议（可读性、命名、风格）。
4. 如无问题，只回一句「本次改动未见明显问题」。
5. **最多列 5 条，每条不超过 2 句**，给出位置与建议改法，不要长篇大论。

# 结构维度（除低级错误外，也要检查这些「屎山」信号）
- 🟡 重复代码：同一逻辑在 diff 里被复制多份，应抽公共函数/常量；
- 🟡 职责混乱：一个函数塞了多件事（读取+计算+写文件），或工具/模块边界不清；
- 🟡 过度嵌套：深层 if/for/try 堆叠，应先返回/提前退出；
- 🟡 结构破坏：改动破坏了既有分层（如 UI 层直接拼 SQL、数据层做展示格式化），或把调用链搞乱；
- 🟡 越补越乱：改动在打补丁而不是修根因（同位置反复改、魔法值散落），应提示先定位根源；
- 🟢 硬编码：散落的魔法数/路径/文案应提为常量或配置。`;

function buildReviewMessages(changed) {
  const items = (changed || []).map((c, i) => {
    const op = c.op || c.name || '改动';
    return `### 改动 ${i + 1}（${op}）：${c.path || ''}\n${c.summary || ''}`;
  }).join('\n\n');
  const user = `请审查以下本次任务产生的代码改动（共 ${changed.length} 处）：\n\n${items}\n\n请给出审查意见。`;
  return [
    { role: 'system', content: REVIEW_SYSTEM },
    { role: 'user', content: user }
  ];
}

/**
 * 运行一次审查。
 * @param {object} opts
 * @param {function} opts.silentCall 静默模型调用 (messages) => result，不向 UI 推送
 * @param {object} opts.cfg 配置（预留）
 * @param {Array} opts.changed 本轮代码写操作列表 [{name,path,op,summary}]
 * @returns {Promise<{ok:boolean,text:string,error?:string}>}
 */
async function runReview({ silentCall, cfg, changed }) {
  if (!silentCall) return { ok: false, text: '' };
  const messages = buildReviewMessages(changed);
  try {
    const result = await silentCall(messages);
    const text =
      (result && result.content) ||
      (result && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) ||
      '';
    return { ok: true, text: String(text) };
  } catch (e) {
    // 额度/余额耗尽需要冒泡给调用方，由 run() catch 统一处理自动终止 + 保留记忆
    if (e && e.isQuota) throw e;
    return { ok: false, text: '', error: (e && e.message) || String(e) };
  }
}

module.exports = { REVIEW_SYSTEM, buildReviewMessages, runReview };
