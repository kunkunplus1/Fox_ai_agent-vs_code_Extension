'use strict';

const vscode = require('vscode');
const config = require('./config');
const { chatOnce, fimCompleteOnce } = require('./client');
const anthropic = require('./anthropic');
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

const SYSTEM_FIM = `你是代码补全引擎。任务：只输出光标所在缺口（hole）应该填入的代码。

格式规则：
- 只输出中间缺口的代码，绝对不要重复缺口前或缺口后的已有文本。
- 不要解释、不要 markdown 代码围栏、不要输出文件名或语言名。
- 如果光标处已经完整，无需补全，必须输出空字符串。`;

const FIM_TEMPLATES = {
  diffusion: { prefix: '<fim_prefix>', suffix: '<fim_suffix>', middle: '<fim_middle>' },
  starcoder: { prefix: '<fim_prefix>', suffix: '<fim_suffix>', middle: '<fim_middle>' },
  codellama: { prefix: '<PRE>', suffix: '<SUF>', middle: '<MID>' },
  deepseek:  { prefix: '<｜fim▁begin｜>', suffix: '<｜fim▁hole｜>', middle: '<｜fim▁end｜>' }
};

function detectFimStrategy(strategy, model) {
  if (strategy && strategy !== 'auto') return strategy;
  const m = String(model || '').toLowerCase();
  if (/codellama|code-llama/.test(m)) return 'codellama';
  if (/deepseek-coder|deepseek-v3|deepseek-v4|deepseek-chat/.test(m)) return 'deepseek';
  if (/starcoder|qwen.*coder|qwen2\.5-coder/.test(m)) return 'starcoder';
  return 'diffusion';
}

function buildFimPrompt(prefix, suffix, strategy) {
  const tpl = FIM_TEMPLATES[strategy] || FIM_TEMPLATES.diffusion;
  return `${tpl.prefix}${prefix}${tpl.suffix}${suffix}${tpl.middle}`;
}

function cleanup(text) {
  let t = String(text || '');
  t = t.replace(/^```[a-zA-Z0-9]*\s*\n?/, '').replace(/```\s*$/, '');
  // 去掉可能被模型回显的 FIM 特殊 token
  t = t.replace(/<fim_prefix>|<fim_suffix>|<fim_middle>|<PRE>|<SUF>|<MID>|<｜fim▁begin｜>|<｜fim▁hole｜>|<｜fim▁end｜>/g, '');
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
  if (resolved && resolved.inlineCompletion && resolved.inlineCompletion.model) {
    return resolved.inlineCompletion.model;
  }
  return (resolved && resolved.model) || '';
}

/**
 * 判断模型是否 DeepSeek 思考模型（deepseek-reasoner / deepseek-v4-pro 等带 reasoner/thinking 后缀）。
 * DeepSeek 官方文档：deepseek-reasoner 不支持 FIM 补全（Beta），也不支持 temperature 等采样参数。
 * https://api-docs.deepseek.com/zh-cn/guides/reasoning_model
 */
function isDeepSeekReasoner(model) {
  const m = String(model || '').toLowerCase();
  return /deepseek-(reasoner|r1|v4?-?pro)|deepseek.*(thinking|reasoning)/.test(m);
}

/**
 * 按 transport + thinking 配置构造请求 body 额外字段。
 * - openai  + thinking=on → { reasoning_effort: effort }（推理模型顶层参数）
 * - anthropic + thinking=on → { thinking: { type:'enabled', budget_tokens: N } }
 *   （budget 须 ≥1024 且 < maxTokens；按 effort 映射 low=2048 / medium=4096 / high=8192）
 * - 其余返回空对象
 */
