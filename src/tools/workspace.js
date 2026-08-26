'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DIFF_SCHEME = 'foxai-diff';
/** @type {Map<string, string>} 供 diff 视图读取的虚拟文档 */
const diffStore = new Map();
/** diffStore 最多保留多少条，防止无限泄漏 */
const DIFF_STORE_MAX = 50;

function setDiffContent(key, text) {
  if (diffStore.size >= DIFF_STORE_MAX && !diffStore.has(key)) {
    const first = diffStore.keys().next().value;
    diffStore.delete(first);
  }
  diffStore.set(key, text || '');
}

/** 注册 diff 用的虚拟文档提供者 */
function registerDiffProvider(context) {
  const provider = {
    provideTextDocumentContent(uri) {
      return diffStore.get(uri.toString()) || '';
    }
  };
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, provider)
  );
}

/**
 * 兜底工作区根目录：当 VS Code 未打开任何文件夹时，用配置里的目录作为「虚拟工作区根」，
 * 让网页接入（WebAI2API）、本地模型等「无文件夹」场景也能像原生 API 那样主动读/写文件。
 *
 * 优先级：
 *   1) foxAi.workspace.fallbackDir —— 显式指定，最优先（推荐给任意 provider 用）
 *   2) foxAi.webai2api.projectDir —— WebAI2API 已注册配置，未开文件夹时自动复用其项目目录
 *
 * 仅接受「真实存在、是目录、且非系统敏感路径」的目录，否则返回 null（保持原行为，相对路径仍需绝对路径）。
 * 安全：系统敏感路径永远禁止写入（isSystemPath），工作区外的写/删仍触发三重确认（isOutsideWorkspace）。
 */
function fallbackRoot() {
  try {
    const cfg = vscode.workspace.getConfiguration('foxAi');
    const candidates = [
      (cfg.get('workspace.fallbackDir') || '').trim(),
      (cfg.get('webai2api.projectDir') || '').trim()
    ];
    for (const raw of candidates) {
      if (!raw) continue;
      const p = path.resolve(raw);
      if (fs.existsSync(p) && fs.statSync(p).isDirectory() && !isSystemPath(p)) {
        return vscode.Uri.file(p);
      }
    }
  } catch (_) { /* 配置读取异常不影响主流程 */ }
  return null;
}

function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length) return folders[0].uri;
  // 未打开文件夹：尝试配置的兜底根目录（如 WebAI2API 项目目录），让无文件夹场景也能用文件工具
  return fallbackRoot();
}

/** 工作区显示名：开了文件夹显示根路径；未开文件夹但配了兜底根显示「(兜底工作区根) 路径」 */
function workspaceLabel() {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length) return folders[0].uri.fsPath;
  const fb = fallbackRoot();
  return fb ? '(兜底工作区根) ' + fb.fsPath : '(未打开文件夹)';
}

function rootPath() {
  const r = workspaceRoot();
  return r ? r.fsPath : '';
}

/** 系统级敏感路径，任何情况下都禁止写入 */
const SYSTEM_PROTECTED = [
  /\\System32(?:\\|$)/i,
  /\\SysWOW64(?:\\|$)/i,
  /\\Windows(?:\\|$)/i,
  /\\Program Files(?:\\|$)/i,
  /\\Program Files \(x86\)(?:\\|$)/i,
  /\\ProgramData(?:\\|$)/i,
  /\\Users\\[^\\]+\\AppData\\Local\\Microsoft(?:\\|$)/i,
  /\\Users\\[^\\]+\\ntuser\.dat/i,
  /\\boot/i,
  /\\etc\\passwd/i,
  /\\etc\\shadow/i,
  /\\\.ssh\\[^\\]+$/i,
  /\\\.env$/i,
  /id_rsa$/i,
  /\.pem$/i,
  /known_hosts$/i,
  /wallet\.dat$/i
];

