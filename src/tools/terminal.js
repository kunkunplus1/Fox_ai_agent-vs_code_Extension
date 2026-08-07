'use strict';

const vscode = require('vscode');
const cp = require('child_process');
const ws = require('./workspace');

const TERMINAL_NAME = '🦊 狐狸 AI';

/** 最近若干次命令的输出，供 get_terminal_output 回看 */
const history = [];
let agentTerminal = null;

function pushHistory(entry) {
  history.push(entry);
  if (history.length > 12) history.shift();
}

function stripAnsi(s) {
  return String(s)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function tail(text, maxChars) {
  const t = String(text || '');
  if (t.length <= maxChars) return t;
  return '…（前面省略）\n' + t.slice(t.length - maxChars);
}

function getShell() {
  const custom = (vscode.workspace.getConfiguration('foxAi').get('agent.shell') || '').trim();
  if (custom) return custom;
  if (process.platform === 'win32') {
    // Windows 现代环境优先 PowerShell；需要 cmd 可显式设置 foxAi.agent.shell
    if (process.env.PSModulePath) {
      const ps = process.env.SystemRoot ? (process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe') : 'powershell.exe';
      return ps;
    }
    return process.env.ComSpec || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      cp.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch (_) {
    try {
      child.kill('SIGKILL');
    } catch (__) {}
  }
}

/** 危险命令拦截 */
function isDangerous(command, extraPatterns) {
  const c = String(command).toLowerCase();
  const builtin = [
    /\brm\s+(-[a-z]*\s+)*-?[rf]{1,2}[a-z]*\s+[/~]\s*$/,
    /\brm\s+-rf\s+\/(?!\w)/,
    /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, // fork bomb
    /\bmkfs\b/,
    /\bdd\s+if=.*of=\/dev\//,
    /\bformat\s+[a-z]:/,
    /\bdel\s+\/[sq]\s+[a-z]:\\?\s*$/,
    /rd\s+\/s\s+\/q\s+[a-z]:\\?\s*$/,
    /shutdown\b/,
    /reboot\b/,
    /\bchmod\s+-R\s+777\s+\//,
    /remove-item\s+-recurse\s+-force\s+[a-z]:\\?\s*$/
  ];
  for (const re of builtin) if (re.test(c)) return '命中内置危险命令拦截';
  for (const p of extraPatterns || []) {
    try {
      if (new RegExp(p, 'i').test(command)) return `命中自定义黑名单：${p}`;
    } catch (_) {
      if (c.includes(String(p).toLowerCase())) return `命中自定义黑名单：${p}`;
    }
  }
  return null;
}

/* ---------------- 用集成终端执行（有 shell integration 时可读输出） ---------------- */

function ensureTerminal(cwd) {
  if (agentTerminal && agentTerminal.exitStatus === undefined) return agentTerminal;
  agentTerminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    cwd: cwd || ws.rootPath() || undefined,
    iconPath: new vscode.ThemeIcon('flame')
  });
  return agentTerminal;
}

function waitForShellIntegration(terminal, ms) {
  if (terminal.shellIntegration) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(!!terminal.shellIntegration);
    }, ms);
    const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal === terminal) {
        clearTimeout(timer);
        sub.dispose();
        resolve(true);
      }
    });
  });
}

async function runInIntegratedTerminal(command, opts) {
  const { cwd, timeout, token, onData } = opts;
  const terminal = ensureTerminal(cwd);
  terminal.show(true);
  const ready = await waitForShellIntegration(terminal, 4000);
  if (!ready || !terminal.shellIntegration) return null; // 交给 spawn 兜底

  const execution = terminal.shellIntegration.executeCommand(command);
  let out = '';
  let exitCode = null;
  let ended = false;

  const endPromise = new Promise((resolve) => {
    const sub = vscode.window.onDidEndTerminalShellExecution((e) => {
      if (e.execution === execution) {
        ended = true;
        exitCode = typeof e.exitCode === 'number' ? e.exitCode : null;
        sub.dispose();
        resolve();
      }
    });
    setTimeout(() => {
      if (!ended) {
        sub.dispose();
        resolve();
      }
    }, timeout);
  });

  const readPromise = (async () => {
    try {
      const stream = execution.read();
      for await (const chunk of stream) {
        const clean = stripAnsi(chunk);
        out += clean;
        if (onData) onData(clean);
        if (out.length > 400000) break;
      }
    } catch (_) {}
  })();

  const cancelPromise = new Promise((resolve) => {
    if (!token) return;
    token.onCancelled(() => {
      try {
        terminal.sendText('\u0003', false); // Ctrl+C
      } catch (_) {}
      resolve('cancelled');
    });
  });

  const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve('timeout'), timeout));
  const why = await Promise.race([
    Promise.all([endPromise, readPromise]).then(() => 'done'),
    cancelPromise,
    timeoutPromise
  ]);

  if (why === 'timeout') {
    try {
      terminal.sendText('\u0003', false);
    } catch (_) {}
  }

  return { output: stripAnsi(out), exitCode, why, via: '集成终端' };
}

/* ---------------- 兜底：子进程执行 ---------------- */

