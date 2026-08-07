'use strict';
/**
 * stealth-fetch 离线校验（不触碰网络 / 不依赖已安装 Python 依赖）
 * 覆盖：目录条目合法性、服务器脚本路径存在、venv 路径格式、runSteps 无 Python 时的优雅报错。
 */
const assert = require('assert');
const path = require('path');
const os = require('os');
const catalog = require('../src/mcpCatalog');
const sf = require('../src/tools/stealthFetchSetup');

let passed = 0;
function ok(name) { passed++; console.log('  ✓', name); }

// 1) 目录条目合法
const entry = catalog.find('stealth-fetch');
assert(entry, 'catalog 应存在 stealth-fetch 条目');
assert.strictEqual(entry.install.type, 'python', 'install.type 应为 python');
assert(Array.isArray(entry.needsEnv) && entry.needsEnv.some((e) => e.key === 'STEALTH_FETCH_COOKIE'),
  'needsEnv 应包含 STEALTH_FETCH_COOKIE');
ok('catalog 条目 stealth-fetch 合法（python 安装类型 + Cookie 环境变量）');

// 2) 服务器脚本路径指向真实存在文件
const repoRoot = path.resolve(__dirname, '..');
const ctx = { extensionPath: repoRoot };
const serverPy = sf.serverScriptPath(ctx);
assert(typeof serverPy === 'string' && serverPy.endsWith('stealth_fetch_server.py'), 'serverScriptPath 应以 server.py 结尾');
const fs = require('fs');
assert(fs.existsSync(serverPy), 'stealth_fetch_server.py 应存在：' + serverPy);
ok('serverScriptPath 解析到真实存在的服务器脚本');

// 3) venv 路径格式（跨平台）
const vd = sf.venvDir();
assert(vd.replace(/\\/g, '/').endsWith('.fox-ai/mcp-servers/stealth-fetch/.venv'), 'venvDir 路径格式');
const vPy = sf.venvPython(vd);
if (process.platform === 'win32') assert(vPy.endsWith('Scripts\\python.exe') || vPy.endsWith('Scripts/python.exe'), 'win venv python 路径');
else assert(vPy.endsWith('bin/python'), 'posix venv python 路径');
ok('venvDir / venvPython 路径格式正确（win=' + (process.platform === 'win32') + '）');

// 4) detectBasePython 可被调用且不抛（返回 string 或 null）
const base = sf.detectBasePython();
assert(base === null || typeof base === 'string', 'detectBasePython 返回 string|null');
ok('detectBasePython 可调用，返回：' + (base || 'null'));

// 5) runSteps：无 Python 解释器时优雅报错（不崩）
(async () => {
  const r = await sf.runSteps({ context: ctx, basePython: null, emit: () => {}, shouldCancel: () => false });
  assert(r.ok === false, 'basePython=null 应失败');
  assert(/Python/.test(r.error || ''), '错误应提及 Python：' + r.error);
  ok('runSteps(basePython=null) 优雅报错：' + r.error);

  // 6) runSteps：脚本缺失时优雅报错
  const r2 = await sf.runSteps({
    context: { extensionPath: path.join(repoRoot, 'no-such-dir') },
    basePython: 'python',
    emit: () => {}, shouldCancel: () => false
  });
  assert(r2.ok === false, '脚本缺失应失败');
  ok('runSteps(脚本缺失) 优雅报错：' + r2.error);

  console.log('\n[stealthFetch] 通过 ' + passed + ' 项断言');
})().catch((e) => { console.error('测试失败：', e); process.exit(1); });
