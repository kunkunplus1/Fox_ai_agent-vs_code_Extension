'use strict';

/*
 * src/webai2api.js — WebAI2API 下载与配置
 *
 * 把 WebAI2API（Camoufox 浏览器自动化服务，安全不易封）下载到用户指定目录，
 * 依次完成：环境检查 → 下载源码（git clone）→ 安装依赖（pnpm/npm）→
 * 初始化浏览器等预编译资源（npm run init，下载 Camoufox 浏览器）→ 生成鉴权密钥写 config.yaml。
 *
 * 全程支持：
 *   - 分阶段百分比进度（下载/初始化阶段解析真实百分比，其余阶段为阶段进度）
 *   - 中途停止（AbortController，Windows 用 taskkill /T /F 清理进程树）
 *   - 自定义安装位置
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const REPO_URL = 'https://github.com/foxhui/WebAI2API.git';
const REPO_NAME = 'WebAI2API';

// 阶段权重（整体 0-100）
const STAGES = [
  { key: 'preflight', label: '检查环境', weight: 3 },
  { key: 'download', label: '下载源码', weight: 17 },
  { key: 'deps', label: '安装依赖', weight: 30 },
  { key: 'init', label: '初始化浏览器等资源', weight: 45 },
  { key: 'config', label: '写入配置', weight: 5 }
];

function isWin() { return process.platform === 'win32'; }
const npmCmd = () => (isWin() ? 'npm.cmd' : 'npm');

/** 从命令混合输出中提取关键错误行（fatal/error/网络/目录冲突等），让失败信息透出真实原因而非只显示「退出码 N」 */
function extractErrorLines(buf) {
  const lines = String(buf || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const key = /fatal:|error:|could not|failed to|unable to|already exists|permission denied|connection|resolve host|timed out|refused|ECONN|TLS|denied|Recv failure|OpenSSL/i;
  const hits = lines.filter((l) => key.test(l));
  return (hits.length ? hits : lines.slice(-8)).slice(-12);
}
const pnpmCmd = () => (isWin() ? 'pnpm.cmd' : 'pnpm');

/** 生成与 WebAI2API genkey 相同格式的鉴权密钥：sk- + 48 位十六进制 */
function generateAuth() {
  return 'sk-' + crypto.randomBytes(24).toString('hex');
}

/** 探测 pnpm 是否可用（同步，带超时） */
function hasPnpm() {
  try {
    // 注意：Windows 上 pnpm 在 PATH 里是 pnpm.cmd，spawnSync 不带 shell 直接 exec .cmd 会抛 EINVAL，
    // 必须 shell:true 让它走 cmd.exe /c；pnpm 不存在时 r.status 非 0，自然返回 false。
    const r = spawnSync(pnpmCmd(), ['--version'], { shell: true, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    return r.status === 0 && /^\d/.test((r.stdout || '').trim());
  } catch (_) { return false; }
}

/** 终止进程树（Windows 用 taskkill /T /F；POSIX 杀进程组） */
function killTree(pid) {
  if (!pid) return;
  try {
    if (isWin()) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch (_) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    }
  } catch (_) { /* 清理失败不阻断 */ }
}

/** 同步终止进程树并等待完成（abort/宿主退出时确保子进程真正消失，避免后台残留继续写日志） */
function killTreeSync(pid) {
  if (!pid) return;
  try {
    if (isWin()) {
      // taskkill /T 递归杀整棵进程树；/F 强制。spawnSync 阻塞等待执行完成。
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch (_) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    }
  } catch (_) { /* 清理失败不阻断 */ }
}

/** 比较语义化版本号 a/b（字符串），返回 -1/0/1 */
function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** 直接 exec node 可执行文件取版本（avoid 走 shell，更快更准） */
function nodeVersion(exe) {
  try {
    const r = spawnSync(exe, ['--version'], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 8000 });
    return (r.stdout || '').trim().replace(/^v/, '');
  } catch (_) { return null; }
}

/**
 * 选择最适合跑 WebAI2API 的 Node：仅从环境变量 PATH 中探测（不扫描任何固定目录）。
 * 优先 PATH 中 < 23 的 Node（LTS，better-sqlite3 等原生模块有预编译，无需本地 C++ 编译）；
 * 其次回退 PATH 中任意 Node（可能需 VS 编译，由调用方给警告）。
 * 返回 { dir, version } 或 null。
 */
function findBestNode() {
  const envPath = (process.env.PATH || '').split(path.delimiter);
  // 1) 优先 PATH 中 < 23 的 Node（LTS，原生模块预编译友好，无需 VS）
  for (const p of envPath) {
    const exe = path.join(p, isWin() ? 'node.exe' : 'node');
    if (fs.existsSync(exe)) {
      const v = nodeVersion(exe);
      if (v && cmpVer(v, '23.0.0') < 0) return { dir: p, version: v };
    }
  }
  // 2) 回退 PATH 中任意 Node（可能需 VS 编译，调用方给警告）
  for (const p of envPath) {
    const exe = path.join(p, isWin() ? 'node.exe' : 'node');
    if (fs.existsSync(exe)) return { dir: p, version: nodeVersion(exe) };
  }
  return null;
}

// ---- 自动下载 Node LTS（PATH 中无合适 Node 时兜底）----

/** 当前平台的 Node 发布归档子名，如 win-x64 / darwin-arm64 / linux-x64 */
function platformArch() {
  const p = process.platform, a = process.arch;
  if (p === 'win32') return 'win-x64';
  if (p === 'darwin') return a === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (p === 'linux') return a === 'arm64' ? 'linux-arm64' : 'linux-x64';
  return `${p}-${a}`;
}

/** 扫描已下载缓存目录 ~/.fox-ai/node，返回 { dir, version } 或 null */
function findCachedNode() {
  try {
    const base = path.join(os.homedir(), '.fox-ai', 'node');
    if (!fs.existsSync(base)) return null;
    const dirs = fs.readdirSync(base).filter((v) => /^v\d+\.\d+\.\d+$/.test(v));
    if (!dirs.length) return null;
    const pick = dirs.find((v) => v.startsWith('v22.') || v.startsWith('v20.') || v.startsWith('v18.')) || dirs[dirs.length - 1];
    const sub = isWin() ? `node-${pick}-win-x64` : `node-${pick}-${platformArch()}`;
    const dir = path.join(base, pick, sub);
    const exe = path.join(dir, isWin() ? 'node.exe' : 'node');
    if (fs.existsSync(exe)) return { dir, version: pick };
  } catch (_) {}
  return null;
}

/** 取 Node 官网最新指定大版本的 LTS 版本号（如 v22.14.0） */
function fetchLatestLTS(major, signal) {
  return new Promise((resolve, reject) => {
    const req = https.get('https://nodejs.org/dist/index.json', { timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('获取 Node 版本列表失败（HTTP ' + res.statusCode + '）')); }
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try {
          const arr = JSON.parse(data);
          const prefix = 'v' + major + '.';
          const hit = arr.find((x) => x.lts && String(x.version).startsWith(prefix));
          if (!hit) return reject(new Error('未找到 Node ' + major + ' LTS 版本'));
          resolve(hit.version);
        } catch (e) { reject(new Error('解析 Node 版本列表失败：' + e.message)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('获取 Node 版本列表超时')));
    req.on('error', (e) => reject(e));
    if (signal) signal.addEventListener('abort', () => req.destroy(new Error('已取消')));
  });
}

/** 下载文件并回调进度（0-1），自动跟随重定向 */
function downloadFile(url, dest, opts = {}) {
  const { onProgress, signal, timeout = 60000 } = opts;
  return new Promise((resolve, reject) => {
    const get = (u, redirects) => {
      if (redirects > 5) return reject(new Error('下载重定向过多'));
      const req = https.get(u, { timeout }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return get(new URL(res.headers.location, u).href, redirects + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('下载 Node 失败（HTTP ' + res.statusCode + '）：' + u)); }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let got = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (d) => { got += d.length; if (total && onProgress) onProgress(got / total); });
        res.pipe(out);
        out.on('finish', () => resolve());
        out.on('error', (e) => { try { fs.rmSync(dest, { force: true }); } catch (_) {} reject(e); });
      });
      req.on('timeout', () => req.destroy(new Error('下载 Node 超时')));
      req.on('error', (e) => reject(e));
      if (signal) signal.addEventListener('abort', () => req.destroy(new Error('已取消')));
    };
    get(url, 0);
  });
}

// ---- 多线程分段下载（Range 并发 + 分片断点续传 + 完整性校验） ----

/** 带重定向跟随的 GET，把最终响应交给 handler(res)；保留 Range 等请求头（重定向时需原样透传） */
function httpsGetFollow(u, headers, handler, signal, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('重定向过多'));
    const req = https.get(u, { headers, timeout: 60000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return httpsGetFollow(new URL(res.headers.location, u).href, headers, handler, signal, redirects + 1).then(resolve, reject);
      }
      handler(res).then(resolve, reject);
    });
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) req.destroy(new Error('已取消'));
      else signal.addEventListener('abort', () => req.destroy(new Error('已取消')), { once: true });
    }
  });
}

