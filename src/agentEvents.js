'use strict';
/**
 * AgentSession 关键运行状态事件化（agent.js 巨石第二刀，对齐 dsh「事件日志派生、一切可重放」）。
 *
 * 哲学：AgentSession 会被每轮用户提问重建，关键状态（_emptyStreak/_guideNudges/_continuesUsed/
 * _toolGuideFetched/_prependedGuide/_guideAtHead/_resumedSession/_lenContinue/_inFinalPhase/
 * _finalStarted）此前只活在实例字段里，一旦会话中断/重启就全部归零，恢复只靠 messages 字符串
 * 猜测（脆弱：字符串格式一变就失效）。这里把每个状态变更点变成一行事件日志（append-only），
 * 重启时从事件流重放重建状态，不再猜。
 *
 * 纯函数：不依赖 AgentSession 实例，只依赖 log.appendLog。写日志失败静默忽略（对齐 log.js）。
 */

const { appendLog } = require('./log');

// —— 事件名枚举（单一收口：要加状态先加事件，杜绝散落的裸字段判断）——
const EV = {
  EMPTY_TURN: 'empty-turn',      // 空轮计数 +1（携带 streak）
  EMPTY_RECOVER: 'empty-recover', // 出现合法调用 → 连续空轮清零
  GUIDE_NUDGE: 'guide-nudge',    // 强制回灌 get_tools （携带 count）
  TOOL_GUIDE_FETCHED: 'tool-guide-fetched', // get_tools 已成功执行
  PREPENDED_GUIDE: 'prepended-guide',       // 前置引导已注入历史头部
  GUIDE_AT_HEAD: 'guide-at-head',           // 首轮引导已摘除用户问题置于历史头部
  RESUMED: 'resumed',            // 识别为恢复会话
  CONTINUE_USED: 'continue-used', // 自动续跑使用计数 +1（携带 count）
  LEN_CONTINUE: 'len-continue',  // 下一轮强制文本协议（只续正文）
  FINAL_PHASE: 'final-phase',    // 进入 final 收尾阶段
  FINAL_STARTED: 'final-started' // final 消息已开始推送
};

/**
 * 创建事件日志文件路径：~/.fox-ai/logs/agent-events-<sessionId>.log
 * sessionId 为空时用 'default'，保证无会话上下文也能落盘。
 */
function eventLogPath(sessionId) {
  const os = require('os');
  const path = require('path');
  const id = String(sessionId || 'default').replace(/[^\w.-]/g, '_');
  return path.join(os.homedir(), '.fox-ai', 'logs', 'agent-events-' + id + '.log');
}

/**
 * 写一条事件日志。events 是 `[event] 事件名 key=value key=value` 的纯文本行（可重放、可 grep），
 * 落盘到 agent-events-<sessionId>.log，与 replayState 读的是同一个文件（读写同源）。
 * 失败静默忽略（不得影响主流程）。
 */
function logEvent(sessionId, ev, fields) {
  try {
    const parts = ['[event]', ev];
    if (fields) {
      for (const k of Object.keys(fields)) {
        const v = fields[k];
        parts.push(k + '=' + (v == null ? '' : String(v)));
      }
    }
    const fs = require('fs');
    const file = eventLogPath(sessionId);
    const dir = require('path').dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, new Date().toISOString() + ' ' + parts.join(' ') + '\n', { flag: 'a' });
  } catch (_) { /* 日志写入失败不得影响主流程 */ }
}

/**
 * 从事件日志重放重建关键状态。
 * @param {string} sessionId
 * @param {object} state 目标状态对象（通常是 this），重放结果直接写进它
 * @returns {object} 重放后的状态对象（与传入的 state 同一引用）
 */
function replayState(sessionId, state) {
  const fs = require('fs');
  try {
    const file = eventLogPath(sessionId);
    if (!fs.existsSync(file)) return state;
    const lines = String(fs.readFileSync(file, 'utf8')).split('\n');
    let streak = 0, guideNudges = 0, continuesUsed = 0;
    let toolGuideFetched = false, prependedGuide = false, guideAtHead = false;
    let resumed = false, lenContinue = false, inFinalPhase = false, finalStarted = false;
    for (const line of lines) {
      const m = /\[event\]\s+(\S+)/.exec(line);
      if (!m) continue;
      const ev = m[1];
      const kv = {};
      const rest = line.slice(m.index + m[0].length);
      for (const pair of rest.trim().split(/\s+/)) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        if (eq > 0) kv[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      switch (ev) {
        case EV.EMPTY_TURN: streak = Number(kv.streak) || streak + 1; break;
        case EV.EMPTY_RECOVER: streak = 0; break;
        case EV.GUIDE_NUDGE: guideNudges = Number(kv.count) || guideNudges + 1; break;
        case EV.TOOL_GUIDE_FETCHED: toolGuideFetched = true; break;
        case EV.PREPENDED_GUIDE: prependedGuide = true; break;
        case EV.GUIDE_AT_HEAD: guideAtHead = true; break;
        case EV.RESUMED: resumed = true; break;
        case EV.CONTINUE_USED: continuesUsed = Number(kv.count) || continuesUsed + 1; break;
        case EV.LEN_CONTINUE: lenContinue = true; break;
        case EV.FINAL_PHASE: inFinalPhase = true; break;
        case EV.FINAL_STARTED: finalStarted = true; break;
        default: break;
      }
    }
    // ⚠️ 或合并原则：布尔字段不能盲写覆盖——constructor 已先扫描 messages 得出
    // _toolGuideFetched/_resumedSession（这是可靠的恢复判定，事件日志是增量证据，
    // 两者取「或」：任一来源为 true 即为 true，绝不因「本会话无事件日志」把已恢复会话冲回 false）。
    state._emptyStreak = streak;
    state._guideNudges = guideNudges;
    state._continuesUsed = continuesUsed;
    state._toolGuideFetched = state._toolGuideFetched || toolGuideFetched;
    state._resumedSession = state._resumedSession || resumed;
    state._prependedGuide = state._prependedGuide || prependedGuide;
    state._guideAtHead = state._guideAtHead || guideAtHead;
    state._lenContinue = state._lenContinue || lenContinue;
    state._inFinalPhase = state._inFinalPhase || inFinalPhase;
    state._finalStarted = state._finalStarted || finalStarted;
    appendLog('agent', '[agent-events] replay ' + JSON.stringify({
      sessionId, streak, guideNudges, continuesUsed, toolGuideFetched,
      prependedGuide, guideAtHead, resumed, lenContinue, inFinalPhase, finalStarted
    }));
  } catch (_) { /* 重放失败不阻断：保持默认状态继续（宁可多跑一轮引导也不死循环） */ }
  return state;
}

module.exports = { EV, eventLogPath, logEvent, replayState };