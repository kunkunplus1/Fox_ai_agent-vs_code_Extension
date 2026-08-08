'use strict';

const vscode = require('vscode');
const config = require('./config');
const { chatOnce } = require('./client');
const projectScan = require('./projectScan');

const outputChannel = vscode.window.createOutputChannel('狐狸 AI·行内补全');
let logLineCount = 0;
const LOG_LINE_LIMIT = 500;
function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  logLineCount++;
  // 输出通道日志无限增长会占用主进程内存，定期清理
  if (logLineCount >= LOG_LINE_LIMIT) {
    outputChannel.clear();
    logLineCount = 0;
    outputChannel.appendLine('[fox-ai] 日志已达上限，已清理');
  }
}

const SYSTEM = `你是代码补全引擎。任务：根据上下文，只输出光标位置需要「插入」的代码片段。

格式规则：
- 只输出应当插入到光标处的新代码。
- 绝对不要重复「当前行光标前」已经出现的任何文本。
- 绝对不要重复「当前行光标后」已经存在的任何文本。
- 不要解释、不要 markdown 代码围栏、不要输出文件名或语言名。
- 如果光标处已经完整，无需补全，必须输出空字符串。

错误示例（不要这样做）：
当前行光标前为 "int jka()" 时，不要输出 "int jka()"，因为会重复。
正确示例：若光标在 "int jka()" 之后且需要函数体，应输出 " {\\n    return 0;\\n}" 这样的增量文本。`;

function cleanup(text) {
  let t = String(text || '');
  t = t.replace(/^```[a-zA-Z0-9]*\s*\n?/, '').replace(/```\s*$/, '');
  t = t.replace(/^<\|[^|]*\|>/g, '');
  return t;
}

/**
 * 选择本次补全使用的模型：优先专用补全模型（inlineCompletion.model），
 * 否则回落到主对话模型。对标 Copilot 用独立轻量引擎做补全，避免拖慢/烧主模型。
 */
function pickCompletionModel(cfg, resolved) {
  const m = (cfg.get('inlineCompletion.model', '') || '').trim();
  if (m) return m;
  return (resolved && resolved.model) || '';
}

/**
 * 去掉补全文本中与光标前后已有文本重复的重叠部分，避免插入后出现 "int jka()int jka()" 这种事。
 */
function trimOverlap(text, lineBefore, lineAfter) {
  let t = text;
  const before = String(lineBefore);
  const after = String(lineAfter);

  // 1. 如果建议以当前行光标前文本结尾，去掉
  if (before && t.endsWith(before)) {
    t = t.slice(0, -before.length);
  }
  // 2. 如果建议以当前行光标前文本开头，去掉
  if (before && t.startsWith(before)) {
    t = t.slice(before.length);
  }
  // 3. 如果建议里包含完整的光标前文本，取它之后的内容
  const idx = before ? t.indexOf(before) : -1;
  if (idx > 0) {
    t = t.slice(idx + before.length);
  }
  // 4. 如果建议以当前行光标后文本开头，去掉
  if (after && t.startsWith(after)) {
    t = t.slice(after.length);
  }

  return t;
}

