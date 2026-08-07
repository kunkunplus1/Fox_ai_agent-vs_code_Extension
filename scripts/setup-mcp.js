#!/usr/bin/env node
'use strict';

/**
 * fox-ai MCP 实验功能依赖自检 / 安装脚本
 * ----------------------------------------------------------------------------
 * 用法：
 *   node scripts/setup-mcp.js --check                 仅检查并打印报告（默认）
 *   node scripts/setup-mcp.js --install               一键安装缺失依赖
 *   node scripts/setup-mcp.js --install --prefix D:\\mcp-modules  安装到自定义目录
 *
 * 安装内容：
 *   1) @modelcontextprotocol/sdk  → 扩展运行所需客户端库
 *      默认装到「用户主目录/.fox-ai/mcp-modules」，不在扩展目录里（扩展更新会被清掉，
 *      且路径更清晰）；可用 --prefix <dir> 自定义。安装后会提示在 VS Code 设置里
 *      把 foxAi.mcp.modulesPath 设成同一目录，扩展才能加载。
 *   2) @playwright/mcp           → 浏览器自动化 MCP 服务器（全局安装，方便 npx 直接调用）
 *   3) npx playwright install chromium → 仅下载 Chromium 浏览器（MCP 默认用 chromium，
 *      体积远小于 firefox/webkit；并启用国内镜像加速，显著缩短下载时间）
 *
 * ⚠️ 两层防护（重要）：
 *   (1) zod 版本钉死：@modelcontextprotocol/sdk@1.30.x 的 zod-compat.js 在解析工具定义时，
 *       对「被判定为 v3 schema 的对象」会调用 v3Schema.safeParse(data)。若 npm 把 zod 的传递
 *       依赖解析成 v4（4.x），v4 的 schema 没有 safeParse 方法 → 抛
 *       `v3Schema.safeParse is not a function`，导致所有 MCP 工具定义解析失败。因此必须显式
 *       钉死 zod@^3.25（兼容 v3 API），禁止漂移到 v4。
 *   (2) zod-compat.js 守卫补丁：即使 zod 是 v3，SDK 1.30.x 还会对「纯 JSON schema 对象
 *       （MCP 服务器返回的工具 inputSchema，普通对象、无 safeParse 方法）」落入 v3 分支并调用
 *       v3Schema.safeParse → 同样抛上述错误。这是 SDK 对非 zod 对象的 latent bug。安装时会对
 *       dist/esm 与 dist/cjs 的 zod-compat.js 注入守卫：v3 分支前若 schema 不是函数就直接放行
 *       （与 SDK 旧版不校验 JSON schema 的行为一致）。补丁幂等，已含 [fox-ai patch] 标记则跳过。
 */

