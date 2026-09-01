/**
 * 工具调用文本解析模块（agent.js 巨石拆分第一刀，对齐 dsh BlockAssembler 协议收口思路）。
 * 纯函数：不依赖 AgentSession 实例状态，只依赖 tools/weakModel 模块。
 */
const tools = require('./tools');
const weakModel = require('./weakModel');
const fs = require('fs');
const path = require('path');
const os = require('os');


// ===== 工具块常量 =====
const TOOL_OPEN = /<(fox:?tool|fox-tool|tool)\s+name\s*=\s*["']([^\s"'<>]+)["']\s*>/i;
const TOOL_BLOCK = /<(fox:?tool|fox-tool|tool)\s+name\s*=\s*["']([^\s"'<>]+)["']\s*>\s*([\s\S]*?)\s*<\/(fox:?tool|fox-tool|tool)>/gi;
const TOOL_END = "</fox:tool>";

// ===== 闭合标签感知 + 块扫描 =====
/**
 * 从 from 位置起找与开标签 tagName 配对的闭合标签，跳过参数 JSON 字符串值内部的闭合标签。
 * （1.1.39 闭合标签感知：模型在工具参数里传 HTML 片段时，字符串里的 </foxtool> 不再被误判为块结束）
 * @returns {number} 闭合标签 '<' 的索引；找不到返回 -1
 */
function findTagCloseIn(text, from, tagName) {
  let inStr = null; // '"' / "'" / null：当前是否在 JSON 字符串内
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === '<') {
      const mm = /<\/(fox:?tool|fox-tool|tool)>/i.exec(text.slice(i, i + 24));
      if (mm && mm[1].toLowerCase() === tagName.toLowerCase()) return i;
    }
  }
  return -1;
}

/** 扫描 <foxtool name="..">…</foxtool> 块（含 <fox:tool>/<fox-tool>/<tool>），闭合标签感知 */
function extractFoxToolBlocks(text) {
  const blocks = [];
  const openRe = /<(fox:?tool|fox-tool|tool)\s+name\s*=\s*["']([^\s"'<>]+)["']\s*>/gi;
  let m;
  while ((m = openRe.exec(text)) !== null) {
    const tag = m[1];
    const end = findTagCloseIn(text, openRe.lastIndex, tag);
    if (end < 0) break; // 无配对闭合（流被截断）→ 后续交给截断兜底
    blocks.push({ name: m[2], body: text.slice(openRe.lastIndex, end) });
    openRe.lastIndex = end + tag.length + 3; // 跳过闭合标签 '</' + tag + '>'
  }
  return blocks;
}


// ===== 通用调试日志 =====
function writeAgentLog(name, lines) {
  try {
    const dir = path.join(os.homedir(), '.fox-ai', 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'agent-' + name + '.log');
    const prefix = new Date().toISOString() + ' [pid:' + process.pid + '] ';
    const text = (Array.isArray(lines) ? lines : [String(lines)])
      .map((l) => prefix + (typeof l === 'string' ? l : JSON.stringify(l)))
      .join('\n') + '\n';
    fs.writeFileSync(file, text, { flag: 'a' });
  } catch (_) { /* 日志写入失败不得影响主流程 */ }
}

function safeParseArgs(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  let text = String(raw).replace(/^﻿/, '').trim();
  const tryJson = (s) => {
    try { return JSON.parse(s); } catch (_) { return undefined; }
  };
  let v = tryJson(text);
  if (v && typeof v === 'object') return v;

  // 1) 去掉 ```json 包裹
  const fenced = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  v = tryJson(fenced);
  if (v && typeof v === 'object') return v;

  // 2) 抽取第一个 { ... } 块，做「宽松 JSON 修复」：单引号→双引号、未加引号键加引号、尾部逗号
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start !== -1 && end > start) {
    let body = fenced.slice(start, end + 1);
    body = body
      .replace(/\/\/.*$/gm, '')               // 行注释
      .replace(/,\s*([}\]])/g, '$1')          // 尾部逗号
      .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)\s*:/g, '$1"$2":')  // 未加引号键
      .replace(/:\s*'([^']*)'/g, ': "$1"')    // 单引号值→双引号
      .replace(/'([^']*)'\s*:/g, '"$1":')     // 单引号键→双引号
      .replace(/:\s*'([^']*)'/g, ': "$1"');   // 再次兜底单引号值
    v = tryJson(body);
    if (v && typeof v === 'object') return v;
  }

  // 3) 行式 key: value 兜底（模型用 YAML 风格输出参数时）
  if (text.includes(':') && !text.includes('{')) {
    const obj = {};
    let ok = false;
    for (const line of text.split(/\n+/)) {
      const m = line.match(/^\s*([A-Za-z_$][\w$-]*)\s*[:=]\s*(.*)$/);
      if (m) { obj[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); ok = true; }
    }
    if (ok) return obj;
  }

  throw new Error('参数不是合法 JSON：' + text.slice(0, 200));
}