/** 探测：Range: bytes=0-0 拿总大小与 Range 支持度（GitHub CDN 均支持） */
function probeRange(url, signal) {
  return httpsGetFollow(url, { Range: 'bytes=0-0', 'Accept-Encoding': 'identity', 'User-Agent': 'Mozilla/5.0' }, (res) => {
    const cr = res.headers['content-range'] || '';
    const m = /\/(\d+)\s*$/.exec(cr);
    const total = m ? parseInt(m[1], 10) : parseInt(res.headers['content-length'] || '0', 10);
    const rangeOk = res.statusCode === 206 && !!m;
    res.resume();
    return Promise.resolve({ total, rangeOk });
  }, signal);
}

/** 下载单个分片（断点续传：分片文件已完整则直接跳过；每片最多重试 3 次） */
function downloadRange(url, part, signal, idleTimeout) {
  const segLen = part.end - part.start + 1;
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      if (fs.existsSync(part.file) && fs.statSync(part.file).size === segLen) return resolve();
      try { fs.rmSync(part.file, { force: true }); } catch (_) {}
      const headers = { Range: 'bytes=' + part.start + '-' + part.end, 'Accept-Encoding': 'identity', 'User-Agent': 'Mozilla/5.0' };
      httpsGetFollow(url, headers, (res) => new Promise((res2, rej2) => {
        if (res.statusCode === 200) { res.resume(); return rej2(new Error('服务器不支持 Range，无法分段')); }
        if (res.statusCode !== 206) { res.resume(); return rej2(new Error('HTTP ' + res.statusCode)); }
        const out = fs.createWriteStream(part.file);
        let lastData = Date.now();
        const idle = setInterval(() => {
          if (!res.readableEnded && Date.now() - lastData > idleTimeout) {
            try { res.destroy(new Error('分片 ' + part.i + ' 无数据传输超时')); } catch (_) {}
          }
        }, 30000);
        res.on('data', () => { lastData = Date.now(); });
        res.pipe(out);
        out.on('finish', () => { clearInterval(idle); res2(); });
        out.on('error', (e) => { clearInterval(idle); rej2(e); });
      }), signal).then(() => {
        if (fs.existsSync(part.file) && fs.statSync(part.file).size === segLen) return resolve();
        reject(new Error('分片 ' + part.i + ' 大小不符'));
      }).catch((e) => {
        if (n >= 3) return reject(e);
        setTimeout(() => attempt(n + 1), 1500);
      });
    };
    attempt(1);
  });
}

/** 按顺序流式合并分片文件到 dest（先删旧 dest） */
function mergeParts(partFiles, dest) {
  return new Promise((resolve, reject) => {
    try { fs.rmSync(dest, { force: true }); } catch (_) {}
    const out = fs.createWriteStream(dest);
    const next = (i) => {
      if (i >= partFiles.length) return out.end(() => resolve());
      const r = fs.createReadStream(partFiles[i]);
      r.on('error', (e) => { try { out.destroy(); } catch (_) {} reject(e); });
      r.on('end', () => next(i + 1));
      r.pipe(out, { end: false });
    };
    out.on('error', reject);
    next(0);
  });
}

/**
 * 多线程分段下载（安全）：Range 并发抓取 → 分片断点续传（已完整分片跳过）→ 逐片重试 →
 * 按序合并 → 总字节数校验（不符即删重）。服务器不支持 Range / 文件太小则自动回退单连接 downloadFile。
 * opts: { connections=8, minChunk=2MB, onProgress(p 0-1), signal, idleTimeout=180s }
 */
function parallelDownload(url, dest, opts = {}) {
  const { connections = 8, minChunk = 2 * 1024 * 1024, onProgress, signal, idleTimeout = 180000 } = opts;
  const prog = onProgress || (() => {});
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('已取消'));
    let cancelled = false;
    const onAbort = () => { cancelled = true; };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const cleanupParts = () => {
      try {
        const dir = path.dirname(dest);
        if (!fs.existsSync(dir)) return;
        const base = path.basename(dest);
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith(base + '.part')) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch (_) {} }
        }
      } catch (_) {}
    };
    probeRange(url, signal).then(({ total, rangeOk }) => {
      if (cancelled) return reject(new Error('已取消'));
      if (!rangeOk || total <= 0 || total < minChunk) {
        return downloadFile(url, dest, { onProgress: prog, signal, timeout: 120000 }).then(resolve, reject);
      }
      const n = Math.max(1, Math.min(connections, Math.ceil(total / minChunk)));
      const size = Math.ceil(total / n);
      const parts = [];
      for (let i = 0; i < n; i++) {
        parts.push({ i, start: i * size, end: Math.min(total, (i + 1) * size) - 1, file: dest + '.part' + i });
      }
      const sumDone = () => parts.reduce((a, p) => a + (fs.existsSync(p.file) ? fs.statSync(p.file).size : 0), 0);
      const jobs = parts.map((p) => downloadRange(url, p, signal, idleTimeout));
      const timer = setInterval(() => { if (total && !cancelled) prog(Math.min(1, sumDone() / total)); }, 500);
      Promise.all(jobs).then(async () => {
        clearInterval(timer);
        if (cancelled) throw new Error('已取消');
        await mergeParts(parts.map((p) => p.file), dest);
        const sz = fs.statSync(dest).size;
        if (sz !== total) throw new Error('下载不完整: 预期 ' + total + ' 字节, 实际 ' + sz);
        cleanupParts();
        if (signal) signal.removeEventListener('abort', onAbort);
        prog(1);
        resolve();
      }).catch((e) => {
        clearInterval(timer);
        cleanupParts();
        try { fs.rmSync(dest, { force: true }); } catch (_) {}
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(e);
      });
    }).catch((e) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(e);
    });
  });
}

/** Camoufox 下载地址（当前固定版本） */
function camoufoxUrl() {
  const v = '135.0.1-beta.24';
  const p = os.platform() === 'win32' ? 'win' : os.platform() === 'darwin' ? 'mac' : 'lin';
  const a = os.arch() === 'arm64' ? 'arm64' : 'x86_64';
  return `https://github.com/daijro/camoufox/releases/download/v${v}/camoufox-${v}-${p}.${a}.zip`;
}

/** 直连模式下的多线程预下载：Camoufox（505MB）与 GeoLite 库。
 * 1.1.40 升级：下载 zip 后自行解压到 camoufox/ 并写 version.json，
 * 保证「任何来源的 init.js」（含上游原版、未手动改过）都能识别已就绪状态，
 * 不再依赖用户手动修改项目文件——所有用户点「下载并配置」效果一致。 */
async function preDownloadBigFiles(projectDir, log, report, signal) {
  const camDir = path.join(projectDir, 'camoufox');
  const tempDir = path.join(projectDir, 'data', 'temp');
  fs.mkdirSync(tempDir, { recursive: true });
  const hasExe = fs.existsSync(camDir) && fs.readdirSync(camDir).some((f) => f.endsWith('.exe'));
  const zipPath = path.join(tempDir, 'camoufox.zip');
  if (!hasExe) {
    if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size < 100 * 1024 * 1024) {
      log('🔧 直连模式：多线程分段预下载 Camoufox 浏览器（约 505MB，8 连接加速）…');
      await parallelDownload(camoufoxUrl(), zipPath, { connections: 8, onProgress: (p) => report(p * 0.8), signal });
    }
    // 自行解压 + 补 version.json：上游原版 init.js 也能识别「已就绪」，无需用户手动改文件
    fs.mkdirSync(camDir, { recursive: true });
    log('🔧 解压 Camoufox（约 1-2 分钟）…');
    report(0.8);
    try {
      await extractArchive(zipPath, camDir);
      fs.writeFileSync(path.join(camDir, 'version.json'), JSON.stringify({ version: '135.0', release: 'beta.24' }, null, 2), 'utf8');
      log('Camoufox 解压完成，init 将跳过下载');
      try { fs.rmSync(zipPath, { force: true }); } catch (_) {}
    } catch (e) {
      log('⚠️ 自动解压失败：' + (e && e.message || e) + '。保留 zip 交由 init 兜底（若已注入跳过补丁则直接解压，否则原版会重下）');
    }
  }
  const mmdb = path.join(camDir, 'GeoLite2-City.mmdb');
  if (!fs.existsSync(mmdb)) {
    fs.mkdirSync(camDir, { recursive: true });
    log('🔧 多线程预下载 GeoLite2-City.mmdb（IP 定位库）…');
    await parallelDownload('https://github.com/P3TERX/GeoLite.mmdb/releases/latest/download/GeoLite2-City.mmdb', mmdb, { connections: 6, onProgress: (p) => report(0.85 + p * 0.15), signal });
  }
}

/** 幂等补丁标记：文件内出现即视为已打过补丁 */
const FX_PATCH_MARK = 'fox-ai:skip-if-ready';

/**
 * 给 WebAI2API 项目注入「已就绪跳过下载」补丁（1.1.40，幂等、可重复执行）。
 * 目的：其他用户 clone 到的上游原版 init.js 不认识 fox-ai 多线程预下载的产物，
 * 会把已下好的 zip 覆盖重下 505MB。fox-ai 在跑 init 前自动打补丁，效果对所有用户一致：
 * - scripts/init.js：installBetterSqlite3 已装则跳过；installCamoufox 已就绪（有可执行文件）则跳过下载与解压
 * - src/server/middlewares/auth.js：token 比较改为 crypto.timingSafeEqual（防时序侧信道）
 * 锚点找不到（上游大改）则静默跳过，绝不阻断主流程。
 * @returns {boolean} 是否发生了改动
 */
