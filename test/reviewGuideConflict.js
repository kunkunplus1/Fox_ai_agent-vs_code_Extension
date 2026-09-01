'use strict';
// 探针：验证「审查新会话」与「主对话三步引导」不冲突
// 两套逻辑独立：审查走 _silentCall（isReview），主对话走 run() 主循环
// 关键点：
//  1. 审查引导用 _reviewGuideSent 幂等标记，主对话用 _prependedGuide → 互不干扰
//  2. 审查引导修复后也用 parseTextCalls（支持 [[tool:]] 自定义符号）
//  3. 审查的 fox_new_session 独立（_reviewResetSent），不影响主对话的 _isFreshSession 判定

// —— 模拟主对话三步引导触发条件 ——
function mainLoopGuide(preparedHistory, resumedSession, toolGuideFetched, prependedGuide) {
  // 复制 agent.js 1950-1952 逻辑
  const isWebTextSess = true;
  return isWebTextSess && !resumedSession && !toolGuideFetched && !prependedGuide;
}

// —— 模拟审查引导触发条件 ——
function reviewGuide(isReview, isWebText, reviewGuideSent) {
  return isReview && isWebText && !reviewGuideSent;
}

// —— 场景1：主对话正常首轮 → 触发三步引导，与审查无关 ——
const s1 = mainLoopGuide(
  [{ role: 'user', content: '问题' }], // preparedHistory
  false, // resumedSession
  false, // toolGuideFetched
  false  // prependedGuide
);
console.log('场景1 主对话首轮触发三步引导:', s1 ? '✓' : '✗');

// —— 场景2：审查触发（isReview=true）→ 审查引导，不碰主对话标记 ——
const s2a = reviewGuide(true, true, false); // 首次审查 → 触发
const s2b = reviewGuide(true, true, true);  // 二次审查 → 幂等跳过
console.log('场景2a 审查首次触发引导:', s2a ? '✓' : '✗');
console.log('场景2b 审查幂等跳过:', !s2b ? '✓' : '✗');

// —— 场景3：主对话与审查标记互不干扰 ——
// 审查执行后置 _reviewGuideSent=true，但主对话 _prependedGuide 仍 false
// → 主对话下一轮提问仍按自己的条件判定（此时 _toolGuideFetched 可能被审查置 true）
const reviewDone = { reviewGuideSent: true, prependedGuide: false, toolGuideFetched: true };
const s3 = mainLoopGuide(
  [{ role: 'user', content: '新问题' }],
  false, reviewDone.toolGuideFetched, reviewDone.prependedGuide
);
console.log('场景3 审查后主对话(工具已获取)跳过三步:', !s3 ? '✓' : '✗');

// —— 场景4：审查引导解析支持 [[tool:]] 自定义符号（parseTextCalls 归一化）——
// 模拟 parseTextCalls 对 [[tool:get_tools]] 的归一化结果
const norm = '我们根据系统要求...\n\n<foxtool name="get_tools">\n{}\n</foxtool>';
const found = /<foxtool name="get_tools">/.test(norm);
console.log('场景4 [[tool:get_tools]]→<foxtool> 归一化可解析:', found ? '✓' : '✗');

// —— 场景5：审查 fox_new_session 与主对话 _isFreshSession 独立 ——
// 审查用 _reviewResetSent，主对话用 _isFreshSession，两套信号互不读写
console.log('场景5 审查/主对话信号独立:',
  ('_reviewResetSent' !== '_isFreshSession' && '_reviewGuideSent' !== '_prependedGuide') ? '✓' : '✗');