function buildInlineExtraBody(ic, model) {
  const thinkingOn = ic && (ic.thinking === 'on' || ic.thinking === true);
  if (!thinkingOn) return {};
  const effort = (ic.thinkingEffort || 'medium').toLowerCase();
  const transport = (ic.transport || 'openai').toLowerCase();
  if (transport === 'anthropic') {
    const budgetMap = { low: 2048, medium: 4096, high: 8192 };
    const budget = budgetMap[effort] || 4096;
    const maxTokens = Math.max(1024, (ic.maxTokens || 256) || 1024);
    // budget 必须 < maxTokens，否则 Anthropic API 报错；给正文留至少 1024
    const safeBudget = Math.min(budget, Math.max(1024, maxTokens - 1024));
    return { thinking: { type: 'enabled', budget_tokens: safeBudget } };
  }
  // openai 系：DeepSeek 思考模型没有 reasoning_effort 参数（官方文档「即将可用」），
  // 但传了也不报错（文档：不支持的参数会被忽略）——为兼容，reasoner 模型直接走自身思考模式，不传参数。
  if (isDeepSeekReasoner(model)) return {};
  return { reasoning_effort: effort };
}

/**
 * 去掉补全文本中与光标前后已有文本重复的重叠部分，避免插入后出现 "int jka()int jka()" 这种事。
 * FIM 模式下模型偶尔会回显 suffix，也要剥掉。
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
  // 5. 如果建议以当前行光标后文本结尾（或后文+可选空白结尾），去掉，避免 FIM 回显 suffix
  if (after) {
    const escaped = after.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped + '\\s*$');
    if (re.test(t)) {
      t = t.replace(re, '');
    }
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
      const ic = resolved.inlineCompletion || {};
      if (!ic.baseUrl) {
        log('跳过：未配置 baseUrl');
        return null;
      }
      if (!(ic.meta && ic.meta.local) && !ic.apiKey) {
        log('跳过：云端模型未设置 API Key');
        return null;
      }

      const span = Math.max(10, cfg.get('inlineCompletion.contextLines', 60));
      const suffixSpan = Math.max(0, cfg.get('inlineCompletion.suffixLines', 30));
      const startLine = Math.max(0, position.line - span);
      const suffixEndLine = Math.min(document.lineCount - 1, position.line + suffixSpan);

      // 把当前行和前后文明确拆开，避免模型重复输出当前行已有文本
      const currentLine = document.lineAt(position.line).text;
      const lineBefore = currentLine.slice(0, position.character);
      const lineAfter = currentLine.slice(position.character);
      const before = document.getText(new vscode.Range(startLine, 0, position.line, 0));
      // 光标在最后一行（或 suffixLines=0）时 position.line+1 > suffixEndLine，Range 非法会抛错
      // 导致补全静默失败。加保护：无后文时 after 为空串。
      const after = (position.line + 1 <= suffixEndLine)
        ? document.getText(new vscode.Range(position.line + 1, 0, suffixEndLine, Number.MAX_SAFE_INTEGER))
        : '';
      if (!before.trim() && !after.trim() && !lineBefore.trim() && !lineAfter.trim()) {
        log('跳过：上下文为空');
        return null;
      }

      // 上下文长度上限：超长行/大文件下避免把过量字符塞进补全请求（省 token + 降延迟）。
      // 前文（更相关）优先保留，后文裁剪。
      const maxContextChars = Math.max(800, cfg.get('inlineCompletion.maxContextChars', 6000));
      let beforeCtx = before;
      let afterCtx = after;
      if (beforeCtx.length + afterCtx.length > maxContextChars) {
        const budget = Math.floor(maxContextChars * 0.7);
        if (beforeCtx.length > budget) beforeCtx = beforeCtx.slice(-budget);
        const remaining = maxContextChars - beforeCtx.length;
        if (afterCtx.length > remaining) afterCtx = afterCtx.slice(0, remaining);
        log('上下文截断', before.length, '+', after.length, '→', beforeCtx.length, '+', afterCtx.length);
      }
      // 当前行缩进：帮助模型生成正确缩进的代码
      const indent = (currentLine.match(/^[ \t]*/) || [''])[0];

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

      const completionModel = pickCompletionModel(cfg, resolved);
      log('请求', document.fileName, 'model=', completionModel, 'provider=', ic.provider || '(main)', 'transport=', ic.transport, 'thinking=', ic.thinking);

      const isFimEndpoint = !!ic.fimEndpoint;
      const fimStrategy = detectFimStrategy(ic.fimStrategy, completionModel);
      // DeepSeek 思考模型（deepseek-reasoner）官方不支持 FIM 补全 → 自动降级为 chat 补全；
      // Anthropic transport 无 FIM 端点 → 也用 chat 补全（Messages API + FIM 模板）
      const isAnthropic = (ic.transport || 'openai') === 'anthropic';
      const useFim = !isAnthropic && fimStrategy !== 'none' && !isFimEndpoint && !isDeepSeekReasoner(completionModel);
      if (ic.thinking === 'on' && isDeepSeekReasoner(completionModel)) {
        log('DeepSeek 思考模型不支持 FIM，已自动降级为 chat 补全（官方文档：deepseek-reasoner Not Supported: FIM）');
      }
      const extraBody = buildInlineExtraBody(ic, completionModel);
      if (Object.keys(extraBody).length) log('注入思考参数:', JSON.stringify(extraBody));

      let prompt;
      let systemPrompt = SYSTEM;
      if (isFimEndpoint) {
        // 专用 FIM 端点（DeepSeek Beta /completions）：前缀/后缀作为原生参数提交，不包 token
        log('使用专用 FIM 端点 /completions', 'prefixLen=', (beforeCtx + lineBefore).length, 'suffixLen=', (lineAfter + afterCtx).length);
      } else if (useFim) {
        // Fill-in-the-Middle：把 prefix + suffix 用专用 token 包裹，让模型知道自己在填空
        const prefix = beforeCtx + lineBefore;
        const suffix = lineAfter + afterCtx;
        prompt = buildFimPrompt(prefix, suffix, fimStrategy);
        systemPrompt = SYSTEM_FIM;
        log('使用 FIM 策略', fimStrategy, 'prefixLen=', prefix.length, 'suffixLen=', suffix.length);
      } else {
        const promptParts = [];
        if (projectContext) promptParts.push('【项目上下文】\n' + projectContext);
        promptParts.push(
          `文件：${document.fileName}\n语言：${document.languageId}\n` +
          `当前行缩进：${JSON.stringify(indent)}\n\n` +
          `当前行光标前：${lineBefore}\n` +
          `当前行光标后：${lineAfter}\n\n` +
          `前文多行：\n${beforeCtx}\n\n` +
          `后文多行：\n${afterCtx}\n\n` +
          `只输出光标位置需要插入的代码，保持上述缩进。绝对不要重复「当前行光标前」或「当前行光标后」的已有文本。`
        );
        prompt = promptParts.join('\n\n');
      }

      const inlineMaxTokens = Math.max(16, cfg.get('inlineCompletion.maxTokens', 128));
      let result;
      if (isFimEndpoint) {
        const { promise, handle } = fimCompleteOnce({
          baseUrl: ic.baseUrl,
          apiKey: ic.apiKey,
          model: completionModel,
          prompt: beforeCtx + lineBefore,
          suffix: (lineAfter + afterCtx) || undefined,
          maxTokens: inlineMaxTokens,
          temperature: 0.1,
          stop: ['\n\n'],
          timeout: 20000
        });
        inflight = handle;
        token.onCancellationRequested(() => {
          try { handle.abort(); } catch (_) {}
        });
        try {
          result = await promise;
        } catch (e) {
          log('FIM 端点请求失败：', e && e.message);
          return null;
        } finally {
          if (inflight === handle) inflight = null;
        }
      } else {
      const chatOpts = {
        baseUrl: ic.baseUrl,
        apiKey: ic.apiKey,
        model: completionModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        maxTokens: inlineMaxTokens,
        timeout: 20000,
        stop: ['\n\n'],
        extraBody
      };
      // Anthropic transport：走原生 Messages API（支持 thinking.budget_tokens）；其余走 OpenAI 兼容
      const useAnthropicClient = isAnthropic;
      const { promise, handle } = useAnthropicClient
        ? anthropic.chatOnce(chatOpts)
        : chatOnce(chatOpts);
      inflight = handle;
      token.onCancellationRequested(() => {
        try { handle.abort(); } catch (_) {}
      });

        try {
          result = await promise;
        } catch (e) {
          log('模型请求失败：', e && e.message);
          return null;
        } finally {
          if (inflight === handle) inflight = null;
        }
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

module.exports = {
  createInlineProvider,
  cleanup,
  trimOverlap,
  pickCompletionModel,
  detectFimStrategy,
  buildFimPrompt,
  isDeepSeekReasoner,
  buildInlineExtraBody
};