function patchWebAI2APIProject(projectDir, log) {
  const initPath = path.join(projectDir, 'scripts', 'init.js');
  const authPath = path.join(projectDir, 'src', 'server', 'middlewares', 'auth.js');
  let changed = false;

  // ---- init.js：已就绪则跳过下载 ----
  if (fs.existsSync(initPath)) {
    try {
      let src = fs.readFileSync(initPath, 'utf8');
      if (!src.includes(FX_PATCH_MARK)) {
        let next = src;
        const sqliteAnchor = 'async function installBetterSqlite3(platform, arch, abi, proxyUrl) {';
        if (next.includes(sqliteAnchor) && !next.includes('better-sqlite3 已安装，跳过下载')) {
          const inject = `    // ${FX_PATCH_MARK}：better-sqlite3 已安装则跳过（避免重复下载预编译产物）
    const _fxBuilt = path.join(PROJECT_ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    if (fs.existsSync(_fxBuilt)) {
        logger.info('初始化', \`better-sqlite3 已安装，跳过下载（\${_fxBuilt}）\`);
        return;
    }
`;
          next = next.replace(sqliteAnchor, sqliteAnchor + '\n' + inject);
        }
        const camAnchor = 'async function installCamoufox(platform, arch, proxyUrl) {';
        if (next.includes(camAnchor) && !next.includes('检测到已安装的 Camoufox')) {
          const inject = `    // ${FX_PATCH_MARK}：camoufox 已就绪（目录里有可执行文件）则跳过下载与解压
    const _fxCamDir = path.join(PROJECT_ROOT, 'camoufox');
    let _fxHasBinary = false;
    try {
        if (fs.existsSync(_fxCamDir)) {
            _fxHasBinary = fs.readdirSync(_fxCamDir).some((f) => f.endsWith('.exe') || f === 'camoufox' || f.endsWith('.app'));
        }
    } catch (e) { }
    if (_fxHasBinary) {
        logger.info('初始化', \`检测到已安装的 Camoufox（\${_fxCamDir}），跳过下载与解压\`);
        const _fxV = path.join(_fxCamDir, 'version.json');
        if (!fs.existsSync(_fxV)) {
            fs.writeFileSync(_fxV, JSON.stringify({ version: '135.0', release: 'beta.24' }, null, 2), 'utf8');
            logger.info('初始化', \`已补写 version.json: \${_fxV}\`);
        }
        return;
    }
`;
          next = next.replace(camAnchor, camAnchor + '\n' + inject);
        }
        if (next !== src) {
          fs.writeFileSync(initPath, next, 'utf8');
          changed = true;
          log('已为 scripts/init.js 注入「已就绪跳过下载」补丁（幂等；重新 clone 会自动重打）');
        }
      }
    } catch (e) { log('⚠️ 补丁 init.js 失败（忽略）：' + e.message); }
  }

  // ---- auth.js：timingSafeEqual 防时序攻击 ----
  if (fs.existsSync(authPath)) {
    try {
      let src = fs.readFileSync(authPath, 'utf8');
      if (!src.includes('timingSafeEqual')) {
        let next = src;
        if (!/import crypto from 'crypto'/.test(next)) {
          next = next.replace(/import\s+[^;]+;/, "import crypto from 'crypto';\n$&");
        }
        const oldCheck = 'return authHeader === `Bearer ${authToken}`;';
        if (next.includes(oldCheck)) {
          const newCheck = `const expected = \`Bearer \${authToken}\`;
    const _a = Buffer.from(String(authHeader || ''), 'utf8');
    const _b = Buffer.from(expected, 'utf8');
    if (_a.length !== _b.length) return false;
    return crypto.timingSafeEqual(_a, _b);`;
          next = next.replace(oldCheck, newCheck);
          fs.writeFileSync(authPath, next, 'utf8');
          changed = true;
          log('已为 src/server/middlewares/auth.js 注入 timingSafeEqual 鉴权加固补丁（幂等）');
        }
      }
    } catch (e) { log('⚠️ 补丁 auth.js 失败（忽略）：' + e.message); }
  }

  // ---- launcher.js：放宽指纹 screen 约束（1.1.43） ----
  // fingerprint-generator@2.1.78 + generative-bayesian-network@2.1.88 的联合约束采样
  // 在「宽高双限 1280-1366×720-768」下 10 次必失败（Failed to generate a consistent fingerprint），
  // 导致浏览器初始化失败、服务进入安全模式（OpenAI API 不可用）。放宽到 1280-1920×720-1080 后稳定。
  const launcherPath = path.join(projectDir, 'src', 'backend', 'engine', 'launcher.js');
  const screenMark = FX_PATCH_MARK + '-screen';
  if (fs.existsSync(launcherPath)) {
    try {
      let src = fs.readFileSync(launcherPath, 'utf8');
      if (!src.includes(screenMark)) {
        const oldScreen = 'screen: { minWidth: 1280, maxWidth: 1366, minHeight: 720, maxHeight: 768 }';
        if (src.includes(oldScreen)) {
          const newScreen = 'screen: { minWidth: 1280, maxWidth: 1920, minHeight: 720, maxHeight: 1080 } // ' + screenMark + '：放宽屏幕约束，规避 fingerprint-generator 2.1.78 联合采样 bug';
          src = src.replace(oldScreen, newScreen);
          fs.writeFileSync(launcherPath, src, 'utf8');
          changed = true;
          log('已为 launcher.js 注入指纹 screen 约束修复补丁（幂等；规避「Failed to generate a consistent fingerprint」）');
        }
      }
    } catch (e) { log('⚠️ 补丁 launcher.js 失败（忽略）：' + e.message); }
  }

  // ---- package.json：锁定 playwright-core 精确版本（1.1.44） ----
  // 上游声明 "playwright-core": "^1.57.0"，npm install 会装最新版（如 1.62.1），其
  // Browser.setDefaultViewport 参数含 isMobile，Camoufox 135 内置 Juggler 协议不识别 →
  // 浏览器初始化失败（Protocol error: Found property "<root>.viewport.isMobile"...）。
  // 锁定为 pnpm-lock 的 1.57.0（必须在 npm install 之前执行，setup 的 deps 阶段已提前调用）。
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      let src = fs.readFileSync(pkgPath, 'utf8');
      const pin = '"playwright-core": "1.57.0"';
      if (!src.includes(pin)) {
        const next = src.replace(/"playwright-core"\s*:\s*"\^1\.57\.0"/, pin);
        if (next !== src) {
          fs.writeFileSync(pkgPath, next, 'utf8');
          changed = true;
          log('已锁定 package.json 的 playwright-core 为 1.57.0（规避新版与 Camoufox Juggler 协议不兼容）');
        }
      }
    } catch (e) { log('⚠️ 补丁 package.json 失败（忽略）：' + e.message); }
  }

  // ---- config.example.yaml：默认适配器 lmarena → deepseek_text（1.1.46） ----
  // LMArena(arena.ai) 常被 Cloudflare 拦截（HTTP 403），上游默认 worker type 是 lmarena；
  // 改为 deepseek_text 作为默认，新用户「下载并配置」后即可直接用 DeepSeek。
  const examplePath = path.join(projectDir, 'config.example.yaml');
  const dsMark = FX_PATCH_MARK + '-deepseek';
  if (fs.existsSync(examplePath)) {
    try {
      let src = fs.readFileSync(examplePath, 'utf8');
      if (!src.includes(dsMark)) {
        const next = src.replace(/^(\s*)type:\s*lmarena(\s*#.*)?$/m, '$1type: deepseek_text        # 适配器类型 (' + dsMark + '：默认 DeepSeek，LMArena 常被 Cloudflare 403)');
        if (next !== src) {
          fs.writeFileSync(examplePath, next, 'utf8');
          changed = true;
          log('已将 config.example.yaml 默认适配器改为 deepseek_text（避免 LMArena 403）');
        }
      }
    } catch (e) { log('⚠️ 补丁 config.example.yaml 失败（忽略）：' + e.message); }
  }

  // ---- deepseek_text.js：复用当前对话而非每次 New chat（1.1.47） ----
  // 适配器原本每次 generate() 都 goto(主页) → 触发 DeepSeek 新对话 → 上下文全断，
  // fox-ai 在同一个对话连续对话时变成独立短消息。改为：先试在当前页面找输入框直接发，
  // 找不到（首次启动/页面被导航走）才 goto 主页兜底。DeepSeek 首次发消息后 URL 变为
  // /a/chat/s/{sid} 并保持，后续同对话继续即可。
  const dsAdapterPath = path.join(projectDir, 'src', 'backend', 'adapter', 'deepseek_text.js');
  const dsReuseMark = FX_PATCH_MARK + '-deepseek-reuse';
  if (fs.existsSync(dsAdapterPath)) {
    try {
      let src = fs.readFileSync(dsAdapterPath, 'utf8');
      if (!src.includes(dsReuseMark)) {
        const anchor = '        await gotoWithCheck(page, TARGET_URL);\n\n        // 1. 等待输入框加载\n        await waitForInput(page, INPUT_SELECTOR, { click: false });';
        if (src.includes(anchor)) {
          const patched = `        // ${dsReuseMark}：复用当前对话而非每次 New chat（修复上下文断裂）
        try {
            await waitForInput(page, INPUT_SELECTOR, { click: false, timeout: 5000 });
        } catch (_e) {
            // 首次启动或页面被导航走：兜底 goto 主页
            logger.info('适配器', '首次或页面失效，重新导航到 DeepSeek 主页...', meta);
            await gotoWithCheck(page, TARGET_URL);
            await waitForInput(page, INPUT_SELECTOR, { click: false });
        }`;
          src = src.replace(anchor, patched);
          fs.writeFileSync(dsAdapterPath, src, 'utf8');
          changed = true;
          log('已为 deepseek_text 适配器注入「复用当前对话」补丁（修复上下文断裂）');
        }
      }
    } catch (e) { log('⚠️ 补丁 deepseek_text.js 失败（忽略）：' + e.message); }
  }

  // ---- deepseek_text.js：接收 fox-ai 新建会话信号，点击「新对话」重置浏览器会话（1.1.48） ----
  // fox-ai 在「新建会话」后的首条消息里携带 fox_new_session=true（经 routes/queue 透传到 meta.foxNewSession）。
  // 适配器读到该标记时，先点 DeepSeek 的「新对话」按钮，使 WebAI2API 浏览器侧会话与 fox-ai 同步归零，
  // 避免 fox-ai 已开新会话、Web 侧却还停留在上一轮对话的错位。锚点用「1.5 切换模式」注释，
  // 该注释在「复用当前对话」补丁前后都存在，故两种版本均可注入。
  const dsNewSessionMark = FX_PATCH_MARK + '-deepseek-newsession';
  if (fs.existsSync(dsAdapterPath)) {
    try {
      let src = fs.readFileSync(dsAdapterPath, 'utf8');
      if (!src.includes(dsNewSessionMark)) {
        const anchor = '        // 1.5 切换基础/专业模式 (Instant / Expert)';
        const inject = `        // ${dsNewSessionMark}：fox-ai 新建会话信号 → 点击 DeepSeek「新对话」重置浏览器会话
        if (meta && meta.foxNewSession) {
          try {
            const _newBtn = page.getByRole('button', { name: /new chat|new conversation|新对话|新建对话/i });
            if (await _newBtn.count() > 0) {
              await safeClick(page, _newBtn.first(), { bias: 'button' });
              await sleep(400, 700);
              await waitForInput(page, INPUT_SELECTOR, { click: false });
              logger.info('适配器', '已开启新对话（fox_new_session）', meta);
            } else {
              logger.debug('适配器', '未找到「新对话」按钮，跳过重置', meta);
            }
          } catch (e) {
            logger.warn('适配器', '新对话按钮点击失败（忽略）：' + e.message, meta);
          }
        }

${anchor}`;
        if (src.includes(anchor)) {
          src = src.replace(anchor, inject);
          fs.writeFileSync(dsAdapterPath, src, 'utf8');
          changed = true;
          log('已为 deepseek_text 适配器注入「新建会话重置」补丁（fox_new_session）');
        }
      }
    } catch (e) { log('⚠️ 补丁 deepseek_text.js(newsession) 失败（忽略）：' + e.message); }
  }

  // ---- routes.js：把请求体里的 fox_new_session 透传到任务队列（1.1.48） ----
  const routesPath = path.join(projectDir, 'src', 'server', 'api', 'openai', 'routes.js');
  const rtMark = FX_PATCH_MARK + '-routes-newsession';
  if (fs.existsSync(routesPath)) {
    try {
      let src = fs.readFileSync(routesPath, 'utf8');
      if (!src.includes(rtMark)) {
        const anchor = '                reasoning\n            });';
        const inject = `                reasoning,\n                foxNewSession: data.fox_new_session === true // ${rtMark}\n            });`;
        if (src.includes(anchor)) {
          src = src.replace(anchor, inject);
          fs.writeFileSync(routesPath, src, 'utf8');
          changed = true;
          log('已为 routes.js 注入 fox_new_session 透传');
        }
      }
    } catch (e) { log('⚠️ 补丁 routes.js 失败（忽略）：' + e.message); }
  }

  // ---- queue.js：把任务里的 foxNewSession 透传到 generate 的 meta（1.1.48） ----
  const queuePath = path.join(projectDir, 'src', 'server', 'queue.js');
  const qMark = FX_PATCH_MARK + '-queue-newsession';
  if (fs.existsSync(queuePath)) {
    try {
      let src = fs.readFileSync(queuePath, 'utf8');
      if (!src.includes(qMark)) {
        let patched = src;
        // 1) 解构任务时取出 foxNewSession
        const dAnchor = 'const { res, prompt, imagePaths, modelId, modelName, id, isStreaming, reasoning } = task;';
        const dInject = `const { res, prompt, imagePaths, modelId, modelName, id, isStreaming, reasoning, foxNewSession } = task; // ${qMark}`;
        if (patched.includes(dAnchor)) patched = patched.replace(dAnchor, dInject);
        // 2) 传给 adapter.generate 的 meta 带上 foxNewSession
        const gAnchor = 'await generate(poolContext, prompt, imagePaths, modelId, { id, reasoning });';
        const gInject = `await generate(poolContext, prompt, imagePaths, modelId, { id, reasoning, foxNewSession }); // ${qMark}`;
        if (patched.includes(gAnchor)) patched = patched.replace(gAnchor, gInject);
        if (patched !== src) {
          fs.writeFileSync(queuePath, patched, 'utf8');
          changed = true;
          log('已为 queue.js 注入 foxNewSession 透传');
        }
      }
    } catch (e) { log('⚠️ 补丁 queue.js 失败（忽略）：' + e.message); }
  }

  // ---- routes.js：补 fox_isolate 透传（审查隔离标签页信号，1.1.19） ----
  // 在已有 foxNewSession 透传基础上增加 foxIsolate，让审查请求能开临时标签页而不切换主会话。
  // 兼容两种上游形态：① 变量声明（const foxNewSession = ...）② 对象属性（foxNewSession: ...）。
  const rtIsoMark = FX_PATCH_MARK + '-routes-isolate';
  if (fs.existsSync(routesPath)) {
    try {
      let src = fs.readFileSync(routesPath, 'utf8');
      if (!src.includes(rtIsoMark) && src.includes('foxNewSession')) {
        // ① 变量声明形态：const foxNewSession = data.fox_new_session === true;
        if (src.includes('const foxNewSession = data.fox_new_session === true;')) {
          src = src.replace(
            'const foxNewSession = data.fox_new_session === true;',
            'const foxNewSession = data.fox_new_session === true;\n            const foxIsolate = data.fox_isolate === true; // ' + rtIsoMark
          );
        }
        // ② 对象属性形态：foxNewSession: data.fox_new_session === true
        else if (src.includes('foxNewSession: data.fox_new_session === true')) {
          src = src.replace(
            'foxNewSession: data.fox_new_session === true',
            'foxNewSession: data.fox_new_session === true,\n                foxIsolate: data.fox_isolate === true // ' + rtIsoMark
          );
        }
        // addTask 透传：把 addTask 块里的 foxNewSession 后补 foxIsolate（只在 addTask 块缺失时补）
        const taskBlock = src.slice(src.lastIndexOf('queueManager.addTask'), src.indexOf('});', src.lastIndexOf('queueManager.addTask')) + 3);
        if (!taskBlock.includes('foxIsolate')) {
          const tAnchor1 = 'foxNewSession\n            });';
          if (src.includes(tAnchor1)) src = src.replace(tAnchor1, 'foxNewSession,\n                foxIsolate\n            });');
          const tAnchor2 = 'foxNewSession,\n            });';
          if (src.includes(tAnchor2)) src = src.replace(tAnchor2, 'foxNewSession,\n                foxIsolate\n            });');
        }
        fs.writeFileSync(routesPath, src, 'utf8');
        changed = true;
        log('已为 routes.js 注入 fox_isolate 透传（审查隔离标签页）');
      }
    } catch (e) { log('⚠️ 补丁 routes.js(fox_isolate) 失败（忽略）：' + e.message); }
  }

  // ---- queue.js：补 foxIsolate 透传（1.1.19） ----
  const qIsoMark = FX_PATCH_MARK + '-queue-isolate';
  if (fs.existsSync(queuePath)) {
    try {
      let src = fs.readFileSync(queuePath, 'utf8');
      if (!src.includes(qIsoMark) && src.includes('foxNewSession')) {
        // 1) 解构任务时取出 foxIsolate
        src = src.replace(
          /const \{ res, prompt, imagePaths, modelId, modelName, id, isStreaming, reasoning, foxNewSession \} = task;/,
          'const { res, prompt, imagePaths, modelId, modelName, id, isStreaming, reasoning, foxNewSession, foxIsolate } = task; // ' + qIsoMark
        );
        // 2) 传给 generate 的 meta 带上 foxIsolate
        src = src.replace(
          /await generate\(poolContext, prompt, imagePaths, modelId, \{ id, reasoning, foxNewSession \}\)/,
          'await generate(poolContext, prompt, imagePaths, modelId, { id, reasoning, foxNewSession, foxIsolate }); // ' + qIsoMark
        );
        fs.writeFileSync(queuePath, src, 'utf8');
        changed = true;
        log('已为 queue.js 注入 foxIsolate 透传（审查隔离标签页）');
      }
    } catch (e) { log('⚠️ 补丁 queue.js(fox_isolate) 失败（忽略）：' + e.message); }
  }

  // ---- Worker.js：隔离任务开临时标签页执行，审完关闭回主会话（1.1.19，方案C） ----
  // fox-ai 审查子代理请求带 fox_isolate=true 时，不点「新对话」（会切走主会话、审完回不来），
  // 而是开一个临时标签页跑审查、结束后自动关闭 —— 主对话标签页始终不动，所有模型网址通用。
  const workerPath = path.join(projectDir, 'src', 'backend', 'pool', 'Worker.js');
  const wIsoMark = FX_PATCH_MARK + '-isolate-tab';
  if (fs.existsSync(workerPath)) {
    try {
      let src = fs.readFileSync(workerPath, 'utf8');
      if (!src.includes(wIsoMark)) {
        const anchor = 'const adapter = registry.getAdapter(type);';
        const inject = `        const adapter = registry.getAdapter(type);
        if (!adapter) {
            return { error: \`适配器不存在: \${type}\` };
        }

        // ${wIsoMark}：隔离任务（fox-ai 审查子代理）→ 开临时标签页执行，不切换主会话，审完自动关闭
        let _isolatePage = null;
        let _isolateNavHandler = null;
        if (meta && meta.foxIsolate && this.browser) {
            try {
                logger.info('工作池', \`[\${this.name}] 隔离任务：开临时标签页执行（审查专用，不切换主会话）\`, meta);
                _isolatePage = await this.browser.newPage();
                _isolatePage.authState = this.page?.authState ? Object.assign({}, this.page.authState) : { isHandlingAuth: false };
                _isolatePage._browserMutex = this._browserMutex;
                const hcm = this.globalConfig?.browser?.humanizeCursor;
                _isolatePage._humanizeCursorMode = hcm;
                if (hcm === true) _isolatePage.cursor = createCursor(_isolatePage);
                if (this._navigationHandler) {
                    _isolateNavHandler = this._navigationHandler;
                    _isolatePage.on('framenavigated', async () => {
                        try { await _isolateNavHandler(_isolatePage); } catch (e) { /* ignore */ }
                    });
                }
                const _isoUrl = registry.getTargetUrl ? registry.getTargetUrl(type, this.globalConfig, this.workerConfig) : (this._targetUrl || 'about:blank');
                try {
                    await tryGotoWithCheck(_isolatePage, _isoUrl, { timeout: 60000 });
                } catch (e) {
                    logger.warn('工作池', \`[\${this.name}] 隔离页导航失败（忽略，交给适配器自愈）: \${e.message}\`, meta);
                }
            } catch (e) {
                logger.warn('工作池', \`[\${this.name}] 隔离标签页创建失败，回退主页面: \${e.message}\`, meta);
                _isolatePage = null;
            }
        }`;
        if (src.includes(anchor)) {
          src = src.replace(anchor, inject);
          // subContext 用隔离页 || 主页
          const ctxAnchor = 'page: this.page,';
          const ctxInject = 'page: _isolatePage || this.page,';
          if (src.includes(ctxAnchor)) src = src.replace(ctxAnchor, ctxInject);
          // finally 里关闭隔离页
          const finAnchor = '        } finally {\n            this.busyCount--;\n        }';
          const finInject = `        } finally {
            this.busyCount--;
            if (_isolatePage) {
                try {
                    await _isolatePage.close().catch(() => {});
                    logger.info('工作池', \`[\${this.name}] 隔离任务完成，已关闭临时标签页回到主会话\`, meta);
                } catch (e) {
                    logger.debug('工作池', \`[\${this.name}] 隔离标签页关闭失败（忽略）: \${e.message}\`, meta);
                }
                _isolatePage = null;
            }
        }`;
          if (src.includes(finAnchor)) src = src.replace(finAnchor, finInject);
          fs.writeFileSync(workerPath, src, 'utf8');
          changed = true;
          log('已为 Worker.js 注入「隔离标签页」补丁（审查不切换主会话，方案C）');
        }
      }
    } catch (e) { log('⚠️ 补丁 Worker.js 失败（忽略）：' + e.message); }
  }

  // ---- 通用「新建会话」注入：page.js 共享助手 + index.js 导出 + 7 个文本适配器（1.1.49） ----
  // 让 ChatGPT / Claude / Gemini / 豆包 / LMArena / z.ai 等（除已单独处理的 DeepSeek 外）也支持
  // fox_new_session 信号：fox-ai 新建会话后，点击站点「新对话」按钮重置浏览器侧会话，避免错位。
  // 各文本适配器在输入框就绪后调用共享助手 startNewSession(page, meta)。幂等：以功能是否就位判定，
  // 因此无论上游是否已被手动改过都不会重复注入。
  const multiMark = FX_PATCH_MARK + '-multisession';

  // 1) page.js：补 logger 导入 + 追加 startNewSession 助手
  const pageUtilsPath = path.join(projectDir, 'src', 'backend', 'utils', 'page.js');
  if (fs.existsSync(pageUtilsPath)) {
    try {
      let src = fs.readFileSync(pageUtilsPath, 'utf8');
      if (!src.includes('export async function startNewSession')) {
        const peol = src.includes('\r\n') ? '\r\n' : '\n';
        const loggerAnchor = "import { TIMEOUTS } from '../../utils/constants.js';";
        if (!src.includes("from '../../utils/logger.js'") && src.includes(loggerAnchor)) {
          src = src.replace(loggerAnchor, loggerAnchor + peol + "import { logger } from '../../utils/logger.js';");
        }
        const startNewSessionFn =
`\n\n// ${multiMark}：fox-ai 新建会话信号 → 点击站点「新对话」重置浏览器会话（通用，覆盖 ChatGPT/Claude/Gemini/豆包/LMArena/z.ai 等）
export async function startNewSession(page, meta = {}) {
    if (!meta || !meta.foxNewSession) return false;
    try {
        const candidates = [
            page.getByRole('button', { name: /new chat|new conversation|start new|新对话|新建对话|开启新对话/i }),
            page.getByRole('link', { name: /new chat|new conversation|新对话|新建对话/i }),
            page.locator('button, a').filter({ hasText: /new chat|new conversation|新对话|新建对话|新聊天|clear conversation|start new/i })
        ];
        for (const sel of candidates) {
            const cnt = await sel.count();
            if (cnt > 0) {
                await safeClick(page, sel.first(), { bias: 'button' });
                await sleep(400, 800);
                logger.info('适配器', '已开启新对话（fox_new_session）', meta);
                return true;
            }
        }
        logger.debug('适配器', '未找到「新对话」按钮，跳过重置', meta);
        return false;
    } catch (e) {
        logger.warn('适配器', '新对话按钮点击失败（忽略）：' + e.message, meta);
        return false;
    }
}`;
        src = src + peol + startNewSessionFn + peol;
        fs.writeFileSync(pageUtilsPath, src, 'utf8');
        changed = true;
        log('已为 page.js 注入 startNewSession 通用助手');
      }
    } catch (e) { log('⚠️ 补丁 page.js(multisession) 失败（忽略）：' + e.message); }
  }

  // 2) index.js：把 startNewSession 加入 page.js 再导出
  const idxUtilsPath = path.join(projectDir, 'src', 'backend', 'utils', 'index.js');
  if (fs.existsSync(idxUtilsPath)) {
    try {
      let src = fs.readFileSync(idxUtilsPath, 'utf8');
      if (!src.includes('startNewSession')) {
        const re = /    scrollToElement,([\r\n]+)} from '\.\/page\.js';/;
        if (re.test(src)) {
          src = src.replace(re, "    scrollToElement,$1    startNewSession, // " + multiMark + "$1} from './page.js';");
          fs.writeFileSync(idxUtilsPath, src, 'utf8');
          changed = true;
          log('已为 index.js 注入 startNewSession 导出');
        }
      }
    } catch (e) { log('⚠️ 补丁 index.js(multisession) 失败（忽略）：' + e.message); }
  }

  // 3) 7 个文本适配器：补 startNewSession 导入 + 调用
  const multiAdapters = ['chatgpt_text', 'claude_text', 'gemini_text', 'gemini_biz_text', 'doubao_text', 'lmarena_text', 'zai_is_text'];
  for (const name of multiAdapters) {
    const ap = path.join(projectDir, 'src', 'backend', 'adapter', name + '.js');
    if (!fs.existsSync(ap)) continue;
    try {
      let src = fs.readFileSync(ap, 'utf8');
      if (src.includes('await startNewSession(page, meta)')) continue; // 已注入，跳过
      const aeol = src.includes('\r\n') ? '\r\n' : '\n';
      let patched = src;
      if (!patched.includes('startNewSession')) {
        const impAnchor = '    waitForInput,';
        if (patched.includes(impAnchor)) patched = patched.replace(impAnchor, '    waitForInput,' + aeol + '    startNewSession,');
      }
      patched = patched.replace(/(await waitForInput\(page,[^\n]*\n)/, '$1        await startNewSession(page, meta); // ' + multiMark + aeol);
      if (patched !== src) {
        fs.writeFileSync(ap, patched, 'utf8');
        changed = true;
        log('已为 ' + name + ' 适配器注入新建会话重置');
      }
    } catch (e) { log('⚠️ 补丁 ' + name + '_text.js(multisession) 失败（忽略）：' + e.message); }
  }

  return changed;
}

/** 解压 Node 归档（Windows 用 PowerShell Expand-Archive；其余用 tar） */
function extractArchive(zip, dest) {
  return new Promise((resolve, reject) => {
    const child = isWin()
      ? spawn('powershell', ['-NoProfile', '-Command',
          `Expand-Archive -Path "${zip.replace(/"/g, '""')}" -DestinationPath "${dest.replace(/"/g, '""')}" -Force`],
        { windowsHide: true, stdio: 'ignore', shell: true })
      : spawn('tar', ['-xf', zip, '-C', dest], { windowsHide: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error('解压 Node 失败（退出码 ' + code + '）')));
  });
}

/**
 * 选择/准备跑 WebAI2API 的 Node：
 *   1) 优先 PATH 中 < 23 的 LTS Node；
 *   2) 其次已下载缓存（~/.fox-ai/node）中的 LTS Node；
 *   3) 否则自动从 nodejs.org 下载 Node 22 LTS 并解压到 ~/.fox-ai/node（一次性，带进度）。
 * 返回 { dir, version, npmExe }。
 */
async function ensureBestNode(opts = {}) {
  const { onLog, onProgress, signal } = opts;
  const log = onLog || (() => {});
  const prog = onProgress || (() => {});
  // 1) PATH 探测（仅环境变量，符合既定策略）
  const found = findBestNode();
  if (found && cmpVer(found.version, '23.0.0') < 0) {
    return Object.assign({}, found, { npmExe: path.join(found.dir, npmCmd()) });
  }
  // 2) 已下载缓存
  const cached = findCachedNode();
  if (cached) {
    log(`将使用已缓存的 Node ${cached.version}（${cached.dir}）`);
    return Object.assign({}, cached, { npmExe: path.join(cached.dir, npmCmd()) });
  }
  // 3) 自动下载 Node 22 LTS
  log('⚠️ 未找到合适的 LTS Node，将自动下载 Node 22 LTS（约 30MB，仅需一次）…');
  const ver = await fetchLatestLTS('22', signal);
  const base = path.join(os.homedir(), '.fox-ai', 'node');
  const sub = isWin() ? `node-${ver}-win-x64` : `node-${ver}-${platformArch()}`;
  const home = path.join(base, ver);
  const nodeDir = path.join(home, sub);
  const nodeExe = path.join(nodeDir, isWin() ? 'node.exe' : 'node');
  if (fs.existsSync(nodeExe)) {
    log(`已缓存 Node ${ver}，跳过下载`);
    return { dir: nodeDir, version: ver, npmExe: path.join(nodeDir, npmCmd()) };
  }
  const ext = isWin() ? 'zip' : 'tar.gz';
  const file = isWin() ? `node-${ver}-win-x64.zip` : `node-${ver}-${platformArch()}.${ext}`;
  const url = `https://nodejs.org/dist/${ver}/${file}`;
  const zipPath = path.join(base, `${ver}.${ext}`);
  fs.mkdirSync(base, { recursive: true });
  log('下载 ' + url + ' …');
  await parallelDownload(url, zipPath, { connections: 8, onProgress: (p) => prog(p), signal });
  log('下载完成，解压中…');
  await extractArchive(zipPath, home);
  try { fs.rmSync(zipPath, { force: true }); } catch (_) {}
  if (!fs.existsSync(nodeExe)) throw new Error('Node 下载解压后未找到可执行文件：' + nodeExe);
  log(`Node ${ver} 已安装至 ${nodeDir}`);
  return { dir: nodeDir, version: ver, npmExe: path.join(nodeDir, npmCmd()) };
}

/** Node 是否支持 --use-system-ca（20.9+ / 21+ / 22+），用于信任系统证书库（如 Windows 代理/MITM 根证书） */
function supportsSystemCa(version) {
  try { return cmpVer(version || '0', '20.9.0') >= 0; } catch (_) { return false; }
}

/**
 * 构造把指定 Node bin 目录前置到 PATH 的环境（让其内部调用的 node 也一致），避免混用系统新版 Node。
 * extraNodeOpts：追加到 NODE_OPTIONS（如 '--use-system-ca'），不覆盖用户已有的 NODE_OPTIONS。
 */
function withNodeEnv(binDir, extraNodeOpts) {
  const env = Object.assign({}, process.env);
  env.PATH = binDir + path.delimiter + (env.PATH || '');
  if (extraNodeOpts) {
    const prev = env.NODE_OPTIONS || '';
    env.NODE_OPTIONS = (prev ? prev + ' ' : '') + extraNodeOpts;
  }
  return env;
}

/** 归一化代理地址：纯 host:port 补 http://；已带 http(s):// 或 socks5:// 等保留原样 */
function normalizeProxy(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s) || /^socks[45]?:\/\//i.test(s)) return s;
  return 'http://' + s;
}