/** 判断路径是否为系统级敏感路径 */
function isSystemPath(p) {
  const s = String(p).replace(/\//g, '\\');
  return SYSTEM_PROTECTED.some((re) => re.test(s));
}

/** 判断 uri 是否在工作区外 */
function isOutsideWorkspace(uri) {
  const root = workspaceRoot();
  if (!root) return true;
  const rel = path.relative(root.fsPath, uri.fsPath);
  return rel.startsWith('..');
}

/** 相对路径 → Uri。
 *  - allowOutside: 是否允许解析到工作区外
 *  - forRead: 若为 true，allowOutside 视为 true（读操作默认可跨工作区）
 */
function resolveUri(p, { allowOutside = false, forRead = false } = {}) {
  const root = workspaceRoot();
  const raw = String(p == null ? '' : p).trim().replace(/^["']|["']$/g, '');
  if (!raw) throw new Error('缺少 path 参数');

  const normalized = raw.replace(/\\/g, '/');
  const isAbsolute = path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw);

  if (!root) {
    if (!isAbsolute) throw new Error('当前没有打开工作区文件夹，请使用绝对路径');
    return vscode.Uri.file(raw);
  }

  let uri;
  if (isAbsolute) {
    uri = vscode.Uri.file(raw);
  } else {
    const parts = normalized.split('/').filter((s) => s && s !== '.');
    uri = vscode.Uri.joinPath(root, ...parts);
  }

  if (!allowOutside && !forRead) {
    const rel = path.relative(root.fsPath, uri.fsPath);
    if (rel.startsWith('..')) {
      throw new Error(`路径超出工作区范围，已拒绝：${raw}`);
    }
  }

  // 读操作跨工作区时受配置控制
  if (forRead && root && isOutsideWorkspace(uri)) {
    const cfg = vscode.workspace.getConfiguration('foxAi');
    if (!cfg.get('workspace.allowOutsideReads', true)) {
      throw new Error(`已禁用工作区外读取：${raw}`);
    }
  }
  return uri;
}

function relative(uri) {
  const root = workspaceRoot();
  if (!root) return uri.fsPath;
  const rel = path.relative(root.fsPath, uri.fsPath);
  return rel ? rel.split(path.sep).join('/') : path.basename(uri.fsPath);
}

async function exists(uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (_) {
    return false;
  }
}

async function readText(uri) {
  // 已打开且有未保存改动时，以编辑器内容为准
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}

function looksBinary(buf) {
  const len = Math.min(buf.length, 4096);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

/* ---------------- 换行符处理 ---------------- */

function detectLineEnding(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** 把外部文本统一成 LF 做内部处理 */
function toLf(text) {
  return text.replace(/\r\n/g, '\n');
}

/** 把 LF 转回指定换行符 */
function fromLf(text, le) {
  return le === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

function splitLines(text) {
  return toLf(text).split('\n');
}

/* ---------------- 工具实现 ---------------- */

async function readFile(args) {
  const uri = resolveUri(args.path, { forRead: true });
  let stat = null;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch (e) {
    // 区分「权限受限 / 系统保护」与「真的不存在」，给出更准确的提示
    const detail = String((e && (e.message + ' ' + e.code)) || '');
    if (/perm|access|denied|EACCES|EPERM|NoPermissions/i.test(detail)) {
      throw new Error('无法读取（权限受限或系统保护）：' + args.path);
    }
  }
  if (!stat) throw new Error('文件不存在：' + args.path);
  if (stat.type === vscode.FileType.Directory) {
    return listDir({ path: args.path });
  }
  if (stat.size > 2 * 1024 * 1024) throw new Error('文件超过 2MB，请指定行号范围读取');

  const bytes = await vscode.workspace.fs.readFile(uri);
  if (looksBinary(Buffer.from(bytes))) throw new Error('这是二进制文件，无法按文本读取');
  const raw = Buffer.from(bytes).toString('utf8');
  const lines = splitLines(raw);

  const start = Math.max(1, parseInt(args.start_line, 10) || 1);
  const end = Math.min(lines.length, parseInt(args.end_line, 10) || lines.length);
  let slice = lines.slice(start - 1, end);

  // 支持同一行内的字符范围（start_char / end_char，从 1 开始，end_char 包含）
  const startChar = parseInt(args.start_char, 10);
  const endChar = parseInt(args.end_char, 10);
  if (!Number.isNaN(startChar) && !Number.isNaN(endChar) && start === end && start <= lines.length) {
    const line = slice[0] || '';
    const sc = Math.max(0, startChar - 1);
    const ec = Math.max(sc, Math.min(line.length, endChar));
    slice = [line.slice(sc, ec)];
  }

  // 行号用「总行数定宽」而非「结束行号定宽」：否则行号位数在文件中部会跳动
  // （如第 2 行标签 2│、第 100 行 100│），模型会把前导空格误读成补零/偏移而数错行。
  const width = Math.max(2, String(lines.length).length);
  const numbered = slice.map((l, i) => String(start + i).padStart(width, ' ') + '│' + l).join('\n');
  const hasCharRange = !Number.isNaN(startChar) && !Number.isNaN(endChar);
  const rangeNote = start === end && hasCharRange
    ? `（共 ${lines.length} 行，显示 ${start} 行 ${startChar}-${endChar} 字符）`
    : `（共 ${lines.length} 行，显示 ${start}-${end}）`;
  let header = `文件：${relative(uri)}${rangeNote}\n`;

  // 大文件未指定范围时，附加代码骨架摘要并提示用户按需读取片段
  const LARGE_FILE_LINES = 400;
  const isLarge = lines.length > LARGE_FILE_LINES && start === 1 && end === lines.length;
  if (isLarge) {
    const projectScan = require('../projectScan');
    const skeleton = projectScan.astSkeleton(uri.fsPath, raw);
    header += '\n【文件较大，已自动提取代码骨架；如需看具体实现，请用 start_line/end_line 指定范围】\n';
    if (skeleton) {
      header += skeleton.split('\n').slice(0, 40).join('\n') + '\n';
      header += '…（以上为骨架，下面是前 ' + LARGE_FILE_LINES + ' 行原文）\n\n';
    }
    const preview = numbered.slice(0, numbered.length); // numbered 已经是 start-end
    // 只展示前 400 行原文
    return header + preview.split('\n').slice(0, LARGE_FILE_LINES).join('\n');
  }

  return header + numbered;
}

/** 写操作的 URI 解析：工作区外需 ctx.outsideConfirmed=true */
function resolveWriteUri(args, ctx) {
  const raw = String(args.path || '').trim();
  const isAbsolute = path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw);
  const uri = resolveUri(args.path, { allowOutside: !!(ctx && ctx.outsideConfirmed) });
  if (isSystemPath(uri.fsPath)) {
    throw new Error(`路径属于系统敏感区域，禁止写入：${raw}`);
  }
  if (isOutsideWorkspace(uri) && !(ctx && ctx.outsideConfirmed)) {
    throw new Error(`工作区外文件写入需先经用户确认：${raw}`);
  }
  return uri;
}

async function writeFile(args, ctx) {
  const uri = resolveWriteUri(args, ctx);
  let content = String(args.content == null ? '' : args.content);
  const had = await exists(uri);
  const before = had ? await readText(uri) : '';

  // 保留原文件换行符：已有文件按原换行写回；新文件默认 LF（避免 Windows 仓库出现大量 CRLF 变更）
  const le = had ? detectLineEnding(before) : '\n';
  content = fromLf(toLf(content), le);

  if (had && before === content) return `内容无变化：${relative(uri)}`;

  const dir = vscode.Uri.file(path.dirname(uri.fsPath));
  await vscode.workspace.fs.createDirectory(dir).catch(() => {});

  const edit = new vscode.WorkspaceEdit();
  if (!had) {
    edit.createFile(uri, { overwrite: false, ignoreIfExists: true });
  }
  const doc = had ? await vscode.workspace.openTextDocument(uri).catch(() => null) : null;
  if (doc) {
    const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    edit.replace(uri, full, content);
  } else {
    edit.insert(uri, new vscode.Position(0, 0), content);
  }
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) throw new Error('写入失败：' + relative(uri));

  const saved = await vscode.workspace.openTextDocument(uri);
  await saved.save();

  if (ctx && ctx.recordUndo) ctx.recordUndo({ uri, before, after: content, existed: had });
  const delta = diffStat(before, content);
  return `${had ? '已覆盖' : '已创建'} ${relative(uri)}（+${delta.added} -${delta.removed} 行）`;
}

/**
 * 纯函数：根据 edit_file 参数计算编辑后的内容。
 * 返回 { before: 原始文本, after: 编辑后文本, editKind, replacedCount }。
 * 与 editFile 实际写入逻辑保持一致，避免审批预览与实际执行不一致。
 */
function previewEditFile(args, rawBefore) {
  const le = detectLineEnding(rawBefore);
  const before = toLf(rawBefore);
  const oldText = toLf(String(args.old_text == null ? '' : args.old_text));
  const newText = toLf(String(args.new_text == null ? '' : args.new_text));

  const startLine = parseInt(args.start_line, 10);
  const endLine = parseInt(args.end_line, 10);
  const startChar = parseInt(args.start_char, 10);
  const endChar = parseInt(args.end_char, 10);

  let after;
  let replacedCount = 1;
  let editKind = '替换';

  // 方式 1：字符级范围替换（start_line + start_char + end_line + end_char）
  if (!Number.isNaN(startLine) && !Number.isNaN(startChar) && !Number.isNaN(endLine) && !Number.isNaN(endChar)) {
    const lines = before.split('\n');
    if (startLine < 1 || startLine > lines.length || endLine < 1 || endLine > lines.length) {
      throw new Error('start_line / end_line 超出文件行数范围');
    }
    const startIdx = charIndexAt(lines, startLine, startChar);
    const endIdx = charIndexAt(lines, endLine, endChar + 1); // end_char 包含，所以 +1
    if (startIdx > endIdx) throw new Error('start_char 不能大于 end_char');
    after = before.slice(0, startIdx) + newText + before.slice(endIdx);
    editKind = '范围替换';
  }
  // 方式 2：行范围 + old_text 限定搜索
  else if (oldText) {
    let searchSpace = before;
    let prefix = '';
    let suffix = '';
    if (!Number.isNaN(startLine) || !Number.isNaN(endLine)) {
      const lines = before.split('\n');
      const s = Math.max(1, Number.isNaN(startLine) ? 1 : startLine);
      const e = Math.min(lines.length, Number.isNaN(endLine) ? lines.length : endLine);
      const beforeLines = lines.slice(0, s - 1);
      const midLines = lines.slice(s - 1, e);
      const afterLines = lines.slice(e);
      prefix = beforeLines.join('\n') + (beforeLines.length ? '\n' : '');
      searchSpace = midLines.join('\n');
      suffix = (afterLines.length ? '\n' : '') + afterLines.join('\n');
    }

    const count = countOccurrences(searchSpace, oldText);
    if (count === 0) {
      const hint = nearestHint(searchSpace, oldText);
      throw new Error(`找不到 old_text。${hint}`);
    }
    if (count > 1 && !args.replace_all) {
      throw new Error(
        `old_text 在文件中出现 ${count} 次，无法确定改哪一处。请补充上下文让它唯一，或传 replace_all=true`
      );
    }

    // 注意：用函数式替换，避免 new_text 中的 $$ / $& / $` / $' / $n 被当作特殊替换模式解释。
    // 否则模型想写入「$$eval」会被静默变成「$eval」，正是历史死循环的根因。
    const midAfter = args.replace_all
      ? searchSpace.split(oldText).join(newText)
      : searchSpace.replace(oldText, () => newText);
    after = prefix + midAfter + suffix;
    replacedCount = args.replace_all ? count : 1;
  }
  // 方式 3：纯行范围删除/替换（old_text 为空，new_text 替换整段）
  else if (!Number.isNaN(startLine) && !Number.isNaN(endLine)) {
    const lines = before.split('\n');
    const s = Math.max(1, startLine);
    const e = Math.min(lines.length, endLine);
    const head = lines.slice(0, s - 1);
    const tail = lines.slice(e);
    // 区分「删除」与「替换」：newText 为空时 head/tail 之间只补一个换行，
    // 否则会在删除处残留一个多余空行（删首行还会留下行首空行）。
    if (newText) {
      after = head.join('\n') + (head.length ? '\n' : '') + newText + (tail.length ? '\n' : '') + tail.join('\n');
    } else {
      after = head.join('\n') + (head.length && tail.length ? '\n' : '') + tail.join('\n');
    }
    editKind = '范围' + (newText ? '替换' : '删除');
  } else {
    throw new Error('old_text 不能为空，创建新文件请用 write_file');
  }

  return { before: rawBefore, after: fromLf(after, le), editKind, replacedCount };
}

async function editFile(args, ctx) {
  const uri = resolveWriteUri(args, ctx);
  if (!(await exists(uri))) throw new Error('文件不存在：' + args.path);
  const rawBefore = await readText(uri);

  let result;
  try {
    result = previewEditFile(args, rawBefore);
  } catch (e) {
    // 把纯函数里的错误消息补回文件路径，保持原有提示体验
    throw new Error(`${relative(uri)}：${e.message}`);
  }
  const finalAfter = result.after;

  const doc = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  edit.replace(uri, full, finalAfter);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) throw new Error('编辑失败：' + relative(uri));
  await doc.save();

  if (ctx && ctx.recordUndo) ctx.recordUndo({ uri, before: rawBefore, after: finalAfter, existed: true });
  const delta = diffStat(rawBefore, finalAfter);
  return `已修改 ${relative(uri)}（${result.editKind} ${result.replacedCount} 处，+${delta.added} -${delta.removed} 行）`;
}

function charIndexAt(lines, line, char) {
  let idx = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) idx += lines[i].length + 1;
  const target = lines[line - 1] || '';
  idx += Math.min(target.length, Math.max(0, char - 1));
  return idx;
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

function nearestHint(content, oldText) {
  const first = oldText.split('\n').find((l) => l.trim());
  if (!first) return '';
  const key = first.trim().slice(0, 40);
  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(key)) return `第 ${i + 1} 行附近有相似内容，注意缩进和空白是否完全一致。`;
  }
  return '建议先用 read_file 确认原文。';
}