const { execFileSync, spawnSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 默认安装位置：用户主目录下独立目录（不在扩展目录里，避免更新被清、路径也清晰）
const DEFAULT_PREFIX = path.join(os.homedir(), '.fox-ai', 'mcp-modules');
const EXT_DIR = path.resolve(__dirname, '..'); // 扩展根目录（仅备用）
const args = process.argv.slice(2);
const mode = args.includes('--install') ? 'install' : 'check';
const prefixIdx = args.indexOf('--prefix');
const PREFIX = prefixIdx >= 0 && args[prefixIdx + 1]
  ? path.resolve(args[prefixIdx + 1])
  : DEFAULT_PREFIX;

// 国内加速镜像：npm 包走 npmmirror 源，Playwright 浏览器二进制走 npmmirror 二进制镜像。
// 大幅缩短下载时间（官方默认 CDN 在国内很慢）。仅作用于本脚本内的 npm/npx 调用，不改用户全局配置。
const MIRROR_ENV = {
  npm_config_registry: 'https://registry.npmmirror.com',
};

// Playwright 浏览器二进制镜像候选（cdn 主用，legacy 备用）。任一可用即可，自动回退。
const PLAYWRIGHT_HOSTS = [
  'https://cdn.npmmirror.com/binaries/playwright',
  'https://npmmirror.com/mirrors/playwright',
];

function hasCmd(name) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function resolveFrom(dir, mod) {
  // 新版 @modelcontextprotocol/sdk 是纯 ESM 包，require.resolve() 在 CJS 加载器下会失败，
  // 因此改用检查 node_modules/<mod>/package.json 是否存在并校验 name，避免误判为未安装。
  const candidates = [dir, path.join(dir, 'node_modules')];
  for (const base of candidates) {
    const pkgFile = path.join(base, mod, 'package.json');
    try {
      if (fs.existsSync(pkgFile)) {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        if (pkg.name === mod) return true;
      }
    } catch (_) { /* ignore */ }
  }
  return false;
}

function readZodVersion(dir) {
  const pkgFile = path.join(dir, 'node_modules', 'zod', 'package.json');
  try {
    if (fs.existsSync(pkgFile)) {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      return pkg.version || '';
    }
  } catch (_) { /* ignore */ }
  return '';
}

/**
 * 固化 zod-compat.js 的 safeParse 守卫补丁（防止 "v3Schema.safeParse is not a function"）。
 * 根因：SDK 1.30.x 的 zod-compat.js 在 v3 分支会对「纯 JSON schema 对象」（MCP 服务器返回的工具
 * inputSchema，普通对象、无 safeParse 方法）调用 v3Schema.safeParse → 抛错。补丁在 v3 分支前判断：
 * 传入的 schema 不是函数（无 safeParse/safeParseAsync）就直接放行，与 SDK 旧版行为一致。
 * 幂等：已含 [fox-ai patch] 标记则跳过；找不到文件或锚点则告警跳过（SDK 版本可能已变）。
 * 对 esm 与 cjs 两个副本都生效（require 默认走 cjs）。
 */
function patchZodCompat(PREFIX) {
  const targets = [
    path.join(PREFIX, 'node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-compat.js'),
    path.join(PREFIX, 'node_modules/@modelcontextprotocol/sdk/dist/cjs/server/zod-compat.js'),
  ];
  // 锚点：isZ4Schema 分支结束 `}` 之后、v3 分支 `const v3Schema = schema;` 之前
  const SP_ANCHOR = "    }\n    const v3Schema = schema;\n    const result = v3Schema.safeParse(data);";
  const SP_PATCH = "    }\n    // [fox-ai patch] JSON schema（普通对象，无 safeParse 方法）直接放行，避免 \"v3Schema.safeParse is not a function\"\n    if (typeof schema?.safeParse !== 'function') {\n        return { success: true, data };\n    }\n    const v3Schema = schema;\n    const result = v3Schema.safeParse(data);";
  const SPA_ANCHOR = "    }\n    const v3Schema = schema;\n    const result = await v3Schema.safeParseAsync(data);";
  const SPA_PATCH = "    }\n    // [fox-ai patch] JSON schema（普通对象，无 safeParseAsync 方法）直接放行\n    if (typeof schema?.safeParseAsync !== 'function') {\n        return { success: true, data };\n    }\n    const v3Schema = schema;\n    const result = await v3Schema.safeParseAsync(data);";

  let patched = 0, skipped = 0;
  for (const file of targets) {
    if (!fs.existsSync(file)) continue;
    let src = fs.readFileSync(file, 'utf8');
    if (src.includes('[fox-ai patch]')) { skipped++; continue; }
    let changed = false;
    if (src.includes(SP_ANCHOR)) { src = src.replace(SP_ANCHOR, SP_PATCH); changed = true; }
    if (src.includes(SPA_ANCHOR)) { src = src.replace(SPA_ANCHOR, SPA_PATCH); changed = true; }
    if (changed) {
      fs.writeFileSync(file, src);
      patched++;
    } else {
      console.error('  ⚠️ 未在 ' + file + ' 找到注入锚点，跳过（SDK 版本可能已变更，请检查）');
    }
  }
  if (patched) console.log('   ✅ 已为 zod-compat.js 打上 safeParse 守卫补丁（' + patched + ' 个文件）');
  if (skipped) console.log('   ℹ️ ' + skipped + ' 个 zod-compat.js 已含补丁，跳过');
  if (!patched && !skipped) console.log('   ℹ️ 未找到 zod-compat.js（SDK 未安装？），补丁将在 SDK 安装后于下次 --install 自动应用');
}

function resolveGlobal(mod) {
  try {
    // shell:true 让 Windows 能解析 npm.cmd（否则 spawnSync('npm') 报 ENOENT）
    // windowsHide:true 防止在 VS Code 扩展宿主里弹出 cmd 黑窗
    const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true, windowsHide: true });
    if (r.status !== 0 || !r.stdout) return false;
    const globalRoot = r.stdout.trim();
    return globalRoot ? fs.existsSync(path.join(globalRoot, mod)) : false;
  } catch (_) {
    return false;
  }
}