/** 解析 Windows 系统代理 ProxyServer 值（可能是 "127.0.0.1:7890" 或多协议 "http=..;https=..;ftp=.."），返回可用的 http 代理地址 */
function parseProxyServer(val) {
  const s = String(val || '').trim();
  if (!s) return '';
  if (s.includes('=')) {
    const parts = s.split(';').map((x) => x.trim()).filter(Boolean);
    const pick = parts.find((x) => /^https?=/i.test(x)) || parts[0];
    const m = /^[^=]+=(.+)$/.exec(pick || '');
    return m ? normalizeProxy(m[1]) : '';
  }
  return normalizeProxy(s);
}

/** 并行扫描本机常见代理端口（Clash/V2Ray 等混合端口），返回首个开放端口的 http 代理地址或 null */
function scanLocalProxyPorts() {
  const ports = [7890, 7891, 7892, 7893, 7895, 1080, 10808, 10809, 8080, 8118, 33210, 20170];
  return new Promise((resolve) => {
    let pending = ports.length;
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    for (const p of ports) {
      let done = false;
      const sock = net.connect({ host: '127.0.0.1', port: p });
      const ok = () => { if (!done) { done = true; try { sock.destroy(); } catch (_) {} finish('http://127.0.0.1:' + p); } };
      const no = () => { if (!done) { done = true; try { sock.destroy(); } catch (_) {} if (--pending === 0) finish(null); } };
      sock.setTimeout(500, no);
      sock.on('connect', ok);
      sock.on('error', no);
    }
    if (ports.length === 0) finish(null);
  });
}

