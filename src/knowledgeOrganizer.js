'use strict';

/*
 * src/knowledgeOrganizer.js — 知识库「AI 整理」
 *
 * 把用户指定目录里的原始文档（md/txt/代码/日志等）交给 AI 提炼成
 * 结构化、便于检索的知识笔记（Markdown），写入到「整理后输出目录」。
 *
 * 设计要点（务必遵守）：
 *   1. agent 读到的是「整理之后」的内容，不是原文。开启 organize 后，
 *      knowledgeBase 的 RAG 只检索 outputDir，原文目录不进上下文。
 *   2. 整理用的 AI 默认是本地（llama.cpp / Ollama / LM Studio），数据不出本机。
 *      若用户选择云端 provider，会弹一次确认，并在设置项里明文提示风险。
 *   3. apiKey 复用 foxAi.apiKey.<providerId>（SecretStorage 优先，明文兜底）。
 *   4. 所有整理动作写审计日志 kb-organize.log。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { chatNonStream } = require('./client');
const anthropic = require('./anthropic');
const config = require('./config');
const { PROVIDERS } = config;
const harness = require('./harness');
const vscode = () => require('vscode');

// 整理支持的文件类型（比 RAG 检索更广，含常见代码/数据文本）
const ORG_EXTS = new Set([
  '.md', '.markdown', '.txt', '.text', '.jsonl', '.json', '.csv', '.log',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.rst', '.adoc',
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.c', '.cpp', '.cc', '.h', '.hpp',
  '.cs', '.rb', '.php', '.swift', '.lua', '.sh', '.bash', '.ps1', '.sql'
]);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.vscode', '.fox-ai']);

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(process.env.HOME || os.homedir(), p.slice(2));
  if (p.startsWith('~\\')) return path.join(process.env.USERPROFILE || os.homedir(), p.slice(2));
  return p;
}

// 整理后输出目录：固定用户数据目录下，agent 通过 RAG 读取它（1.1.27：不允许自定义，避免目录漂移）
function defaultOutputDir() {
  return path.join(os.homedir(), '.fox-ai', 'knowledge');
}

// 自动压缩摘要目录（知识库-2）：固定用户数据目录下，agent 通过 RAG 读取它（1.1.27：不允许自定义）
function defaultAutoSummaryDir() {
  return path.join(os.homedir(), '.fox-ai', 'knowledge-2');
}

// 解析整理用的 AI 连接参数
async function resolveOrganizer(context) {
  const cfg = config.conf().get('knowledgeBase.organize', {}) || {};
  const pid = cfg.provider || 'llamacpp';
  const meta = PROVIDERS[pid] || PROVIDERS.llamacpp;
  const baseUrl = (cfg.baseUrl || '').trim() || config.baseUrlFor(pid);
  const model = (cfg.model || '').trim() || meta.model || 'local-model';
  const apiKey = await config.getOrganizeApiKey(context, pid);
  // 传输层：用户显式配置（auto/openai/anthropic）> provider 预置（与主 agent 一致）
  const t = String(cfg.transport || 'auto').trim();
  const transport = (t === 'anthropic' || t === 'openai')
    ? t
    : (meta.transport || 'openai');
  return { pid, label: meta.label, baseUrl, model, apiKey, local: !!meta.local, transport };
}

// 整理提示词
function buildPrompt(text, source) {
  const cfg = config.conf().get('knowledgeBase.organize', {}) || {};
  const custom = (cfg.prompt || '').trim();
  if (custom) {
    return (custom + '\n\n【原文来源：' + source + '】\n---\n' + text + '\n---').slice(0, 60000);
  }
  return [
    '你是一个知识整理助手。请把下面的原始文档整理成结构化、便于检索的知识笔记（使用简体中文）。',
    '要求：',
    '1. 保留所有关键事实、定义、命令、参数、结论，删除冗余与无关内容；不要编造原文没有的信息。',
    '2. 输出下列 Markdown 结构：',
    '   # <文档标题/主题>',
    '   ## 摘要',
    '   <一两句话概括文档用途与核心> ',
    '   ## 关键要点',
    '   - <要点1>',
    '   - <要点2>',
    '   ## 重要细节 / 命令 / 代码片段',
    '   <保留必要的代码、命令、数值、路径>',
    '   ## 标签',
    '   #标签1 #标签2',
    '3. 不要输出多余寒暄或解释，只输出整理后的 Markdown。',
    '',
    '原文（来自：' + source + '）：',
    '---',
    text,
    '---'
  ].join('\n').slice(0, 60000);
}

function* walkOrgDir(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        yield* walkOrgDir(full);
      } else if (e.isFile()) {
        yield full;
      }
    }
  } catch (_) {}
}

function collectSourceFiles(sourcePaths, policy) {
  const files = [];
  let skippedSensitive = 0;
  for (const p of sourcePaths) {
    const ep = expandHome(p);
    if (!ep || !fs.existsSync(ep)) continue;
    let st;
    try { st = fs.statSync(ep); } catch (_) { continue; }
    if (st.isDirectory()) {
      for (const f of walkOrgDir(ep)) {
        if (policy && policy.isSensitive(f)) { skippedSensitive++; continue; }
        if (!ORG_EXTS.has(path.extname(f).toLowerCase())) continue;
        files.push({ file: f, root: ep });
      }
      if (files.length >= 2000) break;
    } else if (st.isFile()) {
      if (policy && policy.isSensitive(ep)) { skippedSensitive++; continue; }
      if (!ORG_EXTS.has(path.extname(ep).toLowerCase())) continue;
      files.push({ file: ep, root: null });
    }
  }
  return { files, skippedSensitive };
}

function chunkForOrganize(text, maxChunk) {
  const size = Math.max(1500, maxChunk || 6000);
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > i) end = nl;
    }
    chunks.push(text.slice(i, end).trim());
    i = end;
  }
  return chunks.filter(Boolean);
}

// 审计日志（统一落到 ~/.fox-ai/logs；context.logUri 可能为空/被清理，不再使用）
const _auditKB = require('./auditLog').auditKB;
function auditLog(context, action, detail) {
  return _auditKB(action, detail);
}

function statePath(outputDir) {
  return path.join(outputDir, '.kb-organize-state.json');
}

function loadState(outputDir) {
  try {
    const p = statePath(outputDir);
    if (!fs.existsSync(p)) return { version: 1, files: {} };
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!data || typeof data !== 'object') return { version: 1, files: {} };
    return { version: data.version || 1, files: data.files || {} };
  } catch (_) {
    return { version: 1, files: {} };
  }
}

function saveState(outputDir, state) {
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(statePath(outputDir), JSON.stringify(state, null, 2), 'utf8');
  } catch (_) {}
}

function fileSignature(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch (_) {
    return '';
  }
}

/** 并发限制执行器 */
function asyncPool(concurrency, iterable, iteratorFn) {
  return new Promise((resolve, reject) => {
    const results = [];
    const iterator = iterable.entries();
    let running = 0;
    let done = false;
    function next() {
      if (done) return;
      const { value, done: d } = iterator.next();
      if (d) {
        if (running === 0) resolve(results);
        return;
      }
      running++;
      const [index, item] = value;
      Promise.resolve(iteratorFn(item, index))
        .then((r) => { results[index] = r; })
        .catch((e) => { results[index] = e; })
        .finally(() => {
          running--;
          next();
        });
      if (running < concurrency) next();
    }
    next();
  });
}

