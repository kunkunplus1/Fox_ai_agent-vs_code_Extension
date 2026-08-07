'use strict';
// 测试 security_audit 工具（只读代码安全自检 + 治理护栏）：
// - scanFile 命中危险模式规则
// - 脱敏：报告/片段中密钥值打码、凭据文件不读取内容
// - 任务树深度上限 MAX_DEPTH、单节点重试、熔断/失败节点转人工
// 通过拦截 require('vscode') 在纯 Node 环境运行。

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
const sa = require('../src/tools/securityAudit');

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

async function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foxsec-'));

  console.log('测试1：scanFile 命中危险规则');
  const vuln = [
    "const apiKey = 'abcdefghijklmnop123456';",
    'const x = eval(userInput);',
    "const out = child_process.exec('ls ' + name);",
    "const sql = 'SELECT * FROM t WHERE id=' + req.query.id;",
    'const html = el.innerHTML = "<b>" + userText;',
    'const opt = { rejectUnauthorized: false };',
    "const ok = 'no issue here';"
  ].join('\n');
  const f = path.join(tmp, 'vuln.js');
  fs.writeFileSync(f, vuln);
  const hits = sa.scanFile(f);
  const ids = hits.map((h) => h.ruleId);
  ok('命中硬编码密钥', ids.includes('hardcoded-secret'));
  ok('命中动态代码执行', ids.includes('dynamic-eval'));
  ok('命中命令执行', ids.includes('command-exec'));
  ok('命中 SQL 拼接', ids.includes('sql-concat'));
  ok('命中 XSS 注入点', ids.includes('xss-sink'));
  ok('命中 TLS 禁用', ids.includes('tls-disable'));
  ok('无误报（普通行不被命中）', !hits.some((h) => h.snippet.includes('no issue here')));

  console.log('测试2：脱敏——片段中密钥值被打码');
  const secretHit = hits.find((h) => h.ruleId === 'hardcoded-secret');
  ok('片段含打码 ****', secretHit.snippet.includes('****'));
  ok('片段不含明文密钥', !secretHit.snippet.includes('abcdefghijklmnop123456'));

  console.log('测试3：listFiles 排除 node_modules 与凭据文件');
  fs.mkdirSync(path.join(tmp, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'node_modules', 'x', 'dep.js'), 'eval(1);');
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'app.js'), "const k='abcdefghijklmnop';");
  // 凭据文件：只登记、不读取内容
  fs.writeFileSync(path.join(tmp, '.env'), 'AWS_SECRET_ACCESS_KEY=abcdefghijklmnop123456\n');
  fs.mkdirSync(path.join(tmp, '.aws'), { recursive: true });
  const ctx = { excluded: [], nodes: 0, failedNodes: 0, truncated: false };
  const files = sa.listFiles(tmp, ctx);
  const rel = files.map((x) => path.relative(tmp, x));
  ok('包含 src/app.js', rel.includes(path.join('src', 'app.js')));
  ok('排除 node_modules/dep.js', !rel.some((r) => r.includes('node_modules')));
  ok('隔离 .env（不读取内容）', ctx.excluded.some((e) => e.endsWith('.env')));
  ok('隔离 .aws 目录', ctx.excluded.some((e) => e.endsWith('.aws')));

  console.log('测试4：任务树深度上限（>MAX_DEPTH 停止下钻）');
  let deep = tmp;
  for (let i = 0; i < sa.LIMITS.MAX_DEPTH + 2; i++) {
    deep = path.join(deep, 'l' + i);
    fs.mkdirSync(deep, { recursive: true });
  }
  fs.writeFileSync(path.join(deep, 'deep.js'), 'eval(1);');
  const dctx = { excluded: [], nodes: 0, failedNodes: 0, truncated: false };
  const dFiles = sa.listFiles(tmp, dctx);
  const dRel = dFiles.map((x) => path.relative(tmp, x));
  ok('超限深层文件未被扫描', !dRel.some((r) => r.includes('deep.js')));
  ok('ctx.truncated === true', dctx.truncated === true);
  ok('深度上限 = 5', sa.LIMITS.MAX_DEPTH === 5);

  console.log('测试5：单节点重试上限与失败计数');
  const rctx = { excluded: [], nodes: 0, failedNodes: 0, truncated: false };
  const r = sa.scanFile('/no/such/file-xyz.js', rctx);
  ok('不存在文件返回空数组', Array.isArray(r) && r.length === 0);
  ok('失败节点计数 = 1', rctx.failedNodes === 1);
  ok('重试上限 = 3', sa.LIMITS.MAX_RETRIES === 3);

  console.log('测试6：run 生成报告（含脱敏/网络隔离/双盲声明）');
  const report = await sa.run({ path: tmp, checkDeps: true });
  ok('报告含标题', report.includes('代码安全自检报告'));
  ok('报告含静态规则命中章节', report.includes('静态规则命中'));
  ok('报告含脱敏/网络隔离横幅', report.includes('脱敏') && report.includes('网络隔离'));
  ok('报告含双盲声明', report.includes('禁止作为修复的唯一依据'));
  ok('网络隔离默认关闭依赖检查', report.includes('网络隔离沙箱：依赖漏洞检查默认关闭'));
  ok('报告状态 OK', report.includes('状态：OK'));

  console.log('测试7：run 处理不存在路径');
  const bad = await sa.run({ path: path.join(tmp, 'nope'), checkDeps: false });
  ok('不存在路径返回友好提示', typeof bad === 'string' && bad.includes('⚠️'));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  if (fail) process.exit(1);
}

run().catch((e) => { console.error('测试异常：', e); process.exit(1); });
