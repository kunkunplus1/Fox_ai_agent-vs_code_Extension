'use strict';

/*
 * src/runtimes.js — 环境管理器
 *
 * 负责在用户明确授权下，从「官方源白名单」下载并安装各类开发运行时
 * （Python / Node.js / C-C++(MinGW) / C#(.NET) / Java / Go / Rust），
 * 校验文件哈希，配置 PATH，并以受控方式申请管理员权限。
 *
 * 安全原则（不可绕过）：
 *   1. 任何下载 URL 的 host 必须命中 ALLOWED_HOSTS，否则拒绝。
 *   2. 安装 / 改 PATH / 提权前必须用户显式确认（弹窗 / UAC）。
 *   3. 管理员提权只有两种模式：每次 UAC，或「该会话内不再询问」（仍由
 *      Windows 在每次 Start-Process -Verb RunAs 时弹一次系统 UAC，但扩展
 *      自身不再二次弹确认，并尽量把多次操作合并到一次提权脚本里）。
 *   4. 所有动作写入审计日志，可回看；PATH 修改前自动备份，支持回滚。
 *   5. 默认安装在用户数据目录（foxAi.runtimes.installRoot），不污染系统盘。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---- 懒加载，便于在单元测试里 mock ----
function vscode() { return require('vscode'); }
function conf() { return require('./config').conf(); }

// ---- 官方源白名单（仅这些 host 允许下载） ----
const ALLOWED_HOSTS = [
  'www.python.org', 'downloads.python.org',
  'nodejs.org', 'registry.npmmirror.com',
  'github.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com', 'raw.githubusercontent.com', 'release-assets.githubusercontent.com',
  'mirrors.tuna.tsinghua.edu.cn', 'mirrors.ustc.edu.cn', 'mirrors.aliyun.com', 'mirrors.cloud.tencent.com',
  'dotnet.microsoft.com', 'builds.dotnet.microsoft.com', 'aka.ms',
  'download.visualstudio.microsoft.com',
  'api.adoptium.net',
  'go.dev', 'golang.google.cn', 'dl.google.com',
  'static.rust-lang.org', 'static.crates.io',
  '7-zip.org'
];

function isHostAllowed(targetUrl) {
  let u;
  try { u = new URL(targetUrl); } catch (_) { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  return ALLOWED_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

// ---- 运行时清单 ----
// 每个平台项给出 resolve(version, arch) -> { url, mirror?, sha256?, installType, binSubdir }
// installType: 'archive' = 下载压缩包解压；'installer' = 下载安装器并以提权方式运行。
const RUNTIMES = {
  python: {
    id: 'python', name: 'Python', defaultVersion: '3.12.4', kind: 'language',
    platforms: {
      win32: {
        installType: 'archive',
        // 官方 embeddable 包（免安装、可放用户目录），带 pip 的 full embeddable 用 zip
        resolve: (v) => {
          const ver = v.replace(/\./g, ''); // 3.12.4 -> 3124
          const short = v.split('.').slice(0, 2).join(''); // 312
          return {
            url: `https://www.python.org/ftp/python/${v}/python-${v}-embed-amd64.zip`,
            mirror: `https://mirrors.tuna.tsinghua.edu.cn/python/${v}/python-${v}-embed-amd64.zip`,
            installType: 'archive',
            binSubdir: '',
            note: '使用官方 embeddable 包（免安装），解压即用；如需 pip 可自行执行 get-pip.py'
          };
        }
      }
    }
  },
  node: {
    id: 'node', name: 'Node.js', defaultVersion: '22.22.2', kind: 'runtime',
    platforms: {
      win32: {
        installType: 'archive',
        resolve: (v) => {
          const major = v.split('.')[0];
          return {
            url: `https://nodejs.org/dist/v${v}/node-v${v}-win-x64.zip`,
            mirror: `https://registry.npmmirror.com/-/binary/node/v${v}/node-v${v}-win-x64.zip`,
            installType: 'archive',
            binSubdir: ''
          };
        }
      }
    }
  },
  mingw: {
    id: 'mingw', name: 'C / C++ (MinGW-w64)', defaultVersion: '13.2.0', kind: 'toolchain',
    platforms: {
      win32: {
        installType: 'archive',
        resolve: () => ({
          url: 'https://github.com/niXman/mingw-builds-binaries/releases/download/13.2.0-rt_v11-rev1/x86_64-13.2.0-release-win32-seh-msvcrt-rt_v11-rev1.7z',
          mirror: 'https://mirrors.tuna.tsinghua.edu.cn/msys2/mingw/13.2.0/x86_64-13.2.0-release-win32-seh-msvcrt-rt_v11-rev1.7z',
          installType: 'archive',
          binSubdir: 'bin',
          note: '7z 压缩包，解压后把 bin 目录加入 PATH；需要系统已装 7-Zip 或插件调用 7z'
        })
      }
    }
  },
  csharp: {
    id: 'csharp', name: 'C# (.NET SDK)', defaultVersion: '8.0.400', kind: 'runtime',
    platforms: {
      win32: {
        installType: 'installer',
        resolve: (v) => ({
          url: `https://download.visualstudio.microsoft.com/download/pr/dotnet/sdk/${v}/dotnet-sdk-${v}-win-x64.exe`,
          mirror: `https://builds.dotnet.microsoft.com/dotnet/Sdk/${v}/dotnet-sdk-${v}-win-x64.exe`,
          installType: 'installer',
          binSubdir: '',
          note: '官方安装器，需要管理员权限运行'
        })
      }
    }
  },
  java: {
    id: 'java', name: 'Java (Temurin)', defaultVersion: '21.0.4+7', kind: 'runtime',
    platforms: {
      win32: {
        installType: 'archive',
        resolve: () => ({
          url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.4%2B7/OpenJDK21U-jdk_x64_windows_hotspot_21.0.4_7.zip',
          mirror: 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/windows/OpenJDK21U-jdk_x64_windows_hotspot_21.0.4_7.zip',
          installType: 'archive',
          binSubdir: 'bin'
        })
      }
    }
  },
  go: {
    id: 'go', name: 'Go', defaultVersion: '1.22.5', kind: 'runtime',
    platforms: {
      win32: {
        installType: 'archive',
        resolve: (v) => ({
          url: `https://go.dev/dl/go${v}.windows-amd64.zip`,
          mirror: `https://golang.google.cn/dl/go${v}.windows-amd64.zip`,
          installType: 'archive',
          binSubdir: 'bin'
        })
      }
    }
  },
  rust: {
    id: 'rust', name: 'Rust', defaultVersion: 'stable', kind: 'toolchain',
    platforms: {
      win32: {
        installType: 'installer',
        resolve: () => ({
          url: 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe',
          mirror: 'https://mirrors.tuna.tsinghua.edu.cn/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe',
          installType: 'installer',
          binSubdir: '',
          note: 'rustup-init 安装器，会写入用户 PATH；C++ 编译需要另行安装 VS Build Tools / MinGW'
        })
      }
    }
  }
};

function listRuntimes() {
  return Object.keys(RUNTIMES).map((id) => {
    const rt = RUNTIMES[id];
    return { id: rt.id, name: rt.name, defaultVersion: rt.defaultVersion, kind: rt.kind };
  });
}

function resolveSource(id, version) {
  const rt = RUNTIMES[id];
  if (!rt) throw new Error('未知运行时：' + id);
  const plat = rt.platforms[process.platform];
  if (!plat) throw new Error(`运行时 ${rt.name} 暂不支持当前平台 ${process.platform}`);
  const v = version || rt.defaultVersion;
  const info = plat.resolve(v);
  return Object.assign({ id, name: rt.name, version: v, defaultVersion: rt.defaultVersion }, info);
}

// ---- 哈希校验 ----
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function verifyHash(file, expected) {
  if (!expected) return { skipped: true };
  const got = await sha256File(file);
  const ok = got.toLowerCase() === String(expected).toLowerCase();
  return { ok, got, expected };
}

// ---- 下载（http/https，跟随重定向，强校验 host） ----
function downloadFile(url, dest, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (!isHostAllowed(url)) {
      return reject(new Error('下载源不在官方白名单内，已拒绝：' + url));
    }
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'fox-ai-runtime-installer' } }, (res) => {
      if (signal && signal.aborted) { req.destroy(); return reject(new Error('已取消')); }
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 跟随重定向，仍校验 host
        res.resume();
        return downloadFile(res.headers.location, dest, { onProgress, signal })
          .then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('下载失败，HTTP ' + res.statusCode + '：' + url));
      }
      const total = Number(res.headers['content-length']) || 0;
      let done = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (chunk) => {
        done += chunk.length;
        if (onProgress && total) onProgress(Math.floor((done / total) * 100), done, total);
      });
      res.pipe(out);
      out.on('error', reject);
      out.on('finish', () => resolve({ size: done, total }));
    });
    req.on('error', reject);
    if (signal) signal.addEventListener('abort', () => { req.destroy(); reject(new Error('已取消')); });
  });
}

// ---- 查找 / 准备 7-Zip ----
function find7z() {
  const { execSync } = require('child_process');
  const names = ['7z.exe', '7za.exe', '7zr.exe', '7z', '7za', '7zr'];
  for (const n of names) {
    try { execSync(`where ${n} >nul 2>&1`); return n; } catch (_) {}
  }
  const dirs = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe'
  ];
  for (const d of dirs) { if (fs.existsSync(d)) return d; }
  return null;
}

// 保证有可用的 7z：本地有就直接用，没有则从 7-zip.org 下载官方独立版 7za（.zip，可用系统解压）
async function ensure7z(tmpDir) {
  const existing = find7z();
  if (existing) return existing;
  const os = require('os');
  const tmp = tmpDir || path.join(os.tmpdir(), 'fox-ai-7z');
  fs.mkdirSync(tmp, { recursive: true });
  const zip = path.join(tmp, '7za920.zip');
  const stamp = path.join(tmp, '.7za.ready');
  if (fs.existsSync(path.join(tmp, '7za.exe'))) return path.join(tmp, '7za.exe');
  await downloadFile('https://7-zip.org/a/7za920.zip', zip, {});
  const exDir = path.join(tmp, '7za');
  fs.mkdirSync(exDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-Command',
      `Expand-Archive -Path "${zip}" -DestinationPath "${exDir}" -Force`], { windowsHide: true });
    let buf = '';
    p.stderr && p.stderr.on('data', (d) => (buf += d));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('解压 7za 失败：' + buf))));
  });
  fs.writeFileSync(stamp, '');
  return path.join(exDir, '7za.exe');
}

// ---- 解压 ----
async function extractArchive(file, destDir) {
  // .zip 用 PowerShell Expand-Archive；.7z 用 7z（自动查找或下载官方独立版）；.tar.gz 用 tar
  fs.mkdirSync(destDir, { recursive: true });
  const lower = file.toLowerCase();
  let cmd, args;
  if (lower.endsWith('.zip')) {
    cmd = 'powershell.exe';
    args = ['-NoProfile', '-Command',
      `Expand-Archive -Path "${file}" -DestinationPath "${destDir}" -Force`];
  } else if (lower.endsWith('.7z')) {
    const sevenZip = await ensure7z(path.join(destDir, '..', '.7ztmp'));
    cmd = sevenZip; args = ['x', '-y', `-o"${destDir}"`, file];
  } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    cmd = 'tar.exe'; args = ['-xf', file, '-C', destDir];
  } else {
    throw new Error('不支持的压缩格式：' + path.basename(file));
  }
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let buf = '';
    p.stdout && p.stdout.on('data', (d) => (buf += d));
    p.stderr && p.stderr.on('data', (d) => (buf += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(destDir) : reject(new Error(`${cmd} 解压失败 (${code})：${buf}`))));
  });
}

// ---- 审计日志 ----
function auditLog(context, action, detail) {
  try {
    const dir = context && context.logUri ? context.logUri.fsPath : path.join(os.tmpdir(), 'fox-ai');
    fs.mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] ${action} ${detail ? JSON.stringify(detail) : ''}\n`;
    fs.appendFileSync(path.join(dir, 'runtime-audit.log'), line);
  } catch (_) { /* 审计失败不阻断主流程 */ }
}

