'use strict';
/**
 * 前缀缓存基线判定（纯函数，可单测）。
 *
 * 核心问题：原逻辑把「本会话首轮前缀」锁死为基线，之后只要与首轮不同就永远报「缓存失效」。
 * 但首轮往往是「残前缀」（例如 MCP 工具在首轮请求发出后才加载完），自第二轮起每轮都带
 * mcp__* 工具，于是每一轮都和首轮不同 → 误报整段失效、且缓存其实已经能命中（轮次间前缀是稳定的）。
 *
 * 这里区分两种变化：
 *  - 一次性跳变：当前前缀 == 上一轮前缀（说明前缀已稳定到一个新值）→ 接受为新基线（自愈），不误报。
 *  - 持续漂移：当前前缀 != 上一轮前缀（每轮都在变）→ 真·缓存失效，告警。
 *
 * @param {{baseline?:string, prev?:string}} st 会原地更新的状态对象
 * @param {string} current 本轮请求前缀指纹
 * @returns {{baseline:string, drift:boolean, selfHealed:boolean}}
 */
function classifyPrefixDrift(st, current) {
  st = st || {};
  const baseline = st.baseline || '';
  const prev = st.prev || '';
  let selfHealed = false;
  let nextBaseline = baseline;
  if (!baseline) {
    nextBaseline = current; // 首轮：直接作为基线（冷启动轮通常是缓存 miss，无所谓）
  } else if (current && current !== baseline) {
    // 变了：若当前 == 上一轮，说明已稳定到新值（如 MCP 加载完后的完整工具集）→ 自愈接受
    if (current === prev) {
      nextBaseline = current;
      selfHealed = true;
    }
  }
  const drift = !!(nextBaseline && current && current !== nextBaseline);
  st.baseline = nextBaseline;
  st.prev = current;
  return { baseline: nextBaseline, drift, selfHealed };
}
module.exports = { classifyPrefixDrift };
