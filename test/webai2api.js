'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const w = require('../src/webai2api');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('✓ ' + name); }
  catch (e) { failed++; console.log('✗ ' + name + '\n  ' + e.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log('✓ ' + name); }
  catch (e) { failed++; console.log('✗ ' + name + '\n  ' + e.message); }
}

check('阶段权重之和 = 100', () => {
  const sum = w.STAGES.reduce((a, s) => a + s.weight, 0);
  assert.strictEqual(sum, 100);
});

check('阶段顺序 preflight→download→deps→init→config', () => {
  assert.deepStrictEqual(w.STAGES.map((s) => s.key), ['preflight', 'download', 'deps', 'init', 'config']);
});

check('generateAuth 返回 sk- + 48 位十六进制', () => {
  const a = w.generateAuth();
  assert.match(a, /^sk-[0-9a-f]{48}$/);
});

check('generateAuth 每次不同', () => {
  assert.notStrictEqual(w.generateAuth(), w.generateAuth());
});

check('writeConfig 复制 example 并替换 auth', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.example.yaml'),
      'logLevel: info\nserver:\n  port: 3000\n  auth: sk-change-me-to-your-secure-key\n', 'utf8');
    const auth = w.generateAuth();
    w.writeConfig(dir, auth, () => {});
    const content = fs.readFileSync(path.join(dir, 'data', 'config.yaml'), 'utf8');
    assert.ok(content.includes('auth: ' + auth), '应包含新 auth');
    assert.ok(!content.includes('sk-change-me-to-your-secure-key'), '不应含占位 auth');
    assert.ok(content.includes('port: 3000'), '应保留其他字段');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

