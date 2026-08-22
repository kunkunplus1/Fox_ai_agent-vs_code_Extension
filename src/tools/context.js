'use strict';

const vscode = require('vscode');
const ws = require('./workspace');

const SEV_NAME = ['错误', '警告', '信息', '提示'];

function severityFilter(name) {
  switch (String(name || 'warning').toLowerCase()) {
    case 'error':
      return vscode.DiagnosticSeverity.Error;
    case 'info':
      return vscode.DiagnosticSeverity.Information;
    case 'all':
    case 'hint':
      return vscode.DiagnosticSeverity.Hint;
    default:
      return vscode.DiagnosticSeverity.Warning;
  }
}

/** 读取 VS Code 的问题面板（语法/类型/lint 错误） */
async function getDiagnostics(args) {
  const opts = args || {};
  const maxSev = severityFilter(opts.severity);
  const max = Math.min(200, parseInt(opts.max_results, 10) || 50);

  let entries = vscode.languages.getDiagnostics();
  if (opts.path) {
    const uri = ws.resolveUri(opts.path, { forRead: true });
    entries = entries.filter((e) => e[0].toString() === uri.toString());
  }

  const out = [];
  let total = 0;
  for (const [uri, diags] of entries) {
    const useful = diags.filter((d) => d.severity <= maxSev);
    if (!useful.length) continue;
    total += useful.length;
    const rel = ws.relative(uri);
    for (const d of useful.slice(0, 20)) {
      if (out.length >= max) break;
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const src = d.source ? `${d.source}` : '';
      const code = d.code && typeof d.code === 'object' ? d.code.value : d.code;
      const tag = [src, code].filter(Boolean).join(' ');
      out.push(`${rel}:${line}:${col} [${SEV_NAME[d.severity] || '?'}]${tag ? ' (' + tag + ')' : ''} ${d.message.replace(/\s+/g, ' ')}`);
    }
  }

  if (!out.length) return '问题面板里没有诊断信息 ✅（注意：有些语言需要先打开对应文件才会分析）';
  return `共 ${total} 条诊断，展示 ${out.length} 条：\n` + out.join('\n');
}

/** 当前编辑器状态：活动文件、选区、打开的标签 */
async function getEditorContext() {
  const parts = [];
  const root = ws.workspaceLabel();
  parts.push('工作区根目录：' + root);
  parts.push('操作系统：' + process.platform);

  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const doc = editor.document;
    parts.push(`当前文件：${ws.relative(doc.uri)}（${doc.languageId}，${doc.lineCount} 行）`);
    const sel = editor.selection;
    if (!sel.isEmpty) {
      const text = doc.getText(sel);
      parts.push(
        `选中区域：第 ${sel.start.line + 1}-${sel.end.line + 1} 行\n\`\`\`${doc.languageId}\n${text.slice(0, 4000)}\n\`\`\``
      );
    } else {
      parts.push(`光标位置：第 ${sel.active.line + 1} 行`);
      const from = Math.max(0, sel.active.line - 15);
      const to = Math.min(doc.lineCount - 1, sel.active.line + 15);
      const around = doc.getText(new vscode.Range(from, 0, to, Number.MAX_SAFE_INTEGER));
      parts.push(`光标附近（${from + 1}-${to + 1} 行）：\n\`\`\`${doc.languageId}\n${around}\n\`\`\``);
    }
  } else {
    parts.push('当前没有活动编辑器');
  }

  const tabs = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input && tab.input.uri) tabs.push(ws.relative(tab.input.uri));
    }
  }
  if (tabs.length) parts.push('已打开标签：' + Array.from(new Set(tabs)).slice(0, 20).join('、'));

  return parts.join('\n');
}