function diffStat(before, after) {
  const a = before ? splitLines(before) : [];
  const b = after ? splitLines(after) : [];
  const setA = new Map();
  for (const l of a) setA.set(l, (setA.get(l) || 0) + 1);
  let added = 0;
  for (const l of b) {
    const c = setA.get(l) || 0;
    if (c > 0) setA.set(l, c - 1);
    else added++;
  }
  let removed = 0;
  for (const c of setA.values()) removed += c;
  return { added, removed };
}

async function listDir(args) {
  const rel = args && args.path ? args.path : '.';
  const uri = resolveUri(rel === '.' || rel === '/' ? '.' : rel, { forRead: true });
  const depth = Math.min(3, Math.max(1, parseInt(args && args.depth, 10) || 1));
  const skip = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__', '.venv', 'target']);
  const lines = [];
  let count = 0;

  // 读取单个目录条目。VS Code fs API 在系统保护目录（如 System Volume Information）
  // 或某些驱动器根下可能整体拒绝，此时回退 Node fs 读取；仍失败返回 null，
  // 由调用方决定是否中断（根目录失败才报错，子目录失败仅跳过该项，不中断整体）。
  async function readEntries(dirUri) {
    try {
      return await vscode.workspace.fs.readDirectory(dirUri);
    } catch (_) {
      try {
        const p = dirUri.fsPath || String(dirUri);
        const names = await fs.promises.readdir(p);
        return names.map((n) => [n, vscode.FileType.Unknown]);
      } catch (_) {
        return null;
      }
    }
  }

  async function walk(dirUri, prefix, level) {
    if (level > depth || count > 400) return;
    const entries = await readEntries(dirUri);
    if (!entries) {
      if (level === 1) throw new Error('无法读取目录：' + relative(dirUri));
      lines.push(prefix + '⚠️ (无法读取：权限受限或系统保护目录)');
      return;
    }
    entries.sort((x, y) => {
      const dx = x[1] === vscode.FileType.Directory ? 0 : 1;
      const dy = y[1] === vscode.FileType.Directory ? 0 : 1;
      return dx - dy || x[0].localeCompare(y[0]);
    });
    for (const [name, type] of entries) {
      if (count++ > 400) {
        lines.push(prefix + '…（条目过多已截断）');
        return;
      }
      const isDir = type === vscode.FileType.Directory;
      lines.push(prefix + (isDir ? '📁 ' : '📄 ') + name);
      // 只对明确为目录的条目递归；Unknown（兜底读取）不递归，避免误入文件或炸开
      if (isDir && !skip.has(name) && !name.startsWith('.')) {
        await walk(vscode.Uri.joinPath(dirUri, name), prefix + '   ', level + 1);
      }
    }
  }

  await walk(uri, '', 1);
  return `目录 ${relative(uri) || '.'}：\n` + (lines.join('\n') || '(空目录)');
}