check('writeConfig 缺 example 抛错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-test-'));
  try {
    assert.throws(() => w.writeConfig(dir, w.generateAuth(), () => {}), /config\.example\.yaml/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

check('hasPnpm 返回布尔', () => {
  assert.strictEqual(typeof w.hasPnpm(), 'boolean');
});

check('killTree 传 0/null 不抛异常', () => {
  w.killTree(0);
  w.killTree(null);
  assert.ok(true);
});

// 异步：isPortListening（检测一个几乎必然空闲的高位端口，应返回 false）
checkAsync('isPortListening 空闲端口返回 false', async () => {
  const listening = await w.isPortListening(59999, '127.0.0.1');
  assert.strictEqual(listening, false);
});

// startServer：用不存在目录验证「不抛同步异常」（Windows 下 spawn EINVAL 应被捕获，返回 null）
check('startServer 不抛异常（无效目录返回 null）', () => {
  let exited = false;
  const child = w.startServer('/nonexistent-dir-xyz', { onLog: () => {}, onExit: () => { exited = true; } });
  assert.ok(child === null || typeof child === 'object', '应返回 null 或 child 对象');
  if (child && child.pid) w.killTree(child.pid);
});

// findPidByPort：空闲高位端口应返回 null（无监听进程）
check('findPidByPort 空闲端口返回 null', () => {
  const pid = w.findPidByPort(59998);
  assert.strictEqual(pid, null);
});

// killPort：空闲端口返回 false（未找到进程，不误杀）
check('killPort 空闲端口返回 false', () => {
  assert.strictEqual(w.killPort(59997), false);
});

// ---- 代理探测（纯函数）----
check('normalizeProxy 纯 host:port 补 http://', () => {
  assert.strictEqual(w.normalizeProxy('127.0.0.1:7890'), 'http://127.0.0.1:7890');
});
check('normalizeProxy 已带 http(s):// 或 socks5:// 保留', () => {
  assert.strictEqual(w.normalizeProxy('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.strictEqual(w.normalizeProxy('socks5://127.0.0.1:1080'), 'socks5://127.0.0.1:1080');
});
check('normalizeProxy 空白/空格返回空串', () => {
  assert.strictEqual(w.normalizeProxy(''), '');
  assert.strictEqual(w.normalizeProxy('   '), '');
});
check('parseProxyServer 单地址', () => {
  assert.strictEqual(w.parseProxyServer('127.0.0.1:7890'), 'http://127.0.0.1:7890');
});
check('parseProxyServer 多协议优先 http/https', () => {
  assert.strictEqual(w.parseProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7891;ftp=127.0.0.1:21'), 'http://127.0.0.1:7890');
  assert.strictEqual(w.parseProxyServer('ftp=127.0.0.1:21;https=127.0.0.1:7891'), 'http://127.0.0.1:7891');
});

// ---- 多线程下载（本地纯函数）----
check('killTreeSync 传 0/null 不抛异常', () => {
  w.killTreeSync(0);
  w.killTreeSync(null);
  assert.ok(true);
});

check('camoufoxUrl 为 win-x86_64 zip（当前平台）', () => {
  const u = w.camoufoxUrl();
  assert.match(u, /^https:\/\/github\.com\/daijro\/camoufox\/releases\/download\/v135\.0\.1-beta\.24\/camoufox-135\.0\.1-beta\.24-(win|mac|lin)\.(x86_64|arm64)\.zip$/);
});

checkAsync('mergeParts 按序拼接分片并校验内容', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-mp-'));
  try {
    const p0 = path.join(dir, 'a.part0'), p1 = path.join(dir, 'a.part1');
    fs.writeFileSync(p0, 'HELLO ');
    fs.writeFileSync(p1, 'WORLD');
    await w.mergeParts([p0, p1], path.join(dir, 'a'));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'a'), 'utf8'), 'HELLO WORLD');
    assert.ok(fs.existsSync(path.join(dir, 'a.part0')), '分片保留（由调用方 parallelDownload 统一清理）');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 项目补丁（上游原版 → fox-ai 增强，幂等）----
checkAsync('patchWebAI2APIProject 注入跳过补丁且幂等', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-patch-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src', 'server', 'middlewares'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src', 'backend', 'engine'), { recursive: true });
    // 上游原版 launcher.js 关键片段（含指纹 screen 约束）
    fs.writeFileSync(path.join(dir, 'src', 'backend', 'engine', 'launcher.js'), `import { FingerprintGenerator } from 'fingerprint-generator';
async function getPersistentFingerprint(filePath) {
    const generatorOptions = {
        browsers: ['firefox'],
        operatingSystems: [currentOS],
        screen: { minWidth: 1280, maxWidth: 1366, minHeight: 720, maxHeight: 768 }
    };
    const generator = new FingerprintGenerator(generatorOptions);
    fingerprintData = generator.getFingerprint().fingerprint;
}
`, 'utf8');
    // 上游原版 package.json（playwright-core 用 ^ 范围）
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'webai-2api',
      version: '3.0.0',
      dependencies: {
        'camoufox-js': '^0.8.3',
        'playwright-core': '^1.57.0'
      }
    }, null, 2), 'utf8');
    // 上游原版 init.js 关键片段
    fs.writeFileSync(path.join(dir, 'scripts', 'init.js'), `import fs from 'fs';
async function installBetterSqlite3(platform, arch, abi, proxyUrl) {
    logger.info('初始化', '开始安装 better-sqlite3...');
    const url = getBetterSqlite3Url(platform, arch, abi);
    const downloadPath = path.join(TEMP_DIR, 'better-sqlite3.tar.gz');
    await downloadFile(url, downloadPath, proxyUrl);
}
async function installCamoufox(platform, arch, proxyUrl) {
    logger.info('初始化', '开始安装 Camoufox 浏览器...');
    const url = getCamoufoxUrl(platform, arch);
    const downloadPath = path.join(TEMP_DIR, 'camoufox.zip');
    await downloadFile(url, downloadPath, proxyUrl);
}
`, 'utf8');
    // 上游原版 config.example.yaml（默认 worker 适配器 lmarena）
    fs.writeFileSync(path.join(dir, 'config.example.yaml'), `server:
  port: 3000
pool:
  instances:
    - name: "browser_default"
      workers:
        - name: "default"
          type: lmarena              # 适配器类型
`, 'utf8');
    // 上游原版 auth.js
    fs.writeFileSync(path.join(dir, 'src', 'server', 'middlewares', 'auth.js'), `import { sendApiError } from '../respond.js';
import { ERROR_CODES } from '../errors.js';
export function checkAuth(req, authToken) {
    const authHeader = req.headers['authorization'];
    return authHeader === \`Bearer \${authToken}\`;
}
`, 'utf8');

    const logs = [];
    const log = (s) => logs.push(s);
    // 第一次：应注入
    assert.strictEqual(w.patchWebAI2APIProject(dir, log), true, '首次应发生改动');
    let init = fs.readFileSync(path.join(dir, 'scripts', 'init.js'), 'utf8');
    let auth = fs.readFileSync(path.join(dir, 'src', 'server', 'middlewares', 'auth.js'), 'utf8');
    assert.ok(init.includes('fox-ai:skip-if-ready'), 'init.js 应含补丁标记');
    assert.ok(init.includes('检测到已安装的 Camoufox'), 'init.js 应含 camoufox 跳过逻辑');
    assert.ok(init.includes('better-sqlite3 已安装，跳过下载'), 'init.js 应含 better-sqlite3 跳过逻辑');
    assert.ok(init.includes('async function installBetterSqlite3(platform, arch, abi, proxyUrl) {'), '锚点函数名不应被破坏');
    assert.ok(auth.includes('timingSafeEqual'), 'auth.js 应含 timingSafeEqual');
    assert.ok(auth.includes("import crypto from 'crypto';"), 'auth.js 应含 crypto import');
    const launcher = fs.readFileSync(path.join(dir, 'src', 'backend', 'engine', 'launcher.js'), 'utf8');
    assert.ok(launcher.includes('maxWidth: 1920'), 'launcher.js 指纹 screen 约束应被放宽到 1920');
    assert.ok(launcher.includes('fox-ai:skip-if-ready-screen'), 'launcher.js 应含幂等标记');
    assert.ok(!launcher.includes('maxWidth: 1366'), '旧约束 1366 应被替换');
    const pkg = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    assert.ok(pkg.includes('"playwright-core": "1.57.0"'), 'package.json 应锁定 playwright-core 1.57.0');
    assert.ok(!pkg.includes('"playwright-core": "^1.57.0"'), '^ 范围应被替换为精确版本');
    const example = fs.readFileSync(path.join(dir, 'config.example.yaml'), 'utf8');
    assert.ok(example.includes('type: deepseek_text'), 'config.example.yaml 默认适配器应改为 deepseek_text');
    assert.ok(!/(^\s*)type:\s*lmarena/m.test(example.replace(/^#.*$/gm, '')), '非注释的 type: lmarena 应被替换');
    // 第二次：幂等，不再改动
    assert.strictEqual(w.patchWebAI2APIProject(dir, log), false, '二次调用不应再改动');
    const init2 = fs.readFileSync(path.join(dir, 'scripts', 'init.js'), 'utf8');
    const markBefore = (init.match(/fox-ai:skip-if-ready/g) || []).length;
    const markAfter = (init2.match(/fox-ai:skip-if-ready/g) || []).length;
    assert.strictEqual(markAfter, markBefore, '标记数不应因重复调用而增加（' + markBefore + ' → ' + markAfter + '）');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// 等异步测试（checkAsync）全部 settle 后再汇总退出，避免 process.exit 提前掐掉
setTimeout(() => {
  console.log('\n' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
}, 1500);