/** 尝试读取调试控制台的可见内容（需要当前有活动调试会话） */
async function getDebugConsole(args) {
  const maxLines = Math.min(400, Math.max(10, parseInt(args && args.lines, 10) || 80));
  const session = vscode.debug && vscode.debug.activeDebugSession;
  if (!session) {
    return '当前没有活动的调试会话，调试控制台为空。如需读取普通终端输出，请使用 get_terminal_output。';
  }
  const previous = await vscode.env.clipboard.readText();
  let text = '';
  try {
    await vscode.commands.executeCommand('workbench.debug.action.focusRepl');
    await new Promise((r) => setTimeout(r, 120));
    await vscode.commands.executeCommand('editor.action.selectAll');
    await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
    text = await vscode.env.clipboard.readText();
  } catch (e) {
    text = '';
  } finally {
    try { await vscode.env.clipboard.writeText(previous || ''); } catch (_) {}
  }
  text = String(text || '').replace(/\s+$/, '');
  if (!text || text === previous) {
    return '调试控制台为空或未能复制到内容。';
  }
  const arr = text.split('\n');
  const slice = arr.slice(Math.max(0, arr.length - maxLines));
  return `调试控制台「${session.name}」最后 ${slice.length} 行：\n` + slice.join('\n');
}

/** 获取本机正在监听的端口列表（作为 VS Code 端口面板的补充） */
async function getForwardedPorts(args) {
  const max = Math.min(200, parseInt(args && args.max_results, 10) || 50);
  const { execFile } = require('child_process');
  const platform = process.platform;

  return new Promise((resolve) => {
    let cmd, argsArr;
    if (platform === 'win32') {
      cmd = 'powershell.exe';
      argsArr = ['-NoProfile', '-Command',
        'Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Csv -NoTypeInformation'];
    } else if (platform === 'darwin') {
      cmd = 'netstat';
      argsArr = ['-anv', '-p', 'tcp'];
    } else {
      cmd = 'ss';
      argsArr = ['-tunlp'];
    }
    execFile(cmd, argsArr, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      if (err || !stdout) {
        resolve(`无法读取端口列表（${err ? err.message : '无输出'}）。\n注意：VS Code「端口」面板中的转发端口目前无法通过扩展 API 直接读取，请手动查看。`);
        return;
      }
      const lines = stdout.split('\n').filter((l) => l.trim());
      const head = lines.slice(0, max).join('\n');
      resolve(`本机监听端口（${lines.length} 条，展示前 ${max} 条）：\n\`\`\`\n${head}\n\`\`\``);
    });
  });
}

/** 给系统提示词用的简短环境快照 */
async function environmentBrief() {
  const root = ws.workspaceLabel();
  const editor = vscode.window.activeTextEditor;
  const lines = [
    `操作系统：${process.platform}`,
    `工作区：${root}`
  ];
  if (editor) {
    lines.push(`当前打开：${ws.relative(editor.document.uri)}（${editor.document.languageId}）`);
    // 注：原「用户选中了第 X-Y 行」已移除——它每轮随选中变化、对模型价值极低，
    // 却导致环境块每轮字节变化 → 前缀缓存 miss（对齐 DSH「变了才更新」）。
  }
  const errCount = vscode.languages
    .getDiagnostics()
    .reduce((n, e) => n + e[1].filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length, 0);
  if (errCount) lines.push(`问题面板当前有 ${errCount} 个错误（可用 get_diagnostics 查看）`);
  return lines.join('\n');
}

/** L1 极速层：当前激活文件的 Diagnostics 摘要（前 3 个 Error）。无激活文件或无误报返回空串。 */
function activeFileDiagnosticsBrief() {
  try {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return '';
    const uri = editor.document.uri;
    const diags = vscode.languages.getDiagnostics(uri);
    const errors = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
    if (!errors.length) return '';
    const shown = errors.slice(0, 3).map((d) => {
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const src = d.source ? `（${d.source}）` : '';
      return `L${line}:${col} ${d.message.replace(/\s+/g, ' ')}${src}`;
    });
    return `当前文件 ${ws.relative(uri)} 的前 ${shown.length} 个报错：\n` + shown.map((s) => '- ' + s).join('\n');
  } catch (_) {
    return '';
  }
}

module.exports = { getDiagnostics, getEditorContext, environmentBrief, getDebugConsole, getForwardedPorts, activeFileDiagnosticsBrief };
