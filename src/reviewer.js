'use strict';

/**
 * 审查子代理（Code Review Sub-Agent）
 * 只读、不改文件、不执行命令。基于主代理本轮产生的代码改动 diff 摘要，
 * 用一次静默模型调用生成审查意见。结果由主代理作为后续观察追加，供其修正。
 */

const REVIEW_SYSTEM = `你是一位资深代码审查员（Code Reviewer）。你的职责是审查本次代码改动，帮助发现低级错误。

# 规则
1. 你只能阅读提供的改动 diff 并给出审查意见，**绝对不能修改任何文件、不能执行命令、不能调用任何工具**。
2. 只输出 Markdown 格式的审查意见，不要输出多余寒暄。
3. 聚焦真正有价值的问题，按严重程度排序：
   - 🔴 严重：会导致报错 / 崩溃 / 逻辑错误 / 数据丢失的问题；
   - 🟡 中等：边界条件、明显笔误、与上下文或类型不一致、可能引入的隐患；
   - 🟢 建议：可读性、命名、风格、小优化（可选）。
4. 如果没有明显问题，明确说「本次改动未见明显问题」。
5. 每条意见给出：问题位置（文件 + 大致行 / 片段）、原因、建议改法。简洁，不要长篇大论。

# 输出格式
## 🔴 严重问题
- ...
## 🟡 中等问题
- ...
## 🟢 改进建议
- ...`;

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
    return { ok: false, text: '', error: (e && e.message) || String(e) };
  }
}

module.exports = { REVIEW_SYSTEM, buildReviewMessages, runReview };