/**
   * 1.1.15：WebAI2API 网页渲染把 JSON 字符串值里的转义序列破坏后的修复器。
 * 网页会把 \n 渲染成真换行、把 \" 渲染成引号、吞掉反斜杠（如 c:\Users 的 \U 变成非法转义），
 * 使整段 JSON 变成非法文本。这里在「字符串内部」做最小修复，不动字符串外的结构：
 *   - 字符串值内未转义的真换行 / 制表符 → 转义为 \n / \t
 *   - 字符串值内未转义的双引号（被网页渲染破坏的 \"）→ 转义为 \"
 *   - 字符串值内反斜杠后跟非法转义字符（如 \U、\a）→ 转义为 \\U（保留字面反斜杠）
 * 实现：逐字符扫描，维护 inString 状态与 stringKind（键/值）。只处理值字符串内的破坏；
 * 键的结束引号、值的结束引号（后跟 , 或 }）保持原样。结构破坏（缺括号/键值对）交给 safeParseArgs。
 */
function repairArgsJson(raw) {
  const s = String(raw || '');
  let out = '';
  let inString = false;
  let stringKind = null; // 'key' | 'value'
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inString) {
      if (ch === '"') {
        // 确定字符串类型：前面非空白字符是 { 或 , → 键；否则（: 后）→ 值
        let j = i - 1;
        while (j >= 0 && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) j--;
        const prev = j >= 0 ? s[j] : '';
        stringKind = (prev === '{' || prev === ',') ? 'key' : 'value';
        inString = true;
        out += ch;
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === '\\') {
      const n = i + 1 < s.length ? s[i + 1] : '';
      if (n && /[\\"\/bfnrtu]/.test(n)) {
        out += ch + n; i++;            // 合法转义，保留
      } else if (n) {
        out += '\\\\' + n; i++;        // 非法转义（\U 等）→ 字面反斜杠 + 字符
      } else {
        out += '\\\\';                 // 行尾裸反斜杠
      }
      continue;
    }
    if (ch === '"') {
      if (stringKind === 'key') {
        // 键的结束引号（后跟 :），保持原样
        inString = false; stringKind = null; out += ch; continue;
      }
      // 值字符串内：判断是结束引号还是被网页破坏的 \"
      let j = i + 1;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
      const nxt = j < s.length ? s[j] : '';
      if (nxt === ',' || nxt === '}' || nxt === '' || nxt === '\n' || nxt === '\r') {
        inString = false; stringKind = null; out += ch;   // 值的结束引号
      } else {
        out += '\\"';                   // 值内的裸引号 → 转义
      }
      continue;
    }
    if (ch === '\r') {
      if (i + 1 < s.length && s[i + 1] === '\n') i++;      // \r\n 合并为一个换行
      out += '\\n';
      continue;
    }
    if (ch === '\n') { out += '\\n'; continue; }
    if (ch === '\t') { out += '\\t'; continue; }
    out += ch;
  }
  return out;
}

/**
 * 从文本 start 位置起，找到与首个 { 匹配的闭合 }（正确处理字符串内的括号与转义）。
 * 用于从模型的自由文本里截出一个完整的 JSON 对象块。
 */
function extractBalanced(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return '';
}

