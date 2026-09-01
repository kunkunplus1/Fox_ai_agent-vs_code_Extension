'use strict';

/**
 * skill_audit 工具：技能安全审查（Agent 自己下载技能后、启用前做只读安全审查）。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 安全治理护栏（与 security_audit 同源）：
 *  1. 只读：本工具绝不修改技能文件、绝不写文件，只读取并生成报告。
 *  2. 脱敏：命中的疑似密钥值一律打码（****），报告不出现明文。
 *  3. 网络隔离：纯静态审查，不对外发起任何请求（技能里的外联域名只做静态标记）。
 *  4. 分级：high（必须修/不可启用）/ medium（需确认）/ low（建议）三档，附定位行号。
 * ───────────────────────────────────────────────────────────────────────────
 *
 * 适用：用户要求「插件狐狸 AI 加个自己去网上下载技能并自己调用工具审查安全性，
 * 再自己给自己配置的技能」——下载技能后，先静态审查再决定是否启用。
 */

const fs = require('fs');
const path = require('path');

// vscode 只在 run() 需要默认技能目录时才 require（懒加载）：
// 审查引擎本身是纯文件扫描，这样纯 node 环境也能 require 测试。
let vscode = null;
function getVscode() {
  if (!vscode) vscode = require('vscode');
  return vscode;
}

const MAX_FILE_BYTES = 512 * 1024; // 单个技能文件超 512KB 跳过
const MAX_FILES = 100; // 单个技能目录最多审查文件数（防 zip 炸弹式海量文件）

/**
 * 技能专属静态规则。全部是「疑似风险」标记，不自动拦截，
 * 由 Agent（必要时转人工）结合上下文决定是否启用。
 * source: file 命中 SKILL.md / run.js 等文件；line 为行号。
 */
