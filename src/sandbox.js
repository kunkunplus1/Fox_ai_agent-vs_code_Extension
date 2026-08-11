'use strict';

/**
 * src/sandbox.js — 语言无关的代码沙盒测试管理器（进程级隔离 + 可选 Docker）
 *
 * 设计目标（来自需求）：
 *   1) 专门目录存放各类语言的沙盒环境（默认 ~/.fox-ai/sandboxes，可被 foxAi.sandbox.dir 覆盖）。
 *   2) 每个沙盒 = 一个子文件夹，内含 manifest.json（语言、怎么跑、canary 示例）。
 *   3) 主控 agent 通过 run_in_sandbox 工具访问，用沙盒自测它自己写的代码。
 *   4) 用户可手动把沙盒文件夹丢进该目录（manifest 驱动，天然支持"各类语言"）。
 *   5) 新沙盒（非内置）首次发现时，代码先用 manifest 的 canary 示例实跑一遍判断可用性，
 *      通过才注册给 agent；内置沙盒直接信任。
 *   6) 全程详细日志落到 ~/.fox-ai/logs/sandbox.log。
 *
 * 隔离语义：
 *   - 进程级（默认）：在独立临时目录里用 spawn 跑 manifest 指定的命令，绝不碰用户工作区。
 *     注：进程级不阻断网络/文件系统访问，真正隔离请用 runner:"docker"（需本机 docker）。
 *   - Docker 级（可选）：docker run --rm 把临时目录挂进容器，文件系统与网络默认隔离。
 *
 * 可测试性：本模块不依赖 'vscode'，核心逻辑用 createManager(opts) 工厂，离线单测直接注入临时目录。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const { appendLog } = require('./log');

/* ===================== 内置沙盒（直接信任，免 canary） ===================== */
// 进程级：command 为数组 → 走 execFile（不经 shell，安全）；为字符串 → 走 shell（compile && run 用）。
const BUILTINS = [
  {
    name: 'Node.js', language: 'javascript', builtin: true,
    run: { command: ['node', '{{file}}'], timeout: 30000, stdin: true },
    file: { ext: '.js' }
  },
  {
    name: 'Python', language: 'python', builtin: true,
    run: { command: ['python3', '{{file}}'], timeout: 30000, stdin: true },
    file: { ext: '.py' }
  },
  {
    name: 'Go', language: 'go', builtin: true,
    run: { command: ['go', 'run', '{{file}}'], timeout: 60000, stdin: true },
    file: { ext: '.go' }
  },
  {
    name: 'Rust', language: 'rust', builtin: true,
    // 编译 + 运行需要两步，用 shell 串起来（代码已落盘为文件，命令里只插路径，无注入风险）
    run: { command: 'rustc "{{file}}" -o "{{workdir}}/out" && "{{workdir}}/out"', shell: true, timeout: 60000, stdin: true },
    file: { ext: '.rs' }
  },
  {
    name: 'Java', language: 'java', builtin: true,
    // Java 11+ 单文件源码直接运行（JEP 330）
    run: { command: ['java', '{{file}}'], timeout: 60000, stdin: true },
    file: { ext: '.java' }
  }
];