function checkPlaywrightCli() {
  try {
    spawnSync('npx', ['playwright', '--version'], { stdio: 'ignore', shell: true, windowsHide: true });
    return true;
  } catch (_) {
    return false;
  }
}

// 捕获 npm 真实输出（不再用 stdio:'inherit' 吞掉报错），返回 { ok, err }
// shell:true 关键：Windows 下 npm/npx 是 .cmd，spawnSync 不带 shell 会 ENOENT
// windowsHide:true 关键：扩展宿主是 GUI 进程，shell:true 会弹 cmd 黑窗并卡死
// env 注入国内镜像，加速 npm 包下载
function runNpm(npmArgs, cwd) {
  const r = spawnSync('npm', npmArgs, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    shell: true,
    windowsHide: true,
    env: Object.assign({}, process.env, MIRROR_ENV),
  });
  if (r.status === 0) return { ok: true, err: '' };
  const out = [r.stdout || '', r.stderr || '', r.error ? String(r.error) : '']
    .filter(Boolean)
    .join('\n');
  return { ok: false, err: out };
}

// 浏览器下载改为流式输出：把 playwright 的 stdout/stderr 实时转发给父进程（VS Code 进度栏），
// 这样下载百分比（Playwright 用同一行 \r 刷新）才能被实时解析显示。
// 依次尝试各 Playwright 镜像地址，任一成功即可；全部失败才报错误。
function downloadBrowsers() {
  return new Promise((resolve) => {
    let idx = 0;
    const tryHost = () => {
      if (idx >= PLAYWRIGHT_HOSTS.length) {
        resolve(-1);
        return;
      }
      const host = PLAYWRIGHT_HOSTS[idx++];
      console.log('（使用 Playwright 镜像：' + host + '）');
      const child = spawn('npx', ['playwright', 'install', 'chromium'], {
        cwd: EXT_DIR,
        shell: true,
        windowsHide: true,
        env: Object.assign({}, process.env, MIRROR_ENV, { PLAYWRIGHT_DOWNLOAD_HOST: host }),
      });
      child.stdout.on('data', (d) => process.stdout.write(d));
      child.stderr.on('data', (d) => process.stderr.write(d));
      child.on('error', (e) => {
        console.error('\n❌ 启动 playwright 下载进程失败：' + e.message);
        resolve(-1);
      });
      child.on('close', (code) => {
        if (code === 0) { resolve(0); return; }
        console.error('\n⚠️ 该镜像下载失败（退出码 ' + code + '），尝试下一个镜像…');
        tryHost();
      });
    };
    tryHost();
  });
}