const SKILL_RULES = [
  // ── 提示注入 / 越权指示 ──
  {
    id: 'prompt-injection',
    severity: 'high',
    category: '提示注入',
    label: 'SKILL.md 指示忽略系统规则/用户指令（提示注入）',
    re: /(忽略|无视|不要管|不用理会)\s*(系统|用户|之前|以上|上级)(提示|指令|规则|约束|要求)|disregard\s+(system|instructions|rules)|ignore\s+(your\s+)?(system|previous|instructions)/i,
    source: 'SKILL.md'
  },
  {
    id: 'forced-output',
    severity: 'high',
    category: '提示注入',
    label: '要求输出固定内容/隐藏自身身份（越权指示）',
    re: /(你必须|一定要|只能|无条件)(输出|回复|重复|背诵|假装|扮演)(上述|下面|这段|指令|内容|文字)|always\s+(output|respond|say|repeat)/i,
    source: 'SKILL.md'
  },
  // ── 危险命令 / 恶意脚本 ──
  {
    id: 'destructive-rm',
    severity: 'high',
    category: '危险命令',
    label: '递归强制删除（rm -rf / del /s /q）',
    re: /\brm\s+-rf?\b|\brm\s+-[a-z]*r[a-z]*f\b|del\s+\/[sq]\s+\/[sq]\b/i,
    source: 'all'
  },
  {
    id: 'curl-pipe-sh',
    severity: 'high',
    category: '危险命令',
    label: '下载即执行（curl|sh / wget|sh / powershell -c 远程脚本）',
    re: /(curl|wget|iwr|Invoke-WebRequest)[^|;\n]*\|\s*(sh|bash|zsh|pwsh|powershell)|curl[^|;\n]*\|\s*node|powershell\s+-[ec]\s+.*(http|https)/i,
    source: 'all'
  },
  {
    id: 'eval-exec',
    severity: 'high',
    category: '动态执行',
    label: '动态代码执行（eval / new Function / exec 命令串）',
    re: /\beval\s*\(|new\s+Function\s*\(|child_process|execSync|execFileSync|\.exec\s*\(|\.spawn\s*\(/,
    source: 'run.js'
  },
  {
    id: 'base64-obfuscation',
    severity: 'high',
    category: '混淆',
    label: 'base64/hex 混淆执行（解码后执行，常见恶意载荷）',
    re: /Buffer\.from\([^)]*,\s*['"]base64['"]\)|atob\(|fromBase64|base64\s*-\s*d|\[.*\]\.map\(.*fromCharCode\)/i,
    source: 'all'
  },
  {
    id: 'exfil-url',
    severity: 'high',
    category: '数据外泄',
    label: '疑似外联回传（post/get 到外部域名收集数据）',
    re: /https?:\/\/[^\s"')\]]+[^a-zA-Z0-9]?(webhook|collect|callback|upload|beacon|ingest|track|hook)[^\s"')\]]*/i,
    source: 'all'
  },
  {
    id: 'env-exfil',
    severity: 'medium',
    category: '数据外泄',
    label: '读取环境变量/密钥文件并外发（process.env + 网络）',
    re: /process\.env\.[A-Z_]+[\s\S]{0,120}(https?:\/\/|fetch|request|post|upload)/i,
    source: 'run.js'
  },
  {
    id: 'hardcoded-secret',
    severity: 'high',
    category: '密钥',
    label: '疑似硬编码密钥/口令（报告内打码）',
    re: /(['"]\s*)?(api[_-]?key|secret|token|passwd|password|access[_-]?key|private[_-]?key|\bkey)\1?\s*[:=]\s*['"][A-Za-z0-9_\-]{12,}['"]/i,
    source: 'all'
  },
  {
    id: 'known-host',
    severity: 'medium',
    category: '网络',
    label: '连接远程主机（外部域名/IP，需确认用途）',
    re: /(https?:\/\/|ssh\s+|git\s+clone|npm\s+install|pip\s+install)\S*(github|gitlab|raw\.githubusercontent|cdn|npmjs|pypi|:\/\/[\w.-]+)/i,
    source: 'all'
  },
  // ── 权限/越权 ──
  {
    id: 'home-write',
    severity: 'medium',
    category: '越权写入',
    label: '写用户目录/系统目录（~/、$HOME、AppData、/etc）',
    re: /(~\/|\$HOME|%USERPROFILE%|AppData|C:\\Users|home\/|etc\/)['"]?\s*[)\]]?\s*(mkdir|write|touch|>|>>|cp|mv|rm)/i,
    source: 'all'
  }
];

const SEV_ORDER = { high: 0, medium: 1, low: 2 };

/** 脱敏：把命中的疑似密钥值打码（同 security_audit 口径） */
function maskSecret(snippet) {
  return snippet.replace(
    /((?:api[_-]?key|secret|token|passwd|password|access[_-]?key|private[_-]?key|\bkey)[\s]*[:=]\s*['"])[A-Za-z0-9_\-]{4,}(['"])/gi,
    (_, pre, post) => pre + '****' + post
  );
}

/** 扫描单个文件（行级），返回命中数组 */
function scanFile(filePath, rel) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return [];
  const buf = fs.readFileSync(filePath, 'utf8');
  const hits = [];
  const lines = buf.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of SKILL_RULES) {
      // source 限定：'SKILL.md' 只查 SKILL.md；'run.js' 只查 run.js；'all' 全部
      const base = path.basename(filePath);
      if (rule.source === 'SKILL.md' && base !== 'SKILL.md') continue;
      if (rule.source === 'run.js' && base !== 'run.js') continue;
      if (!rule.re.test(line)) continue;
      hits.push({
        file: rel,
        line: i + 1,
        ruleId: rule.id,
        severity: rule.severity,
        category: rule.category,
        label: rule.label,
        snippet: maskSecret(line.trim().slice(0, 180))
      });
    }
  });
  return hits;
}

/** 列出技能目录下的待审查文件（限制数量、跳过凭据文件） */
function listSkillFiles(dir) {
  const out = [];
  let count = 0;
  const walk = (d, depth) => {
    if (depth > 3 || count >= MAX_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (count >= MAX_FILES) return;
      const full = path.join(d, e.name);
      if (/\.(env|pem|key|p12|pfx|jks|keystore)$/i.test(e.name)) continue; // 凭据文件不读
      if (e.isDirectory()) {
        if (/node_modules|\.git|dist|build|__pycache__|\.venv/i.test(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        count++;
        out.push(full);
      }
    }
  };
  walk(dir, 0);
  return out;
}

async function run(a) {
  a = a || {};
  const store = a.path
    ? (typeof a.path === 'string' ? a.path : '')
    : '';
  const dir = store
    ? path.resolve(String(store))
    : (() => {
        const vs = getVscode();
        const gs = vs.workspace.getConfiguration('foxAi');
        const base = gs.get('skills.storagePath', '');
        const p = (base || '').trim()
          ? path.resolve(base.replace(/^~[\\/]/, process.env.USERPROFILE || '') + (base.includes('user-skills') ? '' : path.sep + 'user-skills'))
          : path.join(process.env.USERPROFILE || '', '.fox-ai', 'user-skills');
        return p;
      })();

  if (!dir || !fs.existsSync(dir)) {
    return `⚠️ 技能目录不存在：${dir}\n可先用 list_skills / import_skill 创建技能后再审查。`;
  }

  const files = listSkillFiles(dir);
  if (!files.length) {
    return `🔍 技能目录 ${dir} 下没有可审查文件（技能可能为空，或全是凭据文件被跳过）。`;
  }

  const allHits = [];
  for (const f of files) {
    const rel = path.relative(dir, f) || f;
    allHits.push(...scanFile(f, rel));
  }
  allHits.sort((x, y) => SEV_ORDER[x.severity] - SEV_ORDER[y.severity] || x.file.localeCompare(y.file) || x.line - y.line);

  const bySev = (s) => allHits.filter((h) => h.severity === s);
  const high = bySev('high');
  const medium = bySev('medium');
  const low = bySev('low');

  const fmt = (h) => `- \`${h.file}:${h.line}\` **[${h.category}] ${h.label}**：\`${h.snippet.replace(/`/g, '\\`')}\``;
  const body =
    `### 🔴 高危（${high.length}）\n` + (high.length ? high.map(fmt).join('\n') + '\n' : '（无）\n') +
    `### 🟡 中危（${medium.length}）\n` + (medium.length ? medium.map(fmt).join('\n') + '\n' : '（无）\n') +
    `### 🟢 低危（${low.length}）\n` + (low.length ? low.map(fmt).join('\n') + '\n' : '（无）\n');

  const verdict =
    high.length
      ? '🚫 **审查未通过**：存在高危项（提示注入/危险命令/恶意脚本/数据外泄），不要直接启用。先仔细读对应文件确认是真实风险还是误报；确认风险则删除该技能或手动修复后重新审查。'
      : medium.length
      ? '🟡 **需人工确认**：无高危项，但中危项需要确认用途（外联域名/读环境变量/写用户目录等），用途合理可启用。'
      : '🟢 **审查通过**：未发现明显风险，可直接启用该技能。';

  return (
    `# 技能安全审查报告（只读 · 脱敏 · 网络隔离）\n\n` +
    `**审查目录**：${dir}\n**审查文件数**：${files.length}\n**命中规则数**：${allHits.length}\n\n` +
    `## 规则命中\n\n` +
    body +
    `\n## 结论\n\n` +
    verdict +
    `\n---\n> 说明：规则命中是「疑似风险」，误报难免。高危项建议先人工复核再启用；本审查只读不修改任何文件。`
  );
}

module.exports = {
  run,
  scanFile,
  listSkillFiles,
  maskSecret,
  SKILL_RULES,
  LIMITS: { MAX_FILE_BYTES, MAX_FILES }
};