/** 将简单 glob 转成匹配相对路径的正则 */
function globToRegex(glob) {
  let s = glob.replace(/\\/g, '/');
  s = s.replace(/\*\*\//g, '__SS__');
  s = s.replace(/\*\*/g, '__S__');
  s = s.replace(/\*/g, '[^/]*');
  s = s.replace(/\?/g, '[^/]');
  s = s.replace(/__SS__/g, '(?:.*/)?');
  s = s.replace(/__S__/g, '.*');
  return new RegExp('^' + s + '$', 'i');
}

const GLOBAL_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__',
  '.venv', 'venv', 'target', '.idea', '.vs', '.vscode', 'bin', 'obj',
  'coverage', '.nuxt', '.output', '.cache', 'vendor'
]);

/** 使用 Node.js fs 在指定根目录下按 glob 查找文件（全电脑模式：深度加深到 14） */
async function findFilesGlobal(root, pattern, max) {
  const results = [];
  const re = globToRegex(pattern);
  const rootAbs = path.resolve(root);
  const maxDepth = 14;

  async function walk(dir, depth) {
    if (depth > maxDepth || results.length >= max) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      if (results.length >= max) return;
      if (ent.name.startsWith('.') && ent.name !== '.github' && ent.name !== '.gitlab') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (GLOBAL_SKIP_DIRS.has(ent.name)) continue;
        await walk(full, depth + 1);
      } else if (ent.isFile()) {
        const rel = path.relative(rootAbs, full).replace(/\\/g, '/');
        if (re.test(rel)) results.push(full);
      }
    }
  }

  await walk(rootAbs, 0);
  return results;
}

