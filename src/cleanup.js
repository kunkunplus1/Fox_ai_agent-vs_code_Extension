'use strict';

/**
 * src/cleanup.js — 一键清理狐狸 AI 产生的垃圾/缓存文件
 *
 * 清理范围（全部来自 fox-ai 自己的存储路径，不会碰用户其他文件）：
 *   - ~/.fox-ai/cache/                项目扫描缓存 + 知识库索引缓存
 *   - 会话记录目录（sessions）
 *   - 长期记忆文件/目录（memory）
 *   - 用户技能目录（skills）
 *   - 项目任务清单文件（planTasks）
 *   - 自动摘要知识库目录（knowledgeBase.autoSummarize.dir，若已设置）
 *
 * Windows 下使用 SHFileOperation + FOF_ALLOWUNDO 移到回收站；
 * 其他平台对缓存直接删除，对用户数据弹窗警告后手动处理。
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const storageManager = require('./storageManager');
const { tw } = require('./i18n');

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return bytes + ' B';
}

function dirSize(p) {
  if (!fs.existsSync(p)) return 0;
  const st = fs.statSync(p);
  if (st.isFile()) return st.size;
  let total = 0;
  try {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) total += dirSize(full);
      else if (entry.isFile()) {
        try { total += fs.statSync(full).size; } catch (_) {}
      }
    }
  } catch (_) {}
  return total;
}

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(process.env.HOME || process.env.USERPROFILE || '', p.slice(2));
  if (p.startsWith('~\\')) return path.join(process.env.USERPROFILE || '', p.slice(2));
  return p;
}

function getCleanupItems(context) {
  const cfg = vscode.workspace.getConfiguration('foxAi');
  const paths = storageManager.getPaths(context);
  const autoDir = expandHome(cfg.get('knowledgeBase.autoSummarize.dir', ''));
  const cacheDir = path.join(os.homedir(), '.fox-ai', 'cache');

  const items = [
    {
      key: 'cache',
      label: '$(dashboard) 缓存文件',
      detail: '项目扫描缓存、知识库索引缓存（可安全清理）',
      path: cacheDir,
      dangerous: false,
      picked: true
    },
    {
      key: 'sessions',
      label: '$(comment-discussion) 会话记录',
      detail: '所有对话会话的本地备份',
      path: paths.sessions,
      dangerous: true,
      picked: false
    },
    {
      key: 'memory',
      label: '$(database) 长期记忆',
      detail: 'save_memory / get_memory 持久化的记忆文件',
      path: paths.memory,
      dangerous: true,
      picked: false
    },
    {
      key: 'skills',
      label: '$(folder-library) 用户技能',
      detail: 'create_skill 创建的用户自定义技能',
      path: paths.skills,
      dangerous: true,
      picked: false
    },
    {
      key: 'planTasks',
      label: '$(tasklist) 项目任务清单',
      detail: '项目任务清单数据',
      path: paths.planTasks,
      dangerous: true,
      picked: false
    }
  ];

  if (autoDir) {
    items.push({
      key: 'autoSummarize',
      label: '$(files) 自动摘要知识库',
      detail: '知识库自动摘要生成的文档目录',
      path: autoDir,
      dangerous: true,
      picked: false
    });
  }

  for (const it of items) {
    it.size = dirSize(it.path);
    it.description = `${it.size ? formatBytes(it.size) : '无文件'} · ${it.path}`;
  }

  return items;
}

function encodePowerShellCommand(script) {
  const buf = Buffer.from(script, 'utf16le');
  return buf.toString('base64');
}

/** 跨平台杀进程树（取消 / 超时兜底用） */
function killProcessTree(child) {
  if (!child || child.pid == null) return;
  if (process.platform === 'win32') {
    try {
      cp.spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    } catch (_) {}
  } else {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
}

function runPowerShell(script, { token, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = encodePowerShellCommand(script);
    const child = cp.spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (fn) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); fn(); };
    const onCancel = () => finish(() => { killProcessTree(child); reject(new Error('已取消')); });
    if (token) token.onCancellationRequested(onCancel);
    if (timeout) timer = setTimeout(() => finish(() => { killProcessTree(child); reject(new Error('操作超时（' + (timeout / 1000) + ' 秒）')); }), timeout);
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', (code) => {
      finish(() => {
        if (code !== 0) reject(new Error('PowerShell 退出码 ' + code + (stderr ? ': ' + stderr.trim() : '')));
        else resolve();
      });
    });
  });
}