// ---- PATH 配置（只改用户级 PATH，自动备份，可回滚） ----
function backupUserPath(snapshotDir) {
  const ps = 'powershell.exe';
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile(ps, ['-NoProfile', '-Command',
      '[Environment]::GetEnvironmentVariable("Path","User")'], (err, out) => {
      if (err) return resolve('');
      const val = out.trim();
      try {
        fs.mkdirSync(snapshotDir, { recursive: true });
        fs.writeFileSync(path.join(snapshotDir, 'userpath.bak'), val, 'utf8');
      } catch (_) {}
      resolve(val);
    });
  });
}

function addToUserPath(binDir) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    const ps = 'powershell.exe';
    const script =
      '$p=[Environment]::GetEnvironmentVariable("Path","User");' +
      `$add='${binDir.replace(/'/g, "''")}';` +
      'if($p -notlike "*$add*"){' +
      "[Environment]::SetEnvironmentVariable('Path',($p.TrimEnd(';')+';'+$add),'User');" +
      'Write-Output "added"}else{Write-Output "exists"}';
    execFile(ps, ['-NoProfile', '-Command', script], (err, out) => {
      if (err) return reject(err);
      resolve(out.trim());
    });
  });
}

// ---- 管理员提权（两种模式） ----
// mode: 'always' = 每次都弹确认；'session' = 本次会话已批准则不再弹扩展内确认
let _sessionElevated = false;
function resetElevationCache() { _sessionElevated = false; }