async function organizeFile(context, file, root, outputDir, organizer, { onLog, signal }) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return { file, status: 'skip', reason: '空文件' };
  const source = root ? path.relative(root, file) : path.basename(file);

  const chunks = chunkForOrganize(text);
  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    if (signal && signal.aborted) throw new Error('已取消');
    const prompt = buildPrompt(chunks.length > 1 ? `（第 ${i + 1}/${chunks.length} 段）\n` + chunks[i] : chunks[i], source);
    const callOpts = {
      baseUrl: organizer.baseUrl,
      apiKey: organizer.apiKey,
      model: organizer.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      maxTokens: 0,
      timeout: 180000
    };
    // anthropic transport：走 Messages API（自动映射厂商端点）；否则 OpenAI 兼容
    const res = organizer.transport === 'anthropic'
      ? await anthropic.chatNonStream(callOpts)
      : await chatNonStream(callOpts);
    if (res && res.content) parts.push(res.content.trim());
    else parts.push('（整理未返回内容）');
  }
  const organized = parts.join('\n\n---\n\n');

  // 输出路径：保留相对子目录结构，文件名加 .md
  const rel = root ? path.relative(root, file) : path.basename(file);
  const baseNoExt = rel.replace(/\.[^.]+$/, '');
  const outRel = baseNoExt + '.md';
  const outPath = path.join(outputDir, outRel);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const header = `# ${path.basename(baseNoExt)}\n> 源文件：${source}\n> 整理模型：${organizer.label} / ${organizer.model}\n> 整理时间：${new Date().toISOString()}\n\n`;
  fs.writeFileSync(outPath, header + organized, 'utf8');
  auditLog(context, 'organize.ok', { source, out: outRel, chunks: chunks.length });
  if (onLog) onLog(`✅ 已整理：${source} → ${outRel}`);
  return { file, status: 'ok', out: outRel };
}