/** 可被取消的等待，避免旧请求永久挂起 */
function delay(ms, token) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(true), ms);
    token.onCancellationRequested(() => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

function createInlineProvider(context) {
  let inflight = null;

  return {
    async provideInlineCompletionItems(document, position, ctx, token) {
      const cfg = config.conf();
      if (!cfg.get('inlineCompletion.enabled', false)) {
        log('跳过：inlineCompletion.enabled 未开启');
        return null;
      }
      if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
        log('跳过：非 file/untitled 方案', document.uri.scheme);
        return null;
      }
      const maxFileLines = cfg.get('inlineCompletion.maxFileLines', 8000);
      if (maxFileLines > 0 && document.lineCount > maxFileLines) {
        log('跳过：文件过大', document.lineCount, '>', maxFileLines);
        return null;
      }

      const debounce = Math.max(0, cfg.get('inlineCompletion.debounce', 350));
      const proceed = await delay(debounce, token);
      if (!proceed || token.isCancellationRequested) {
        log('跳过：取消或 debounce 中断');
        return null;
      }

      if (inflight) {
        try {
          inflight.abort();
        } catch (_) {}
        inflight = null;
      }

      const resolved = await config.resolve(context);
      if (!resolved.baseUrl) {
        log('跳过：未配置 baseUrl');
        return null;
      }
      if (!resolved.meta.local && !resolved.apiKey) {
        log('跳过：云端模型未设置 API Key');
        return null;
      }

      const span = Math.max(10, cfg.get('inlineCompletion.contextLines', 60));
      const startLine = Math.max(0, position.line - span);
      const endLine = Math.min(document.lineCount - 1, position.line + Math.floor(span / 3));

      // 把当前行和前后文明确拆开，避免模型重复输出当前行已有文本
      const currentLine = document.lineAt(position.line).text;
      const lineBefore = currentLine.slice(0, position.character);
      const lineAfter = currentLine.slice(position.character);
      const before = document.getText(new vscode.Range(startLine, 0, position.line, 0));
      const after = document.getText(
        new vscode.Range(position.line + 1, 0, endLine, Number.MAX_SAFE_INTEGER)
      );
      if (!before.trim() && !after.trim() && !lineBefore.trim() && !lineAfter.trim()) {
        log('跳过：上下文为空');
        return null;
      }

      // 与对话 AI 共用同一套项目上下文，避免补全“牛头不对马嘴”
      let projectContext = '';
      if (cfg.get('inlineCompletion.useProjectContext', true)) {
        let root = null;
        if (document.uri.scheme === 'file') {
          const folder = vscode.workspace.getWorkspaceFolder(document.uri);
          root = (folder && folder.uri && folder.uri.fsPath) || projectScan.findProjectRoot(document.fileName);
        }
        if (root) {
          const ctxChars = Math.max(200, cfg.get('inlineCompletion.projectContextChars', 1000));
          projectContext = projectScan.renderProjectContext(root, document.fileName, {
            maxChars: ctxChars,
            actionable: false,
            maxRoles: 10,
            includeSkeleton: true,
            skeletonMaxFiles: 6,
            includeNeighbors: true
          });
          log('项目上下文 len=', projectContext.length, 'root=', root);
        } else {
          log('未找到项目根目录，仅使用当前文件上下文');
        }
      }

      const promptParts = [];
      if (projectContext) promptParts.push('【项目上下文】\n' + projectContext);
      promptParts.push(
        `文件：${document.fileName}\n语言：${document.languageId}\n\n` +
        `当前行光标前：${lineBefore}\n` +
        `当前行光标后：${lineAfter}\n\n` +
        `前文多行：\n${before}\n\n` +
        `后文多行：\n${after}\n\n` +
        `只输出光标位置需要插入的代码。绝对不要重复「当前行光标前」或「当前行光标后」的已有文本。`
      );
      const prompt = promptParts.join('\n\n');
      log('请求', document.fileName, 'model=', pickCompletionModel(cfg, resolved));

      const { promise, handle } = chatOnce({
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        model: pickCompletionModel(cfg, resolved),
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        maxTokens: Math.max(16, cfg.get('inlineCompletion.maxTokens', 128)),
        timeout: 20000,
        stop: ['\n\n\n']
      });
      inflight = handle;
      token.onCancellationRequested(() => {
        try {
          handle.abort();
        } catch (_) {}
      });

      let result;
      try {
        result = await promise;
      } catch (e) {
        log('模型请求失败：', e && e.message);
        return null;
      } finally {
        if (inflight === handle) inflight = null;
      }
      if (token.isCancellationRequested) {
        log('请求完成后被取消');
        return null;
      }

      const raw = (result && result.content) || '';
      const text = trimOverlap(cleanup(raw), lineBefore, lineAfter);
      log('收到回复 rawLen=', raw.length, 'cleanLen=', text.length);
      if (!text || !text.trim()) {
        log('跳过：清洗后为空（可能因去重后无内容）');
        return null;
      }

      log('返回补全：', text.slice(0, 80).replace(/\n/g, '\\n'));
      return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))];
    }
  };
}

module.exports = { createInlineProvider, cleanup, trimOverlap, pickCompletionModel };
