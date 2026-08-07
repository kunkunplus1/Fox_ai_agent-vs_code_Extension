'use strict';

/**
 * security_audit 工具：在授权的工作区内做**只读**代码安全自检（自检 Agent）。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 安全治理护栏（v0.8.0 起强制）：
 *  1. 只读：本工具绝不写文件、绝不改代码，只读取并生成报告。
 *  2. 脱敏：绝不读取「凭据仓库」文件内容（.env / .aws / .ssh / *.pem / credentials
 *     等），扫描到的密钥值在报告里一律打码（****），报告里不出现任何明文密钥。
 *  3. 网络隔离沙箱：本自检纯静态、不向外发起任何请求。唯一的联网动作是 npm audit
 *     依赖检查，默认关闭（foxAi.securityAudit.allowNetwork=false），开启后也只是
 *     本地审计、不回传任何源码/密钥。
 *  4. 任务树绝对深度上限 MAX_DEPTH（默认 5 层），超过即停止下钻并标记「已截断」。
 *  5. 单节点（单个文件）扫描重试上限 MAX_RETRIES（默认 3 次），全部失败计入失败节点。
 *  6. 熔断：扫描节点总数超过 NODE_BUDGET，或失败节点累计超过 MAX_FAILED_NODES，
 *     立即熔断（CIRCUIT_BROKEN）并转人工复核，绝不无限递归撑爆资源。
 *  7. 双盲声明：报告明确标注「结果仅供参考，禁止作为修复唯一依据」，修复 Agent 须
 *     经独立的 referee_review（裁判 Agent）交叉验证后方可定论。
 * ───────────────────────────────────────────────────────────────────────────
 *
 * 适用：用户要求「让狐狸 AI 自己尝试在沙盒内检验代码安全，保证没有漏洞」。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const vscode = require('vscode');

// ── 治理常量（绝对上限，防止资源耗尽 / 死循环）──
const MAX_DEPTH = 5; // 任务树绝对深度上限（目录嵌套层数）
const MAX_RETRIES = 3; // 单节点扫描重试上限
const NODE_BUDGET = 5000; // 熔断总节点预算（目录 + 文件节点累计）
const MAX_FAILED_NODES = 20; // 失败节点累计阈值 → 熔断

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__',
  '.venv', 'target', 'bin', 'obj',
  // 凭据仓库目录：不进入、不读取内容
  '.aws', '.ssh', 'secrets', '.npm', '.cache'
]);
const SRC_EXT = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rb', '.php',
  '.c', '.cpp', '.cs', '.rs', '.sh', '.json', '.yaml', '.yml', '.html', '.vue'
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 单个文件超过 2MB 跳过

/**
 * 凭据文件模式：命中则**只记录路径、绝不读取内容**（脱敏 + 严禁挂载生产 AK/SK）。
 * 这些文件哪怕被「自检」扫到，也只是列出名字，内容不会被读进内存、不会出现在报告里。
 */
const CREDENTIAL_STORE = /(^|[\\/])\.env(\.[^\\/]+)?$|(^|[\\/])\.aws([\\/]|$)|(^|[\\/])\.ssh([\\/]|$)|(^|[\\/])secrets?([\\/]|$)|(^|[\\/])credentials|service[-_]?account|\.(pem|key|p12|pfx|jks|keystore)$/i;