function runWithSpawn(command, opts) {
  const { cwd, timeout, token, onData } = opts;
  return new Promise((resolve) => {
    const shell = getShell();
    const child = cp.spawn(command, {
      cwd: cwd || ws.rootPath() || process.cwd(),
      shell,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: Object.assign({}, process.env, { FORCE_COLOR: '0', NO_COLOR: '1' })
    });

    let out = '';
    let why = 'done';
    const append = (buf) => {
      const clean = stripAnsi(buf.toString('utf8'));
      out += clean;
      if (onData) onData(clean);
      if (out.length > 400000) {
        why = 'truncated';
        killTree(child);
      }
    };
    child.stdout && child.stdout.on('data', append);
    child.stderr && child.stderr.on('data', append);

    const timer = setTimeout(() => {
      why = 'timeout';
      killTree(child);
    }, timeout);

    const cancelSub =
      token &&
      token.onCancelled(() => {
        why = 'cancelled';
        killTree(child);
      });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (cancelSub) cancelSub();
      resolve({ output: out + '\n[启动失败] ' + err.message, exitCode: -1, why: 'error', via: '子进程' });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (cancelSub) cancelSub();
      resolve({ output: out, exitCode: code, why, via: '子进程' });
    });
  });
}

/* ---------------- 对外工具 ---------------- */

async function runCommand(args, ctx) {
  const command = String(args.command || '').trim();
  if (!command) throw new Error('command 不能为空');

  const cfg = vscode.workspace.getConfiguration('foxAi');
  const blocked = isDangerous(command, ctx && ctx.blockedCommands);
  if (blocked) throw new Error(`拒绝执行该命令（${blocked}）：${command}`);

  const timeout = Math.max(5000, cfg.get('agent.commandTimeout', 120000));
  const mode = cfg.get('agent.terminalMode', 'integrated');
  let cwd = ws.rootPath();
  if (args.cwd) {
    try {
      cwd = ws.resolveUri(args.cwd).fsPath;
    } catch (e) {
      /* 保持默认 */
    }
  }

  const onData = ctx && ctx.onStream ? (chunk) => ctx.onStream(chunk) : null;
  const token = ctx && ctx.token;

  let result = null;
  if (mode === 'integrated') {
    try {
      result = await runInIntegratedTerminal(command, { cwd, timeout, token, onData });
    } catch (e) {
      result = null;
    }
  }
  if (!result) result = await runWithSpawn(command, { cwd, timeout, token, onData });

  pushHistory({ command, output: result.output, exitCode: result.exitCode, at: Date.now() });

  const maxOut = (ctx && ctx.maxToolOutput) || 8000;
  const body = tail(result.output.trim(), maxOut) || '(没有输出)';
  const statusMap = {
    done: result.exitCode === 0 ? '成功' : `退出码 ${result.exitCode}`,
    timeout: '超时已终止',
    cancelled: '被用户取消',
    truncated: '输出过多已截断并终止',
    error: '启动失败'
  };
  const status = statusMap[result.why] || String(result.why);
  return `$ ${command}\n[${result.via} · ${status}]\n${body}`;
}

/** 读取当前活动终端的可见内容（用户自己跑出来的报错） */
async function readActiveTerminal(args) {
  const lines = Math.min(400, Math.max(10, parseInt(args && args.lines, 10) || 80));
  const terminal = vscode.window.activeTerminal;

  if (!terminal) {
    if (history.length) return formatHistory(lines);
    return '当前没有打开的终端，也没有本次会话执行过的命令记录。';
  }

  const previous = await vscode.env.clipboard.readText();
  let text = '';
  try {
    terminal.show(false);
    await new Promise((r) => setTimeout(r, 120));
    await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
    await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');
    text = await vscode.env.clipboard.readText();
  } catch (e) {
    text = '';
  } finally {
    await vscode.env.clipboard.writeText(previous || '');
  }

  text = stripAnsi(text || '').replace(/\s+$/, '');
  if (!text || text === previous) {
    return history.length ? formatHistory(lines) : '没能读到终端内容（终端可能是空的）。';
  }
  const arr = text.split('\n');
  const slice = arr.slice(Math.max(0, arr.length - lines));
  return `终端「${terminal.name}」最后 ${slice.length} 行：\n` + slice.join('\n');
}

function formatHistory(lines) {
  const last = history[history.length - 1];
  if (!last) return '暂无命令记录。';
  const arr = last.output.split('\n');
  return (
    `最近一次命令：$ ${last.command}（退出码 ${last.exitCode}）\n` +
    arr.slice(Math.max(0, arr.length - lines)).join('\n')
  );
}

/** 在集成终端启动一个命令，不等待它结束（适合交互式程序） */
function startInTerminal(command, opts) {
  const { cwd } = opts || {};
  const terminal = ensureTerminal(cwd);
  terminal.show(true);
  terminal.sendText(String(command), true);
  return terminal.name;
}

function clearTerminalRef() {
  agentTerminal = null;
}

module.exports = {
  runCommand,
  readActiveTerminal,
  startInTerminal,
  isDangerous,
  stripAnsi,
  clearTerminalRef,
  TERMINAL_NAME,
  history
};