/** 获取全局搜索的默认根目录 */
function globalSearchRoot(args) {
  if (args && args.root) return path.resolve(String(args.root));
  const cfgRoot = (vscode.workspace.getConfiguration('foxAi').get('workspace.globalSearchRoot', '') || '').trim();
  if (cfgRoot) return path.resolve(cfgRoot);
  const home = os.homedir();
  return home || process.cwd();
}

async function findFiles(args) {
  const pattern = String(args.pattern || '**/*').trim();
  // 1.1.17：一次搜索量加大——电脑内默认 200、上限 2000（原来默认 60/上限 200，经常「搜不到几个」）
  const max = Math.min(2000, parseInt(args.max_results, 10) || 200);
  const scope = args.scope || 'workspace';
  const isGlobal = scope === 'global' || path.isAbsolute(pattern);

  let list;
  if (isGlobal) {
    const root = globalSearchRoot(args);
    list = await findFilesGlobal(root, pattern, max);
    if (!list.length) return `在 ${root} 下没有匹配 ${pattern} 的文件。可试试更宽的模式（如 **/*.txt）或换 root 起始目录。`;
    const loc = locHint(list.length, pattern);
    return `在 ${root} 匹配 ${pattern} 的文件（${list.length} 个）：\n` + list.join('\n') + loc;
  }

  const exclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.venv/**,**/__pycache__/**}';
  const uris = await vscode.workspace.findFiles(pattern, exclude, max);
  if (!uris.length) return `没有匹配 ${pattern} 的文件。可试试更宽的模式或去掉排除目录。`;
  list = uris.map((u) => relative(u));
  return `匹配 ${pattern} 的文件（${list.length} 个）：\n` + list.join('\n') + locHint(list.length, pattern);
}

/** 搜索完成后的定位提示：告诉模型怎么把结果落成「具体文件定位」 */
function locHint(count, pattern) {
  const lines = [];
  if (count >= 200) {
    lines.push(`\n\n【定位提示】结果较多（≥200），建议先用 open_file / read_file 定位前几个确认路径正确，再用更窄的 pattern（如 src/**/*.js、**/package.json）缩小范围。`);
  } else {
    lines.push(`\n\n【定位提示】以上路径均为绝对/工作区相对路径，可直接 open_file / read_file 打开定位；若需进一步缩小，可用 search_text 在指定目录或用更精确的 glob 再搜。`);
  }
  return lines.join('\n');
}

async function searchText(args) {
  const query = String(args.query || '');
  if (!query) throw new Error('query 不能为空');
  const glob = String(args.glob || '**/*');
  // 1.1.17：搜索量加大——默认 80、上限 500（原来 40/120，电脑内搜文本经常不够）
  const max = Math.min(500, parseInt(args.max_results, 10) || 80);
  const isRegex = !!args.is_regex;
  const scope = args.scope || 'workspace';
  const isGlobal = scope === 'global' || path.isAbsolute(glob);
  let re;
  try {
    re = isRegex ? new RegExp(query, 'g') : null;
  } catch (e) {
    throw new Error('正则不合法：' + e.message);
  }

  if (isGlobal) {
    const root = globalSearchRoot(args);
    const files = await findFilesGlobal(root, glob, 600);
    const hits = [];
    for (const file of files) {
      if (hits.length >= max) break;
      let buf;
      try {
        const stat = await fs.promises.stat(file);
        if (stat.size > 1024 * 1024) continue;
        buf = await fs.promises.readFile(file);
      } catch (_) {
        continue;
      }
      if (looksBinary(buf)) continue;
      const lines = splitLines(buf.toString('utf8'));
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let matched = false;
        if (re) {
          re.lastIndex = 0;
          matched = re.test(line);
        } else {
          matched = line.indexOf(query) !== -1;
        }
        if (matched) {
          hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 200)}`);
          if (hits.length >= max) break;
        }
      }
    }
    if (!hits.length) return `在 ${root} 下没找到「${query}」`;
    return `在 ${root} 搜索「${query}」共 ${hits.length} 条：\n` + hits.join('\n') +
      `\n\n【定位提示】每条是「文件路径:行号: 命中行」，用 read_file 直接定位到对应文件+行（参数 path 填冒号前的路径，start_line 填行号）；若想继续缩小范围，可加 glob 限定文件类型再搜。`;
  }

  const exclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.venv/**,**/__pycache__/**,**/*.min.*}';
  const uris = await vscode.workspace.findFiles(glob, exclude, 1500);
  const hits = [];
  for (const uri of uris) {
    if (hits.length >= max) break;
    let stat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch (_) {
      continue;
    }
    if (stat.size > 1024 * 1024) continue;
    let buf;
    try {
      buf = Buffer.from(await vscode.workspace.fs.readFile(uri));
    } catch (_) {
      continue;
    }
    if (looksBinary(buf)) continue;
    const lines = splitLines(buf.toString('utf8'));
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let matched = false;
      if (re) {
        re.lastIndex = 0;
        matched = re.test(line);
      } else {
        matched = line.indexOf(query) !== -1;
      }
      if (matched) {
        hits.push(`${relative(uri)}:${i + 1}: ${line.trim().slice(0, 200)}`);
        if (hits.length >= max) break;
      }
    }
  }
  if (!hits.length) return `没找到「${query}」`;
  return `搜索「${query}」共 ${hits.length} 条：\n` + hits.join('\n') +
    `\n\n【定位提示】每条是「相对路径:行号: 命中行」，用 read_file 直接定位（path 填冒号前的路径、start_line 填行号）；也可加 glob 限定文件类型（如 *.js）再搜缩小范围。`;
}

async function deleteFile(args, ctx) {
  const uri = resolveWriteUri(args, ctx);
  if (!(await exists(uri))) throw new Error('文件不存在：' + args.path);
  let rawBefore = '';
  try {
    rawBefore = await readText(uri);
  } catch (_) {}

  const startLine = parseInt(args.start_line, 10);
  const endLine = parseInt(args.end_line, 10);

  // 支持只删除指定行范围，而不是整个文件
  if (!Number.isNaN(startLine) || !Number.isNaN(endLine)) {
    const le = detectLineEnding(rawBefore);
    const before = toLf(rawBefore);
    const lines = before.split('\n');
    const s = Math.max(1, Number.isNaN(startLine) ? 1 : startLine);
    const e = Math.min(lines.length, Number.isNaN(endLine) ? lines.length : endLine);
    if (s > e) throw new Error('start_line 不能大于 end_line');
    const head = lines.slice(0, s - 1);
    const tail = lines.slice(e);
    const after = fromLf(
      head.join('\n') + (head.length && tail.length ? '\n' : '') + tail.join('\n'),
      le
    );
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    edit.replace(uri, full, after);
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) throw new Error('删除行范围失败：' + relative(uri));
    await doc.save();
    if (ctx && ctx.recordUndo) ctx.recordUndo({ uri, before: rawBefore, after, existed: true });
    const delta = diffStat(rawBefore, after);
    return `已删除 ${relative(uri)} 的第 ${s}-${e} 行（-${delta.removed} 行）`;
  }

  await vscode.workspace.fs.delete(uri, { recursive: !!args.recursive, useTrash: true });
  if (ctx && ctx.recordUndo) ctx.recordUndo({ uri, before: rawBefore, existed: true, deleted: true });
  return `已把 ${relative(uri)} 移入回收站（可用「撤销上一次改动」找回，撤销后还能「重做」恢复）`;
}

async function openFile(args) {
  const uri = resolveUri(args.path, { forRead: true });
  const doc = await vscode.workspace.openTextDocument(uri);
  const line = Math.max(0, (parseInt(args.line, 10) || 1) - 1);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  return `已在编辑器中打开 ${relative(uri)}${args.line ? ' 第 ' + args.line + ' 行' : ''}`;
}

/** 打开原生 diff 视图 */
async function showDiff(pathLike, oldText, newText, title) {
  const uri = resolveUri(pathLike);
  const key = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const leftUri = vscode.Uri.parse(`${DIFF_SCHEME}:/${key}/原文件/${path.basename(uri.fsPath)}`);
  const rightUri = vscode.Uri.parse(`${DIFF_SCHEME}:/${key}/AI 修改后/${path.basename(uri.fsPath)}`);
  setDiffContent(leftUri.toString(), oldText || '');
  setDiffContent(rightUri.toString(), newText || '');
  await vscode.commands.executeCommand(
    'vscode.diff',
    leftUri,
    rightUri,
    title || `${relative(uri)}（狐狸 AI 待应用改动）`,
    { preview: true }
  );
}

/**
 * 生成带行号的紧凑 diff 摘要，给审批卡片 / 审查摘要展示。
 *
 * 行号规则（与编辑器、read_file 的 1 索引一致）：
 *   - 上下文行 / 删除行 标「原文件行号」，新增行标「新文件行号」；
 *   - 原行号 ≠ 新行号 时用「原→新」标注（删除/插入带来的行号错位），
 *     让模型一眼看出「第 N 行内容被挪到了第 M 行」——正是「让 AI 写第 15 行、
 *     结果写到第 14 行」这类落点偏差能被自检发现的锚点；
 *   - 行号右对齐、定宽，避免 read_file 那种宽度跳动（1/9/10 行号宽窄不一）。
 */
function unifiedPreview(before, after, maxLines = 40) {
  // 先把 CRLF 归一成 LF：否则「CRLF 原文件 vs LF 新内容」会被逐行误判为全部改动，
  // 审批预览 / 审查摘要里就会出现满屏的「每行都删又都加」假 diff。
  const a = (before || '').replace(/\r\n/g, '\n').split('\n');
  const b = (after || '').replace(/\r\n/g, '\n').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const aWidth = Math.max(1, String(a.length).length);
  const bWidth = Math.max(1, String(b.length).length);
  const width = Math.max(aWidth, bWidth);
  const ln = (n, pad) => String(n).padStart(pad || width, ' ');
  const ctxStart = Math.max(0, start - 2);
  const out = [];
  // 上下文行：原行号与目标行号错位时标注「原→新」，行号一致则只标一个
  for (let i = ctxStart; i < start; i++) {
    const oldNo = i + 1;
    const newNo = oldNo + (b.length - a.length);
    out.push((oldNo === newNo ? ' ' + ln(oldNo) : ln(oldNo) + '→' + ln(newNo, aWidth)) + '│ ' + a[i]);
  }
  for (let i = start; i <= endA; i++) out.push('-' + ln(i + 1, aWidth) + '│ ' + a[i]);
  for (let i = start; i <= endB; i++) out.push('+' + ln(i + 1, bWidth) + '│ ' + b[i]);
  const tailEnd = Math.min(a.length - 1, endA + 2);
  for (let i = endA + 1; i <= tailEnd; i++) {
    const oldNo = i + 1;
    const newNo = oldNo + (b.length - a.length);
    out.push((oldNo === newNo ? ' ' + ln(oldNo) : ln(oldNo) + '→' + ln(newNo, aWidth)) + '│ ' + a[i]);
  }
  if (out.length > maxLines) {
    return out.slice(0, maxLines).join('\n') + `\n… 还有 ${out.length - maxLines} 行`;
  }
  return out.join('\n');
}

module.exports = {
  DIFF_SCHEME,
  registerDiffProvider,
  workspaceRoot,
  workspaceLabel,
  rootPath,
  resolveUri,
  isOutsideWorkspace,
  isSystemPath,
  relative,
  exists,
  readText,
  readFile,
  writeFile,
  editFile,
  previewEditFile,
  listDir,
  findFiles,
  searchText,
  deleteFile,
  openFile,
  showDiff,
  unifiedPreview,
  diffStat
};