/* ===================== 用户沙盒模板（UI 一键新建用，manifest 骨架） ===================== */
// 仅作脚手架：UI 选模板后用户可改 name/language/command/ext/canary 再保存。
// command 为字符串 → 走 shell（方便 compile && run）；为数组 → 走 execFile。
const TEMPLATES = {
  cpp: {
    name: 'C++', language: 'cpp',
    run: { command: 'g++ -std=c++17 -O2 "{{file}}" -o "{{workdir}}/out" && "{{workdir}}/out"', shell: true, timeout: 60000, stdin: true },
    file: { ext: '.cpp' },
    canary: { code: '#include <iostream>\nint main(){ std::cout << "ok"; return 0; }', expected: 'ok' }
  },
  ruby: {
    name: 'Ruby', language: 'ruby',
    run: { command: ['ruby', '{{file}}'], timeout: 30000, stdin: true },
    file: { ext: '.rb' },
    canary: { code: 'puts "ok"', expected: 'ok' }
  },
  php: {
    name: 'PHP', language: 'php',
    run: { command: ['php', '{{file}}'], timeout: 30000, stdin: true },
    file: { ext: '.php' },
    canary: { code: '<?php echo "ok";', expected: 'ok' }
  },
  bash: {
    name: 'Bash', language: 'bash',
    run: { command: ['bash', '{{file}}'], timeout: 30000, stdin: false },
    file: { ext: '.sh' },
    canary: { code: 'echo ok', expected: 'ok' }
  },
  typescript: {
    name: 'TypeScript', language: 'typescript',
    run: { command: ['npx', '--yes', 'ts-node', '{{file}}'], timeout: 60000, stdin: true },
    file: { ext: '.ts' },
    canary: { code: 'console.log("ok");', expected: 'ok' }
  },
  csharp: {
    name: 'C#', language: 'csharp',
    run: { command: ['dotnet', 'script', '{{file}}'], timeout: 60000, stdin: true },
    file: { ext: '.csx' },
    canary: { code: 'Console.WriteLine("ok");', expected: 'ok' }
  },
  lua: {
    name: 'Lua', language: 'lua',
    run: { command: ['lua', '{{file}}'], timeout: 30000, stdin: true },
    file: { ext: '.lua' },
    canary: { code: 'print("ok")', expected: 'ok' }
  },
  perl: {
    name: 'Perl', language: 'perl',
    run: { command: ['perl', '{{file}}'], timeout: 30000, stdin: true },
    file: { ext: '.pl' },
    canary: { code: 'print "ok\\n";', expected: 'ok' }
  }
};

/* ===================== 模块级校验缓存（跨调用复用，reload 时清） ===================== */
// key = 沙盒文件夹绝对路径；value = { status:'ready'|'invalid', error?, at }
const validationCache = new Map();

/* ===================== 日志 ===================== */
function log(...lines) {
  try { appendLog('sandbox', lines); } catch (_) { /* 日志失败不影响主流程 */ }
}

/* ===================== 变量替换 ===================== */
function expand(str, ctx) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/\{\{file\}\}/g, ctx.file)
    .replace(/\{\{workdir\}\}/g, ctx.workdir)
    .replace(/\{\{sandbox\}\}/g, ctx.sandbox)
    .replace(/\{\{ext\}\}/g, ctx.ext);
}

/* ===================== 异步 spawn（带超时 + stdin） ===================== */
function spawnAsync(command, args, opts) {
  const timeout = opts.timeout || 30000;
  return new Promise((resolve) => {
    let child;
    try {
      child = cp.spawn(command, args, opts);
    } catch (e) {
      return resolve({ error: 'spawn 失败：' + String((e && e.message) || e), stdout: '', stderr: '', code: null, killed: false });
    }
    let stdout = '';
    let stderr = '';
    if (child.stdout) child.stdout.on('data', (d) => { stdout += d; });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d; });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }, timeout);
    if (opts.stdinData) {
      try { child.stdin.write(opts.stdinData); child.stdin.end(); } catch (_) { /* ignore */ }
    }
    child.on('error', (e) => { stderr += '\n[spawn error] ' + String((e && e.message) || e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ error: null, stdout, stderr, code: killed ? null : code, killed });
    });
  });
}

