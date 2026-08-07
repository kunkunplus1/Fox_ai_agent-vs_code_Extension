'use strict';

/**
 * src/memoryOptimize.js — 类似 PCL2 "内存优化" 的系统级内存释放
 *
 * Windows 下通过 PowerShell 调用：
 *   1) SetProcessWorkingSetSize 修剪 VS Code 自身工作集
 *   2) NtSetSystemInformation(0x50) 尝试清空系统待机列表（standby list）
 *      - 需要管理员权限，未提权时静默降级为仅修剪工作集
 *   （旧版的 rundll32 advapi32.dll,ProcessIdleTasks 在「以管理员身份运行」的 VS Code 下会长时间阻塞，
 *     导致通知栏迟迟不出结果，已移除。）
 *
 * 返回 { beforeBytes, afterBytes, freedBytes, standbyCleared }
 */

const vscode = require('vscode');
const cp = require('child_process');
const os = require('os');

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return bytes + ' B';
}

const POWERSHELL_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Get-UsedPhysicalMemory {
    $os = Get-CimInstance Win32_OperatingSystem
    return [long]($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) * 1024L
}

Add-Type -Name 'MemOpt' -Namespace 'Native' -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool SetProcessWorkingSetSize(IntPtr hProcess, UIntPtr dwMinimumWorkingSetSize, UIntPtr dwMaximumWorkingSetSize);

[DllImport("ntdll.dll")]
public static extern int NtSetSystemInformation(int InfoClass, IntPtr Input, int InputSize);
'@ -ErrorAction SilentlyContinue

function Optimize-ProcessWorkingSets {
    $names = @('Code', 'Code - Insiders', 'code-oss', 'VSCodium')
    $procs = Get-Process | Where-Object { $names -contains $_.ProcessName }
    foreach ($p in $procs) {
        try {
            $h = $p.Handle
            [Native.MemOpt]::SetProcessWorkingSetSize($h, [UIntPtr]::new([UInt64]::MaxValue), [UIntPtr]::new([UInt64]::MaxValue)) | Out-Null
        } catch {}
    }
}

function Clear-StandbyList {
    try {
        $bytes = [System.BitConverter]::GetBytes([UInt32]4)
        $ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(4)
        [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, 4)
        $r = [Native.MemOpt]::NtSetSystemInformation(0x50, $ptr, 4)
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
        return $r -eq 0
    } catch {
        return $false
    }
}

$before = Get-UsedPhysicalMemory
Optimize-ProcessWorkingSets
$standby = Clear-StandbyList
# 说明：旧版在此调用 rundll32.exe advapi32.dll,ProcessIdleTasks 触发空闲整理，
#       但在「以管理员身份运行」的 VS Code 下会长时间阻塞导致界面卡死，已移除。
#       修剪工作集 + 清空待机列表已具备释放效果，这里仅做极短等待让计数稳定。
Start-Sleep -Milliseconds 300
$after = Get-UsedPhysicalMemory
$freed = $before - $after

@{
    beforeBytes = $before
    afterBytes = $after
    freedBytes = $freed
    standbyCleared = $standby
} | ConvertTo-Json -Compress
`;

function encodePowerShellCommand(script) {
  const buf = Buffer.from(script, 'utf16le');
  return buf.toString('base64');
}

/**
 * 跨平台杀进程树：Windows 用 taskkill /T /F 连带子进程一起杀，
 * 否则仅杀当前进程（SIGTERM）。用于中途取消 / 超时兜底。
 */
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

function runPowerShellJson(script, { token, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = encodePowerShellCommand(script);
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
    const child = cp.spawn('powershell.exe', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (fn) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); fn(); };
    const onCancel = () => finish(() => { killProcessTree(child); reject(new Error('已取消')); });
    if (token) token.onCancellationRequested(onCancel);
    if (timeout) timer = setTimeout(() => finish(() => { killProcessTree(child); reject(new Error('操作超时（' + (timeout / 1000) + ' 秒）')); }), timeout);
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', (code) => {
      finish(() => {
        if (code !== 0) return reject(new Error('PowerShell 退出码 ' + code + (stderr ? ': ' + stderr.trim() : '')));
        try {
          const text = stdout.trim();
          const json = text ? JSON.parse(text) : {};
          resolve(json);
        } catch (e) {
          reject(new Error('解析 PowerShell 输出失败：' + stdout.trim()));
        }
      });
    });
  });
}

async function optimizeMemory() {
  if (process.platform !== 'win32') {
    throw new Error('内存优化当前仅支持 Windows 系统。');
  }

  const result = await vscode.window.withProgress(
    { title: '内存优化中…（可点取消）', location: vscode.ProgressLocation.Notification, cancellable: true },
    async (progress, token) => {
      progress.report({ message: '正在修剪 VS Code 工作集…' });
      const r = await runPowerShellJson(POWERSHELL_SCRIPT, { token, timeout: 30000 });
      return {
        beforeBytes: typeof r.beforeBytes === 'number' ? r.beforeBytes : 0,
        afterBytes: typeof r.afterBytes === 'number' ? r.afterBytes : 0,
        freedBytes: typeof r.freedBytes === 'number' ? r.freedBytes : 0,
        standbyCleared: !!r.standbyCleared
      };
    }
  );

  const standbyMsg = result.standbyCleared ? '（已清空系统待机缓存）' : '（已修剪工作集，如需更强效果请以管理员身份运行 VS Code）';
  vscode.window.showInformationMessage(
    `[狐狸 AI] 内存优化完成。已释放 ${formatBytes(result.freedBytes)}，从 ${formatBytes(result.beforeBytes)} 降至 ${formatBytes(result.afterBytes)}。${standbyMsg}`
  );
  return result;
}

module.exports = { optimizeMemory, formatBytes };