/**
 * 自动探测可用于 init 下载的代理地址（优先级）：
 *   1) 环境变量 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY（含小写）
 *   2) Windows 系统代理（注册表 Internet Settings\ProxyServer）
 *   3) 本机常见代理端口 TCP 探测（Clash/V2Ray 混合端口等）
 * 返回 http:// 或 socks5:// 地址，或 null。
 */
async function detectProxy() {
  const envProxy = (process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy || '').trim();
  if (envProxy) return normalizeProxy(envProxy);
  if (isWin()) {
    try {
      const out = spawnSync('reg', ['query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v', 'ProxyServer'], { windowsHide: true, encoding: 'utf8', timeout: 5000 }).stdout || '';
      const m = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(out);
      if (m && m[1]) {
        const p = parseProxyServer(m[1]);
        if (p) return p;
      }
    } catch (_) {}
  }
  return scanLocalProxyPorts();
}

/**
 * 安装依赖（npm install），优先用 Node 22 LTS 的 npm 避免 better-sqlite3 等原生模块源码编译。
 * nodeEnv：已注入 PATH + NODE_OPTIONS（含 --use-system-ca，信任系统证书库，避免代理环境下预编译下载证书失败）。
 * 若因 TLS/证书校验仍失败，自动以「跳过证书校验」重试一次（仅本次安装）。
 */