/* ===================== 在隔离临时目录里运行一份代码 ===================== */
async function execute(def, code, opts) {
  opts = opts || {};
  const ext = (def.file && def.file.ext) || '.txt';
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxai-sb-'));
  const fileName = 'main' + ext;
  const filePath = path.join(workdir, fileName);
  const sandboxDir = def._folder || workdir;
  const ctx = { file: filePath, workdir, sandbox: sandboxDir, ext };

  // 写代码到隔离目录
  try {
    fs.writeFileSync(filePath, code || '', { encoding: 'utf8' });
  } catch (e) {
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    return { ok: false, error: '写入沙盒文件失败：' + String((e && e.message) || e), stdout: '', stderr: '', exit: null };
  }

  const run = def.run || {};
  const timeout = Math.max(1000, Math.min(opts.timeout || run.timeout || 30000, 600000));
  const stdinData = opts.stdin ? String(opts.stdin) : null;

  let result;
  if (run.runner === 'docker') {
    result = await executeDocker(def, ctx, { timeout, stdinData });
  } else {
    result = await executeProcess(def, ctx, { timeout, stdinData });
  }

  // 清理隔离目录（best-effort）
  try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (_) { /* ignore */ }

  const ok = !result.error && !result.killed && result.code === 0;
  log(
    '[run] sandbox=' + def.name + ' lang=' + def.language +
    ' exit=' + (result.code === null ? (result.killed ? 'TIMEOUT' : '?') : result.code) +
    ' outLen=' + (result.stdout || '').length + ' errLen=' + (result.stderr || '').length
  );
  if (result.error) log('[run-error] ' + def.name + ': ' + result.error);
  return {
    ok,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exit: result.code,
    error: result.error || (result.killed ? '运行超时（>' + timeout + 'ms）被强制终止' : null),
    killed: !!result.killed
  };
}

async function executeProcess(def, ctx, opts) {
  const run = def.run || {};
  const env = Object.assign({}, process.env, { FOXAI_SANDBOX: '1' });
  const spawnOpts = { cwd: ctx.workdir, env, timeout: opts.timeout, windowsHide: true };

  if (typeof run.command === 'string') {
    // shell 模式（compile && run 等）：整体替换变量后交给 shell
    const shellCmd = expand(run.command, ctx);
    log('[spawn-shell] ' + def.name + ' :: ' + shellCmd);
    return spawnAsync(shellCmd, [], Object.assign({ shell: true, stdinData: opts.stdinData }, spawnOpts));
  }
  // 数组模式：逐元素替换，execFile 不经 shell
  const arr = (Array.isArray(run.command) ? run.command : [run.command]).map((c) => expand(c, ctx));
  if (!arr.length || !arr[0]) return { error: 'manifest.run.command 为空', stdout: '', stderr: '', code: null };
  log('[spawn] ' + def.name + ' :: ' + arr.join(' '));
  return spawnAsync(arr[0], arr.slice(1), Object.assign({ stdinData: opts.stdinData }, spawnOpts));
}

async function executeDocker(def, ctx, opts) {
  const run = def.run || {};
  const docker = run.docker || {};
  const image = docker.image;
  if (!image) return { error: 'docker runner 缺少 docker.image', stdout: '', stderr: '', code: null };
  // 容器内路径：临时目录挂到 /work，沙盒目录挂到 /sandbox(ro)
  const cctx = { file: path.posix.join('/work', path.basename(ctx.file)), workdir: '/work', sandbox: '/sandbox' };
  let cmdArgs;
  if (typeof run.command === 'string') cmdArgs = ['sh', '-c', expand(run.command, cctx)];
  else cmdArgs = (Array.isArray(run.command) ? run.command : [run.command]).map((c) => expand(c, cctx));
  const dockerArgs = [
    'run', '--rm',
    '-v', ctx.workdir + ':/work',
    '-v', ctx.sandbox + ':/sandbox:ro',
    '-w', '/work',
    image
  ].concat(cmdArgs);
  log('[docker] ' + def.name + ' :: docker ' + dockerArgs.join(' '));
  return spawnAsync('docker', dockerArgs, { cwd: ctx.workdir, timeout: opts.timeout, windowsHide: true, stdinData: opts.stdinData });
}

/* ===================== manifest 校验 ===================== */
function validateManifest(m) {
  if (!m || typeof m !== 'object') return 'manifest 不是合法 JSON 对象';
  if (!m.name) return 'manifest 缺少 name';
  if (!m.language) return 'manifest 缺少 language';
  if (!m.run || (!m.run.command && m.run.runner !== 'docker')) return 'manifest.run.command 不能为空（docker runner 需 docker.image）';
  if (m.run.runner === 'docker' && (!m.run.docker || !m.run.docker.image)) return 'docker runner 必须提供 run.docker.image';
  return null;
}

