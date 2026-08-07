'use strict';

/**
 * Stealth Fetch 自动环境配置
 * ----------------------------------------------------------------------------
 * 为「stealth-fetch」MCP 服务器自动准备 Python 运行环境：
 *   1) 探测可用的 Python 解释器（优先用已存在的 venv，否则探测系统/托管 Python）
 *   2) 在 ~/.fox-ai/mcp-servers/stealth-fetch/.venv 建虚拟环境（幂等）
 *   3) pip 安装 curl_cffi（带百分比进度回调，可取消）
 *   4) 校验导入，返回 venv python 与 server.py 路径
 *
 * 核心逻辑（runSteps）为纯函数式，依赖通过参数注入（emit / shouldCancel），
 * 便于离线单测；installStealthFetch 负责包上 VS Code 进度条 UI。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const SERVER_REL = path.join('resources', 'stealth-fetch', 'stealth_fetch_server.py');

/** 返回 stealth-fetch 服务器脚本绝对路径（位于扩展 resources 内） */
function serverScriptPath(context) {
  const root = (context && context.extensionPath) || process.cwd();
  return path.join(root, SERVER_REL);
}

/** venv 根目录（跨会话稳定，~/.fox-ai/mcp-servers/stealth-fetch/.venv） */
function venvDir() {
  return path.join(os.homedir(), '.fox-ai', 'mcp-servers', 'stealth-fetch', '.venv');
}

/** 根据 venv 目录返回其中的 python 可执行文件路径（跨平台） */
function venvPython(venv) {
  if (process.platform === 'win32') return path.join(venv, 'Scripts', 'python.exe');
  return path.join(venv, 'bin', 'python');
}

function isWin() { return process.platform === 'win32'; }

/** 简单延时（Promise） */
function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

/**
 * 结束可能仍占用 venv 中 .pyd 的残留 stealth-fetch 服务器进程。
 * Windows 上，已运行的服务器会加载 _cffi_backend.pyd，重装 pip 时该文件被锁，
 * 导致 WinError 5（拒绝访问）。结束进程即可释放文件锁。
 * 只针对「命令行含 stealth_fetch_server 或 venv 路径」的 python.exe，绝不误杀其他 python。
 * 用临时 .ps1 文件执行，避免 cmd.exe 下的引号转义地狱。
 */