function report() {
  const nodeOk = hasCmd('node');
  const npmOk = hasCmd('npm');
  const npxOk = hasCmd('npx');
  const sdkOk = resolveFrom(PREFIX, '@modelcontextprotocol/sdk');
  const pwMcpOk = resolveFrom(PREFIX, '@playwright/mcp');
  const pwCliOk = checkPlaywrightCli();
  const zodVer = readZodVersion(PREFIX);
  const zodV4Broken = !!zodVer && zodVer.startsWith('4');
  const compatFile = path.join(PREFIX, 'node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-compat.js');
  let compatPatched = false;
  try { if (fs.existsSync(compatFile)) compatPatched = fs.readFileSync(compatFile, 'utf8').includes('[fox-ai patch]'); } catch (_) {}

  const locationHint = PREFIX === EXT_DIR ? '扩展目录' : PREFIX;

  console.log('=== fox-ai MCP 依赖检查 ===');
  console.log('node                         :', nodeOk ? '可用' : '缺失');
  console.log('npm                          :', npmOk ? '可用' : '缺失');
  console.log('npx                          :', npxOk ? '可用' : '缺失');
  console.log('@modelcontextprotocol/sdk    :', sdkOk ? `已安装（${locationHint}）` : `未安装（位置：${locationHint}）`);
  console.log('zod                          :', zodVer ? `${zodVer}${zodV4Broken ? ' ⚠️ v4 会与 SDK 冲突，需 --install 修正' : ' ✅ v3 兼容'}` : '未检测到');
  console.log('zod-compat 守卫补丁          :', !sdkOk ? 'SDK 未装（跳过）' : (compatPatched ? '已打 ✅' : '⚠️ 缺失，需 --install 重打'));
  console.log('@playwright/mcp              :', pwMcpOk ? `已安装（${locationHint}）` : `未安装（位置：${locationHint}）`);
  console.log('Playwright 浏览器 CLI        :', pwCliOk ? '可用' : '未就绪（需先装 @playwright/mcp 再下载浏览器）');

  const missing = [];
  if (!sdkOk) missing.push('@modelcontextprotocol/sdk');
  if (!pwMcpOk) missing.push('@playwright/mcp');
  if (!pwCliOk) missing.push('Playwright 浏览器');
  if (zodV4Broken) missing.push('zod 需降级到 v3（运行 --install 自动修正）');
  if (sdkOk && !compatPatched) missing.push('zod-compat 守卫补丁（运行 --install 自动重打）');

  if (missing.length === 0) {
    console.log('\n✅ 全部依赖就绪。可在设置里开启 foxAi.mcp.enabled 并配置服务器。');
  } else {
    console.log('\n⚠️ 缺失或待安装：' + missing.join('、'));
    console.log('运行 `node scripts/setup-mcp.js --install` 自动安装（需联网与 npm）。');
    if (PREFIX !== DEFAULT_PREFIX) {
      console.log('自定义位置请加上：--prefix ' + PREFIX);
    }
  }
  return missing.length === 0 ? 0 : 2;
}

