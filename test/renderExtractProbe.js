/* 探针 v3：从 media/chat.js 动态提取 markdown 渲染区域（escapeHtml → codeBlockHtml），
 * 注入最小依赖，用用户真实原文验证修复后渲染输出。
 * 验证的永远是 chat.js 真身，不会与探针副本分叉。 */
'use strict';
const fs = require('fs');
const path = require('path');

const chatJsPath = path.join(__dirname, '..', 'media', 'chat.js');
const s = fs.readFileSync(chatJsPath, 'utf8');

const start = s.indexOf('/* ================= markdown =================');
const normStart = s.indexOf('function normKey(');
if (start === -1 || normStart === -1 || normStart <= start) {
  console.error('FAIL: 未找到 markdown 区域边界');
  process.exit(1);
}
const mdRegion = s.slice(start, normStart);

// 注入最小依赖
const stub = `
function t(key) {
  const map = { '图片': '图片', '复制': '复制', '插入': '插入', '新文件': '新文件' };
  return map[key] || key;
}
`;
const src = stub + '\n' + mdRegion + '\nmodule.exports = { renderMarkdown };';
const modPath = path.join(__dirname, '_md_region_probe.js');
fs.writeFileSync(modPath, src, 'utf8');

const { renderMarkdown } = require(modPath);

/* ===== 用户真实原文（含非规范 GFM） ===== */
const SAMPLE = [
  'VSCode提示「编辑器是只读」通常有几种原因，按最可能到最不可能排查：',
  '##1.最快解决：切换文件只读状态（80%的情况）',
  '-按Ctrl+Shift+P→输入ToggleFileReadonly（文件：切换只读）回车',
  '-或点击编辑器右下角状态栏的「只读」文字，可直接切换',
  '##2.文件系统层面被设为只读（Windows）',
  '-在资源管理器里右键该文件→属性→取消勾选「只读」→确定',
  '-若文件在U盘、网络盘、或权限受限目录里，也会被判定为只读，需先取得写权限',
  '##3.VSCode设置把文件强制设为只读打开设置（Ctrl+,）检查这几项：',
  '|设置项|作用|',
  '|---|---|',
  '|files.readonlyInclude|匹配到的文件强制只读|',
  '|files.readonlyFromPermission|按文件系统权限判断（设为false可关闭）|',
  '|files.readonlyExclude|从不设为只读的文件|',
  '如果readonlyInclude/readonlyFromPermission被配置了，去掉相关条目即可。',
  '##4.整个工作区以「只读模式」打开',
  '-若VSCode是用--read-only参数启动，或标题栏/窗口显示「只读」标识，需要关闭窗口重新用正常方式打开文件夹。',
  '---建议顺序：先试第1步的ToggleFileReadonly（最常见）；不行再看第2步文件属性；仍不行查第3步设置。'
].join('\n');

function assert(cond, label, detail) {
  if (cond) console.log('✅ ' + label);
  else { console.log('❌ ' + label + (detail ? '  ' + detail : '')); process.exitCode = 1; }
}

const html = renderMarkdown(SAMPLE);
console.log('========== chat.js 真身渲染输出 ==========');
console.log(html);
console.log('==========================================');

assert(html.includes('<h2>'), '标题 ##1~##4 应渲染 <h2>');
assert((html.match(/<h2>/g) || []).length === 4, '应恰好 4 个 <h2>');
assert(html.includes('<ul>'), '列表 -按 应渲染 <ul>');
assert(html.includes('<table>'), '表格应渲染 <table>');
assert(html.includes('<thead>'), '表格应渲染 <thead>');
assert((html.match(/<th>/g) || []).length === 2, '应恰好 2 个 <th>');
assert((html.match(/<td>/g) || []).length === 6, '应恰好 6 个 <td>');
assert(html.includes('<hr>'), '---建议 粘连应渲染 <hr>');
// 关键回归：不应出现「一整坨纯文本」
assert(!/^<p>[^<]*(?:<br>[^<]*)+<\/p>$/.test(html), '不应是纯文本 <p>+<br> 一坨');
console.log('\n完成。');