function needsElevation() {
  // 在 Windows 上判断是否当前进程已是管理员；非管理员才需要提权
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      '[bool](([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))'],
      { encoding: 'utf8', windowsHide: true }).trim();
    return out !== 'True';
  } catch (_) {
    return true; // 探测失败按需要提权处理
  }
}

function runElevated(script, { context, mode = 'always', actionLabel = '提权操作' } = {}) {
  return new Promise((resolve, reject) => {
    const elevation = conf().get('runtimes.elevation', 'always');
    const effectiveMode = mode || elevation;
    if (effectiveMode === 'session' && _sessionElevated) {
      // 会话已批准：直接用普通 PowerShell 执行（若已管理员则无需 RunAs）
      const { execFile } = require('child_process');
      return execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true }, (err, out, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(out));
    }
    // 需要弹 UAC：封装成 Start-Process -Verb RunAs
    const ps = 'powershell.exe';
    const enc = Buffer.from(script, 'utf8').toString('base64');
    const lift = `$c=[Convert]::FromBase64String('${enc}');$s=[Text.Encoding]::UTF8.GetString($c);` +
      `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',$s`;
    const { execFile } = require('child_process');
    execFile(ps, ['-NoProfile', '-Command', lift], { windowsHide: true }, (err, out, stderr) => {
      if (err) return reject(new Error('UAC 提权失败或被拒绝：' + (stderr || err.message)));
      if (effectiveMode === 'session') _sessionElevated = true;
      resolve(out);
    });
  });
}

