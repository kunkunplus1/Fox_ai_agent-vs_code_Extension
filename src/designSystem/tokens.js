'use strict';
/**
 * 设计令牌（视觉纪律的单一真相源）—— 第一层：设计 Token 约束。
 *
 * 模型生成任何 UI 时只能引用这里的变量，禁止硬编码色值 / 间距 / 圆角。
 * 任何不一致都从这里改，保证「无论生成什么功能，按钮、浮窗的颜色和间距始终统一」。
 *
 * 用户锁定的基准值：
 *   主色 #1890ff、圆角 8px（radius.md）、栅格间距 20px（space.lg）。
 */
const DEFAULT_TOKENS = Object.freeze({
  color: Object.freeze({
    primary: '#1890ff',
    primaryHover: '#40a9ff',
    primaryActive: '#096dd9',
    success: '#52c41a',
    warning: '#faad14',
    error: '#ff4d4f',
    text: '#1f2329',
    textSecondary: '#646a73',
    border: '#e5e6eb',
    bg: '#ffffff',
    bgMuted: '#f5f6f7',
    overlay: 'rgba(0,0,0,0.45)'
  }),
  radius: Object.freeze({
    sm: '4px',
    md: '8px',
    lg: '12px',
    pill: '999px'
  }),
  space: Object.freeze({
    xs: '4px',
    sm: '8px',
    md: '12px',
    lg: '20px',
    xl: '32px'
  }),
  font: Object.freeze({
    size: Object.freeze({ sm: '12px', md: '14px', lg: '16px', xl: '20px' }),
    family: "system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif"
  }),
  shadow: Object.freeze({
    sm: '0 1px 2px rgba(0,0,0,0.06)',
    md: '0 4px 12px rgba(0,0,0,0.10)',
    lg: '0 8px 24px rgba(0,0,0,0.14)'
  }),
  z: Object.freeze({
    base: '1',
    pop: '1000',
    modal: '1100',
    toast: '1200'
  })
});

/** 用用户覆盖（cfg.designSystem.tokens）浅合并出可用令牌，未覆盖则回退默认。 */
function resolveTokens(override) {
  if (!override || typeof override !== 'object') return DEFAULT_TOKENS;
  const out = JSON.parse(JSON.stringify(DEFAULT_TOKENS));
  for (const k of Object.keys(override)) {
    if (override[k] && typeof override[k] === 'object' && out[k] && typeof out[k] === 'object') {
      Object.assign(out[k], override[k]);
    } else {
      out[k] = override[k];
    }
  }
  return out;
}

/** 生成 :root CSS 变量块（模型把这段写进 <style> 顶部即可用 var(--fox-...)）。 */
function cssVarBlock(tokens) {
  const t = tokens || DEFAULT_TOKENS;
  const lines = [':root {'];
  for (const [k, v] of Object.entries(t.color)) lines.push(`  --fox-color-${k}: ${v};`);
  for (const [k, v] of Object.entries(t.radius)) lines.push(`  --fox-radius-${k}: ${v};`);
  for (const [k, v] of Object.entries(t.space)) lines.push(`  --fox-space-${k}: ${v};`);
  lines.push(`  --fox-font-family: ${t.font.family};`);
  for (const [k, v] of Object.entries(t.font.size)) lines.push(`  --fox-font-size-${k}: ${v};`);
  for (const [k, v] of Object.entries(t.shadow)) lines.push(`  --fox-shadow-${k}: ${v};`);
  for (const [k, v] of Object.entries(t.z)) lines.push(`  --fox-z-${k}: ${v};`);
  lines.push('}');
  return lines.join('\n');
}

/** 生成给模型看的「令牌清单」文本（强制注入提示词用）。 */
function promptCatalog(tokens) {
  const t = tokens || DEFAULT_TOKENS;
  const c = t.color, r = t.radius, s = t.space, f = t.font, sh = t.shadow, z = t.z;
  return [
    '① 设计令牌（唯一可用的视觉变量，禁止硬编码颜色 / 间距 / 圆角）',
    '生成 CSS 时只能使用下列值（或对应的 CSS 变量 var(--fox-...)）；不得出现其它色值 / 间距 / 圆角。',
    `- 主色 primary ${c.primary}（hover ${c.primaryHover} / active ${c.primaryActive}）；成功 ${c.success}；警告 ${c.warning}；错误 ${c.error}`,
    `- 文字 text ${c.text} / 次要 ${c.textSecondary}；边框 ${c.border}；背景 ${c.bg} / 浅底 ${c.bgMuted}；遮罩 ${c.overlay}`,
    `- 圆角 sm ${r.sm} / md ${r.md} / lg ${r.lg} / 全圆 pill ${r.pill}`,
    `- 间距 xs ${s.xs} / sm ${s.sm} / md ${s.md} / lg ${s.lg} / xl ${s.xl}（px）`,
    `- 阴影 sm ${sh.sm} / md ${sh.md} / lg ${sh.lg}；层级 base ${z.base} / pop ${z.pop} / modal ${z.modal} / toast ${z.toast}`,
    `- 字号 sm ${f.size.sm} / md ${f.size.md} / lg ${f.size.lg} / xl ${f.size.xl}（px）；字体 ${f.family}`,
    '（需要 var 形式时，在 <style> 顶部写入 :root{...} 注入上述变量；或直接用上述字面值。）'
  ].join('\n');
}

module.exports = { DEFAULT_TOKENS, resolveTokens, cssVarBlock, promptCatalog };