function killRunningServer(venv) {
  if (!isWin()) {
    try { cp.execSync('pkill -f stealth_fetch_server.py 2>/dev/null || true', { windowsHide: true }); } catch (_) {}
    return;
  }
  const venvNorm = path.normalize(venv).toLowerCase();
  const ps = [
    "$procs = Get-CimInstance Win32_Process -Filter \"Name='python.exe'\"",
    "foreach ($p in $procs) {",
    "  $cmd = [string]$p.CommandLine; $exe = [string]$p.ExecutablePath",
    "  if ($cmd -like '*stealth_fetch_server*' -or $cmd -like '*" + venvNorm + "*' -or $exe -like '*" + venvNorm + "*') {",
    "    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue",
    "  }",
    "}"
  ].join('\n');
  const tmp = path.join(os.tmpdir(), 'fox-ai-kill-stealth-' + Date.now() + '.ps1');
  try {
    fs.writeFileSync(tmp, ps, 'utf8');
    cp.execSync('powershell -NoProfile -NonInteractive -File "' + tmp + '"', { windowsHide: true, timeout: 30000 });
  } catch (_) {
    // 进程可能本就不存在 / 权限不足；忽略，安装步骤会继续
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

/**
 * 探测一个 Python 解释器是否可用（同步，快速）。
 * @param {string} exe 解释器路径或命令名
 * @returns {boolean}
 */
function probePython(exe) {
  try {
    const r = cp.spawnSync(exe, ['--version'], { windowsHide: true, timeout: 15000, encoding: 'utf8' });
    return r.status === 0 && /python/i.test((r.stdout || '') + (r.stderr || ''));
  } catch (_) { return false; }
}

/**
 * 探测基础 Python 解释器（用于创建 venv）。
 * 优先级：环境变量覆盖 > 已存在的 venv > 托管 Python > PATH(python3/python)。
 * @returns {string|null}
 */
function detectBasePython() {
  const candidates = [];
  if (process.env.FOX_AI_PYTHON) candidates.push(process.env.FOX_AI_PYTHON);
  const vd = venvDir();
  if (fs.existsSync(venvPython(vd))) candidates.push(venvPython(vd)); // 复用已有 venv
  if (isWin()) {
    const managed = path.join(os.homedir(), '.workbuddy', 'binaries', 'python', 'versions', '3.13.12', 'python.exe');
    if (fs.existsSync(managed)) candidates.push(managed);
    candidates.push('python', 'python3');
  } else {
    candidates.push('python3', 'python');
  }
  for (const c of candidates) {
    if (probePython(c)) return c;
  }
  return null;
}

/** 幂等判断：venv 内是否已能 import curl_cffi（服务器唯一第三方依赖） */
function alreadyInstalled(venvPy) {
  try {
    const r = cp.spawnSync(venvPy, ['-c', 'import curl_cffi'], { windowsHide: true, timeout: 20000, encoding: 'utf8' });
    return r.status === 0;
  } catch (_) { return false; }
}

/** 返回 venv 内 import curl_cffi 的真实错误文本（成功返回 null），用于失败透传 */
function curlCffiImportError(venvPy) {
  try {
    const r = cp.spawnSync(venvPy,
      ['-c', 'import curl_cffi as m; print("OK", getattr(m, "__version__", "?"))'],
      { windowsHide: true, timeout: 20000, encoding: 'utf8' });
    if (r.status === 0) return null;
    const out = String(r.stderr || r.stdout || '').trim();
    return out ? out.slice(0, 600) : ('退出码 ' + r.status);
  } catch (e) {
    return String(e && e.message || e);
  }
}

/**
 * 执行安装步骤（纯逻辑，不依赖 vscode）。
 * @param {Object} opts
 *   context        扩展上下文（取 extensionPath）
 *   basePython     基础解释器
 *   venv           目标 venv 目录
 *   emit(pct,msg) 进度回调（百分比整数 + 文本）
 *   shouldCancel() 是否取消
 * @returns {Promise<{ok:boolean, venvPython?:string, serverPy?:string, error?:string}>}
 */
async function runSteps(opts) {
  const { context, basePython, venv, emit, shouldCancel } = opts;
  const cancel = shouldCancel || (() => false);
  const safeEmit = (p, m) => { try { emit && emit(p, m); } catch (_) {} };

  const targetVenv = venv || venvDir();
  const vPy = venvPython(targetVenv);
  const serverPy = serverScriptPath(context);

  // 0) 入口校验
  if (!basePython) { return { ok: false, error: '未找到可用的 Python 解释器（需要 Python 3.10+）' }; }
  if (!fs.existsSync(serverPy)) { return { ok: false, error: '未找到 stealth_fetch_server.py：' + serverPy }; }

  // 0.5) 释放可能占用 venv 中 .pyd 的残留服务器进程（避免 Windows 文件锁 → WinError 5）
  safeEmit(6, '清理可能残留的旧服务器进程（释放文件锁）…');
  killRunningServer(targetVenv);
  await sleep(800);

  // 1) 已安装则跳过（幂等）
  if (alreadyInstalled(vPy)) {
    safeEmit(100, '依赖已就绪（curl_cffi），跳过安装');
    return { ok: true, venvPython: vPy, serverPy };
  }

  safeEmit(8, '已定位 Python：' + basePython);

  // 2) 建 venv（不存在才建）
  if (!fs.existsSync(vPy)) {
    safeEmit(20, '正在创建虚拟环境…');
    const mk = cp.spawnSync(basePython, ['-m', 'venv', targetVenv], { windowsHide: true, timeout: 120000, encoding: 'utf8' });
    if (mk.status !== 0) {
      return { ok: false, error: '创建虚拟环境失败：' + (mk.stderr || mk.stdout || '').slice(0, 300) };
    }
  } else {
    safeEmit(20, '复用已有虚拟环境');
  }
  if (cancel()) return { ok: false, error: '已取消' };

  // 3) 升级 pip（轻量，失败不致命）
  safeEmit(30, '升级 pip…');
  cp.spawnSync(vPy, ['-m', 'pip', 'install', '-U', 'pip', '-q'], {
    windowsHide: true, timeout: 120000, encoding: 'utf8',
    env: Object.assign({}, process.env, pipEnv())
  });

  // 4) 安装 curl_cffi（唯一第三方依赖，带进度）。服务器为零依赖手写 MCP 协议，无需 mcp SDK。
  const indexUrl = process.env.STEALTH_FETCH_PIP_INDEX || 'https://pypi.tuna.tsinghua.edu.cn/simple';
  const onLine = (raw) => {
    const l = String(raw || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (/Downloading|Installing|Collecting/i.test(l)) safeEmit(null, l.slice(0, 180));
  };
  safeEmit(40, '安装 curl_cffi 及底层 cffi（强制重装以修复可能损坏的 .pyd）…');
  let r = await spawnPip(vPy, ['install', '--upgrade', '--force-reinstall', 'cffi', 'curl_cffi', '-q', '--index-url', indexUrl], onLine, cancel);
  // 文件锁（WinError 5 / 拒绝访问）兜底：再杀一次残留进程并等待释放后重试一次
  if (!r.ok && /WinError 5|Access is denied|拒绝访问|errno 13/i.test(r.msg)) {
    safeEmit(40, '检测到文件锁，释放后重试…');
    killRunningServer(targetVenv);
    await sleep(1500);
    r = await spawnPip(vPy, ['install', '--upgrade', '--force-reinstall', 'cffi', 'curl_cffi', '-q', '--index-url', indexUrl], onLine, cancel);
  }
  if (!r.ok) return { ok: false, error: '安装 curl_cffi 失败：' + r.msg };
  if (cancel()) return { ok: false, error: '已取消' };

  // 5) 校验导入（失败则透出真实错误，便于对症排查）
  safeEmit(90, '校验依赖导入…');
  if (!alreadyInstalled(vPy)) {
    const impErr = curlCffiImportError(vPy) || '未知导入错误';
    return {
      ok: false,
      error: ('安装完成但无法导入 curl_cffi：\n' + impErr + '\n' +
        '常见原因：底层 cffi 的 .pyd 损坏。已改用 --force-reinstall 重装 cffi+curl_cffi；' +
        '若仍失败，请关闭 VS Code 后重试，或检查杀毒软件是否锁住 ~/.fox-ai 目录。')
    };
  }

  safeEmit(100, '环境就绪');
  return { ok: true, venvPython: vPy, serverPy };
}

/** pip 镜像与相关环境变量 */
function pipEnv() {
  return Object.assign({}, process.env, {
    PIP_INDEX_URL: process.env.STEALTH_FETCH_PIP_INDEX || 'https://pypi.tuna.tsinghua.edu.cn/simple',
    PIP_DISABLE_PIP_VERSION_CHECK: '1'
  });
}

/**
 * 封装一次 pip 调用，解析输出并支持取消。
 * @returns {Promise<{ok:boolean, msg:string}>}
 */
function spawnPip(venvPy, args, onLine, cancel) {
  return new Promise((resolve) => {
    let child;
    try {
      child = cp.spawn(venvPy, ['-m', 'pip'].concat(args), {
        shell: false, windowsHide: true, env: pipEnv()
      });
    } catch (e) {
      return resolve({ ok: false, msg: '启动 pip 失败：' + String(e.message || e) });
    }
    let cancelled = false;
    let spawnErr = null;
    if (cancel && cancel()) { try { child.kill('SIGTERM'); } catch (_) {} return resolve({ ok: false, msg: '已取消' }); }
    const { StringDecoder } = require('string_decoder');
    const dec = new StringDecoder('utf8');
    let buf = '';
    let tail = '';
    const TAIL_LIMIT = 1200;
    const flush = (s) => {
      buf += s;
      tail += s;
      if (tail.length > TAIL_LIMIT) tail = tail.slice(-TAIL_LIMIT);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        onLine && onLine(line);
      }
    };
    child.stdout.on('data', (d) => flush(dec.write(d)));
    child.stderr.on('data', (d) => flush(dec.write(d)));
    child.on('error', (e) => { spawnErr = e; });
    child.on('close', (code, signal) => {
      if (cancelled) return resolve({ ok: false, msg: '已取消' });
      if (spawnErr) return resolve({ ok: false, msg: 'pip 进程错误：' + String(spawnErr.message || spawnErr) });
      if (code === 0) return resolve({ ok: true, msg: '' });
      const snippet = (buf + '\n' + tail).replace(/\s+/g, ' ').trim().slice(0, 400);
      let msg = 'pip 退出码 ' + code;
      if (signal) msg += '（信号 ' + signal + '）';
      if (snippet) msg += '：' + snippet;
      return resolve({ ok: false, msg });
    });
    // 取消轮询
    const timer = setInterval(() => {
      if (cancel && cancel() && !child.killed) { cancelled = true; try { child.kill('SIGTERM'); } catch (_) {} clearInterval(timer); }
    }, 500);
    child.on('close', () => clearInterval(timer));
    // 手动超时（cp.spawn 的 timeout 选项对流式子进程无效）
    const timeoutMs = 300000;
    const to = setTimeout(() => {
      if (!child.killed) {
        cancelled = true;
        try { child.kill('SIGTERM'); } catch (_) {}
        return resolve({ ok: false, msg: 'pip 安装超时（' + (timeoutMs / 60000) + ' 分钟）' });
      }
    }, timeoutMs);
    child.on('close', () => clearTimeout(to));
  });
}

/**
 * 对外入口：包上 VS Code 进度条 UI。
 * @param {Object} opts { context, token? }
 * @returns {Promise<{ok:boolean, venvPython?:string, serverPy?:string, error?:string}>}
 */
async function installStealthFetch(opts = {}) {
  const vscode = require('vscode');
  const context = opts.context;
  const basePython = detectBasePython();
  const targetVenv = venvDir();

  // 已就绪直接返回（不弹进度条）
  const vPy = venvPython(targetVenv);
  if (fs.existsSync(vPy) && alreadyInstalled(vPy)) {
    return { ok: true, venvPython: vPy, serverPy: serverScriptPath(context) };
  }

  return vscode.window.withProgress(
    { title: '配置 Stealth Fetch 运行环境（可点取消）', location: vscode.ProgressLocation.Notification, cancellable: true },
    (progress, token) => {
      let last = 0;
      const emit = (pct, msg) => {
        if (typeof pct === 'number') {
          const inc = Math.max(0, pct - last);
          last = pct;
          progress.report({ increment: inc, message: (pct + '% ') + (msg || '') });
        } else if (msg) {
          progress.report({ message: msg });
        }
      };
      return runSteps({ context, basePython, venv: targetVenv, emit, shouldCancel: () => token.isCancellationRequested });
    }
  ).then((res) => res).catch((e) => ({ ok: false, error: e && e.message ? e.message : String(e) }));
}

module.exports = {
  serverScriptPath,
  venvDir,
  venvPython,
  detectBasePython,
  alreadyInstalled,
  curlCffiImportError,
  runSteps,
  installStealthFetch,
  pipEnv
};