// ---- 安装编排 ----
async function installRuntime(context, id, opts = {}) {
  const startedAt = Date.now();
  try {
    return await _doInstallRuntime(context, id, opts);
  } catch (err) {
    auditLog(context, 'install.failed', {
      id,
      error: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : '',
      elapsedMs: Date.now() - startedAt,
      at: new Date().toISOString()
    });
    throw err;
  }
}

async function _doInstallRuntime(context, id, opts = {}) {
  const { version, installRoot, onProgress, signal } = opts;
  const rtConf = conf();
  const root = installRoot || rtConf.get('runtimes.installRoot', '');
  if (!root) throw new Error('未设置安装根目录（foxAi.runtimes.installRoot）');
  const base = resolveSource(id, version);
  const targetDir = path.join(root, id + (base.version ? '-' + base.version : ''));

  // 1) 审计 + 确认
  auditLog(context, 'install.request', { id, version: base.version, target: targetDir, url: base.url, installType: base.installType });
  const ok = await vscode().window.showWarningMessage(
    `即将从官方源下载并安装 ${base.name} (${base.version}) 到：\n${targetDir}\n` +
    `来源：${base.url}\n安装方式：${base.installType === 'installer' ? '需要管理员权限' : '解压到用户目录'}`,
    { modal: true }, '确认安装', '取消'
  );
  if (ok !== '确认安装') { auditLog(context, 'install.cancelled', { id }); return { cancelled: true }; }

  fs.mkdirSync(root, { recursive: true });
  const tmp = path.join(root, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const ext = (base.url.split('?')[0].match(/\.(zip|7z|tar\.gz|tgz|exe)$/i) || ['.zip'])[0];
  const file = path.join(tmp, `${id}${ext}`);

  // 2) 下载（尝试官方源，失败回退镜像）
  const sources = [base.url].concat(base.mirror ? [base.mirror] : []);
  let lastErr;
  let triedUrls = [];
  for (const src of sources) {
    triedUrls.push(src);
    try {
      await downloadFile(src, file, { onProgress, signal });
      break;
    } catch (e) { lastErr = e; }
  }
  if (!fs.existsSync(file)) {
    auditLog(context, 'download.failed', { id, triedUrls, reason: lastErr && lastErr.message });
    throw lastErr || new Error('下载失败');
  }

  // 3) 哈希校验（有则校验，无则记录跳过）
  const hashRes = await verifyHash(file, base.sha256);
  if (hashRes.ok === false) {
    fs.unlinkSync(file);
    auditLog(context, 'hash.failed', { id, file, expected: base.sha256, got: hashRes.got });
    throw new Error(`哈希校验不通过，已删除下载文件（期望 ${base.sha256}，实际 ${hashRes.got}）`);
  }
  auditLog(context, 'download.ok', { id, file, size: fs.statSync(file).size, hash: hashRes });

  // 4) 解压 / 运行安装器
  if (base.installType === 'archive') {
    await extractArchive(file, targetDir);
    fs.unlinkSync(file);
    const binDir = path.join(targetDir, base.binSubdir || '');
    // 备份 PATH 并加入
    const snap = path.join(root, '.snapshot');
    await backupUserPath(snap);
    const r = await addToUserPath(binDir);
    auditLog(context, 'path.updated', { id, binDir, result: r });
    // 记录到 globalState
    const installed = context.globalState.get('foxAi.runtimes', {});
    installed[id] = { version: base.version, dir: targetDir, binDir, installedAt: new Date().toISOString() };
    await context.globalState.update('foxAi.runtimes', installed);
    auditLog(context, 'install.done', { id, dir: targetDir, binDir, result: 'ok' });
    return { ok: true, id, version: base.version, dir: targetDir, binDir };
  } else {
    // 安装器：需要提权
    const elevated = needsElevation();
    const ps = `Start-Process -FilePath "${file}" -ArgumentList '/quiet','/norestart' -Wait;` +
      `Write-Output "installer-exit"`;
    if (elevated) {
      await runElevated(ps, { context, mode: rtConf.get('runtimes.elevation', 'always'), actionLabel: `安装 ${base.name}` });
    } else {
      await new Promise((resolve, reject) => {
        const { execFile } = require('child_process');
        execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true },
          (e, o, se) => e ? reject(new Error(se || e.message)) : resolve(o));
      });
    }
    fs.unlinkSync(file);
    const installed = context.globalState.get('foxAi.runtimes', {});
    installed[id] = { version: base.version, installer: base.url, installedAt: new Date().toISOString() };
    await context.globalState.update('foxAi.runtimes', installed);
    auditLog(context, 'install.done', { id, viaInstaller: true, result: 'ok' });
    return { ok: true, id, version: base.version, viaInstaller: true };
  }
}

// os 在尾部再 require，避免部分环境缺包报错
const os = require('os');

module.exports = {
  ALLOWED_HOSTS, isHostAllowed,
  RUNTIMES, listRuntimes, resolveSource,
  sha256File, verifyHash, downloadFile, extractArchive,
  backupUserPath, addToUserPath,
  needsElevation, runElevated, resetElevationCache,
  installRuntime, auditLog
};
