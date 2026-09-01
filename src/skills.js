'use strict';

/**
 * src/skills.js — 狐狸 AI 的用户技能（agent 自己给自己写的可复用工作流）
 *
 * 与「自带技能」（WorkBuddy 的 ~/.workbuddy/skills/）完全隔开：
 * 用户技能只存在 fox-ai 自己的 globalStorage 下「user-skills/」目录，
 * 由 agent 通过 create_skill 自主创建、use_skill 自主调用。
 *
 * 每个技能是一个目录：user-skills/<name>/SKILL.md
 *   SKILL.md 顶部是 YAML frontmatter（name / description / when_to_use），下面是 Markdown 指导。
 *   可选的 run.js 是该技能的脚本，use_skill 激活时会被执行。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MAX_PROMPT_CHARS = 2000;

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(process.env.HOME || process.env.USERPROFILE || '', p.slice(2));
  if (p.startsWith('~\\')) return path.join(process.env.USERPROFILE || '', p.slice(2));
  return p;
}

/**
 * 找到能用于执行 node 脚本的 node 可执行文件。
 * 注意：VS Code 扩展宿主里 process.execPath 是 Code.exe / Electron，
 * 不能直接当 node 用；必须找到真正的 node，否则脚本会被当成 Electron 启动而报错。
 */
function resolveNodeBin() {
  try {
    execFileSync('node', ['-v'], { stdio: 'ignore' });
    return 'node';
  } catch (_) { /* 不在 PATH */ }
  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs', 'node.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'node.exe'),
    process.env.NVM_HOME && path.join(process.env.NVM_HOME, 'node.exe'),
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe'
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'node';
}

function resolveDir(globalStorageDir, customDir) {
  return (customDir || '').trim()
    ? path.join(path.resolve(expandHome(customDir)), 'user-skills')
    : path.join(globalStorageDir || '', 'user-skills');
}

function defaultDir(globalStorageDir) {
  return resolveDir(globalStorageDir, '');
}

function skillDir(baseDir, name) {
  return path.join(baseDir, name);
}

function sanitizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function parseFrontmatter(text) {
  const m = String(text || '').match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: String(text || '') };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[k] = v;
  }
  return { meta, body: String(text || '').slice(m[0].length) };
}

/* ---------------- GitHub skill 导入 ---------------- */

/**
 * 解析 GitHub 链接，判定类型并提取 owner/repo/branch/子路径。
 * 支持两类：
 *   A. raw 文件：https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path...}/SKILL.md
 *   B. 仓库页：https://github.com/{owner}/{repo} 或 .../tree/{branch}/{path...}
 * 返回 { type:'raw'|'repo', owner, repo, branch, path }；非 GitHub 链接返回 null。
 */