function sessionSummaryPath(dir, sessionId) {
  const safeId = String(sessionId || 'global').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dir, `${safeId}-summary.md`);
}

/**
 * 把一段对话历史压缩成结构化摘要，写入「知识库-2」（自动压缩目录）。
 * 复用整理 AI 的连接参数（provider/baseUrl/model/apiKey），默认本地、数据不出本机。
 * 同一 session 的摘要将追加到同一个文件，避免一次压缩一个文件；不同 session 文件隔离。
 * @param {Array} messages 要压缩的对话消息数组（角色 + 内容）
 * @returns {Promise<string|null>} 写入的文件路径；无需压缩或失败时返回 null
 */
async function summarizeConversation(context, messages, { onLog, signal, sessionId, protocol } = {}) {
  if (!Array.isArray(messages) || messages.length < 2) return null;

  const organizer = await resolveOrganizer(context);
  const summaryDir = defaultAutoSummaryDir();
  fs.mkdirSync(summaryDir, { recursive: true });

  // 组装对话文本：优先走「类型感知专用预处理」（本地、零模型开销、最大化压缩冗余），
  // 失败则回退到原来的通用拼接，保证语义压缩层永不中断。
  const { typeAwarePrepare } = require('./compress');
  let prepareResult = null;
  try {
    prepareResult = typeAwarePrepare(messages, { protocol: protocol || 'native', maxBytes: 8000 });
  } catch (_) {
    prepareResult = null;
  }
  const text = prepareResult
    ? prepareResult.prepared
    : messages
        .map((m) => {
          const role = m && m.role ? m.role : 'user';
          const c = (m && m.content) || '';
          const body = typeof c === 'string' ? c : JSON.stringify(c);
          return `【${role}】\n${body.slice(0, 4000)}`;
        })
        .join('\n\n');
  if (prepareResult && onLog) {
    const s = prepareResult.stats;
    const ratioPct = Math.abs(s.ratio * 100).toFixed(0);
    const direction = s.ratio > 0 ? '压缩' : (s.ratio < 0 ? '膨胀' : '持平');
    const fallbackTag = s.fallback ? '（已回退）' : '';
    onLog(
      `🔧 类型感知预处理：原始 ${s.rawChars} 字 → 精简 ${s.preparedChars} 字（${direction} ${ratioPct}%${fallbackTag}）；工具结果 ${s.tool} 段、用户 ${s.user} 段、助手 ${s.assistant} 段、深度思考 ${s.reasoning} 段`
    );
  }

  const prompt = [
    '你是一个对话压缩助手。请把下面这段对话压缩成结构化摘要（简体中文），便于后续检索与衔接。',
    '要求：',
    '1. 保留：用户的核心意图与需求、关键决策与结论、已完成的代码改动 / 命令、未解决的待办、用户明确表达的偏好或约定。',
    '2. 删除：寒暄、重复内容、与主线无关的细枝末节；不要编造对话中没有的信息。',
    '3. 输出下列 Markdown 结构（不要多余寒暄）：',
    '# 对话压缩摘要',
    '## 用户意图',
    '## 关键决策 / 结论',
    '## 代码与命令改动',
    '## 待办 / 未决',
    '## 用户偏好 / 约定',
    '',
    '对话内容：',
    '注：下方带【工具·X】标签的段落已由本地算法做行级压缩，请重点保留「改动了哪些文件/符号、命令退出状态、关键错误行」，而不要复述原始输出；带【思考结论】标签的段落只保留结论要点。',
    '---',
    text,
    '---'
  ]
    .join('\n')
    .slice(0, 60000);

  if (signal && signal.aborted) throw new Error('已取消');

  const res = organizer.transport === 'anthropic'
    ? await anthropic.chatNonStream({
        baseUrl: organizer.baseUrl,
        apiKey: organizer.apiKey,
        model: organizer.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        maxTokens: 0,
        timeout: 180000
      })
    : await chatNonStream({
        baseUrl: organizer.baseUrl,
        apiKey: organizer.apiKey,
        model: organizer.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        maxTokens: 0,
        timeout: 180000
      });

  const content = (res && res.content ? res.content : '').trim();
  if (!content) {
    if (onLog) onLog('⚠️ 压缩结果为空，跳过');
    return null;
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeId = String(sessionId || 'global').replace(/[^a-zA-Z0-9_-]/g, '_');
  const outPath = sessionSummaryPath(summaryDir, sessionId);

  // 同一 session 已存在摘要时追加，保持「一个会话一个文件」
  let existing = '';
  try {
    if (fs.existsSync(outPath)) existing = fs.readFileSync(outPath, 'utf8');
  } catch (_) {}

  const blockHeader =
    `# 对话压缩摘要（批次 ${ts}）\n> 生成时间：${new Date().toISOString()}\n> 来源：上下文超限自动压缩\n` +
    `> 会话 ID：${safeId}\n> 涵盖消息数：${messages.length}\n> 压缩模型：${organizer.label} / ${organizer.model}\n\n`;
  const block = blockHeader + content;
  const final = existing ? `${existing.trim()}\n\n---\n\n${block}` : block;
  fs.writeFileSync(outPath, final, 'utf8');
  auditLog(context, 'summary.ok', { out: path.basename(outPath), count: messages.length, sessionId: safeId });
  if (onLog) onLog(`✅ 已压缩 ${messages.length} 条早期对话 → 知识库-2（${path.basename(outPath)}）`);
  return outPath;
}

/**
 * 入口：整理全部源文件
 * @returns {Promise<{ok:number,fail:number,skip:number,total:number}>}
 */
async function organize(context, { onLog, signal } = {}) {
  const cfg = config.conf().get('knowledgeBase.organize', {}) || {};
  if (!cfg.enabled) throw new Error('未开启知识库整理（foxAi.knowledgeBase.organize.enabled）');

  const sourcePaths = (cfg.sourcePaths || []).filter(Boolean);
  if (!sourcePaths.length) throw new Error('未设置整理源目录（foxAi.knowledgeBase.organize.sourcePaths）');

  const organizer = await resolveOrganizer(context);
  const outputDir = defaultOutputDir();
  fs.mkdirSync(outputDir, { recursive: true });

  // 非本地 provider：明文提示后弹一次确认
  if (!organizer.local) {
    const choice = await vscode().window.showWarningMessage(
      `知识库整理将把源目录内的文件内容发送给「${organizer.label}」(${organizer.baseUrl}) 进行 AI 整理。` +
      `建议优先使用本地 AI（数据不出本机）。是否继续？`,
      { modal: true }, '继续', '取消'
    );
    if (choice !== '继续') { auditLog(context, 'organize.cancelled', { reason: '用户拒绝云端整理' }); throw new Error('已取消'); }
  }

  const policy = new harness.PolicyEngine({
    autoApprove: config.conf().get('agent.autoApprove', 'read'),
    policy: config.conf().get('policy', {}),
    blockedCommands: config.conf().get('agent.blockedCommands', [])
  });
  const { files, skippedSensitive } = collectSourceFiles(sourcePaths, policy);
  if (skippedSensitive) {
    auditLog(context, 'organize.skipSensitive', { count: skippedSensitive });
    if (onLog) onLog(`⚠️ 已跳过敏感文件 ${skippedSensitive} 个（不会发送给整理 AI）`);
  }
  if (!files.length) { if (onLog) onLog('未找到可整理的源文件'); return { ok: 0, fail: 0, skip: 0, total: 0 }; }

  // 增量状态：仅重新整理「新增 / 修改 / 输出缺失」的文件，跳过未变化的
  const state = loadState(outputDir);
  const stateFiles = state.files || {};
  const toProcess = [];
  for (const f of files) {
    const sig = fileSignature(f.file);
    const rel = f.root ? path.relative(f.root, f.file) : path.basename(f.file);
    const outRel = rel.replace(/\.[^.]+$/, '') + '.md';
    const outPath = path.join(outputDir, outRel);
    const prev = stateFiles[f.file];
    if (prev && prev.sig === sig && fs.existsSync(outPath)) {
      // 未变化且输出存在：跳过
    } else {
      toProcess.push({ f, sig, outRel, outPath, changed: !prev || prev.sig !== sig });
    }
  }
  const skippedUnchanged = files.length - toProcess.length;
  if (skippedUnchanged) {
    if (onLog) onLog(`⏩ 跳过未变化的 ${skippedUnchanged} 个文件（增量整理）`);
  }
  if (!toProcess.length) {
    if (onLog) onLog('所有文件都未变化，无需整理～');
    return { ok: 0, fail: 0, skip: files.length, total: files.length };
  }

  auditLog(context, 'organize.start', { provider: organizer.label, model: organizer.model, sourceCount: files.length, toProcess: toProcess.length, outputDir });
  if (onLog) onLog(`开始整理 ${toProcess.length} 个文件（共扫描 ${files.length}，跳过 ${skippedUnchanged}）→ ${outputDir}（使用 ${organizer.label}）`);

  // 并发整理（默认 3 路），并把已成功写入的状态落盘，避免中途打断后无法续跑
  const CONCURRENCY = 3;
  let ok = 0, fail = 0, skip = 0;
  const results = await asyncPool(CONCURRENCY, toProcess, async (item) => {
    if (signal && signal.aborted) throw new Error('已取消');
    try {
      const r = await organizeFile(context, item.f.file, item.f.root, outputDir, organizer, { onLog, signal });
      if (r.status === 'ok') {
        stateFiles[item.f.file] = { sig: item.sig, out: item.outRel, at: Date.now() };
      } else if (r.status === 'skip') {
        stateFiles[item.f.file] = { sig: item.sig, out: item.outRel, at: Date.now(), skipped: true };
      }
      saveState(outputDir, { version: 1, files: stateFiles });
      return r;
    } catch (e) {
      return { file: item.f.file, status: 'error', error: String(e.message).split('\n')[0] };
    }
  });

  for (const r of results) {
    if (!r) continue;
    if (r.status === 'ok') ok++;
    else if (r.status === 'skip') skip++;
    else { fail++; if (onLog) onLog(`❌ 整理失败：${r.file} — ${r.error}`); }
  }

  auditLog(context, 'organize.done', { ok, fail, skip, outputDir });
  if (onLog) onLog(`整理完成：成功 ${ok} / 失败 ${fail} / 跳过 ${skip}`);
  return { ok, fail, skip, total: files.length };
}

module.exports = {
  ORG_EXTS, defaultOutputDir, defaultAutoSummaryDir, resolveOrganizer, collectSourceFiles,
  organize, summarizeConversation, auditLog, buildPrompt
};
