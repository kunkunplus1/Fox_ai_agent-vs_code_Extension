'use strict';
/**
 * UI 锚点静态校验 —— 第三层：并行生成 + ID 锚定（连接视觉与逻辑）。
 *
 * 不做渲染，纯静态检查「HTML 里定义的 id」与「JS 里引用的 id」是否对得上，
 * 以及原子组件（fox-modal 等）是否满足最小契约。把「有样子没反应」在生成阶段就抓出来。
 */
const fs = require('fs');

const ID_RE = /id\s*=\s*["']([^"']+)["']/g;
const GETEL_RE = /getElementById\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const QS_RE = /querySelector(?:All)?\s*\(\s*['"]#([A-Za-z0-9_-]+)['"]/g;
const MODAL_RE = /<fox-modal\b([^>]*)>/gi;

function extractIds(html) {
  const ids = new Set();
  let m;
  ID_RE.lastIndex = 0;
  while ((m = ID_RE.exec(html)) !== null) ids.add(m[1]);
  return ids;
}

function extractRefs(html) {
  const refs = new Set();
  let m;
  GETEL_RE.lastIndex = 0;
  while ((m = GETEL_RE.exec(html)) !== null) refs.add(m[1]);
  QS_RE.lastIndex = 0;
  while ((m = QS_RE.exec(html)) !== null) refs.add(m[1]);
  return refs;
}

function checkModalContracts(html) {
  const issues = [];
  let m;
  MODAL_RE.lastIndex = 0;
  let i = 0;
  while ((m = MODAL_RE.exec(html)) !== null) {
    i++;
    const attrs = m[1] || '';
    const hasOncloseAttr = /\bonclose\s*=/.test(attrs);
    const hasVisible = /\bvisible\b/.test(attrs);
    // JS 侧是否绑定了关闭：搜索脚本里 onclose 赋值或 'close' 事件监听
    const scriptBindsClose =
      /onclose\s*=/.test(html) ||
      /addEventListener\s*\(\s*['"]close['"]/.test(html) ||
      /dispatchEvent\s*\(\s*new\s+CustomEvent\s*\(\s*['"]close['"]/.test(html);
    if (!hasOncloseAttr && !scriptBindsClose) {
      issues.push({
        level: 'error',
        msg: `第 ${i} 个 <fox-modal> 缺少关闭绑定：必须设 onclose 属性（函数）或监听 "close" 事件，否则浮层关不掉。`
      });
    }
    if (!hasVisible && !/setAttribute\s*\(\s*['"]visible['"]/.test(html)) {
      issues.push({
        level: 'warn',
        msg: `第 ${i} 个 <fox-modal> 未发现 visible 标记：默认隐藏，需 JS 置 visible 才弹出（确认这是预期）。`
      });
    }
  }
  return issues;
}

/** 核心分析：返回 { ids, refs, issues, ok }。 */
function analyzeHtml(html) {
  const ids = extractIds(html);
  const refs = extractRefs(html);
  const issues = [];

  for (const r of refs) {
    if (!ids.has(r)) {
      issues.push({
        level: 'error',
        id: r,
        msg: `锚点失效：JS 引用了 #${r}，但 HTML 中不存在该 id（元素未定义 → 点击/逻辑无对象）。`
      });
    }
  }

  // 反向：有 id 但 JS 完全没引用（仅提示，非错误——可能是纯展示元素）
  const orphan = [];
  for (const id of ids) {
    if (!refs.has(id) && /^(btn|sidebar|modal|tab|toast|menu|drawer|panel)/i.test(id)) {
      orphan.push(id);
    }
  }
  if (orphan.length) {
    issues.push({
      level: 'warn',
      msg: `以下带交互语义的 id 在 JS 中未找到任何引用（可能漏绑事件）：${orphan.join('、')}。`
    });
  }

  issues.push(...checkModalContracts(html));

  const ok = !issues.some((x) => x.level === 'error');
  return { ids: Array.from(ids), refs: Array.from(refs), issues, ok };
}

/**
 * 工具入口：接受 { html } 或 { file }。返回文本化报告。
 */
function verifyUiAnchors(opts) {
  opts = opts || {};
  let html = opts.html;
  if (!html && opts.file) {
    try { html = fs.readFileSync(opts.file, 'utf8'); } catch (e) {
      return `无法读取文件 ${opts.file}：${e.message}`;
    }
  }
  if (!html || typeof html !== 'string') {
    return 'verify_ui_anchors 需要 html 字符串或可读的 file 路径。';
  }
  const res = analyzeHtml(html);
  if (!res.issues.length) {
    return `✅ UI 锚点校验通过：共发现 ${res.ids.length} 个 id、${res.refs.length} 处 JS 引用，无锚点缺口、无原子组件契约缺失。`;
  }
  const lines = ['🔍 UI 锚点校验报告（静态）：'];
  for (const it of res.issues) {
    const tag = it.level === 'error' ? '❌' : '⚠️';
    lines.push(`  ${tag} ${it.msg}`);
  }
  lines.push(res.ok ? '（仅有警告，无阻断性错误）' : '（存在阻断性错误：锚点缺口 / 原子组件契约缺失，请修正后重测）');
  return lines.join('\n');
}

module.exports = { analyzeHtml, verifyUiAnchors, extractIds, extractRefs, checkModalContracts };
