'use strict';

/**
 * src/storageManager.js — 统一管理 fox-ai 各数据文件的存储位置
 *
 * 提供：查询当前路径、打开目录/文件、迁移到新目录。
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { resolvePath: memoryPath, defaultPath: memoryDefault } = require('./memory');
const { resolveDir: skillsDir, defaultDir: skillsDefault } = require('./skills');
const { resolvePath: planTaskPath, defaultPath: planTaskDefault } = require('./planTasks');
const { tw } = require('./i18n');

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(process.env.HOME || process.env.USERPROFILE || '', p.slice(2));
  if (p.startsWith('~\\')) return path.join(process.env.USERPROFILE || '', p.slice(2));
  return p;
}

function sessionDir(globalStorageDir, customDir) {
  const base = (customDir || '').trim()
    ? path.resolve(expandHome(customDir), 'sessions')
    : path.join(globalStorageDir, 'sessions');
  return base;
}

function moveTo(oldPath, newPath) {
  if (!fs.existsSync(oldPath)) return true;
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  try {
    fs.renameSync(oldPath, newPath);
  } catch (e) {
    const stat = fs.statSync(oldPath);
    if (stat.isDirectory()) {
      fs.cpSync(oldPath, newPath, { recursive: true, force: true });
      fs.rmSync(oldPath, { recursive: true, force: true });
    } else {
      fs.copyFileSync(oldPath, newPath);
      fs.unlinkSync(oldPath);
    }
  }
  return true;
}

async function openInVscode(fileOrDir) {
  try {
    const stat = fs.statSync(fileOrDir);
    if (stat.isDirectory()) {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(fileOrDir));
    } else {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fileOrDir));
      await vscode.window.showTextDocument(doc, { preview: false });
    }
  } catch (e) {
    vscode.window.showErrorMessage(tw('无法打开：{0}', e.message));
  }
}

function getPaths(context) {
  const cfg = vscode.workspace.getConfiguration('foxAi');
  const gs = context.globalStorageUri.fsPath;
  return {
    sessions: sessionDir(gs, cfg.get('sessions.storagePath', '')),
    memory: memoryPath(gs, cfg.get('memory.storagePath', '')),
    skills: skillsDir(gs, cfg.get('skills.storagePath', '')),
    planTasks: planTaskPath(gs, cfg.get('planTasks.storagePath', ''))
  };
}

function defaults(context) {
  const gs = context.globalStorageUri.fsPath;
  return {
    sessions: sessionDir(gs, ''),
    memory: memoryDefault(gs),
    skills: skillsDefault(gs),
    planTasks: planTaskDefault(gs)
  };
}

async function pickDirectory(title) {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: title || '选择目录'
  });
  return uris && uris.length ? uris[0].fsPath : null;
}

async function migrateMemory(context) {
  const cfg = vscode.workspace.getConfiguration('foxAi');
  const gs = context.globalStorageUri.fsPath;
  const oldPath = memoryPath(gs, cfg.get('memory.storagePath', ''));
  const newDir = await pickDirectory('选择长期记忆存储目录');
  if (!newDir) return;
  const newPath = memoryPath(gs, newDir);
  moveTo(oldPath, newPath);
  await cfg.update('memory.storagePath', newDir, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(tw('长期记忆已迁移到新位置，reload 窗口后完全生效'));
}

async function migrateSkills(context) {
  const cfg = vscode.workspace.getConfiguration('foxAi');
  const gs = context.globalStorageUri.fsPath;
  const oldDir = skillsDir(gs, cfg.get('skills.storagePath', ''));
  const newDir = await pickDirectory('选择用户技能存储目录');
  if (!newDir) return;
  const newPath = skillsDir(gs, newDir);
  moveTo(oldDir, newPath);
  await cfg.update('skills.storagePath', newDir, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(tw('用户技能已迁移到新位置，reload 窗口后完全生效'));
}

async function migratePlanTasks(context) {
  const cfg = vscode.workspace.getConfiguration('foxAi');
  const gs = context.globalStorageUri.fsPath;
  const oldPath = planTaskPath(gs, cfg.get('planTasks.storagePath', ''));
  const newDir = await pickDirectory('选择项目任务清单存储目录');
  if (!newDir) return;
  const newPath = planTaskPath(gs, newDir);
  moveTo(oldPath, newPath);
  await cfg.update('planTasks.storagePath', newDir, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(tw('项目任务清单已迁移到新位置，reload 窗口后完全生效'));
}

async function manageStorage(context) {
  const paths = getPaths(context);
  const items = [
    { label: '$(comment-discussion) 会话', description: paths.sessions, key: 'sessions', isFile: false },
    { label: '$(database) 长期记忆', description: paths.memory, key: 'memory', isFile: true },
    { label: '$(folder-library) 用户技能', description: paths.skills, key: 'skills', isFile: false },
    { label: '$(tasklist) 项目任务清单', description: paths.planTasks, key: 'planTasks', isFile: true }
  ];
  const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择要管理的存储项' });
  if (!picked) return;
  const action = await vscode.window.showQuickPick([
    { label: '$(folder-opened) 打开所在位置', key: 'open' },
    { label: '$(folder) 更改存储位置', key: 'change' }
  ], { placeHolder: '对 ' + picked.key + ' 执行操作' });
  if (!action) return;
  if (action.key === 'open') {
    await openInVscode(picked.isFile ? path.dirname(picked.description) : picked.description);
  } else if (action.key === 'change') {
    if (picked.key === 'sessions') {
      await vscode.commands.executeCommand('foxAi.setSessionStorage');
    } else if (picked.key === 'memory') {
      await migrateMemory(context);
    } else if (picked.key === 'skills') {
      await migrateSkills(context);
    } else if (picked.key === 'planTasks') {
      await migratePlanTasks(context);
    }
  }
}

module.exports = {
  getPaths,
  defaults,
  openInVscode,
  migrateMemory,
  migrateSkills,
  migratePlanTasks,
  manageStorage,
  sessionDir
};