async function runNpmInstall(projectDir, bestNode, nodeEnv, signal, log) {
  const exe = bestNode ? (bestNode.npmExe || path.join(bestNode.dir, npmCmd())) : npmCmd();
  const baseEnv = nodeEnv || (bestNode ? withNodeEnv(bestNode.dir) : process.env);
  // 代理/MITM 环境下，GitHub 上的原生模块（如 better-sqlite3）预编译二进制下载会因证书校验失败
  // 而回退源码编译（又缺 Python/VS）。仅在本安装进程临时关闭 TLS 证书校验（不改动系统/用户配置），
  // 让预编译能正常下载，从而无需本地 C++ 编译。
  const tlsBypass = { NODE_TLS_REJECT_UNAUTHORIZED: '0' };
  const run = (extra) => runCmd(exe, ['install'], {
    cwd: projectDir, signal, name: 'npm install',
    env: Object.assign({}, baseEnv, tlsBypass, extra || {}),
    onStderr: (s) => { if (/error|ERR|failed/i.test(s)) log(s); }
  });
  try {
    await run();
  } catch (e) {
    const m = String(e.message);
    if (/verify|certificate|UNABLE TO VERIFY|self[- ]?signed|TLS/i.test(m)) {
      log('⚠️ 仍存在 TLS/证书校验失败，请检查代理证书、或手动安装 Node 22 LTS 后重试。');
    }
    throw e;
  }
}

