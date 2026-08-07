'use strict';
// 测试 referee_review 工具（只读裁判 Agent · 双盲交叉验证）：
// - 仅格式/注释差异 → 逻辑等价 → SUSPEND（强制挂起）
// - 真实逻辑改动 → PROCEED
// - 新增文件（无 HEAD）→ NEW
// - 非 git 目录 → 友好提示
// 通过拦截 require('vscode') + 本地临时 git 仓库运行。

const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'vscode') {
    return { workspace: { workspaceFolders: null, getConfiguration: () => ({ get: () => '' }) }, window: {} };
  }
  return origLoad.apply(this, arguments);
};

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const referee = require('../src/tools/referee');

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function initRepo(dir) {
  sh(dir, 'git', ['init', '-q']);
  sh(dir, 'git', ['config', 'user.email', 'test@fox.ai']);
  sh(dir, 'git', ['config', 'user.name', 'fox-test']);
}

async function run() {
  console.log('测试1：isEquivalent 纯函数');
  ok('仅格式/注释差异 → 等价', referee.isEquivalent('function f(a){return a+1;}', 'function f(a) {\n  return a + 1; // add one\n}').equivalent === true);
  ok('真实逻辑改动 → 不等价', referee.isEquivalent('function f(a){return a+1;}', 'function f(a){return a+2;}').equivalent === false);

  console.log('测试2：仅格式差异 → SUSPEND（误报挂起）');
  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'foxref2-'));
  initRepo(r2);
  fs.writeFileSync(path.join(r2, 'calc.js'), 'function f(a){return a+1;}');
  sh(r2, 'git', ['add', '-A']);
  sh(r2, 'git', ['commit', '-q', '-m', 'v1']);
  // 仅重排+加注释（逻辑不变）
  fs.writeFileSync(path.join(r2, 'calc.js'), 'function f(a) {\n  return a + 1; // add one\n}');
  const rep2 = await referee.run({ path: r2 });
  ok('报告含 SUSPEND 建议', rep2.includes('SUSPEND') && rep2.includes('强制挂起'));
  ok('逐文件结论含「挂起」', rep2.includes('🔴 挂起'));

  console.log('测试3：真实逻辑改动 → PROCEED');
  const r3 = fs.mkdtempSync(path.join(os.tmpdir(), 'foxref3-'));
  initRepo(r3);
  fs.writeFileSync(path.join(r3, 'calc.js'), 'function f(a){return a+1;}');
  sh(r3, 'git', ['add', '-A']);
  sh(r3, 'git', ['commit', '-q', '-m', 'v1']);
  fs.writeFileSync(path.join(r3, 'calc.js'), 'function f(a){return a+2;}');
  const rep3 = await referee.run({ path: r3 });
  ok('报告含 PROCEED 建议', rep3.includes('PROCEED'));
  ok('逐文件结论含「通过」', rep3.includes('🟢 通过'));

  console.log('测试4：新增文件（无 HEAD）→ NEW，不误判挂起');
  const r4 = fs.mkdtempSync(path.join(os.tmpdir(), 'foxref4-'));
  initRepo(r4);
  const newFile = path.join(r4, 'added.js');
  fs.writeFileSync(newFile, 'const x = 1;\nconsole.log(x);');
  const rep4 = await referee.run({ path: newFile });
  ok('报告识别为新增文件', rep4.includes('新增文件') || rep4.includes('NEW'));
  ok('未误挂起', !rep4.includes('SUSPEND'));

  console.log('测试5：非 git 目录 → 友好提示');
  const r5 = fs.mkdtempSync(path.join(os.tmpdir(), 'foxref5-'));
  fs.writeFileSync(path.join(r5, 'a.js'), 'const x=1;');
  const rep5 = await referee.run({ path: r5 });
  ok('非 git 返回友好提示', rep5.includes('⚠️') && rep5.includes('git 仓库'));

  [r2, r3, r4, r5].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  if (fail) process.exit(1);
}

run().catch((e) => { console.error('测试异常：', e); process.exit(1); });
