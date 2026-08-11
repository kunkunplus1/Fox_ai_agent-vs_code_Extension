'use strict';

/*
 * src/compress.js — 上下文压缩的类型感知预处理（本地、零模型开销）
 *
 * 在把对话历史交给「整理 AI」做语义摘要之前，按消息类型分别应用专用压缩算法，
 * 最大化剔除冗余信息，同时保住语义完整性所需的骨架（改了哪些符号/文件、命令退出
 * 状态、关键错误行、用户真实意图），让后续 RAG 检索命中质量更高、模型输入更省 token。
 *
 * 覆盖的消息类型：
 *   - user 真实提问        → 高保真，仅去多余空白（用户意图最贵）
 *   - assistant 正文       → 原样（交给模型做语义提炼）
 *   - 深度思考 reasoning    → 最冗余，仅取尾部结论（约 600 字）
 *   - tool 结果（native role:'tool' 或 text 协议包裹的 [工具 X 的结果]）
 *                           → 按 read/cmd/search/diff/generic 分类走专用行级压缩
 *   - system / 其他         → 不进压缩范围（压缩切片不含 system）
 */

const TOOL_WRAP_RE = /^\[工具\s+([^\]]+?)\s+的结果\]/;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const STACK_RE = /^\s*at\s|\(node:|at Object\.|at Module\.|at async |at process\.|at .+:\d+:\d+\)?$/;

function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

function isToolWrap(m) {
  if (m && m.role === 'tool') return { name: m.name || '工具', wrapped: false };
  if (m && m.role === 'user') {
    const c = typeof m.content === 'string' ? m.content : '';
    const mm = TOOL_WRAP_RE.exec(c);
    if (mm) return { name: mm[1], wrapped: true };
  }
  return null;
}

/**
 * 通用 stdout / 长文本行级压缩：去 ANSI、去空行堆叠、去重复栈帧，
 * 保留 error 相关行，超长时只留首尾各若干行 + 错误段。
 */
function compressStdout(text, maxLines) {
  maxLines = maxLines || 120;
  const lines = stripAnsi(text).split(/\r?\n/);
  const kept = [];
  let prevStack = '';
  let blank = 0;
  const errorLines = [];
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) {
      blank++;
      if (blank <= 1) kept.push('');
      continue;
    }
    blank = 0;
    if (STACK_RE.test(ln)) {
      const key = ln.replace(/\d+/g, '#');
      if (key === prevStack) continue; // 重复栈帧去重
      prevStack = key;
    } else {
      prevStack = '';
    }
    if (/error|exception|failed|cannot|undefined|traceback|拒绝|失败|报错|panic/i.test(t)) {
      errorLines.push(ln);
    }
    kept.push(ln);
    if (kept.length > maxLines) break;
  }
  let out = kept.join('\n');
  if (out.length > maxLines * 90) {
    const head = kept.slice(0, 40).join('\n');
    const tail = kept.slice(-40).join('\n');
    const errBlock = errorLines.length ? '\n[错误相关行]\n' + errorLines.slice(0, 30).join('\n') : '';
    out = head + '\n…(中间已省略)…\n' + tail + errBlock;
  }
  return out;
}

function classifyTool(name) {
  if (name === 'read_file' || /read_file|read_file/i.test(name)) return 'read';
  if (/search|grep|find|glob|search_text/i.test(name)) return 'search';
  if (/write|edit|patch|apply|update_file/i.test(name)) return 'diff';
  if (/exec|run|command|terminal|bash|shell|cmd/i.test(name)) return 'cmd';
  return 'generic';
}

function toolLabel(name) {
  const s = String(name || '工具');
  return s.length > 35 ? s.slice(0, 32) + '…' : s;
}

function compressToolResult(name, text, maxBytes) {
  text = stripAnsi(text);
  const kind = classifyTool(name);
  if (kind === 'read') {
    // 文件内容：保留开头 + 关键符号定义行（函数/类/接口），便于后续 RAG「改了哪个符号」
    const lines = text.split(/\r?\n/);

    // 短文件直接保留全文，避免「摘要前缀 + 符号重复」导致负压缩
    if (text.length <= 1200 || lines.length <= 40) {
      return text;
    }

    const sigLines = lines
      .filter((l) => /^\s*(export\s+)?(function|class|def|interface|type|const|let|var|public|private|protected|fn|func|struct|enum)\s/.test(l));
    const head = lines.slice(0, Math.min(60, lines.length)).join('\n');
    const tail = lines.length > 120 ? '\n…(中间省略)…\n' + lines.slice(-20).join('\n') : '';

    // 符号定义只追加 head 未覆盖的部分，避免同一段内容被塞两遍
    const headSet = new Set(head.split('\n'));
    const extraSigs = sigLines.slice(0, 15).filter((s) => !headSet.has(s));
    const sig = extraSigs.length
      ? '\n[符号定义] ' + extraSigs.map((s) => s.trim()).join(' | ')
      : '';

    return `[文件摘要] ${toolLabel(name)} ${text.length}字：\n${head}${tail}${sig}`;
  }
  if (kind === 'cmd') {
    const compact = compressStdout(text, 120);
    // 如果压缩没省多少，直接返回原文，不要套前缀造成膨胀
    if (compact.length >= text.length * 0.92) return text;
    return '[命令摘要] ' + compact;
  }
  if (kind === 'search') {
    const lines = text.split(/\r?\n/);
    if (text.length <= 800 || lines.length <= 40) return text;
    const filtered = lines.filter((l) => /:\d+:|matched|匹配|文件|^\s*[-]{3,}/i.test(l));
    return '[搜索摘要] ' + (filtered.slice(0, 60).join('\n') || text.slice(0, 800));
  }
  if (kind === 'diff') {
    if (text.length <= 400) return text;
    const adds = (text.match(/^\+(?!\+\+)/gm) || []).length;
    const dels = (text.match(/^-(?!--)/gm) || []).length;
    const files = [
      ...new Set(
        (text.match(/^(?:\+\+\+|---)\s+(.+)$/gm) || []).map((s) => s.replace(/^(?:\+\+\+|---)\s+/, ''))
      )
    ];
    return `[改动摘要] ${toolLabel(name)}：${files.length}文件 +${adds}/-${dels}；${files.slice(0, 10).join(', ')}`;
  }
  const compact = compressStdout(text, 100);
  if (compact.length >= text.length * 0.92) return text;
  return '[工具摘要] ' + compact;
}

