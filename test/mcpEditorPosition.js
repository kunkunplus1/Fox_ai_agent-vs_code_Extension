'use strict';

/**
 * 回归测试：MCP 添加/编辑表单在 HTML 中必须位于服务器列表上方，
 * 避免点击「添加/编辑」后表单出现在页面最底部。
 */

const assert = require('assert');
const path = require('path');

// envView.js 导出 getEnvHtml（或类似函数），这里直接读源码验证静态 HTML 片段
// 1.1.25：openMcpEditor 前端逻辑已随拆分迁到 media/env.js（envView.js 只生成静态 HTML），
// 所以 scrollIntoView 断言须读 media/env.js；HTML 结构断言仍读 src/envView.js。
const srcPath = path.join(__dirname, '../src/envView.js');
const fs = require('fs');
const src = fs.readFileSync(srcPath, 'utf8');
const envJsPath = path.join(__dirname, '../media/env.js');
const envJs = fs.existsSync(envJsPath) ? fs.readFileSync(envJsPath, 'utf8') : '';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); }
}

console.log('\n[MCP 编辑器位置]');

// 找到 <div id="mcp-editor" ...> 与 <div id="mcp-list"> 在源码中的位置
check('mcp-editor 位于 mcp-list 之前', () => {
  const editorIdx = src.indexOf('<div id="mcp-editor"');
  const listIdx = src.indexOf('<div id="mcp-list">');
  assert.ok(editorIdx > 0, '找不到 mcp-editor 开始标签');
  assert.ok(listIdx > 0, '找不到 mcp-list 开始标签');
  assert.ok(editorIdx < listIdx, 'mcp-editor 应在 mcp-list 之前');
});

check('mcp-editor 仍位于 mcp-catalog-section 之前', () => {
  const editorIdx = src.indexOf('<div id="mcp-editor"');
  const catalogIdx = src.indexOf('<div id="mcp-catalog-section"');
  assert.ok(catalogIdx > 0, '找不到 mcp-catalog-section 开始标签');
  assert.ok(editorIdx < catalogIdx, 'mcp-editor 应在 mcp-catalog-section 之前');
});

check('openMcpEditor 内调用了 scrollIntoView（media/env.js 前端逻辑）', () => {
  // 1.1.25：openMcpEditor 实现已迁到 media/env.js（envView.js 只生成静态 HTML）
  assert.ok(envJs.includes('editor.scrollIntoView'), '应在 openMcpEditor 中滚动到编辑器');
});

check('mcp-editor 设置了背景色，增强视觉层级', () => {
  assert.ok(src.includes('background:var(--vscode-editor-background)'), 'mcp-editor 应设置背景色');
});

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