async function install() {
  const npmOk = hasCmd('npm');
  const npxOk = hasCmd('npx');
  const sdkOk = resolveFrom(PREFIX, '@modelcontextprotocol/sdk');
  const pwMcpOk = resolveFrom(PREFIX, '@playwright/mcp');
  const locationHint = PREFIX === EXT_DIR ? '扩展目录' : PREFIX;

  if (!npmOk || !npxOk) {
    console.error('\n❌ 未找到 npm / npx，无法自动安装。请先安装 Node.js 后重试。');
    return 1;
  }

  console.log(`\n📦 安装目标位置：${locationHint}（已启用国内镜像加速）`);

  // 准备目标目录与最小 package.json（所有依赖都本地装到 PREFIX，避免全局 npm 路径混乱）
  try {
    fs.mkdirSync(PREFIX, { recursive: true });
    const pkgFile = path.join(PREFIX, 'package.json');
    if (!fs.existsSync(pkgFile)) {
      fs.writeFileSync(
        pkgFile,
        JSON.stringify({ name: 'fox-ai-mcp-modules', version: '1.0.0', private: true, dependencies: { zod: '^3.25' } }, null, 2)
      );
    }
  } catch (e) {
    console.error('❌ 创建目标目录失败：' + e.message);
    return 1;
  }

  // 1) SDK
  if (!sdkOk) {
    console.log('\n[1/3] 正在安装 @modelcontextprotocol/sdk 到 ' + PREFIX + ' …');
    const sdkRes = runNpm(['install', '--no-audit', '--no-fund', '@modelcontextprotocol/sdk'], PREFIX);
    if (!sdkRes.ok) {
      console.error('❌ @modelcontextprotocol/sdk 安装失败，npm 输出如下：');
      console.error(sdkRes.err.trim());
      return 1;
    }
  } else {
    console.log('\n✅ @modelcontextprotocol/sdk 已存在，跳过。');
  }

  // 1.5) 钉死 zod 为 v3 + 为 zod-compat.js 打 safeParse 守卫补丁（无论 SDK 是否新装都执行）。
  // 见文件顶部注释：SDK 1.30.x 的 zod-compat 在 zod v4 会抛 v3Schema.safeParse is not a function；
  // 即使 zod 是 v3，SDK 仍会对纯 JSON schema（无 safeParse 方法的普通对象）调 v3Schema.safeParse 而炸——
  // 这是 SDK 1.30.x 对非 zod 对象的 latent bug。补丁在 v3 分支前判 schema 不是函数就直接放行。
  console.log('\n[1.5/4] 正在钉定 zod 为 v3（^3.25）并为 zod-compat.js 打 safeParse 守卫补丁…');
  const zodRes = runNpm(['install', '--no-audit', '--no-fund', 'zod@^3.25'], PREFIX);
  if (!zodRes.ok) {
    console.error('❌ zod 钉定失败，npm 输出如下：');
    console.error(zodRes.err.trim());
    console.error('（可忽略此警告继续，但 MCP 客户端可能仍报 v3Schema.safeParse 错误；建议手动重跑该命令）');
  } else {
    const zv = readZodVersion(PREFIX);
    console.log('   ✅ zod 已钉定：' + (zv || '未知版本') + (zv && zv.startsWith('4') ? ' ⚠️ 仍是 v4，请检查 npm 解析' : ''));
  }
  // 固化 safeParse 守卫补丁（钉死的是 zod 版本，这步修的是 SDK 对非 zod 对象的误判）
  patchZodCompat(PREFIX);

  // 2) Playwright MCP 服务器（同样本地安装到 PREFIX，避免多 Node 版本全局目录不一致）
  if (!pwMcpOk) {
    console.log('\n[2/4] 正在安装 @playwright/mcp 到 ' + PREFIX + ' …');
    const pwRes = runNpm(['install', '--no-audit', '--no-fund', '@playwright/mcp'], PREFIX);
    if (!pwRes.ok) {
      console.error('❌ @playwright/mcp 安装失败，npm 输出如下：');
      console.error(pwRes.err.trim());
      return 1;
    }
  } else {
    console.log('\n✅ @playwright/mcp 已存在，跳过。');
  }

  // 3) Playwright 浏览器：仅 chromium（MCP 默认用 chromium），并走国内镜像，流式输出进度
  console.log('\n[3/4] 正在下载 Playwright 浏览器（chromium，国内镜像加速）…');
  const code = await downloadBrowsers();
  if (code !== 0) {
    console.error('\n❌ Playwright 浏览器下载失败（退出码 ' + code + '）。');
    console.error('可手动运行 `npx playwright install chromium` 重试。');
    return 1;
  }

  console.log('\n✅ 全部 MCP 依赖与浏览器准备就绪。');
  console.log('请将 VS Code 设置项 foxAi.mcp.modulesPath 设为：' + PREFIX);
  console.log('（通过扩展内的「检查并安装依赖」按钮安装时，会自动写入该设置；命令行手动安装则需自行设置。）');
  console.log('现在可以开启 foxAi.mcp.enabled 并添加 MCP 服务器了。');
  return 0;
}

if (mode === 'install') {
  install()
    .then((code) => process.exit(code))
    .catch((e) => { console.error(e); process.exit(1); });
} else {
  process.exit(report());
}
