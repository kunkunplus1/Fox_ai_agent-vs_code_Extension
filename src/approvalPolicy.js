'use strict';
/**
 * 工具审批纯策略（agent.js 巨石拆分第三刀：审批链中的「纯判定」部分）。
 *
 * 拆分边界（减法原则）：
 *  - 纯判定（可测、无副作用）→ 本模块：按 autoApprove / alwaysAllow / kind 决定是否自动放行。
 *  - 强依赖实例的部分（要弹 UI、要改 this.state / this._pendingApproval / this.alwaysAllow）→
 *    留在 agent.js 的 approve() 里调用本模块，只把「要不要问用户」这个纯决策交出来。
 * 这样拆的好处：决策逻辑可单测、可在无 UI 环境（headless / 测试）直接复用，
 * 且不会引入「传一堆 this 上下文」的传参地狱。
 */

/**
 * 审批模式决策（纯函数，无副作用）。
 * @param {object} cfg 配置（取 cfg.autoApprove）
 * @param {Set} alwaysAllow 用户已勾选「始终允许」的工具名集合
 * @param {string} name 工具名
 * @param {string} kind 工具类别：'read' | 'edit' | 'exec' | 'delete' 等
 * @returns {string|null} 'approve'=自动放行；null=需要询问用户
 *
 * 规则优先级（与旧 approve() 逐字一致，仅把「要不要问」拆出来）：
 *  1. alwaysAllow 命中 → approve
 *  2. mode=all → approve
 *  3. mode=edit 且 kind!=='exec' → approve（写/删放行，命令仍要问）
 *  4. mode=read 且 kind==='read' → approve
 *  5. 其余 → null（需要人工确认）
 */
function decideApproval(cfg, alwaysAllow, name, kind) {
  const mode = (cfg && cfg.autoApprove) || 'read';
  if (alwaysAllow && alwaysAllow.has(name)) return 'approve';
  if (mode === 'all') return 'approve';
  if (mode === 'edit' && kind !== 'exec') return 'approve';
  if (mode === 'read' && kind === 'read') return 'approve';
  return null;
}

module.exports = { decideApproval };