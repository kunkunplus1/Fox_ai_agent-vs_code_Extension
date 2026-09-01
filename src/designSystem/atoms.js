'use strict';
/**
 * 原子组件库（视觉 + 交互已封装绑定）—— 第二层：组件原子库（绑定样式与功能）。
 *
 * 模型不需要自己画一个浮窗：只调用 <fox-modal visible onclose> 这样的标签并填属性，
 * 视觉样式与交互逻辑（点击关闭、遮罩层、Esc）已被封装绑定。模型只管「搭积木」。
 *
 * 本文件是「组件契约目录」的数据源 + 注入提示词的文本；真正的实现在
 *   src/designSystem/assets/fox-atoms.css 与 fox-atoms.js
 * 生成 UI 时把这两个文件复制到目标项目并成对引入即可，禁止手搓等价组件。
 */
const ATOMS = Object.freeze([
  {
    tag: 'fox-button',
    props: [
      { name: 'variant', type: 'enum', required: false, desc: 'primary(主色) | default(描边) | text(文字)；默认 default' },
      { name: 'disabled', type: 'boolean', required: false, desc: '禁用态' }
    ],
    behavior: '主色按钮自带 hover/active 态；点击走原生 onclick / addEventListener。',
    contract: '禁止自己写 <button> 再手写颜色——直接用 <fox-button>。'
  },
  {
    tag: 'fox-modal',
    props: [
      { name: 'visible', type: 'boolean', required: true, desc: '是否显示；默认隐藏，设置 visible 属性即显示' },
      { name: 'onclose', type: 'function|event', required: true, desc: '关闭回调：可设 JS 属性 el.onclose=fn，或监听 el.addEventListener("close", fn)' },
      { name: 'title', type: 'string', required: false, desc: '标题文案' }
    ],
    behavior: '遮罩浮层；点遮罩 / 按 Esc / 点关闭按钮 → 触发 onclose 并把 visible 置 false。',
    contract: '生成 fox-modal 必须同时绑定 onclose（属性函数或 "close" 事件），否则「有浮层关不掉」。'
  },
  {
    tag: 'fox-tooltip',
    props: [
      { name: 'text', type: 'string', required: true, desc: '提示文案' },
      { name: 'position', type: 'enum', required: false, desc: 'top | bottom | left | right；默认 top' }
    ],
    behavior: '悬浮（mouseenter）显示提示，移出隐藏；样式锁定令牌。',
    contract: '用 fox-tooltip 代替手搓 title 属性或绝对定位 div。'
  },
  {
    tag: 'fox-toast',
    props: [
      { name: 'type', type: 'enum', required: false, desc: 'info | success | error；默认 info' },
      { name: 'duration', type: 'number', required: false, desc: '自动消失毫秒数，默认 2600' }
    ],
    behavior: '轻提示：JS 调用 el.show("文案") 后从顶部滑入，定时自动消失。',
    contract: '用 fox-toast 的 show() 方法，不要自己写 fixed 定位提示条。'
  },
  {
    tag: 'fox-tabs / fox-tab',
    props: [
      { name: 'name', type: 'string', required: true, desc: '每个 fox-tab 的标签名（fox-tabs 下多个 fox-tab 互斥切换）' }
    ],
    behavior: '<fox-tabs> 包裹若干 <fox-tab name="x">；点击标签切换对应内容，自动管理 active 态。',
    contract: '选项卡用 fox-tabs+fox-tab 一对标签，不要手写 display 切换逻辑。'
  },
  {
    tag: 'fox-sidebar',
    props: [
      { name: 'open', type: 'boolean', required: false, desc: '是否展开；设置 open 属性即滑入' },
      { name: 'onclose', type: 'function|event', required: false, desc: '关闭回调（同 fox-modal）' }
    ],
    behavior: '侧边抽屉；open 时从左侧滑入并带遮罩；可配关闭按钮。',
    contract: '侧边栏用 fox-sidebar，id 稳定（如 id="sidebar"）并在 JS 里绑定 open/close。'
  }
]);

/** 生成给模型看的「原子组件契约」文本（注入提示词用）。 */
function atomsPrompt() {
  const lines = [
    '② 原子组件库（视觉 + 交互已封装，禁止手搓等价组件）',
    '生成 UI 时优先用下列内置原子组件（已随插件提供 fox-atoms.css / fox-atoms.js）：'
  ];
  for (const a of ATOMS) {
    const props = a.props.map((p) => `${p.name}:${p.type}${p.required ? '(必填)' : ''}`).join('、');
    lines.push(`- <${a.tag}>${props ? ' ' + props : ''}：${a.behavior}`);
    lines.push(`  ${a.contract}`);
  }
  lines.push('引入方式：把插件内置的 fox-atoms.css / fox-atoms.js 复制到目标项目，并 <link rel="stylesheet" href="fox-atoms.css"> + <script src="fox-atoms.js"></script> 成对引入。');
  lines.push('完整属性契约见工具 verify_ui_anchors / ui_selfcheck 的报错，不要凭记忆补全属性。');
  return lines.join('\n');
}

module.exports = { ATOMS, atomsPrompt };