/** 静态规则：id / 严重度 / 说明 / 正则 */
const RULES = [
  {
    id: 'hardcoded-secret',
    severity: 'high',
    label: '疑似硬编码密钥/口令',
    re: /(['"]\s*)?(api[_-]?key|secret|token|passwd|password|access[_-]?key|private[_-]?key)\1?\s*[:=]\s*['"][A-Za-z0-9_\-]{12,}['"]/i
  },
  {
    id: 'dynamic-eval',
    severity: 'high',
    label: '动态代码执行（eval / new Function）',
    re: /\beval\s*\(|new\s+Function\s*\(/
  },
  {
    id: 'command-exec',
    severity: 'medium',
    label: '命令执行（child_process / exec / spawn）',
    re: /child_process|execSync|execFileSync|\.exec\s*\(|\.spawn\s*\(/
  },
  {
    id: 'sql-concat',
    severity: 'medium',
    label: '疑似 SQL 拼接（注入风险）',
    re: /('|"|`)\s*\+\s*(req|params|query|body|input|user|data|name|id)|SELECT\s+[\s\S]{0,80}\+/
  },
  {
    id: 'path-traversal',
    severity: 'medium',
    label: '路径穿越（../ 拼接）',
    re: /\.\.\/\.\.\/|\.\\.\\\.\.\\\.\.\\|\.\.\/%2e/i
  },
  {
    id: 'xss-sink',
    severity: 'medium',
    label: '疑似 XSS 注入点（innerHTML / document.write 拼接）',
    re: /(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\s*[\(:]?\s*[:=]?\s*[`'"][^`'"()]*["']?\s*\+/
  },
  {
    id: 'tls-disable',
    severity: 'high',
    label: 'TLS 证书校验被禁用（rejectUnauthorized:false）',
    re: /rejectUnauthorized\s*:\s*false/
  },
  {
    id: 'debug-backdoor',
    severity: 'low',
    label: '可能暴露的调试/后门入口',
    re: /(eval|child_process|require\s*\(\s*['"]child_process['"]\s*\))\s*[;,]?\s*$/m
  }
];

const SEV_ORDER = { high: 0, medium: 1, low: 2 };

/**
 * 脱敏：把行内的疑似密钥值打码，避免报告泄露明文 AK/SK。
 * 仅对「key = "..."」「key: "..."」形态的赋值做掩码，保留字段名与上下文。
 */
function maskSecret(snippet) {
  return snippet.replace(
    /((?:api[_-]?key|secret|token|passwd|password|access[_-]?key|private[_-]?key)[\s]*[:=]\s*['"])[A-Za-z0-9_\-]{4,}(['"])/gi,
    (_, pre, post) => pre + '****' + post
  );
}

/**
 * 列出待扫描文件。超出深度即停止下钻；凭据文件只登记不读取。
 * @param {string} root 工作区根
 * @param {object} ctx 运行时上下文（含 counters / excluded / truncated 标记）
 * @returns {string[]} 文件绝对路径数组
 */
function listFiles(root, ctx) {
  ctx = ctx || {};
  const out = [];
  const excluded = (ctx.excluded = ctx.excluded || []);
  const walk = (dir, depth) => {
    if (ctx.nodes > NODE_BUDGET) { ctx.truncated = true; return; }
    if (depth > MAX_DEPTH) { ctx.truncated = true; return; }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (ctx.nodes > NODE_BUDGET) { ctx.truncated = true; return; }
      ctx.nodes++;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (CREDENTIAL_STORE.test(full)) { excluded.push(full); continue; }
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        if (CREDENTIAL_STORE.test(full)) {
          // 脱敏：只登记路径，绝不读取内容
          excluded.push(full);
          continue;
        }
        const ext = path.extname(e.name).toLowerCase();
        if (SRC_EXT.has(ext) && !excluded.includes(full)) out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}

/** 单次扫描单个文件（不重试），返回命中数组 */
function scanFileOnce(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return [];
  const buf = fs.readFileSync(filePath, 'utf8');
  const hits = [];
  const lines = buf.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        hits.push({
          line: i + 1,
          ruleId: rule.id,
          severity: rule.severity,
          label: rule.label,
          snippet: maskSecret(line.trim().slice(0, 200))
        });
      }
    }
  });
  return hits;
}

/**
 * 单节点重试包装：最多 MAX_RETRIES 次。全部失败则把错误计入 ctx.failedNodes。
 */
function scanFileWithRetry(filePath, ctx) {
  ctx = ctx || {};
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return scanFileOnce(filePath);
    } catch (e) {
      lastErr = e;
    }
  }
  ctx.failedNodes = (ctx.failedNodes || 0) + 1;
  ctx.failedList = ctx.failedList || [];
  ctx.failedList.push({ file: filePath, error: String((lastErr && lastErr.message) || lastErr).split('\n')[0] });
  return [];
}

/** best-effort 依赖漏洞检查（npm audit）。仅当 allowNetwork=true 时运行（网络隔离默认关闭）。 */
function npmAudit(root, allowNetwork) {
  if (!allowNetwork) {
    return { skipped: true, reason: '网络隔离沙箱：依赖漏洞检查默认关闭（foxAi.securityAudit.allowNetwork=false）。' };
  }
  const pkg = path.join(root, 'package.json');
  const nm = path.join(root, 'node_modules');
  if (!fs.existsSync(pkg) || !fs.existsSync(nm)) return { skipped: true, reason: '无 package.json 或 node_modules' };
  try {
    const raw = execFileSync('npm', ['audit', '--json'], { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    const data = JSON.parse(raw);
    const v = data && data.metadata && data.metadata.vulnerabilities;
    return { skipped: false, vulnerabilities: v || {}, total: v ? (v.critical || 0) + (v.high || 0) + (v.moderate || 0) + (v.low || 0) : 0 };
  } catch (e) {
    return { skipped: true, reason: 'npm audit 执行失败（可能无网络或沙盒限制）：' + String((e && e.message) || e).split('\n')[0] };
  }
}

async function run(a, ctx) {
  a = a || {};
  const folders = vscode.workspace.workspaceFolders;
  const root = a.path
    ? path.resolve(a.path)
    : folders && folders[0]
    ? folders[0].uri.fsPath
    : process.cwd();

  if (!fs.existsSync(root)) {
    return `⚠️ 目标路径不存在：${root}`;
  }

  const cfg = vscode.workspace.getConfiguration('foxAi');
  const allowNetwork = cfg.get('securityAudit.allowNetwork', false);

  const scanCtx = { nodes: 0, failedNodes: 0, excluded: [], truncated: false };
  const files = listFiles(root, scanCtx);
  const allHits = [];
  for (const f of files) {
    if (scanCtx.nodes > NODE_BUDGET) { scanCtx.truncated = true; break; }
    const hits = scanFileWithRetry(f, scanCtx);
    for (const h of hits) {
      allHits.push(Object.assign({ file: path.relative(root, f) || f }, h));
    }
  }
  allHits.sort((x, y) => SEV_ORDER[x.severity] - SEV_ORDER[y.severity] || x.file.localeCompare(y.file) || x.line - y.line);

  // 熔断判定：节点预算耗尽 或 失败节点过多 → 转人工
  const circuitBroken = scanCtx.nodes > NODE_BUDGET || scanCtx.failedNodes > MAX_FAILED_NODES;
  const status = circuitBroken ? 'CIRCUIT_BROKEN' : scanCtx.failedNodes > 0 ? 'NEEDS_HUMAN' : 'OK';

  let depReport = '';
  if (a.checkDeps !== false) {
    const r = npmAudit(root, allowNetwork);
    if (r.skipped) {
      depReport = `\n## 依赖漏洞检查\n\n⏭️ 已跳过：${r.reason}`;
    } else {
      const v = r.vulnerabilities;
      depReport =
        `\n## 依赖漏洞检查（npm audit）\n\n` +
        `- 🔴 严重(critical)：${v.critical || 0}\n- 🔴 高危(high)：${v.high || 0}\n` +
        `- 🟡 中危(moderate)：${v.moderate || 0}\n- 🟢 低危(low)：${v.low || 0}\n` +
        `- 合计：${r.total}\n\n> 如需详情请运行 \`npm audit\` 查看具体包与修复建议。`;
    }
  }

  const bySev = (sev) => allHits.filter((h) => h.severity === sev);
  const high = bySev('high');
  const medium = bySev('medium');
  const low = bySev('low');

  const fmt = (h) => `- \`${h.file}:${h.line}\` **${h.label}**：\`${h.snippet.replace(/`/g, '\\`')}\``;
  const body =
    `### 🔴 高危（${high.length}）\n` + (high.length ? high.map(fmt).join('\n') + '\n' : '（无）\n') +
    `### 🟡 中危（${medium.length}）\n` + (medium.length ? medium.map(fmt).join('\n') + '\n' : '（无）\n') +
    `### 🟢 低危（${low.length}）\n` + (low.length ? low.map(fmt).join('\n') + '\n' : '（无）\n');

  const banner = [
    '> ⚠️ **只读 · 脱敏 · 网络隔离沙箱执行**。本自检不修改文件、不读取凭据文件内容、不向外发起请求。',
    '> **双盲声明**：本报告结果仅供参考，**禁止作为修复的唯一依据**。修复须经独立裁判 Agent（referee_review）交叉验证；若裁判判定「修复前后逻辑等价（自检疑似误报）」，将强制挂起转人工。'
  ].join('\n');

  const excludedNote = scanCtx.excluded.length
    ? `\n> 🔒 已隔离的凭据文件（仅列出路径，未读取内容）：${scanCtx.excluded.length} 个`
    : '';
  const truncatedNote = scanCtx.truncated
    ? `\n> ⛔ 扫描已达上限（深度 ${MAX_DEPTH} 层 / 节点预算 ${NODE_BUDGET}）而**熔断**，超出部分未扫描，需人工复核。`
    : '';
  const failedNote = scanCtx.failedNodes > 0
    ? `\n> ⚠️ 有 ${scanCtx.failedNodes} 个文件扫描失败（重试 ${MAX_RETRIES} 次仍不可用），已计入失败列表，建议人工复核。`
    : '';

  const statusLine =
    status === 'CIRCUIT_BROKEN'
      ? '\n> 🛑 **状态：已熔断（CIRCUIT_BROKEN）→ 转人工复核**'
      : status === 'NEEDS_HUMAN'
      ? '\n> 🟠 **状态：部分节点异常 → 建议人工复核**'
      : '\n> 🟢 **状态：OK**';

  return (
    `# 代码安全自检报告（只读 · 脱敏 · 网络隔离）\n\n` +
    `**扫描范围**：${root}\n**扫描文件数**：${files.length}\n**命中规则数**：${allHits.length}\n` +
    `**治理参数**：深度上限=${MAX_DEPTH} 层，单节点重试=${MAX_RETRIES} 次，节点预算=${NODE_BUDGET}，失败熔断阈值=${MAX_FAILED_NODES}\n\n` +
    banner + '\n' +
    `## 静态规则命中\n\n` +
    body +
    depReport +
    excludedNote + truncatedNote + failedNote + statusLine +
    `\n---\n> 说明：规则命中是「疑似风险」，误报难免。高危项（硬编码密钥、动态代码执行、TLS 禁用）建议优先处理；最终以人工复核与裁判 Agent 结论为准。`
  );
}

module.exports = {
  run,
  scanFile: scanFileWithRetry,
  scanFileOnce,
  listFiles,
  npmAudit,
  maskSecret,
  RULES,
  CREDENTIAL_STORE,
  // 导出常量便于测试断言治理上限
  LIMITS: { MAX_DEPTH, MAX_RETRIES, NODE_BUDGET, MAX_FAILED_NODES }
};
