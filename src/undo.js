'use strict';

const vscode = require('vscode');
const nodeFs = require('fs');
const ws = require('./tools/workspace');
const { tw } = require('./i18n');

/**
 * 撤销 / 重做栈。每条记录描述一次 AI 文件改动：
 *   { uri, before, after, existed, deleted, at }
 * - before：改动前的文件内容（deleted 时为被删文件的内容）
 * - after ：改动后的文件内容（deleted 时为 null，因为文件已删）
 * - existed：改动前文件是否已存在（false 表示是「新建文件」）
 * - deleted：本次改动是否为「删除文件」
 */
const undoStack = [];
const redoStack = [];
const MAX = 60;

function record(entry) {
  const e = Object.assign({ at: Date.now() }, entry);
  if (e.deleted) {
    e.after = null; // 删除操作：重做 = 再次删除，无需内容
  } else if (typeof e.after === 'string') {
    // 调用方已提供改动后的内容（最准确，也避免二次读盘）
  } else if (e.existed === false) {
    // 新建文件：改动后内容即当前文件内容
    try { e.after = nodeFs.readFileSync(e.uri.fsPath, 'utf8'); } catch (_) { e.after = ''; }
  } else {
    // 编辑已有文件：记录时文件已是新内容
    try { e.after = nodeFs.readFileSync(e.uri.fsPath, 'utf8'); } catch (_) { e.after = ''; }
  }
  undoStack.push(e);
  if (undoStack.length > MAX) undoStack.shift();
  // 新的改动会让「重做」失效（标准编辑器行为）
  redoStack.length = 0;
}

function size() {
  return undoStack.length;
}

function redoSize() {
  return redoStack.length;
}

async function writeContent(uri, content) {
  const edit = new vscode.WorkspaceEdit();
  const exists = await ws.exists(uri);
  if (!exists) {
    edit.createFile(uri, { overwrite: true });
    edit.insert(uri, new vscode.Position(0, 0), content);
  } else {
    const doc = await vscode.workspace.openTextDocument(uri);
    const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    edit.replace(uri, full, content);
  }
  await vscode.workspace.applyEdit(edit);
  const doc = await vscode.workspace.openTextDocument(uri);
  await doc.save();
}

// 把文件恢复到「改动前」状态（撤销）
async function applyBackward(op) {
  if (op.deleted) {
    await writeContent(op.uri, op.before || '');
    return `已撤销：恢复了被删除的 ${ws.relative(op.uri)}`;
  }
  if (!op.existed) {
    // 当初是新建文件 → 撤销 = 把它删掉（优先回收站，失败则强制删除）
    try {
      await vscode.workspace.fs.delete(op.uri, { useTrash: true });
    } catch (_) {
      await vscode.workspace.fs.delete(op.uri, { useTrash: false });
    }
    return `已撤销：删除了新建的 ${ws.relative(op.uri)}`;
  }
  await writeContent(op.uri, op.before || '');
  return `已撤销对 ${ws.relative(op.uri)} 的改动`;
}

// 把文件恢复到「改动后」状态（重做）
async function applyForward(op) {
  if (op.deleted) {
    try {
      await vscode.workspace.fs.delete(op.uri, { useTrash: true });
    } catch (_) {
      await vscode.workspace.fs.delete(op.uri, { useTrash: false });
    }
    return `已重做：再次删除了 ${ws.relative(op.uri)}`;
  }
  await writeContent(op.uri, op.after || '');
  if (!op.existed) return `已重做：恢复了新建的 ${ws.relative(op.uri)}`;
  return `已重做对 ${ws.relative(op.uri)} 的改动`;
}

async function undoLast() {
  const op = undoStack.pop();
  if (!op) {
    vscode.window.showInformationMessage(tw('狐狸 AI 没有可撤销的改动～'));
    return null;
  }
  try {
    const msg = await applyBackward(op);
    redoStack.push(op);
    vscode.window.showInformationMessage(msg);
    return op.uri;
  } catch (e) {
    undoStack.push(op); // 失败则塞回栈，可重试
    vscode.window.showErrorMessage(tw('撤销失败：{0}', e && e.message));
    return null;
  }
}

async function redoLast() {
  const op = redoStack.pop();
  if (!op) {
    vscode.window.showInformationMessage(tw('没有可重做的改动～（重做仅在刚撤销后可用，新的改动会清空它）'));
    return null;
  }
  try {
    const msg = await applyForward(op);
    undoStack.push(op);
    vscode.window.showInformationMessage(msg);
    return op.uri;
  } catch (e) {
    redoStack.push(op);
    vscode.window.showErrorMessage(tw('重做失败：{0}', e && e.message));
    return null;
  }
}

function clear() {
  undoStack.length = 0;
  redoStack.length = 0;
}

module.exports = { record, undoLast, redoLast, size, redoSize, clear };
