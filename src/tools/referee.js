'use strict';

/**
 * referee_review 工具：**只读的第三方「裁判」Agent**。
 *
 * 职责（双盲交叉验证的一环）：
 *   对比「修复前（git HEAD 原版）」与「修复后（工作区当前版）」的语义差异。
 *   若发现修复前后**逻辑完全等价**（仅有格式 / 重排 / 注释差异，无实质逻辑变化），
 *   说明这次「修复」什么也没改——极可能是自检 Agent（security_audit）的误报被当成
 *   真问题去修了。此时**强制挂起（SUSPEND）→ 转人工**，绝不自己放行。
 *
 * 边界：只读、不修改文件、不调用自检 Agent 的结果作为依据（独立判断）。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const vscode = require('vscode');

/** 向上查找 git 仓库根 */
function getGitRoot(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
}

/** 读取 git HEAD 中的原版内容；不存在（新增文件）返回 null */
function readHead(rel, root) {
  try {
    return sh('git', ['show', 'HEAD:' + rel], root);
  } catch (_) {
    return null;
  }
}

function readWorking(absPath) {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch (_) {
    return null;
  }
}

/** 去除注释（块注释 / // / # 行注释，避免 http:// 误伤） */
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])(\/\/.*)$/gm, '$1')
    .replace(/^\s*#.*$/gm, '');
}

/** 归一化：去注释 + 折叠空白 + 运算符周围空白归一 */
function normalize(s) {
  return stripComments(s || '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([=+\-*/<>{}()[\];,.:?&|!])\s*/g, '$1')
    .trim();
}

/** 结构相似度（Jaccard），用于识别「仅重命名变量」这类等价但归一化不同的改动 */
function tokenize(s) {
  return (s || '').split(/[^A-Za-z0-9_$]+/).filter(Boolean);
}
function jaccard(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * 判断修复前后是否逻辑等价。
 * 返回 { equivalent:boolean, reason:string, confidence:'high'|'medium'|'low' }
 */
function isEquivalent(before, after) {
  const nb = normalize(before);
  const na = normalize(after);
  // 1) 归一化完全相同 → 仅注释/空白/排版差异，高置信等价
  if (nb === na) {
    return { equivalent: true, confidence: 'high', reason: '修复前后归一化后完全一致（仅注释/空白/排版差异）' };
  }
  // 2) 结构高度相似 + 长度接近 → 可能仅重命名变量，中置信等价
  const j = jaccard(nb, na);
  const lenRatio = nb.length && na.length ? Math.max(nb.length, na.length) / Math.min(nb.length, na.length) : 1;
  if (j >= 0.97 && lenRatio <= 1.1) {
    return { equivalent: true, confidence: 'medium', reason: `结构相似度 ${j.toFixed(3)} 且长度比 ${lenRatio.toFixed(2)}，疑似仅标识符重命名` };
  }
  return { equivalent: false, confidence: 'low', reason: `结构相似度 ${j.toFixed(3)}，存在实质逻辑差异` };
}

/**
 * 对比单个文件。返回 { file, status, confidence, reason }
 *  status: SUSPENDED（等价/误报）| PROCEED（有实质改动）| NEW（新增文件，无法比对）| DELETED（已删除）
 */
function compareFile(absPath, root) {
  const rel = path.relative(root, absPath).split(path.sep).join('/');
  const before = readHead(rel, root);
  const after = readWorking(absPath);
  if (before === null && after !== null) {
    return { file: rel, status: 'NEW', confidence: 'low', reason: '新增文件，无法与 HEAD 比对（非等价误报场景）' };
  }
  if (before !== null && after === null) {
    return { file: rel, status: 'DELETED', confidence: 'low', reason: '文件已删除' };
  }
  const eq = isEquivalent(before, after);
  return {
    file: rel,
    status: eq.equivalent ? 'SUSPENDED' : 'PROCEED',
    confidence: eq.confidence,
    reason: eq.reason
  };
}

async function run(a, ctx) {
  a = a || {};
  const folders = vscode.workspace.workspaceFolders;
  const cwd = a.path ? path.resolve(a.path) : folders && folders[0] ? folders[0].uri.fsPath : process.cwd();
  const root = getGitRoot(cwd);
  if (!root) {
    return '⚠️ 当前目录不是 git 仓库，裁判 Agent 无法比对 HEAD 与工作区差异。请在 git 仓库内使用，或先提交基线。';
  }
  if (!fs.existsSync(cwd)) {
    return `⚠️ 目标路径不存在：${cwd}`;
  }

  let targets;
  try {
    if (a.path) {
      const abs = path.resolve(a.path);
      // 目录：校验该目录下相对 HEAD 的全部改动；单文件：只校验该文件
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
        const out = sh('git', ['diff', '--name-only', 'HEAD'], root).trim();
        targets = out ? out.split('\n').map((p) => path.join(root, p)) : [];
      } else {
        targets = [abs];
      }
    } else {
      // 全部相对 HEAD 的改动文件
      const out = sh('git', ['diff', '--name-only', 'HEAD'], root).trim();
      targets = out ? out.split('\n').map((p) => path.join(root, p)) : [];
    }
  } catch (e) {
    return '⚠️ 读取 git 改动失败：' + String((e && e.message) || e).split('\n')[0];
  }

  if (!targets.length) {
    return '# 裁判 Agent 交叉验证\n\n未检测到相对 HEAD 的改动，无可比对内容。\n> 提示：先做出改动（或指定 path），再调用本工具做双盲校验。';
  }

  const results = targets.map((p) => compareFile(p, root));
  const compared = results.filter((r) => r.status === 'SUSPENDED' || r.status === 'PROCEED');
  const suspended = results.filter((r) => r.status === 'SUSPENDED');
  const proceeded = results.filter((r) => r.status === 'PROCEED');

  // 整体判定：凡存在「既有文件被改动」且全部判定为等价 → 强制挂起（自检疑似误报）
  const recommendation =
    compared.length > 0 && suspended.length === compared.length ? 'SUSPEND' : 'PROCEED';

  const fmt = (r) => {
    const tag = r.status === 'SUSPENDED' ? '🔴 挂起' : r.status === 'PROCEED' ? '🟢 通过' : '⚪ ' + r.status;
    return `- ${tag} \`${r.file}\`（${r.confidence}）：${r.reason}`;
  };

  const head =
    '# 裁判 Agent 双盲交叉验证（只读）\n\n' +
    `**比对基准**：${root} 的 git HEAD（原版）vs 工作区（修复后）\n` +
    `**文件数**：${results.length}（等价挂起 ${suspended.length} / 实质改动 ${proceeded.length}）\n\n` +
    (recommendation === 'SUSPEND'
      ? '> 🛑 **建议：SUSPEND（强制挂起转人工）**。所有改动文件修复前后逻辑等价，说明本次「修复」未改变任何实质逻辑——自检 Agent 极可能是误报。请人工确认，勿自行放行。\n'
      : '> 🟢 **建议：PROCEED**。存在实质逻辑改动，修复有效（仍需结合人工复核与测试）。\n');

  return head + '\n## 逐文件结论\n\n' + results.map(fmt).join('\n') +
    '\n---\n> 裁判 Agent 独立判断，不依赖自检 Agent 的输出；其结论仅供交叉验证，最终以人工复核为准。';
}

module.exports = { run, isEquivalent, normalize, compareFile, getGitRoot, LIMITS: {} };