function parseGitHubUrl(url) {
  const u = String(url || '').trim();
  let m;
  // A. raw.githubusercontent.com
  m = u.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/([\s\S]+)$/i);
  if (m) return { type: 'raw', owner: m[1], repo: m[2], branch: m[3], path: m[4] };
  // B. github.com/{owner}/{repo}
  m = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)/i);
  if (m) {
    const rest = u.slice(u.indexOf(m[2]) + m[2].length);
    let branch = '';
    let path = '';
    let tm = rest.match(/^\/tree\/([^/]+)(?:\/([\s\S]*))?$/);
    if (tm) {
      branch = tm[1];
      path = tm[2] || '';
    }
    return { type: 'repo', owner: m[1], repo: m[2].replace(/\.git$/i, ''), branch, path };
  }
  // C. GitLab raw 文件：https://gitlab.com/{owner}/{repo}/-/raw/{branch}/{path...}/SKILL.md
  m = u.match(/^https?:\/\/gitlab\.com\/([^/]+)\/([^/?#]+)\/-\/raw\/([^/]+)\/([\s\S]+)$/i);
  if (m) return { type: 'raw', owner: m[1], repo: m[2].replace(/\.git$/i, ''), branch: m[3], path: m[4] };
  // D. Gitee raw 文件：https://gitee.com/{owner}/{repo}/raw/{branch}/{path...}/SKILL.md
  m = u.match(/^https?:\/\/gitee\.com\/([^/]+)\/([^/?#]+)\/raw\/([^/]+)\/([\s\S]+)$/i);
  if (m) return { type: 'raw', owner: m[1], repo: m[2].replace(/\.git$/i, ''), branch: m[3], path: m[4] };
  // E. 任何 https 直链：文件以 .md/.txt 结尾 → 直接当 SKILL.md 内容源（普通文件链接 / zip 内的 SKILL.md 不适用，zip 需先解压）
  if (/^https?:\/\/[^/]+\/[^?#]+\.(md|markdown|txt)(\?|#|$)/i.test(u)) {
    return { type: 'file', url: u, owner: '', repo: 'skill', branch: '', path: '' };
  }
  return null;
}

/** 生成仓库 SKILL.md 的候选 raw URL 列表（按可能性排序，逐个尝试直到命中） */
function candidateSkillUrls(parsed) {
  const { owner, repo, branch, path } = parsed;
  const b = branch || 'main';
  const base = `https://raw.githubusercontent.com/${owner}/${repo}/${b}/`;
  const cands = [];
  // 用户给了子路径（tree 链接）→ 优先在子路径下找
  if (path) {
    cands.push(base + path.replace(/\/+$/, '') + '/SKILL.md');
    cands.push(base + path.replace(/\/+$/, '') + '/skill/SKILL.md');
  }
  // 仓库根
  cands.push(base + 'SKILL.md');
  // 常见嵌套：skills/<repo>/、skills/<name>/、skill/<repo>/
  cands.push(base + `skills/${repo}/SKILL.md`);
  cands.push(base + `skills/${sanitizeName(repo)}/SKILL.md`);
  cands.push(base + `skill/${repo}/SKILL.md`);
  cands.push(base + `skills/SKILL.md`);
  return cands;
}

/**
 * 带重定向跟随的 https GET（最多 5 跳），返回 { status, body }；超时 15s。
 * 代理支持：传入 proxy 形如 http://127.0.0.1:7890（http 代理），
 * 走 CONNECT 隧道；不走代理时直连。用于绕过 GitHub raw 被墙的网络环境。
 */
function httpsGet(url, redirects = 0, proxy = '') {
  return new Promise((resolve) => {
    const https = require('https');
    const http = require('http');
    const parsed = new URL(url);
    const useProxy = proxy && /^https?:\/\//i.test(proxy);
    const send = (opts, path) => {
      const lib = useProxy ? http : https;
      const req = lib.request(opts, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirects >= 5) return resolve({ status: res.statusCode, body: '' });
          return resolve(httpsGet(new URL(res.headers.location, url).toString(), redirects + 1, proxy));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
      req.on('error', () => resolve({ status: 0, body: '' }));
      req.end();
      return req;
    };
    if (useProxy) {
      // HTTP 代理 CONNECT 隧道
      const p = new URL(proxy);
      const connectReq = http.request({
        hostname: p.hostname,
        port: p.port || 80,
        method: 'CONNECT',
        path: `${parsed.hostname}:${parsed.port || 443}`,
        timeout: 15000
      });
      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          return resolve({ status: 0, body: '' });
        }
        const tls = require('tls');
        const tlsSock = tls.connect(
          { socket, servername: parsed.hostname },
          () => {
            const req = https.request(
              { createConnection: () => tlsSock, hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'GET', headers: { 'User-Agent': 'fox-ai/1.1.15 (skill importer)' }, timeout: 15000 },
              (res2) => {
                if ([301, 302, 303, 307, 308].includes(res2.statusCode) && res2.headers.location) {
                  res2.resume();
                  if (redirects >= 5) return resolve({ status: res2.statusCode, body: '' });
                  return resolve(httpsGet(new URL(res2.headers.location, url).toString(), redirects + 1, proxy));
                }
                const chunks = [];
                res2.on('data', (c) => chunks.push(c));
                res2.on('end', () => resolve({ status: res2.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
              }
            );
            req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
            req.on('error', () => resolve({ status: 0, body: '' }));
            req.end();
          }
        );
        tlsSock.on('error', () => resolve({ status: 0, body: '' }));
      });
      connectReq.on('timeout', () => { connectReq.destroy(); resolve({ status: 0, body: '' }); });
      connectReq.on('error', () => resolve({ status: 0, body: '' }));
      connectReq.end();
    } else {
      send(
        {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers: { 'User-Agent': 'fox-ai/1.1.15 (skill importer)' },
          timeout: 15000
        },
        parsed.pathname + parsed.search
      );
    }
  });
}

/** 从环境变量/常见位置探测代理：HTTPS_PROXY > HTTP_PROXY > ALL_PROXY */
function detectProxy() {
  const e = process.env;
  return String(e.HTTPS_PROXY || e.https_proxy || e.HTTP_PROXY || e.http_proxy || e.ALL_PROXY || e.all_proxy || '').trim() || '';
}

/** 尝试候选 URL 列表，返回第一个 200 的 { url, body }；全失败返回 null */
async function fetchFirst(cands, proxy) {
  for (const u of cands) {
    const r = await httpsGet(u, 0, proxy);
    if (r.status === 200 && r.body && r.body.trim()) return { url: u, body: r.body };
  }
  return null;
}

/** 从 SKILL.md 内容推断技能名：frontmatter.name > 目录/仓库名 */
function inferSkillName(raw, fallback) {
  const { meta } = parseFrontmatter(raw);
  const n = sanitizeName(meta.name || fallback || '');
  return n || 'imported-skill';
}

/** 补齐/规范化 frontmatter：保证 name / description / when_to_use 三项都在 */
function normalizeSkillFile(raw, name, fallbackDesc) {
  const { meta, body } = parseFrontmatter(raw);
  const safe = sanitizeName(name || meta.name) || 'imported-skill';
  const desc = String(meta.description || fallbackDesc || '').slice(0, 200);
  const when = String(meta.when_to_use || '').trim() || '用户需求与该技能描述匹配、或明确要求使用该技能时';
  return buildSkillFile({ name: safe, description: desc, whenToUse: when, body: body || '' });
}

/** 从 GitHub 下载并导入一个技能到本目录。返回 { ok, name, path, errors, sourceUrl } */
async function importFromUrl(url, opts = {}) {
  const errors = [];
  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    return { ok: false, errors: ['仅支持 GitHub 链接：仓库页 https://github.com/… 或 raw 文件 https://raw.githubusercontent.com/…'], name: '', path: '' };
  }
  // 代理：显式传入 > 环境变量探测（HTTPS_PROXY/HTTP_PROXY/ALL_PROXY）。GitHub raw 直连常被墙，走代理更稳。
  const proxy = String(opts.proxy || '').trim() || detectProxy();
  try {
    let skillMd = null;
    let scriptRaw = null;
    if (parsed.type === 'raw') {
      // raw 链接：直接取该文件当 SKILL.md；同目录试 run.js
      const r = await httpsGet(url, 0, proxy);
      if (r.status !== 200 || !r.body) return { ok: false, errors: ['raw 文件下载失败（HTTP ' + r.status + '）：' + url + (proxy ? '' : '（若直连被墙，可先配置系统代理或用镜像链接）')], name: '', path: '' };
      skillMd = r.body;
      const dir = parsed.path.slice(0, parsed.path.lastIndexOf('/'));
      if (dir && parsed.owner) {
        // 同平台同位置试 run.js：把 SKILL.md 文件名换成 run.js（GitHub/GitLab/Gitee raw 通用）
        const scriptUrl = url.slice(0, url.indexOf(parsed.path)) + dir + '/run.js';
        const sr = await httpsGet(scriptUrl, 0, proxy);
        if (sr.status === 200 && sr.body && sr.body.trim()) scriptRaw = sr.body;
      }
    } else if (parsed.type === 'file') {
      // 任意 https 直链（.md/.markdown/.txt）：直接当 SKILL.md 内容源
      const r = await httpsGet(url, 0, proxy);
      if (r.status !== 200 || !r.body) return { ok: false, errors: ['文件直链下载失败（HTTP ' + r.status + '）：' + url], name: '', path: '' };
      skillMd = r.body;
    } else {
      // 仓库链接：候选路径逐个试
      const cands = candidateSkillUrls(parsed);
      const hit = await fetchFirst(cands, proxy);
      if (!hit) {
        return { ok: false, errors: ['仓库中未找到 SKILL.md（试过：' + cands.slice(0, 4).join('、') + ' 等）。请确认该仓库是 Agent Skill 格式（含 SKILL.md），或改用 raw 文件链接。' + (proxy ? '' : '（若直连 GitHub 被墙，请先配置系统代理后重试）')], name: '', path: '' };
      }
      skillMd = hit.body;
      // 同目录试 run.js（把 SKILL.md 换成 run.js）
      const dir = hit.url.slice(0, hit.url.lastIndexOf('/'));
      const sr = await httpsGet(dir + '/run.js', 0, proxy);
      if (sr.status === 200 && sr.body && sr.body.trim()) scriptRaw = sr.body;
    }

    // 校验并规范化
    const name = sanitizeName(opts.name) || inferSkillName(skillMd, parsed.repo);
    if (!skillMd.trim()) errors.push('SKILL.md 内容为空');
    if (errors.length) return { ok: false, errors, name: '', path: '' };

    const content = normalizeSkillFile(skillMd, name, parsed.repo);
    const dir = skillDir(this.baseDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const skillPath = path.join(dir, 'SKILL.md');
    fs.writeFileSync(skillPath, content, 'utf8');

    let scriptNote = '';
    if (scriptRaw && String(scriptRaw).trim()) {
      const scriptPath = path.join(dir, 'run.js');
      fs.writeFileSync(scriptPath, String(scriptRaw), 'utf8');
      try {
        execFileSync(resolveNodeBin(), ['--check', scriptPath], { stdio: 'pipe' });
        scriptNote = '（含 run.js，已通过语法检查）';
      } catch (e) {
        // 脚本语法不合法也保留文件，但提示用户
        scriptNote = '（含 run.js，但语法检查未通过，激活时可能报错，请人工检查）';
      }
    }
    return { ok: true, name, path: skillPath, errors, sourceUrl: url, scriptNote };
  } catch (e) {
    return { ok: false, errors: ['导入失败：' + String((e && e.message) || e)], name: '', path: '' };
  }
}

function buildSkillFile({ name, description, whenToUse, body, interactive }) {
  const fm =
    '---\n' +
    `name: ${name}\n` +
    `description: ${description || ''}\n` +
    `when_to_use: ${whenToUse || ''}\n` +
    `interactive: ${interactive ? 'true' : 'false'}\n` +
    '---\n\n' +
    (body && body.trim() ? body.trim() + '\n' : '');
  return fm;
}

class UserSkillStore {
  constructor(globalStorageDir, customDir) {
    this.baseDir = resolveDir(globalStorageDir, customDir);
  }

  list() {
    try {
      if (!fs.existsSync(this.baseDir)) return [];
      return fs
        .readdirSync(this.baseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => this._metaOf(d.name))
        .filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  _metaOf(name) {
    const dir = skillDir(this.baseDir, name);
    const file = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    return {
      name: meta.name || name,
      description: meta.description || '',
      whenToUse: meta.when_to_use || '',
      interactive: meta.interactive === 'true' || meta.interactive === true,
      hasScript: fs.existsSync(path.join(dir, 'run.js')),
      path: file,
      body
    };
  }

  get(name) {
    const dir = skillDir(this.baseDir, name);
    const file = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
  }

  /**
   * 创建一个用户技能。body 为 Markdown 指导正文；script 可选，为脚本源码（写入 run.js 并做 node --check）。
   * @returns { ok:boolean, errors:string[], path:string }
   */
  create({ name, description, whenToUse, body, script, interactive, overwrite }) {
    const errors = [];
    const safe = sanitizeName(name);
    if (!safe) errors.push('技能名不能为空，且只能包含小写字母、数字、-、_');
    if (!body || !String(body).trim()) errors.push('技能指导 body 不能为空');
    if (errors.length) return { ok: false, errors, path: '' };

    // 去重：已存在的同名技能默认禁止重复创建，避免模型陷入
    // 「use_skill 激活 → create_skill 同名重写」的死循环（见 0.8.61）。
    // 模型应直接 use_skill 激活执行，或用 create_plan_task 跟踪进度；
    // 确实需要更新技能内容时，显式传 overwrite:true 即可。
    const existing = this._metaOf(safe);
    if (existing && !overwrite) {
      return {
        ok: false,
        errors: [
          `技能「${safe}」已存在，禁止重复创建。请直接用 use_skill 激活它执行任务，` +
          `或用 create_plan_task 把本次需求拆成可见清单；不要再次调用 create_skill。` +
          `（若你确实要主动更新该技能内容，请显式传 overwrite:true。）`
        ],
        path: existing.path
      };
    }

    const dir = skillDir(this.baseDir, safe);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      return { ok: false, errors: ['无法创建技能目录：' + e.message], path: '' };
    }

    // 写 SKILL.md
    const content = buildSkillFile({ name: safe, description, whenToUse, body, interactive });
    const skillPath = path.join(dir, 'SKILL.md');
    try {
      fs.writeFileSync(skillPath, content, 'utf8');
    } catch (e) {
      errors.push('写入 SKILL.md 失败：' + e.message);
      return { ok: false, errors, path: skillPath };
    }

    // 可选脚本：写入并自动校验语法
    if (script && String(script).trim()) {
      const scriptPath = path.join(dir, 'run.js');
      try {
        fs.writeFileSync(scriptPath, String(script), 'utf8');
      } catch (e) {
        errors.push('写入脚本失败：' + e.message);
        return { ok: false, errors, path: skillPath };
      }
      try {
        execFileSync(resolveNodeBin(), ['--check', scriptPath], { stdio: 'pipe' });
      } catch (e) {
        errors.push('脚本语法检查未通过（node --check）：' + String(e.stderr || e.message).split('\n').slice(0, 3).join(' '));
        return { ok: false, errors, path: skillPath };
      }
    }

    return { ok: true, errors, path: skillPath };
  }

  remove(name) {
    const safe = sanitizeName(name);
    const dir = skillDir(this.baseDir, safe);
    if (!fs.existsSync(dir)) return false;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 激活一个技能：读取指导；非交互式脚本会在这里执行，交互式脚本请在外部用终端启动 */
  activate(name, query) {
    const meta = this._metaOf(name);
    if (!meta) return { ok: false, reason: `没有名为「${name}」的技能`, guidance: '', output: '', hasScript: false, interactive: false };
    let scriptOut = '';
    // 交互式脚本不在此处执行（避免阻塞 stdin），由调用方启动到集成终端
    if (meta.hasScript && !meta.interactive) {
      const scriptPath = path.join(skillDir(this.baseDir, name), 'run.js');
      try {
        scriptOut = execFileSync(resolveNodeBin(), [scriptPath], { cwd: skillDir(this.baseDir, name), encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        scriptOut = '[脚本执行出错] ' + String(e.stderr || e.message).split('\n').slice(0, 5).join('\n');
      }
    }
    return { ok: true, reason: '', guidance: meta.body, output: scriptOut, whenToUse: meta.whenToUse, hasScript: meta.hasScript, interactive: meta.interactive };
  }

  /** 生成注入系统提示词的技能清单（带大小上限） */
  renderForPrompt() {
    const items = this.list();
    if (!items.length) return '';
    const lines = ['你拥有以下用户技能（agent 自己编写的可复用工作流），当用户需求匹配 when_to_use 时，应调用 use_skill 激活它并按其指导执行：'];
    let chars = 0;
    for (const it of items) {
      const line = `- ${it.name}：${it.description}${it.whenToUse ? '（适用：' + it.whenToUse + '）' : ''}${it.hasScript ? ' [含脚本]' : ''}`;
      if (chars + line.length + 20 > MAX_PROMPT_CHARS) break;
      lines.push(line);
      chars += line.length;
    }
    return lines.join('\n');
  }

  /** 从 GitHub 导入技能到本目录（见 importFromUrl 纯函数） */
  importFromUrl(url, opts) {
    return importFromUrl.call(this, url, opts);
  }
}

module.exports = { UserSkillStore, defaultDir, sanitizeName, resolveDir, parseGitHubUrl, parseSkillUrl: parseGitHubUrl, candidateSkillUrls, inferSkillName, normalizeSkillFile, httpsGet, fetchFirst, detectProxy };