/** 从模型输出里抽取疑似工具调用的 JSON 块（含 ```json 围栏 与 裸对象 {name/tool/action:...}） */
function collectJsonToolCandidates(text) {
  const out = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fence.exec(text)) !== null) out.push(m[1]);
  const objRe = /\{[^{}]*"name"\s*:|\{[^{}]*"tool"\s*:|\{[^{}]*"action"\s*:/g;
  while ((m = objRe.exec(text)) !== null) {
    const slice = extractBalanced(text, m.index);
    if (slice) out.push(slice);
  }
  return out;
}

// ===== 解析方法（原 AgentSession 类方法 → 模块函数）=====
function parseTextCalls(content, knownTools) {
  const out = [];
  // 1.1.15：先把用户自定义的调用符号（tool-tag-map.json，如 [[tool:write_file]]）归一化为
  // 内部标准 <foxtool>，再走既有解析链——网页上不再出现统一标签，规避风控识别防封号。
  const text = tools.normalizeToolTags(String(content || ''));
  const seen = new Set();
  // exact=true：明确标签来源（<foxtool>/<function>/函数样式）不去重——模型一次输出多个
  // write_file 块（如连续写多份教材文件）时，1.1.14 之前被 seen 按工具名去重，只有第一个
  // 执行、其余静默丢弃，模型还以为都写了。模糊来源（JSON 扫描/截断兜底）仍去重防误判。
  const push = (name, rawArgs, exact) => {
    if (!name) return;
    const n = String(name).trim();
    if (!n) return;
    const key = n.toLowerCase();
    if (!exact) {
      if (seen.has(key)) return;
      seen.add(key);
    }
    // 已知工具名过滤：避免把随机 JSON 对象误判成工具调用（增强③防误触）
    if (knownTools && knownTools.length && !knownTools.includes(key)) return;
    out.push({ id: 'text_' + out.length, name: n, rawArgs: rawArgs || '' });
  };
  writeAgentLog('textcalls', [`parseTextCalls input len=${text.length}`, `head=${text.slice(0, 300).replace(/\s+/g, ' ')}`, `known=${knownTools ? knownTools.length : 'none'}`]);

  // 1) <foxtool name="..">...</foxtool> / <fox:tool> / <tool>
  //    闭合标签感知（1.1.39）：扫描时跳过参数 JSON 字符串值内部的闭合标签，
  //    避免「工具参数里含 </foxtool> 字样」被提前截断导致参数解析失败。
  for (const blk of extractFoxToolBlocks(text)) {
    push(blk.name, blk.body, true);
    if (out.length >= 5) { out._truncated = true; break; }
  }

  // 2) <function name="..">...</function> 风格（部分模型按 OpenAI 工具调用格式吐标签）
  if (out.length < 5) {
    const FN = /<function\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/function>/gi;
    let m;
    while ((m = FN.exec(text)) !== null) {
      push(m[1], m[2], true);
      if (out.length >= 5) { out._truncated = true; break; }
    }
  }

  // 3) 还没解析到，扫描 JSON 块（```json 围栏 或 裸对象 {name/tool/action:...}）
  if (!out.length) {
    for (const jc of collectJsonToolCandidates(text)) {
      let parsed;
      try { parsed = safeParseArgs(jc); } catch (_) { parsed = null; }
      if (!parsed || typeof parsed !== 'object') continue;
      const nm = parsed.name || parsed.tool || parsed.action || parsed.function;
      if (!nm) continue;
      let args;
      if (typeof parsed.arguments === 'string') args = parsed.arguments;
      else if (parsed.arguments !== undefined || parsed.parameters !== undefined)
        args = JSON.stringify(parsed.arguments || parsed.parameters || {});
      else {
        // 其余字段当作参数
        const rest = Object.assign({}, parsed);
        delete rest.name; delete rest.tool; delete rest.action; delete rest.function;
        args = JSON.stringify(rest);
      }
      push(nm, args);
      if (out.length >= 5) { out._truncated = true; break; }
    }
  }

  // 4) 截断兜底：开头是 <foxtool>/<fox:tool>/<tool>/<function> 但缺闭合标签
  if (!out.length) {
    const OPEN_ANY = /<(foxtool|fox:tool|fox-tool|tool|function)\s+name\s*=\s*["']([^"']+)["']\s*>/i;
    const open = OPEN_ANY.exec(text);
    if (open) {
      const name = open[2]; // 统一把工具名放在第 2 组，避免 <function> 与 <foxtool> 分组错位
      // 1.1.39：只截到「本工具块的自然边界」（下一处工具开标签之前），
      // 不再用「正文中任意 < 之后全吞」的过激规则，避免参数 JSON 里含 <tag>/比较表达式被误截。
      const rest = text.slice(open.index + open[0].length);
      const nextOpen = /<(foxtool|fox:tool|fox-tool|tool|function)\s+name\s*=/i.exec(rest);
      const body = (nextOpen ? rest.slice(0, nextOpen.index) : rest)
        .replace(/<\/(foxtool|fox:tool|fox-tool|tool|function)>[\s\S]*$/, '').trim();
      if (body) push(name, body);
    }
  }

  writeAgentLog('textcalls', [`parseTextCalls output count=${out.length}`, `names=${out.map((c) => c.name).join(',')}`, `rawArgsPreview=${out.map((c) => String(c.rawArgs).slice(0, 100)).join(' | ')}`]);
  return out;
}


/**
 * 弱模型模式：对解析出的文本协议工具调用做 JSON Schema 轻量校验。
 * @param {Array} calls parseTextCalls 的结果（{id,name,rawArgs}）
 * @returns {{valid:Array, invalid:Array, report:string}}
 */
function validateTextCalls(calls) {
  const valid = [];
  const invalid = [];
  const reports = [];
  for (const c of calls) {
    const tool = (typeof tools !== 'undefined' && tools.getTool) ? tools.getTool(c.name) : null;
    if (!tool) {
      invalid.push(c);
      reports.push(`- 未知工具：${c.name}（不在可用工具列表中）`);
      continue;
    }
    let args;
    const rawArgs = String(c.rawArgs || '{}');
    // 1.1.15：WebAI2API 网页渲染会把 JSON 字符串值里的 \n 变成真换行、吞掉反斜杠（如 c:\Users 的 \U），
    // 导致裸 JSON.parse 失败。这里先做本地容错修复（safeParseArgs 已有容错链 + repairArgsJson 处理
    // 「字符串值内未转义的真换行/引号」），修复成功直接执行，不回灌模型白费轮次。
    try {
      args = JSON.parse(rawArgs);
    } catch (_) {
      try {
        args = safeParseArgs(rawArgs);
      } catch (_2) {
        try {
          args = JSON.parse(repairArgsJson(rawArgs));
        } catch (_3) {
          invalid.push(c);
          reports.push(`- 工具 ${c.name} 的参数不是合法 JSON（本地修复失败）：${String(_3 && _3.message || '').slice(0, 120)}`);
          continue;
        }
      }
    }
    const v = weakModel.validateToolArgs(tool, args);
    if (!v.ok) {
      invalid.push(c);
      reports.push(`- 工具 ${c.name}：${v.errors.join('；')}`);
    } else {
      // 1.1.15：修复后参数已可用，把修复后的参数写回，本地执行时直接吃修复结果
      valid.push(Object.assign({}, c, { rawArgs: JSON.stringify(args) }));
    }
  }
  return { valid, invalid, report: reports.join('\n') };
}

function stripToolBlocks(content, keepStepMark) {
  let text = String(content || '');
  // 先归一化用户自定义符号（tool-tag-map.json 的 [[tool:%name%]] / [[/tool]]，防网页风控的
  // 自定义调用标签），归一化成内部标准 <foxtool> 再由 TOOL_BLOCK 剥离——否则模型输出的
  // 「正文+[[tool:...]]{json}[[/tool]]」混合流里，自定义符号调用块会原文裸露到思考/回答气泡
  //（1.1.18 修复：stripToolBlocks 之前只剥 <foxtool>，漏掉自定义符号）。
  text = tools.normalizeToolTags(text);
  // 1.1.18 步骤流：剥掉工具块的同时保留「步骤边界标记」，供前端把思考流切成
  // 「💭 思考 / 🖥️ 工具」分步卡片（对齐 DSH 的 Think/Pwsh/Read 动作步骤节奏，
  // 但用狐狸 AI 既有 step-item 时间线卡片体系，不照抄 DSH 终端样式）。
  // 替换回调里用 TOOL_BLOCK 捕获的工具名（$2）生成私有控制符 —— 前端按此切段：
  //   正文段 → step-text 思考卡；\u0002STEP:<name>\u0002 → step-tool 动作卡。
  if (keepStepMark) {
    text = text
      .replace(TOOL_BLOCK, (_m, _a, name) => '\u0002STEP:' + name + '\u0002')
      .replace(/<(fox:?tool|fox-tool|tool)[\s\S]*$/i, '');
  } else {
    // 1.1.23 治本（对齐 dsh 稳定性，修「新会话还会中断」）：默认不留 STEP 边界标记。
    // 模型在历史里看到 `STEP:read_file` 就会模仿输出 `STEP:read_file{...}` 叙述式占位，
    // 工具不执行、空轮 2 次后静默 final —— 这就是「会话中断」的根因闭环。
    // 只在展示路径（onDelta 卡片切分）显式传 keepStepMark=true 才输出 \u0002STEP:<name>\u0002。
    text = text
      .replace(TOOL_BLOCK, '')
      .replace(/<(fox:?tool|fox-tool|tool)[\s\S]*$/i, '');
  }
  // 1.1.31：裸 JSON 工具参数剥离（用户「糊成一团」新形态：模型在正文里直接输出
  // {"path":"parse.js","start_line":225,...} / {"command":"node parse.js 2>&1|Out-String"}
  // 这类无 <foxtool> 外壳的裸参数对象——TOOL_BLOCK 只剥带标签块，剥不到裸 JSON，
  // 原文裸露进正文气泡（08-26/08-29 修的「糊」只覆盖标签块与键=值段，漏了纯 JSON 对象）。
  // 配平剥除工具参数键开头的完整 JSON 对象，保留前后正文；非参数键的 JSON（如示例输出）
  // 不误伤。
  text = stripBareToolArgs(text);
  // 未配对自定义符号兜底：normalizeToolTags 只处理完整配对块，模型输出被截断时
  //（有 [[tool: 无 [[/tool]]）归一化后仍是 [[tool: 原文，TOOL_BLOCK 与 <tool 尾巴正则都不匹配
  //（不是 < 开头）。此时从第一个残留 [[tool: 处截断，保留头部正文，绝不让工具调用原文裸露。
  const customIdx = text.search(/\[\[tool:/i);
  if (customIdx !== -1) text = text.slice(0, customIdx);
  return text.trim();
}

// 裸 JSON 工具参数剥离（1.1.31）：识别正文里孤立的「已知工具参数键」开头的完整 JSON 对象，
// 用括号配平精确剥到对象结尾，保留前后正文。已知参数键表与工具调用参数契约一致：
// path / command / query / glob / content / old_text / new_text / start_line / end_line /
// max_results / timeout / pattern / file / text / args / title / description 等。
// 防止把示例输出 JSON（如 {"ok":true}）或普通对象误剥：只剥「首键是工具参数键」且整体
// 配平为单个 JSON 对象的情况。
// 注意 JSON 对象里键带引号（{"path":...} → slice 后是 "path":...），正则要兼容
// 带引号与不带引号两种形态；title 已在上方出现一次，这里不重复（重复无副作用但保持整洁）。
const BARE_ARG_KEYS = /^(?:"(?:path|command|query|glob|content|old_text|new_text|start_line|end_line|max_results|timeout|pattern|file|text|args|model|input|question|answer|src|dst|name|message|url|body|options)"|(?:path|command|query|glob|content|old_text|new_text|start_line|end_line|max_results|timeout|pattern|file|text|args|model|input|question|answer|src|dst|name|message|url|body|options))\s*:/i;
function stripBareToolArgs(text) {
  if (typeof text !== 'string' || !text.includes('{')) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{' && BARE_ARG_KEYS.test(text.slice(i + 1))) {
      // 从 { 后开始括号配平（跳过字符串内的引号/括号），剥完整对象
      let depth = 1, j = i + 1, inStr = false, esc = false;
      for (; j < text.length; j++) {
        const c = text[j];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
      }
      if (depth === 0) { i = j + 1; continue; } // 完整对象 → 剥掉
      // 未闭合（截断）→ 剥到结尾
      i = text.length;
      continue;
    }
    out += ch; i++;
  }
  return out.trim();
}


module.exports = { TOOL_OPEN, TOOL_BLOCK, TOOL_END, findTagCloseIn, extractFoxToolBlocks,
  writeAgentLog, safeParseArgs, repairArgsJson, extractBalanced, collectJsonToolCandidates,
  parseTextCalls, validateTextCalls, stripToolBlocks, stripBareToolArgs };