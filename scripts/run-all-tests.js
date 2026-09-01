#!/usr/bin/env node
/**
 * 一键全量回归入口：跑 fox-ai 全部测试文件（test/*.js + 根目录 test_*.js）。
 *
 * 用法：node scripts/run-all-tests.js [--skip <关键词>] [--only <子串>] [--timeout <ms>]
 *   --skip   按文件名子串跳过（可多次），例：--skip probe --skip live
 *   --only   只跑文件名含该子串的测试
 *   --timeout 单文件超时毫秒（默认 60000）
 *
 * 每个文件在子进程里独立跑：崩溃/超时不影响其他文件，最后输出汇总表。
 *
 * 默认跳过（无需 --skip 的「非回归」类）：
 *   - 一次性探针：文件名含 probe / _repro / env.script / scan
 *   - 真实环境依赖：playwrightConnector（需真实浏览器）、*_live（需真实 API/VS Code）
 * 想强制跑默认跳过项时用 --include-skipped；想额外排除再叠加 --skip。
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const timeout = (() => {
  const i = args.indexOf('--timeout');
  return i >= 0 ? parseInt(args[i + 1], 10) || 60000 : 60000;
})();
const skips = [];
const onlys = [];
let includeSkipped = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--skip') { skips.push(args[i + 1]); i++; }
  else if (args[i] === '--only') { onlys.push(args[i + 1]); i++; }
  else if (args[i] === '--include-skipped') includeSkipped = true;
}

// 默认排除「非回归」类：一次性探针 + 真实环境依赖
const DEFAULT_SKIP_RE = /(_repro|probe|env\.script|scan|playwrightconnector|_live)/i;

function collectTestFiles() {
  const files = [];
  // test/ 目录全部 .js
  const testDir = path.join(ROOT, 'test');
  if (fs.existsSync(testDir)) {
    for (const f of fs.readdirSync(testDir)) {
      if (f.endsWith('.js')) files.push(path.join(testDir, f));
    }
  }
  // 根目录 test_*.js
  for (const f of fs.readdirSync(ROOT)) {
    if (/^test_.+\.js$/.test(f)) files.push(path.join(ROOT, f));
  }
  return files.sort();
}

function shouldRun(f) {
  const base = path.basename(f);
  if (onlys.length && !onlys.some((o) => base.includes(o))) return false;
  if (skips.some((s) => base.includes(s))) return false;
  if (!includeSkipped && DEFAULT_SKIP_RE.test(base)) return false;
  return true;
}

const files = collectTestFiles().filter(shouldRun);
console.log('=== fox-ai 全量回归 ===');
console.log('共发现测试文件: ' + collectTestFiles().length + '，本次运行: ' + files.length +
  (skips.length ? '（额外跳过: ' + skips.join(', ') + '）' : '') +
  (includeSkipped ? '' : '（默认排除探针/真实环境依赖类）') +
  (onlys.length ? '（仅: ' + onlys.join(', ') + '）' : '') +
  '，单文件超时: ' + timeout + 'ms');
console.log('');

const results = [];
let okCount = 0, failCount = 0, crashCount = 0, timeoutCount = 0;

for (const f of files) {
  const base = path.basename(f);
  process.stdout.write('▶ ' + base + ' … ');
  const r = spawnSync(process.execPath, [f], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, NO_COLOR: '1' }
  });
  let status = '';
  if (r.error) {
    if (r.error.code === 'ETIMEDOUT') { status = '⏱ 超时'; timeoutCount++; }
    else { status = '⚠ 崩溃(' + r.error.code + ')'; crashCount++; }
  } else if (r.status !== 0) {
    // 退出码非 0：抓最后几行原因
    const tail = (r.stdout || r.stderr || '').trim().split('\n').slice(-4).join(' | ');
    status = '✗ 失败 (' + r.status + ') ' + tail;
    failCount++;
  } else {
    status = '✓ 通过';
    okCount++;
  }
  results.push({ base, status });
  console.log(status);
}

console.log('');
console.log('=== 汇总 ===');
console.log('通过: ' + okCount + '  失败: ' + failCount + '  崩溃: ' + crashCount + '  超时: ' + timeoutCount +
  '  合计: ' + results.length);
console.log('');
const bad = results.filter((r) => !r.status.startsWith('✓'));
if (bad.length) {
  console.log('—— 未通过清单 ——');
  for (const r of bad) console.log('  ' + r.base + '  ' + r.status);
  process.exitCode = 1;
} else {
  console.log('全部通过 ✅');
}