/**
 * 类型感知预处理入口。
 * @param {Array} messages 原始消息数组（已 clamp 截断的单条上限）
 * @param {{protocol?:string, maxBytes?:number}} [opts]
 * @returns {{prepared:string, stats:object}}
 */
function typeAwarePrepare(messages, opts) {
  opts = opts || {};
  const blocks = [];
  const stats = {
    user: 0,
    assistant: 0,
    tool: 0,
    reasoning: 0,
    other: 0,
    rawChars: 0,
    preparedChars: 0,
    fallback: false
  };

  function pushBlock(prefix, body, forcePrefix) {
    if (!body) return;
    // 只有在确实做了压缩/截断，或内容很长需要标识时，才加前缀；否则直接放原文避免包装膨胀
    if (forcePrefix || prefix) {
      blocks.push(prefix ? `${prefix}\n${body}` : body);
    } else {
      blocks.push(body);
    }
  }

  for (const m of messages || []) {
    if (!m) continue;
    const role = m.role;
    const c = typeof m.content === 'string' ? m.content : m.content ? JSON.stringify(m.content) : '';

    // 1) 深度思考：最冗余，仅取尾部结论
    if (role === 'assistant' && m.reasoning && String(m.reasoning).trim()) {
      stats.reasoning++;
      const r = String(m.reasoning);
      const concl = r.length > 600 ? '（深度思考结论）' + r.slice(-600) : r;
      // 只有真正截断时才需要标识
      pushBlock(r.length > 600 ? '【思考结论】' : '', concl, false);
      if (m.content && m.content !== m.reasoning) {
        stats.assistant++;
        pushBlock('', m.content.slice(0, 2000), false);
      }
      continue;
    }

    // 2) 工具结果：类型感知行级压缩
    const tw = isToolWrap(m);
    if (tw) {
      stats.tool++;
      const body = tw.wrapped ? c.replace(TOOL_WRAP_RE, '') : c;
      stats.rawChars += body.length;
      const compact = compressToolResult(tw.name, body, opts.maxBytes || 8000);
      const compressed = compact.length < body.length * 0.92;
      pushBlock(compressed ? `【工具·${toolLabel(tw.name)}】` : '', compact, false);
      continue;
    }

    // 3) 用户真实提问：高保真，仅压缩多余空白
    if (role === 'user') {
      stats.user++;
      const u = c.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').slice(0, 3000);
      stats.rawChars += u.length;
      pushBlock('', u, false);
      continue;
    }

    // 4) 助手正文
    if (role === 'assistant') {
      stats.assistant++;
      const a = c.slice(0, 2000);
      stats.rawChars += a.length;
      pushBlock('', a, false);
      continue;
    }

    // 5) 其他
    stats.other++;
    if (c) {
      stats.rawChars += c.length;
      pushBlock(`【${role}】`, c.slice(0, 1000), true);
    }
  }

  let prepared = blocks.join('\n\n');

  // 防御：如果本地预处理确实让总字数膨胀，回退到最简拼接（仍去掉工具包装前缀）
  if (stats.rawChars && prepared.length > stats.rawChars) {
    prepared = messages
      .filter(Boolean)
      .map((m) => {
        let body = typeof m.content === 'string' ? m.content : m.content ? JSON.stringify(m.content) : '';
        const tw = isToolWrap(m);
        if (tw && tw.wrapped) body = body.replace(TOOL_WRAP_RE, '');
        if (m.role === 'assistant' && m.reasoning && String(m.reasoning).trim() && String(m.reasoning).length > 600) {
          return String(m.reasoning).slice(-600) + '\n\n' + body.slice(0, 800);
        }
        return body;
      })
      .join('\n\n');
    stats.fallback = true;
  }

  stats.preparedChars = prepared.length;
  stats.ratio = stats.rawChars ? 1 - stats.preparedChars / stats.rawChars : 0;
  return { prepared, stats };
}

module.exports = { typeAwarePrepare, compressToolResult, compressStdout, isToolWrap };