function buildRecycleScript(paths) {
  const quoted = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
  return `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class RecycleBin {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern int SHFileOperation(ref SHFILEOPSTRUCT lpFileOp);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct SHFILEOPSTRUCT {
    public IntPtr hwnd;
    public uint wFunc;
    public string pFrom;
    public string pTo;
    public ushort fFlags;
    public bool fAnyOperationsAborted;
    public IntPtr hNameMappings;
    public string lpszProgressTitle;
  }

  public const uint FO_DELETE = 0x0003;
  public const ushort FOF_ALLOWUNDO = 0x0040;
  public const ushort FOF_NOCONFIRMATION = 0x0010;
  public const ushort FOF_SILENT = 0x0004;

  public static int Delete(string path) {
    var op = new SHFILEOPSTRUCT();
    op.wFunc = FO_DELETE;
    op.pFrom = path + "\\0";
    op.fFlags = (ushort)(FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT);
    return SHFileOperation(ref op);
  }
}
'@

$paths = @(${quoted})
foreach ($p in $paths) {
  if (Test-Path $p) {
    [RecycleBin]::Delete($p) | Out-Null
  }
}
`;
}

async function deleteItemsWindows(paths, token) {
  if (!paths.length) return;
  await runPowerShell(buildRecycleScript(paths), { token, timeout: 60000 });
}

async function deleteItemsPosix(items, token) {
  for (const it of items) {
    if (token && token.isCancellationRequested) throw new Error('已取消');
    if (!fs.existsSync(it.path)) continue;
    const st = fs.statSync(it.path);
    if (it.dangerous) {
      await vscode.window.showWarningMessage(
        `非 Windows 平台下删除用户数据需要手动操作：${it.path}`,
        { modal: true }, '我已备份，永久删除'
      );
    }
    if (st.isDirectory()) fs.rmSync(it.path, { recursive: true, force: true });
    else fs.unlinkSync(it.path);
  }
}

async function cleanupFoxAi(context) {
  const items = getCleanupItems(context);
  if (items.every((it) => it.size === 0)) {
    vscode.window.showInformationMessage(tw('[狐狸 AI] 没有找到可清理的狐狸 AI 文件。'));
    return { cleaned: [], freedBytes: 0 };
  }

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: '选择要清理的类别（默认仅勾选缓存，用户数据请谨慎）',
    ignoreFocusOut: true
  });
  if (!picked || !picked.length) return { cleaned: [], freedBytes: 0 };

  const totalBytes = picked.reduce((s, it) => s + it.size, 0);
  const hasDangerous = picked.some((it) => it.dangerous);

  const lines = picked.map((it) => `• ${it.label.split(' ').slice(1).join(' ')}：${formatBytes(it.size)}`).join('\n');
  const confirm = await vscode.window.showWarningMessage(
    `⚠️ 即将把以下狐狸 AI 文件移到回收站（共 ${formatBytes(totalBytes)}）：\n${lines}` +
    (hasDangerous ? '\n\n包含用户数据，删除后不可从狐狸 AI 恢复，但可在回收站还原。' : ''),
    { modal: true }, '确认清理'
  );
  if (confirm !== '确认清理') return { cleaned: [], freedBytes: 0 };

  await vscode.window.withProgress(
    { title: '清理狐狸 AI 文件中…（可点取消）', location: vscode.ProgressLocation.Notification, cancellable: true },
    async (progress, token) => {
      if (process.platform === 'win32') {
        await deleteItemsWindows(picked.map((it) => it.path), token);
      } else {
        await deleteItemsPosix(picked, token);
      }
    }
  );

  vscode.window.showInformationMessage(
    `[狐狸 AI] 已清理 ${picked.length} 类文件，释放 ${formatBytes(totalBytes)}。可到回收站还原。`
  );
  return { cleaned: picked.map((it) => it.key), freedBytes: totalBytes };
}

module.exports = { cleanupFoxAi, formatBytes, dirSize };