/**
 * 执行命令并流式回调输出，支持取消。
 * opts: { cwd, signal, name, onRaw(chunkString), onStderr(chunkString) }
 * 返回 Promise<{ code, output }>
 */
function runCmd(cmd, args, opts) {
  const { cwd, signal, name, onRaw, onStderr, env } = opts || {};
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('已取消'));
    let child;
    try {
      child = spawn(cmd, args, {
        cwd, env: env || process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: true
      });
    } catch (e) { return reject(e); }
    // 中止/退出时彻底清理子进程树（Windows：taskkill /T /F 同步执行并确认；
    // 同时注册宿主进程退出钩子，防止 VS Code 关闭后 cmd/npm/node 残留后台继续跑）。
    const onAbort = () => killTreeSync(child.pid);
    const onHostExit = () => { try { killTreeSync(child.pid); } catch (_) {} };
    if (signal) signal.addEventListener('abort', onAbort);
    process.once('exit', onHostExit);
    let buf = '';
    const feed = (d, isErr) => {
      const s = d.toString('utf8');
      buf += s;
      if (onRaw) onRaw(s);
      if (isErr && onStderr) onStderr(s);
    };
    child.stdout.on('data', (d) => feed(d, false));
    child.stderr.on('data', (d) => feed(d, true));
    child.on('error', (e) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      process.removeListener('exit', onHostExit);
      reject(e);
    });
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      process.removeListener('exit', onHostExit);
      if (signal && signal.aborted) return reject(new Error('已取消'));
      if (code === 0) return resolve({ code, output: buf });
      // 透出命令真实错误输出（git 等把 fatal 写进 stderr，原本被静默吞掉，导致只看到「退出码 128」）
      const tail = extractErrorLines(buf).join('\n');
      reject(new Error(`${name || cmd} 失败（退出码 ${code}）${tail ? '：\n' + tail : ''}`));
    });
  });
}

/** 生成 data/config.yaml：复制 example，替换 server.auth 为生成的密钥 */
function writeConfig(projectDir, auth, log) {
  const example = path.join(projectDir, 'config.example.yaml');
  const dataDir = path.join(projectDir, 'data');
  const target = path.join(dataDir, 'config.yaml');
  if (!fs.existsSync(example)) throw new Error('找不到 config.example.yaml，源码可能不完整');
  let content = fs.readFileSync(example, 'utf8');
  const re = /^(\s*)auth:\s*sk-change-me-to-your-secure-key\s*$/m;
  if (re.test(content)) {
    content = content.replace(re, `$1auth: ${auth}`);
  } else {
    log('⚠️ 未找到默认 auth 占位，保留示例配置（请手动确认 server.auth）');
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  log('已写入 ' + target);
}

/**
 * 主入口：下载并配置 WebAI2API。
 * opts: { installDir, onLog(str), onProgress(percent, indeterminate), onStage(label), signal }
 * 返回 { projectDir, auth, port, baseUrl }
 */
async function setup(opts) {
  const { installDir, mirror, proxy, onLog, onProgress, onStage, signal } = opts || {};
  const log = onLog || (() => {});
  const prog = onProgress || (() => {});
  const stage = onStage || (() => {});

  if (!installDir) throw new Error('未指定安装目录');
  const projectDir = path.join(installDir, REPO_NAME);

  // 计算阶段边界
  let acc = 0;
  const bounds = STAGES.map((s) => {
    const b = { key: s.key, label: s.label, start: acc, end: acc + s.weight };
    acc += s.weight;
    return b;
  });
  const report = (key, intra) => {
    const b = bounds.find((x) => x.key === key);
    if (!b) return;
    prog(Math.round(b.start + (b.end - b.start) * (intra == null ? 0 : intra)), false);
  };
  const beginStage = (key) => { const b = bounds.find((x) => x.key === key); stage(b.label); report(key, 0); };
  const endStage = (key) => report(key, 1);

  // 1) 环境检查 + 选择/下载 Node
  beginStage('preflight');
  const bestNode = await ensureBestNode({ onLog: log, onProgress: (p) => report('preflight', p), signal });
  log(`将使用 Node ${bestNode.version}（${bestNode.dir}）安装依赖，避免新版 Node 缺失原生模块预编译而需本地 C++ 编译`);
  const npm = bestNode.npmExe;
  // --use-system-ca：让 Node 信任系统证书库（Windows 上默认走 Schannel，含代理/MITM 根证书）。
  // 否则 Node 自带 Mozilla CA 不认系统代理证书，prebuild-install 下载原生模块预编译会报
  // 「unable to verify the first certificate」→ 回退源码编译（又因缺 Python/VS 失败）。
  // 该选项需 Node 20.9+，旧版回退到 reject-unauthorized 重试。
  const sysCa = supportsSystemCa(bestNode.version) ? '--use-system-ca' : '';
  const nodeEnv = withNodeEnv(bestNode.dir, sysCa);
  try {
    // shell:true 关键：Windows 上 npm 是 npm.cmd，spawnSync 不带 shell 直接 exec 会抛 EINVAL；
    // 走 cmd.exe /c 后，npm 存在则 status=0、stdout 有版本号；不存在则 status≠0，给出友好提示。
    const r = spawnSync(npm, ['--version'], { shell: true, windowsHide: true, encoding: 'utf8', timeout: 15000, env: nodeEnv });
    if (r.error) throw new Error('未检测到 npm：' + r.error.message);
    if (r.status !== 0) throw new Error('npm 不可用');
    log(`npm 版本：${(r.stdout || '').trim()}`);
  } catch (e) {
    throw new Error('环境检查失败：' + e.message);
  }
  // 始终使用所选 Node 自带的 npm（最稳，避免原生模块用错 Node 编译）
  const pm = npm;
  const pmName = 'npm';
  log('包管理器：npm（使用所选 Node 自带）');
  endStage('preflight');

  // 2) 下载源码（git clone，带真实百分比）
  beginStage('download');
  const already = fs.existsSync(path.join(projectDir, 'package.json'));
  if (!already) {
    // 目标目录是专用子目录（WebAI2API）；若无 package.json 视为上次失败残留，清理后重试，避免「目录已存在」类 128
    if (fs.existsSync(projectDir) && path.basename(projectDir) === REPO_NAME) {
      log('⚠️ 检测到目标目录残留（上次未完成的下载），清理后重新克隆…');
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
    fs.mkdirSync(installDir, { recursive: true });

    // git 可用性探测（防御性，区分「git 未装」与「clone 失败」）
    const gv = spawnSync('git', ['--version'], { shell: true, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    if (gv.error || gv.status !== 0) {
      throw new Error('未检测到 git，请先安装 Git（https://git-scm.com）并加入 PATH 后重试。');
    }

    // 候选 URL：可选镜像前缀（国内访问 GitHub 常需代理/镜像），失败再回退官方地址
    const mirrorVal = String(mirror || '').trim();
    const candidates = [];
    if (mirrorVal) {
      const base = mirrorVal.replace(/\/+$/, '');
      candidates.push({ url: base + '/' + REPO_URL, label: '镜像 ' + base });
    }
    candidates.push({ url: REPO_URL, label: '官方 ' + REPO_URL });

    let lastErr = null;
    for (const c of candidates) {
      log('克隆 ' + c.label + ' …');
      try {
        await runCmd('git', ['clone', '--depth', '1', '--progress', c.url, projectDir], {
          cwd: installDir, signal, name: 'git clone',
          onRaw: (s) => {
            const m = /Receiving objects:\s+(\d+)%/.exec(s);
            if (m) report('download', Math.min(1, parseInt(m[1], 10) / 100));
          }
        });
        log('源码下载完成：' + projectDir);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        // 清理本次残留，避免影响下一次重试（或下次整体重跑时仍报「目录已存在」）
        if (fs.existsSync(projectDir) && path.basename(projectDir) === REPO_NAME) {
          try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch (_) {}
        }
        log('⚠️ 经 ' + c.label + ' 克隆失败：' + String(e.message).split('\n')[0]);
      }
    }
    if (lastErr) {
      const msg = String(lastErr.message);
      const netK = /could not resolve|failed to connect|timed out|connection|443|ECONN|refused|TLS|denied|unable to access|Recv failure|OpenSSL|proxy/i;
      if (netK.test(msg)) {
        log('❌ 无法连接代码托管（' + REPO_URL + '）。常见原因与对策：');
        log('   ① 网络无法访问 GitHub：国内常需代理 / VPN；');
        log('   ② 为 git 配置代理：git config --global http.proxy http://127.0.0.1:7890');
        log('   ③ 或在此面板「镜像前缀」填入 ghproxy 类镜像（如 https://ghproxy.com/）后重试。');
      } else {
        log('❌ 克隆失败，请查看上方错误信息后重试。');
      }
      throw lastErr;
    }
  } else {
    log('检测到已有源码，跳过下载：' + projectDir);
  }
  endStage('download');

  // 3) 安装依赖（不确定时长 → 前端脉冲动画）
  beginStage('deps');
  prog(bounds.find((x) => x.key === 'deps').start, true); // 通知前端进入不确定态
  log(`运行 ${pmName} install …（使用 Node ${bestNode ? bestNode.version : '系统默认'}，首次可能需数分钟）`);
  // 1.1.44：安装前先注入项目补丁（幂等），其中 playwright-core 精确锁定必须在 npm install 之前生效，
  // 否则 npm 按 ^1.57.0 装最新版（如 1.62.1）→ setDefaultViewport 参数含 isMobile → Camoufox Juggler 不识别 → 浏览器初始化失败。
  try { patchWebAI2APIProject(projectDir, log); } catch (_) {}
  // install 前清理上次的脏 node_modules（避免残留的 partial build 干扰重装，尤其 better-sqlite3 编译失败残留）
  const nmDir = path.join(projectDir, 'node_modules');
  if (fs.existsSync(nmDir)) {
    log('清理上次的 node_modules 残留（确保干净重装）…');
    try { fs.rmSync(nmDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
    catch (e) { log('⚠️ 残留清理未完全（可能被占用），将尝试增量重装：' + e.message); }
  }
  try {
    await runNpmInstall(projectDir, bestNode, nodeEnv, signal, log);
  } catch (e) {
    const m = String(e.message);
    if (/better-sqlite3|node-gyp|prebuild|gyp ERR|MSBUILD|Visual Studio/i.test(m)) {
      log('❌ 原生模块编译失败。对策：① 安装 Node 22 LTS（better-sqlite3 有官方预编译，无需本地编译）；② 或安装 Visual Studio「使用 C++ 的桌面开发」工作负载后重试。');
    }
    throw e;
  }
  log('依赖安装完成');
  endStage('deps');

  // 4) 初始化浏览器等资源（npm run init，解析下载真实百分比）
  beginStage('init');
  log('运行 npm run init …（下载 Camoufox 浏览器等，文件较大，请耐心）');
  // init 脚本自带的下载器是 Node 原生 http 直连 GitHub Release CDN（objects.githubusercontent.com），
  // 在规则代理/TUN 环境下常被判为「直连」而被重置（ECONNRESET）。若用户填了代理或能自动探测到，
  // 则通过 init 的 -proxy 参数显式走代理，绕过「直连」分流，下载更稳。
  const proxyUrl = proxy && proxy.trim() ? normalizeProxy(proxy.trim()) : await detectProxy();
  if (proxyUrl) log('ℹ️ init 将通过代理下载：' + proxyUrl + '（避免直连 GitHub Release CDN 被重置）');
  else {
    log('ℹ️ 未检测到代理，使用多线程分段下载加速（直连 GitHub Release CDN）');
    try {
      // 项目补丁已在 deps 阶段（npm install 前）注入（幂等）；此处直接复用多线程预下载产物
      await preDownloadBigFiles(projectDir, log, (p) => report('init', p), signal);
    } catch (e) {
      log('⚠️ 多线程预下载失败：' + (e && e.message || e) + '，改由 init 脚本下载（可考虑在上方「代理」框填代理地址）');
    }
  }
  const initArgs = proxyUrl ? ['run', 'init', '--', '-proxy=' + proxyUrl] : ['run', 'init'];
  // init.js 用 \r 单行刷新输出「下载进度: X%」，可能跨 chunk 截断数字 → 按 \r 分段缓存最后一段再解析
  let initProgBuf = '';
  try {
    await runCmd(npm, initArgs, {
      cwd: projectDir, signal, name: 'npm run init',
      env: Object.assign({}, nodeEnv, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }),
      onRaw: (s) => {
        initProgBuf += s;
        const segs = initProgBuf.split('\r');
        initProgBuf = segs.pop(); // 保留末尾不完整段，等下一 chunk 补全
        for (const seg of segs) {
          const m = /下载进度:\s*([\d.]+)%/.exec(seg);
          if (m) report('init', Math.min(1, parseFloat(m[1]) / 100));
        }
      },
      onStderr: (s) => { if (/error|ERR|failed/i.test(s)) log(s); }
    });
  } catch (e) {
    const em = String(e && e.message || e);
    if (/ECONNRESET|ECONNREFUSED|read ECONN|connection reset|connect .* refused|socket hang up/i.test(em)) {
      log('❌ 初始化下载失败（网络连接被重置/拒绝）。多为你的网络对 GitHub Release CDN 直连不稳所致。');
      log('   对策：① 在上方「代理」框填入你的代理地址（如 http://127.0.0.1:7890）；或 ② 在代理软件切到「全局模式」，然后重新点击「下载并配置」。');
    }
    throw e;
  }
  log('初始化完成（Camoufox 浏览器就绪）');
  endStage('init');

  // 5) 生成配置
  beginStage('config');
  const auth = generateAuth();
  writeConfig(projectDir, auth, log);
  log('鉴权密钥已生成并写入 config.yaml');
  endStage('config');

  return { projectDir, auth, port: 3000, baseUrl: 'http://localhost:3000/v1' };
}

module.exports = { setup, generateAuth, writeConfig, REPO_URL, REPO_NAME, STAGES, hasPnpm, killTree, killTreeSync, isPortListening, startServer, killPort, findPidByPort, findBestNode, withNodeEnv, runNpmInstall, ensureBestNode, findCachedNode, detectProxy, normalizeProxy, parseProxyServer, parallelDownload, camoufoxUrl, probeRange, mergeParts, downloadRange, preDownloadBigFiles, patchWebAI2APIProject };

// ---- 服务管理（启动 / 停止 / 端口检测）----

/** 检测本地端口是否被监听（默认 127.0.0.1，1.5s 超时） */
function isPortListening(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ port: Number(port) || 0, host });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; sock.destroy(); resolve(v); } };
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
    sock.setTimeout(1500, () => done(false));
  });
}