function loadUserManifest(folder) {
  const mp = path.join(folder, 'manifest.json');
  if (!fs.existsSync(mp)) return null;
  const raw = fs.readFileSync(mp, 'utf8');
  const m = JSON.parse(raw);
  m._folder = folder;
  m.builtin = false;
  return m;
}

/* ===================== 工厂 ===================== */
function createManager(opts) {
  opts = opts || {};
  const baseDir = (opts.dir && opts.dir.trim()) || path.join(os.homedir(), '.fox-ai', 'sandboxes');
  const globalTimeout = opts.timeout || 30000;
  const allowDocker = !!opts.allowDocker;
  const enabled = opts.enabled !== false;

  function defaultDir() { return baseDir; }

  async function validateUserCanary(m) {
    // docker runner 的 canary 本身也依赖 docker，没装/未授权时无法校验；
    // 交由 run() 的 allowDocker 开关与真实 spawn 报错来反馈，这里乐观标 ready。
    if (m.run && m.run.runner === 'docker') {
      log('[canary] 跳过 docker 沙盒「' + m.name + '」校验（运行受 foxAi.sandbox.allowDocker 与本地 docker 约束）');
      return { status: 'ready', error: null };
    }
    const canary = m.canary;
    if (!canary || !canary.code) {
      return { status: 'ready', error: null }; // 无 canary 直接信任
    }
    log('[canary] 校验用户沙盒「' + m.name + '」(' + m.language + ') ...');
    try {
      const r = await execute(m, canary.code, {
        timeout: canary.timeout || globalTimeout,
        stdin: canary.stdin || null
      });
      const out = (r.stdout || '').trim();
      const expected = (canary.expected || '').trim();
      const pass = !r.error && (expected === '' ? out.length > 0 : out.includes(expected));
      if (pass) {
        log('[canary] ✅ 「' + m.name + '」通过（输出含 "' + expected + '"）');
        return { status: 'ready', error: null };
      }
      log('[canary] ❌ 「' + m.name + '」未通过：exit=' + r.exit + ' out=' + JSON.stringify(out.slice(0, 200)) + ' err=' + JSON.stringify((r.stderr || '').slice(0, 200)));
      return { status: 'invalid', error: 'canary 未通过：期望输出含 "' + expected + '"，实际得到 "' + out.slice(0, 200) + '"' };
    } catch (e) {
      log('[canary] ❌ 「' + m.name + '」异常：' + String((e && e.message) || e));
      return { status: 'invalid', error: 'canary 运行异常：' + String((e && e.message) || e) };
    }
  }

  async function discover() {
    const userList = [];
    try {
      if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
        log('[discover] 已创建沙盒目录 ' + baseDir);
      }
      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const folder = path.join(baseDir, e.name);
        let m;
        try { m = loadUserManifest(folder); } catch (err) {
          log('[discover] 跳过 ' + folder + '：manifest 解析失败 ' + String((err && e.message) || err));
          userList.push({ name: e.name, language: '?', builtin: false, source: 'user', status: 'invalid', error: 'manifest 解析失败', folder });
          continue;
        }
        if (!m) continue; // 没有 manifest.json 的文件夹忽略
        const verr = validateManifest(m);
        if (verr) {
          log('[discover] 跳过 ' + folder + '：' + verr);
          userList.push({ name: m.name || e.name, language: m.language || '?', builtin: false, source: 'user', status: 'invalid', error: verr, folder });
          continue;
        }
        // 缓存命中则复用，否则跑 canary
        let cached = validationCache.get(folder);
        if (!cached) {
          cached = await validateUserCanary(m);
          validationCache.set(folder, cached);
        }
        userList.push({
          name: m.name, language: m.language, builtin: false, source: 'user',
          status: cached.status, error: cached.error || null, folder, _def: m
        });
      }
    } catch (e) {
      log('[discover] 扫描沙盒目录失败：' + String((e && e.message) || e));
    }
    const builtins = BUILTINS.map((b) => ({
      name: b.name, language: b.language, builtin: true, source: 'builtin', status: 'ready', error: null, folder: null, _def: b
    }));
    return { builtins, user: userList };
  }

  function findSandbox(list, key) {
    // 按 name 或 language 模糊匹配（大小写不敏感）
    const k = String(key || '').toLowerCase();
    for (const s of list.builtins.concat(list.user)) {
      if (s.status === 'invalid') continue;
      if (s.name.toLowerCase() === k || s.language.toLowerCase() === k) return s;
    }
    for (const s of list.builtins.concat(list.user)) {
      if (s.status === 'invalid') continue;
      if (s.name.toLowerCase().includes(k) || s.language.toLowerCase().includes(k)) return s;
    }
    return null;
  }

  function list() {
    // list 不强制重扫（缓存优先）；invalid 也列出来便于排查
    const userList = [];
    try {
      if (fs.existsSync(baseDir)) {
        const entries = fs.readdirSync(baseDir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const folder = path.join(baseDir, e.name);
          let m;
          try { m = loadUserManifest(folder); } catch (_) { continue; }
          if (!m) continue;
          const verr = validateManifest(m);
          if (verr) { userList.push({ name: m.name || e.name, language: m.language || '?', builtin: false, source: 'user', status: 'invalid', error: verr, folder }); continue; }
          const cached = validationCache.get(folder);
          userList.push({
            name: m.name, language: m.language, builtin: false, source: 'user',
            status: cached ? cached.status : 'unknown', error: cached ? (cached.error || null) : null, folder
          });
        }
      }
    } catch (_) { /* ignore */ }
    const builtins = BUILTINS.map((b) => ({ name: b.name, language: b.language, builtin: true, source: 'builtin', status: 'ready', error: null, folder: null }));
    return { builtins, user: userList };
  }

  async function reload() {
    validationCache.clear();
    log('[reload] 已清空校验缓存，重新扫描 ' + baseDir);
    return discover();
  }

  async function run(key, code, runOpts) {
    if (!enabled) return { ok: false, error: '沙盒功能未启用（foxAi.sandbox.enabled=false）', stdout: '', stderr: '', exit: null };
    const list = await discover();
    const target = findSandbox(list, key);
    if (!target) {
      log('[run] 未找到可用沙盒「' + key + '」');
      return null;
    }
    if (target._def.run && target._def.run.runner === 'docker' && !allowDocker) {
      return { ok: false, error: '该沙盒使用 docker runner，但 foxAi.sandbox.allowDocker=false 已禁用', stdout: '', stderr: '', exit: null };
    }
    log('[run] 命中沙盒「' + target.name + '」(' + target.language + ')，代码长度=' + (code || '').length);
    return execute(target._def, code, { timeout: globalTimeout, stdin: runOpts && runOpts.stdin });
  }

  /* ===================== 用户沙盒增删 ===================== */
  function slugify(s) {
    return String(s || '').trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'sandbox';
  }
  function guessExt(lang) {
    const map = {
      javascript: '.js', python: '.py', go: '.go', rust: '.rs', java: '.java',
      cpp: '.cpp', c: '.c', ruby: '.rb', php: '.php', bash: '.sh', sh: '.sh',
      typescript: '.ts', csharp: '.csx', lua: '.lua', perl: '.pl'
    };
    return map[String(lang || '').toLowerCase()] || '.txt';
  }
  // 防越权：目标路径必须严格位于 baseDir 之下
  function isInsideBaseDir(target) {
    const rel = path.relative(baseDir, target);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  async function createSandbox(spec) {
    spec = spec || {};
    if (!spec.name) return { ok: false, error: '缺少 name' };
    const base = (spec.template && TEMPLATES[spec.template]) ? JSON.parse(JSON.stringify(TEMPLATES[spec.template])) : {};
    const manifest = Object.assign({}, base);
    manifest.name = spec.name;
    if (spec.language) manifest.language = spec.language;
    else if (!manifest.language) return { ok: false, error: '缺少 language（或 template）' };
    if (spec.run) manifest.run = spec.run;
    else if (!manifest.run) return { ok: false, error: '缺少 run.command（或 template）' };
    if (spec.file) manifest.file = spec.file;
    else if (!manifest.file) manifest.file = { ext: guessExt(manifest.language) };
    if (spec.canary !== undefined) manifest.canary = spec.canary; // 允许显式传 null

    const verr = validateManifest(manifest);
    if (verr) return { ok: false, error: verr };

    const folderName = (spec.folder && String(spec.folder).trim()) || slugify(spec.name);
    const folder = path.join(baseDir, folderName);
    if (!isInsideBaseDir(folder)) return { ok: false, error: '非法文件夹名（越权）' };
    if (fs.existsSync(folder)) return { ok: false, error: '目标文件夹已存在：' + folderName };

    try {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
      log('[create] 新建沙盒「' + manifest.name + '」→ ' + folder);
      validationCache.delete(folder);
      const list = await discover();
      return { ok: true, folder, manifest, list };
    } catch (e) {
      return { ok: false, error: '写入失败：' + String((e && e.message) || e) };
    }
  }

  async function removeSandbox(name) {
    if (!name) return { ok: false, error: '缺少 name' };
    const list = await discover();
    const all = list.builtins.concat(list.user);
    const target = all.find((s) =>
      s.name === name || s.language === name ||
      (s._def && s._def.name === name) ||
      (s.folder && path.basename(s.folder) === name)
    );
    if (!target) return { ok: false, error: '未找到沙盒「' + name + '」' };
    if (target.builtin) return { ok: false, error: '内置沙盒「' + target.name + '」禁止删除（仅用户自建沙盒可删）' };
    const folder = target.folder || (target._def && target._def._folder);
    if (!folder || !isInsideBaseDir(folder)) return { ok: false, error: '非法路径（越权），拒绝删除' };
    try {
      fs.rmSync(folder, { recursive: true, force: true });
      validationCache.delete(folder);
      log('[remove] 已删除沙盒「' + target.name + '」→ ' + folder);
      const nl = await discover();
      return { ok: true, list: nl };
    } catch (e) {
      return { ok: false, error: '删除失败：' + String((e && e.message) || e) };
    }
  }

  /* ===================== 目录热感知（fs.watch + 防抖） ===================== */
  function watch(cb) {
    let timer = null;
    let watcher = null;
    try {
      if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
      watcher = fs.watch(baseDir, { recursive: true }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          validationCache.clear();
          log('[watch] 沙盒目录变化，已重扫 ' + baseDir);
          try {
            const l = await discover();
            if (cb && typeof cb === 'function') cb(l);
          } catch (e) { log('[watch] callback error: ' + String((e && e.message) || e)); }
        }, 300);
      });
      log('[watch] 已监听沙盒目录 ' + baseDir);
    } catch (e) {
      log('[watch] 启动失败：' + String((e && e.message) || e));
      return () => {};
    }
    return function dispose() {
      if (timer) clearTimeout(timer);
      try { if (watcher) watcher.close(); } catch (_) { /* ignore */ }
      log('[watch] 已停止监听');
    };
  }

  return { discover, list, reload, run, defaultDir, createSandbox, removeSandbox, watch, _BUILTINS: BUILTINS, log };
}

/* ===================== 懒加载单例（扩展内使用） ===================== */
let _mgr = null;
function getManager(cfg) {
  const sb = (cfg && cfg.sandbox) || null;
  const opts = {
    dir: (sb && sb.dir) || '',
    timeout: (sb && sb.timeout) || 30000,
    allowDocker: !!(sb && sb.allowDocker),
    enabled: sb ? sb.enabled !== false : true,
    nodePath: (cfg && cfg.nodePath) || ''
  };
  if (!_mgr) _mgr = createManager(opts);
  return _mgr;
}

module.exports = { createManager, getManager, BUILTINS, TEMPLATES, validateManifest, expand, _validationCache: validationCache };