/**
 * 长驻启动服务（npm start，即 node supervisor.js），返回 child（不 await）。
 * onLog(chunkString)：流式输出；onExit(code, signal, err)：进程退出/启动失败回调（只触发一次）。
 * spawn 同步失败（如 cwd 不存在，Windows 抛 EINVAL）时返回 null 并经 onExit(err) 通知。
 */
async function startServer(projectDir, opts = {}) {
  const { onLog, onExit } = opts || {};
  let bestNode;
  try {
    // 自动选择/下载合适的 Node（首次可能触发自动下载 Node 22 LTS，日志会透出进度）
    bestNode = await ensureBestNode({ onLog: (s) => { if (onLog) onLog(s); }, signal: null });
  } catch (e) {
    if (onExit) onExit(null, null, e);
    return null;
  }
  const cmd = bestNode.npmExe;
  // 服务运行时会出网访问各模型官网（HTTPS），代理/MITM 环境下同样需要跳过证书校验
  const env = withNodeEnv(bestNode.dir, supportsSystemCa(bestNode.version) ? '--use-system-ca' : '');
  env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  let child;
  try {
    child = spawn(cmd, ['start'], {
      cwd: projectDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: true
    });
  } catch (e) {
    if (onExit) onExit(null, null, e);
    return null;
  }
  const feed = (d) => { const s = d.toString('utf8'); if (onLog) onLog(s); };
  if (child.stdout) child.stdout.on('data', feed);
  if (child.stderr) child.stderr.on('data', feed);
  let settled = false;
  const finish = (code, signal, err) => { if (settled) return; settled = true; if (onExit) onExit(code, signal, err); };
  // 用 'close'（覆盖 ENOENT 命令找不到的情况）+ settled 防 error/close 双触发
  child.on('error', (e) => finish(null, null, e));
  child.on('close', (code, signal) => finish(code, signal, null));
  return child;
}

/**
 * 查找监听指定端口的进程 PID（找不到返回 null）。
 * Windows 用 netstat -ano 精确匹配「:端口+空白」，避免 3000 误匹配 30000/30001；POSIX 用 lsof。
 */
function findPidByPort(port) {
  try {
    if (isWin()) {
      const out = (spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true }).stdout || '');
      const re = new RegExp(':' + port + '\\s');
      for (const line of out.split(/\r?\n/)) {
        if (/LISTENING/i.test(line) && re.test(line)) {
          const cols = line.trim().split(/\s+/);
          const pid = parseInt(cols[cols.length - 1], 10);
          if (pid) return pid;
        }
      }
      return null;
    } else {
      const r = spawnSync('sh', ['-c', `lsof -ti:${port}`], { encoding: 'utf8' });
      const pid = parseInt((r.stdout || '').trim(), 10);
      return pid || null;
    }
  } catch (_) { return null; }
}

/**
 * 按端口强杀监听进程（兜底：服务可能由用户在终端自己启动、或扩展重载后引用丢失）。
 * 返回是否找到并尝试终止。
 */
function killPort(port) {
  const pid = findPidByPort(port);
  if (!pid) return false;
  try {
    if (isWin()) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    return true;
  } catch (_) { return false; }
}
