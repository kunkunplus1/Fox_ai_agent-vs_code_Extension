(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const messagesEl = $('messages');
  const stepItems = {};
  const thinkingSteps = {};
  const inputEl = $('input');
  const btnSend = $('btnSend');
  const btnAttach = $('btnAttach');
  const attachmentsEl = $('attachments');
  const btnPause = $('btnPause');
  const btnResume = $('btnResume');
  const btnStop = $('btnStop');
  const btnUndo = $('btnUndo');
  const btnRedo = $('btnRedo');
  const btnReadTerminal = $('btnReadTerminal');
  const runBar = $('runBar');
  const runText = $('runText');
  const errorBar = $('errorBar');
  const errorText = $('errorText');
  const ragHintEl = $('ragHint');
  const cacheStatusEl = $('cacheStatus');
  const providerChip = $('providerChip');
  const modelChip = $('modelChip');
  const apiModeChip = $('apiModeChip');
  const thinkChip = $('thinkChip');
  const agentChip = $('agentChip');
  const approveChip = $('approveChip');
  const btnPlanTasks = $('btnPlanTasks');
  const planPanel = $('planPanel');
  const planList = $('planList');
  const btnPlanClearDone = $('btnPlanClearDone');
  const btnContextUsage = $('btnContextUsage');
  const contextPanel = $('contextPanel');
  const contextBody = $('contextBody');
  const btnStorage = $('btnStorage');
  const workchainPanel = $('workchainPanel');
  const workchainList = $('workchainList');
  const workchainHead = $('workchainHead');
  const workchainCount = $('workchainCount');
  const workchainClear = $('workchainClear');
  const workchainToggle = $('workchainToggle');
  const workchainSubbar = $('workchainSubbar');
  const wcFilters = $('wcFilters');
  const wcDetail = $('wcDetail');

  const live = {};
  const toolCards = {};
  let rafPending = false;
  let busy = false;
  let attachments = [];

  const slashPopup = $('slashPopup');
  let slashCandidates = [];
  let slashIndex = -1;
  let slashTimer = null;
  let slashReqId = 0;
  let slashPending = false;
  let slashMcpPolicy = { enabled: false, autoInject: false };

  const APPROVE_LEVELS = ['off', 'read', 'edit', 'all'];
  const APPROVE_LABEL = { off: '每步确认', read: '读放行', edit: '读写放行', all: '全自动' };
  let approveLevel = 'read';

  /* ================= markdown ================= */

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function renderInline(s) {
    let out = escapeHtml(s);
    // 占位符池：图片/链接一律抽出，避免其 url 被后续规则（裸图链、斜体、裸链）二次误伤
    const holds = [];
    const hold = (html) => {
      holds.push(html);
      return '\u0004H' + (holds.length - 1) + '\u0004';
    };
    // 行内代码：优先消费并占位，避免其中的 url/星号被后续规则误伤
    out = out.replace(/`([^`\n]+)`/g, (m, c) => hold('<code class="inline">' + c + '</code>'));
    // 图片 markdown：![alt](url) —— 仅允许 https: / data:image 协议，防止注入
    out = out.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+|data:image\/[a-zA-Z0-9.+-]+;base64,[^\s)]+)\)/g,
      (m, alt, url) => hold(imgTag(alt, url)));
    // 普通链接 [text](url)
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, txt, url) => hold(linkTag(url, txt)));
    // 裸图片链接（以图片扩展名结尾）：自动缩略图
    out = out.replace(/(https?:\/\/\S+\.(png|jpe?g|gif|webp|svg|bmp))(?:\?\S*)?/gi, (m, url) => hold(imgTag('', url)));
    out = out.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[^\s<]+/g, (m) => hold(imgTag('', m)));
    // 裸链接自动可点击：此时图片与 markdown 链接已被占位符保护，不会重复匹配
    out = out.replace(/https?:\/\/[^\s<>"'（）()【】\[\]、，。；]+/g, (m) => {
      const clean = m.replace(/[.,;:!?]+$/, '');
      return hold(linkTag(clean, clean)) + m.slice(clean.length);
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    // 最后还原图片/链接，确保 url 里的 * _ 等字符不被 markdown 规则破坏
    out = out.replace(/\u0004H(\d+)\u0004/g, (m, i) => holds[Number(i)]);
    return out;
  }

  // 外链图片（仅 https: / data:image，杜绝 javascript: 等注入）
  function imgTag(alt, url) {
    const a = escapeHtml(alt || '');
    return '<img class="ext-img" src="' + url + '" alt="' + a + '" title="' + (a || t('图片')) + '" loading="lazy" />';
  }

  // 外部链接：只允许 http(s)。不写 href，改用 data-url + 前端点击 → 扩展端 openExternal，
  // 避免 webview 内导航被拦截导致「点了没反应」。
  function linkTag(url, text) {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) return text;
    return '<a class="ext-link" data-url="' + u + '" title="' + u + '" role="link" tabindex="0">' + text + '</a>';
  }

  // 数学公式渲染：优先用本地 KaTeX（vendor/katex，离线），出错或库未加载时降级为 .math-fallback 纯文本
  function renderMath(tex, display) {
    try {
      if (typeof window !== 'undefined' && window.katex) {
        return window.katex.renderToString(tex, {
          displayMode: !!display,
          throwOnError: false,
          errorColor: '#cc0000',
          output: 'htmlAndMathml'
        });
      }
    } catch (_) { /* 落到下面的纯文本降级 */ }
    return (display ? '<div class="math-fallback">$$' : '$') +
      escapeHtml(tex) + (display ? '$$</div>' : '$');
  }

  // GFM 表格：把一行按 | 拆成单元格（兼容首尾省略的 |）
  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  }
  function isSepRow(line) {
    const cells = splitRow(line);
    return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
  }
  function isTableRow(line) {
    const t = line.trim();
    return t.length > 0 && t.indexOf('|') !== -1 && t.charCodeAt(0) !== 0;
  }

  function renderMarkdown(src) {
    const blocks = [];
    let text = String(src == null ? '' : src);

    text = text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
      blocks.push({ lang: (lang || '').trim(), code: code.replace(/\n$/, '') });
      return '\u0000CB' + (blocks.length - 1) + '\u0000';
    });
    const open = text.lastIndexOf('```');
    if (open !== -1) {
      const rest = text.slice(open + 3);
      const nl = rest.indexOf('\n');
      const lang = (nl === -1 ? rest : rest.slice(0, nl)).trim();
      const code = nl === -1 ? '' : rest.slice(nl + 1);
      blocks.push({ lang, code });
      text = text.slice(0, open) + '\u0000CB' + (blocks.length - 1) + '\u0000';
    }

    // 数学公式：先把块级 $$...$$ 与行内 $...$ 抽成占位符，避免被当成普通文本解析
    // 先保护行内代码（`...`），防止其中的 $...$ 被误当公式
    const inlineCodes = [];
    text = text.replace(/`([^`\n]+)`/g, (m) => {
      inlineCodes.push(m);
      return '\u0005IC' + (inlineCodes.length - 1) + '\u0005';
    });
    const math = [];
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => {
      math.push({ display: true, tex: tex.trim() });
      return '\u0002M' + (math.length - 1) + '\u0002';
    });
    text = text.replace(/\$([^$\n]+?)\$/g, (m, tex) => {
      const tt = tex.trim();
      // 排除像「$10 to $20」这类货币/价格片段：含空格且无任何数学符号
      if (/\s/.test(tt) && !/[\\^_{}=+\-*/<>|&%:;]/.test(tt)) return m;
      math.push({ display: false, tex: tt });
      return '\u0002M' + (math.length - 1) + '\u0002';
    });
    text = text.replace(/\u0005IC(\d+)\u0005/g, (m, i) => inlineCodes[Number(i)] || m);

    const lines = text.split('\n');
    const html = [];
    let listType = null;
    let para = [];

    const flushPara = () => {
      if (para.length) {
        html.push('<p>' + renderInline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
        para = [];
      }
    };
    const closeList = () => {
      if (listType) { html.push(listType === 'ul' ? '</ul>' : '</ol>'); listType = null; }
    };

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.replace(/\s+$/, '');
      const ph = line.match(/^\u0000CB(\d+)\u0000$/);
      if (ph) { flushPara(); closeList(); html.push(codeBlockHtml(blocks[Number(ph[1])])); continue; }
      if (!line.trim()) { flushPara(); closeList(); continue; }

      // GFM 表格：表头行 + 下一行是分隔行时触发
      if (isTableRow(line) && i + 1 < lines.length && isTableRow(lines[i + 1]) && isSepRow(lines[i + 1])) {
        flushPara(); closeList();
        const headCells = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map((c) => {
          const left = c.startsWith(':'), right = c.endsWith(':');
          return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
        });
        const al = (k) => (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '');
        let j = i + 2;
        const rows = [];
        while (j < lines.length && isTableRow(lines[j]) && !isSepRow(lines[j])) {
          rows.push(splitRow(lines[j]));
          j++;
        }
        const thead = '<tr>' + headCells.map((c, k) => '<th' + al(k) + '>' + renderInline(c) + '</th>').join('') + '</tr>';
        const tbody = rows.map((r) => '<tr>' + headCells.map((_, k) => '<td' + al(k) + '>' + renderInline(r[k] || '') + '</td>').join('') + '</tr>').join('');
        html.push('<table><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table>');
        i = j - 1; // 跳过已消费的数据行（循环末 i++ 正好到 j）
        continue;
      }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flushPara(); closeList(); html.push('<h' + h[1].length + '>' + renderInline(h[2]) + '</h' + h[1].length + '>'); continue; }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushPara(); closeList(); html.push('<hr>'); continue; }
      const q = line.match(/^>\s?(.*)$/);
      if (q) { flushPara(); closeList(); html.push('<blockquote>' + renderInline(q[1]) + '</blockquote>'); continue; }
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ul) {
        flushPara();
        if (listType !== 'ul') { closeList(); html.push('<ul>'); listType = 'ul'; }
        html.push('<li>' + renderInline(ul[1]) + '</li>');
        continue;
      }
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ol) {
        flushPara();
        if (listType !== 'ol') { closeList(); html.push('<ol>'); listType = 'ol'; }
        html.push('<li>' + renderInline(ol[1]) + '</li>');
        continue;
      }
      closeList();
      para.push(line);
    }
    flushPara(); closeList();
    let out = html.join('');
    // 还原数学公式（块级 / 行内）：有 KaTeX 时渲染为公式，否则降级为 .math-fallback 纯文本
    out = out.replace(/\u0002M(\d+)\u0002/g, (m, i) => {
      const item = math[Number(i)];
      if (!item) return '';
      return renderMath(item.tex, item.display);
    });
    return out;
  }

  function codeBlockHtml(b) {
    if (!b) return '';
    const lang = (b.lang || 'text').toLowerCase();
    return (
      '<div class="code-block"><div class="code-head">' +
      '<span class="lang">' + escapeHtml(lang) + '</span>' +
      '<button data-act="copy">' + t('复制') + '</button>' +
      '<button data-act="insert">' + t('插入') + '</button>' +
      '<button data-act="newfile">' + t('新文件') + '</button>' +
      '</div><pre><code class="language-' + escapeHtml(lang) + '">' + escapeHtml(b.code) + '</code></pre></div>'
    );
  }

  /* ---------- 搜索引用角标 ---------- */

  // 联网搜索结果里的「标题 → URL」索引：由 web_search 工具输出实时收割，
  // 供来源标签只写了网站名/标题（没带链接）时反查真实网址。
  const citeUrlIndex = [];
  const citeUrlByNum = {};   // [n] / [^n] 数字编号 -> { title, url }
  const CITE_INDEX_MAX = 400;
  // 来源索引变化后重渲染 assistant 气泡的防抖 timer，避免工具流多次 delta 反复全量重排
  let refreshAssistantBubblesTimer = null;

  function normKey(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[\s\u3000“”"'‘’《》〈〉()（）\[\]【】{}.,，。、:：;；!！?？|\-—_]/g, '');
  }

  // 从工具输出中收割 `[1] 标题\nURL: https://...` / `[^1] 标题\nURL: ...` 形式的结果
  function harvestSourceUrls(text) {
    const s = String(text || '');
    if (!s || s.indexOf('://') === -1) return false;
    let changed = false;
    // 后端 buildSourcesText 生成「[n] 标题\nURL: url\n摘要」；这里把摘要（snippet）也一并收割，
    // 让引用浮窗能展示来源内容摘要（参考 DSH WebSource.snippet），而不只是标题 + 链接。
    const re = /^[ \t]*(?:\[\^?(\d+)\^?\][ \t]*)?(.+?)[ \t]*\r?\n[ \t]*(?:URL|url|链接|网址)[:：][ \t]*(https?:\/\/\S+)(?:[ \t]*\r?\n[ \t]*([^\r\n]+))?/gm;
    let m;
    while ((m = re.exec(s))) {
      const num = m[1] ? Number(m[1]) : 0;
      const title = String(m[2] || '').trim();
      const url = String(m[3] || '').trim();
      const snippet = String(m[4] || '').trim().slice(0, 200);
      if (!title || !url) continue;
      const key = normKey(title);
      if (key.length >= 2) {
        if (!citeUrlIndex.some((it) => it.key === key && it.url === url)) {
          citeUrlIndex.push({ key, url });
          if (citeUrlIndex.length > CITE_INDEX_MAX) citeUrlIndex.shift();
          changed = true;
        }
      }
      if (num > 0) {
        const prev = citeUrlByNum[num];
        if (!prev || prev.url !== url || prev.title !== title || (snippet && prev.snippet !== snippet)) {
          citeUrlByNum[num] = { title, url, snippet: snippet || (prev && prev.snippet) || '' };
          changed = true;
        }
      }
    }
    return changed;
  }

  // 直接从来源标签里抠 URL：支持 [标题](url) / 裸链接 / 纯域名
  const TLD = 'com|cn|net|org|io|dev|gov|edu|co|me|info|xyz|top|ai|app|tech|site|wiki';
  function pickUrlFromLabel(label) {
    const s = String(label || '');
    const md = s.match(/\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/);
    if (md) return md[1];
    const bare = s.match(/https?:\/\/[^\s，。；、）)】\]]+/);
    if (bare) return bare[0];
    const dom = s.match(new RegExp('(?:^|[\\s（(])((?:www\\.[\\w-]+(?:\\.[\\w-]+)+|[\\w-]+(?:\\.[\\w-]+)*\\.(?:' + TLD + '))(?:\\/\\S*)?)(?=$|[\\s，。；、）)])', 'i'));
    if (dom) return 'https://' + dom[1];
    return '';
  }

  // 标签没带链接时，按标题在搜索结果索引里反查
  function lookupCiteUrl(label) {
    const k = normKey(label);
    if (k.length < 2) return '';
    // 1) 完全匹配
    for (const it of citeUrlIndex) if (it.key === k) return it.url;
    // 2) 去掉模型常加的前缀后再匹配（如「web_search 结果——」「搜索结果：」等）
    const k2 = k.replace(/^(web[_\-]?search|搜索|来源|参考|网页|结果|results?|sources?)[:：\-—–·\s]+/, '').replace(/^[\-—–·\s]+/, '');
    if (k2.length >= 2 && k2 !== k) {
      for (const it of citeUrlIndex) if (it.key === k2) return it.url;
    }
    // 3) 按常见分隔符拆成多段分别匹配（模型常把多个结果合并成一条用「、」隔开）。
    //    每段先去前缀，再精确匹配；精确失败则按子串模糊匹配（段较长时）。
    //    逐段顺序扫描、命中首段即返回，保证合并标签优先命中靠前的来源。
    const segs = label.split(/[、，,；;|\\/]+/).map((s) => normKey(s)).filter((s) => s.length >= 2);
    const stripCitePrefix = (x) => x.replace(/^(web[_\-]?search|搜索|来源|参考|网页|结果|results?|sources?)[:：\-—–·\s]+/, '').replace(/^[\-—–·\s]+/, '');
    for (const seg of segs) {
      const s2 = stripCitePrefix(seg);
      const cands = [s2, seg].filter((c) => c.length >= 2);
      for (const cand of cands) {
        for (const it of citeUrlIndex) if (it.key === cand) return it.url;
        if (cand.length >= 4) {
          for (const it of citeUrlIndex) if (it.key.indexOf(cand) !== -1 || cand.indexOf(it.key) !== -1) return it.url;
        }
      }
    }
    // 4) 子串模糊匹配（要求稍长一点，避免误伤）
    if (k.length >= 4) {
      for (const it of citeUrlIndex) if (it.key.indexOf(k) !== -1 || k.indexOf(it.key) !== -1) return it.url;
    }
    return '';
  }

  // 搜索结果索引更新后，重新渲染所有已结束的 assistant 气泡，
  // 让原本因 URL 未到而只能静态显示的 [n] 角标变成可点击链接。
  function refreshAssistantBubbles() {
    if (!messagesEl) return;
    if (refreshAssistantBubblesTimer) clearTimeout(refreshAssistantBubblesTimer);
    refreshAssistantBubblesTimer = setTimeout(() => {
      refreshAssistantBubblesTimer = null;
      for (const wrap of messagesEl.querySelectorAll('.msg.assistant')) {
        const bubble = wrap.querySelector('.bubble');
        if (!bubble) continue;
        const raw = bubble.dataset.raw;
        if (!raw) continue;
        const liveId = wrap.dataset.id;
        if (liveId && live[liveId]) {
          live[liveId].dirty = true;
          continue;
        }
        bubble.innerHTML = renderAssistant(raw, liveId);
      }
      scheduleRender();
    }, 120);
  }

  // 解析模型自带的「[n] 标题」参考列表（常出现在文末，可能无 URL）。
  // 返回 { stripped, entries }；entries: [{ num, label, url, lineIndex }]。
  // 用于把模型自己列的参考文献注册成可点角标，并把这些行从正文剥离（由末尾 .cites 统一展示）。
  // 仅当是「连续 [n] 行（>=2）」或「来源/参考 标题 + [n] 行」时才识别，避免误判正文有序列表。
  function parseReferenceList(src) {
    const lines = String(src || '').split('\n');
    const entries = [];
    let headerIdx = -1;
    let i = lines.length - 1;
    while (i >= 0) {
      const lm = lines[i].match(/^[ \t]*\[(\d+)\][ \t]*(.+?)[ \t]*$/);
      if (lm) {
        const label = String(lm[2] || '').trim();
        if (label) {
          const kb = findKbSource(label);
          entries.push({ num: Number(lm[1]), label, url: pickUrlFromLabel(label), lineIndex: i, type: kb ? 'kb' : '', localPath: kb ? kb.file : '' });
        }
        i--;
        continue;
      }
      if (lines[i].trim() === '' && entries.length) { i--; continue; } // 允许空行分隔
      if (entries.length && /^\s*#{0,6}\s*(来源|参考来源|参考文献|引用来源|references?|sources?)\s*:?\s*$/i.test(lines[i])) {
        headerIdx = i;
      }
      break;
    }
    if (entries.length < 2 && headerIdx === -1) return null; // 太短且无标题，避免误判正文有序列表
    const removeSet = new Set(entries.map((e) => e.lineIndex));
    if (headerIdx >= 0) removeSet.add(headerIdx);
    const strippedLines = lines.filter((_, k) => !removeSet.has(k));
    while (strippedLines.length && strippedLines[strippedLines.length - 1].trim() === '') strippedLines.pop();
    return { stripped: strippedLines.join('\n'), entries: entries.reverse() };
  }

  // 解析引用标记：
  // 0) 模型自带的「[n] 标题」参考列表（注册成角标，并从正文剥离）
  // 1) 模型常用的 [^n] / [n] 数字引用（优先匹配 web_search 结果编号）
  // 2) 后端已有的「（来源：xxx）」/「【来源：xxx】」等中文标签
  // 合并为 [n] 角标 + 气泡末尾来源列表，不依赖后端改协议。
  function extractCitations(src) {
    const cites = [];
    const map = {};       // 中文来源标签 -> idx
    const numMap = {};    // 数字 n -> idx

    function resolveNum(num) {
      let idx = numMap[num];
      if (idx !== undefined) return idx;
      idx = cites.length;
      const found = citeUrlByNum[num];
      const label = found ? found.title : ('来源 ' + num);
      const url = found ? found.url : '';
      const kb = found && found.localPath ? found : findKbSource(label);
      cites.push({ label, url, snippet: (found && found.snippet) || '', type: kb ? 'kb' : '', localPath: kb ? kb.file : '' });
      numMap[num] = idx;
      return idx;
    }

    let text = src;

    // 阶段 0：模型自带的「[n] 标题」参考列表（常在文末，可能无 URL）
    // 注册成引用角标，使内联 [n] 可点；并从正文剥离这些行（由末尾 .cites 统一展示）
    const ref = parseReferenceList(text);
    if (ref) {
      for (const e of ref.entries) {
        let url = e.url || lookupCiteUrl(e.label);
        // 若 harvest 已按编号提供真实 URL（即使标题反查失败），优先回填，避免模型自列的合并摘要把链接弄丢
        if (!url && citeUrlByNum[e.num] && citeUrlByNum[e.num].url) {
          url = citeUrlByNum[e.num].url;
        }
        // 仅在 harvest 未提供更优先 URL 时才用模型自列（harvest 优先）
        if (!citeUrlByNum[e.num] || !citeUrlByNum[e.num].url) {
          citeUrlByNum[e.num] = { title: e.label, url, type: e.type || '', localPath: e.localPath || '' };
        }
        if (numMap[e.num] === undefined) {
          const c = citeUrlByNum[e.num];
          cites.push({ label: c.title, url: c.url, type: c.type || '', localPath: c.localPath || '' });
          numMap[e.num] = cites.length - 1;
        }
      }
      text = ref.stripped;
    }

    // 阶段 1：[^n] 无条件识别为引用角标；[n] 只在存在数字索引时识别，避免一刀切误伤普通文本
    text = text.replace(/\[\^(\d+)\^?\]/g, (m, n) => {
      const idx = resolveNum(Number(n));
      return '\u0003CIT' + idx + '\u0003';
    });
    if (Object.keys(citeUrlByNum).length > 0) {
      text = text.replace(/\[(\d+)\]/g, (m, n) => {
        const num = Number(n);
        if (!citeUrlByNum[num]) return m;
        const idx = resolveNum(num);
        return '\u0003CIT' + idx + '\u0003';
      });
    }

    // 阶段 2：中文来源标签
    const re = new RegExp(
      '（\\s*来源[:：]\\s*([^）]+?)\\s*）' +
      '|【\\s*来源[:：]\\s*([^】]+?)\\s*】' +
      '|\\(\\s*来源[:：]\\s*((?:[^()]|\\([^()]*\\))+?)\\s*\\)' +
      '|\\[\\s*来源[:：]\\s*((?:[^\\[\\]]|\\[[^\\[\\]]*\\])+?)\\s*\\]',
      'g'
    );
    text = text.replace(re, (m, g1, g2, g3, g4) => {
      const key = String(g1 || g2 || g3 || g4 || '').trim();
      if (!key) return m;
      let idx = map[key];
      if (idx === undefined) {
        // 本地知识库来源：统一反查（剥包装 + basename 兜底）
        const kb = findKbSource(key);
        if (kb && kb.file) {
          const show = key.replace(/^[\s,，·、:：\-—|]+|[\s,，·、:：\-—|]+$/g, '') || key;
          idx = cites.length;
          cites.push({ label: show, url: '', type: 'kb', localPath: kb.file });
          map[key] = idx;
          return '\u0003CIT' + idx + '\u0003';
        }
        idx = cites.length;
        const url = pickUrlFromLabel(key);
        // 标签内已带链接时，展示文本去掉裸 url，避免又长又乱
        let show = url ? key.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '').trim() : key;
        show = show.replace(/^[\s,，·、:：\-—|]+|[\s,，·、:：\-—|]+$/g, '') || key;
        cites.push({ label: show, url });
        map[key] = idx;
      }
      return '\u0003CIT' + idx + '\u0003';
    });
    return { text, cites };
  }

  // 引用源数据层：按消息 fid 存档 { label, url, type, localPath }，供点击角标弹浮窗取用，避免流式过程中来源数据丢失/串味
  const sourceStore = {};
  // 本地知识库命中来源：相对路径 label -> { label, file(绝对路径) }，供阶段 2 中文来源标签反查并标记为可定位本地文件的角标
  const kbSourceMap = {};
  function recordSources(fid, cites) {
    if (!fid) return;
    sourceStore[fid] = cites.map((c) => ({ label: c.label || '', url: c.url || '', snippet: c.snippet || '', type: c.type || '', localPath: c.localPath || '' }));
  }
  function getSource(fid, idx) {
    const arr = sourceStore[fid];
    if (!arr) return null;
    const s = arr[Number(idx)];
    if (!s) return null;
    return { label: s.label || '', url: s.url || '', snippet: s.snippet || '', type: s.type || '', localPath: s.localPath || '' };
  }
  // 测试/外部重置本地知识库来源映射（仅 Node 导出）
  function setKbSources(sources) {
    for (const k of Object.keys(kbSourceMap)) delete kbSourceMap[k];
    if (Array.isArray(sources)) {
      for (const s of sources) {
        if (s && s.label && s.file) kbSourceMap[String(s.label)] = { label: s.label, file: s.file };
      }
    }
  }
  // 本地知识库标签归一化：剥「（知识库-2）」/「· 相关度」/「本地知识库《...》」/「知识库《...》」/《...》包装，并去掉包装后的 trailing 描述
  function normalizeForKbLookup(label) {
    let s = String(label || '').replace(/[（(]知识库-2[）)]?\s*$/i, '').replace(/\s*·\s*相关度\s*[\d.]+\s*$/, '').trim();
    s = s.replace(/^(?:本地\s*)?知识库[《〈「『]/, '').replace(/[》〉」』]$/, '').trim();
    // 也处理没有「知识库」前缀的《...》/〈...〉/「...」/『...』
    s = s.replace(/^[《〈「『]/, '').replace(/[》〉」』]$/, '').trim();
    // 模型常在《...》后加描述，如「知识库《大纲.md》总故事梗概」→只取文件名部分
    const wrapped = s.match(/^([^》〉」』]+)[》〉」』]\s*(.*)$/);
    if (wrapped) s = wrapped[1].trim();
    return s;
  }
  // 用 label 反查本地知识库：精确匹配 → basename 兜底匹配
  function findKbSource(label) {
    const bare = normalizeForKbLookup(label);
    if (!bare) return null;
    let kb = kbSourceMap[bare];
    if (kb && kb.file) return kb;
    const base = bare.split(/[\\/]/).pop();
    if (!base) return null;
    for (const k of Object.keys(kbSourceMap)) {
      if (k.split(/[\\/]/).pop() === base) return kbSourceMap[k];
    }
    return null;
  }

  // 渲染助手消息：先抽引用角标，再走 markdown（含公式/代码），最后把角标还原为 [n] 并追加来源列表
  function renderAssistant(raw, fid) {
    const { text, cites } = extractCitations(String(raw == null ? '' : raw));
    // 补全链接：标签自带 > 搜索结果索引反查；并把来源存档到该消息，供点击角标取用（URL 晚到也会在重绘时回填）
    const resolved = cites.map((c) => ({ label: c.label, url: c.url || lookupCiteUrl(c.label), type: c.type, localPath: c.localPath }));
    recordSources(fid, resolved);
    let html = renderMarkdown(text);
    html = html.replace(/\u0003CIT(\d+)\u0003/g, (m, i) => {
      const c = resolved[Number(i)] || { label: '', url: '' };
      const n = Number(i) + 1;
      const sid = fid ? (fid + ':' + i) : ('_:' + i);
      const tip = escapeHtml(c.url ? c.label + ' · ' + c.url : c.label);
      // 角标始终可交互（点击弹浮窗，有 URL 则提供跳转）。不再因缺 URL 静默渲染成不可点纯文本。
      return '<sup class="cite link" data-source-id="' + escapeHtml(String(sid)) + '" title="' + tip +
        '" role="link" tabindex="0">[' + n + ']</sup>';
    });
    if (resolved.length) {
      const items = resolved.map((c, i) => {
        const idx = '<span class="cite-idx">[' + (i + 1) + ']</span>';
        const sid = fid ? (fid + ':' + i) : ('_:' + i);
        const body = '<a class="cite-link" data-source-id="' + escapeHtml(String(sid)) + '" title="' +
          escapeHtml(c.url || c.label) + '" role="link" tabindex="0">' + escapeHtml(c.label || c.url) + '</a>';
        return '<span class="cite-item">' + idx + body + '</span>';
      }).join('');
      html += '<div class="cites"><span class="cites-label">' + t('来源') + '</span>' + items + '</div>';
    }
    return html;
  }

  // 点击引用角标/来源项时弹出的浮窗：展示标题与链接，提供「打开来源」跳转
  let citePopupEl = null;
  function ensureCitePopup() {
    if (citePopupEl) return citePopupEl;
    citePopupEl = document.createElement('div');
    citePopupEl.id = 'citePopup';
    citePopupEl.className = 'cite-popup hidden';
    citePopupEl.innerHTML =
      '<div class="cite-popup-title"></div>' +
      '<div class="cite-popup-snippet"></div>' +
      '<button type="button" class="cite-popup-link">打开来源 ↗</button>' +
      '<div class="cite-popup-url"></div>';
    document.body.appendChild(citePopupEl);
    const linkEl = citePopupEl.querySelector('.cite-popup-link');
    linkEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const type = linkEl.getAttribute('data-type') || '';
      const u = linkEl.getAttribute('data-url') || '';
      if (type === 'kb') {
        const p = linkEl.getAttribute('data-path') || '';
        if (p) vscode.postMessage({ type: 'openLocal', path: p });
      } else if (/^https?:\/\//i.test(u)) {
        vscode.postMessage({ type: 'openExternal', url: u });
      }
      hideCitePopup();
    });
    return citePopupEl;
  }
  function showCitePopup(anchor, src) {
    const pop = ensureCitePopup();
    const titleEl = pop.querySelector('.cite-popup-title');
    const snippetEl = pop.querySelector('.cite-popup-snippet');
    const linkEl = pop.querySelector('.cite-popup-link');
    const urlEl = pop.querySelector('.cite-popup-url');
    titleEl.textContent = src.label || (src.type === 'kb' ? t('本地知识库文件') : t('来源'));
    if (snippetEl) {
      const sn = String((src && src.snippet) || '').trim();
      snippetEl.textContent = sn;
      snippetEl.style.display = sn ? '' : 'none';
    }
    if (src.type === 'kb' && src.localPath) {
      linkEl.style.display = '';
      linkEl.textContent = '在资源管理器定位 ↗';
      linkEl.setAttribute('data-type', 'kb');
      linkEl.setAttribute('data-path', src.localPath);
      linkEl.removeAttribute('data-url');
      urlEl.textContent = src.localPath;
    } else if (src.url) {
      linkEl.style.display = '';
      linkEl.textContent = '打开来源 ↗';
      linkEl.setAttribute('data-url', src.url);
      linkEl.removeAttribute('data-type');
      linkEl.removeAttribute('data-path');
      urlEl.textContent = src.url;
    } else {
      linkEl.style.display = 'none';
      linkEl.removeAttribute('data-url');
      linkEl.removeAttribute('data-type');
      linkEl.removeAttribute('data-path');
      urlEl.textContent = '（无可用链接）';
    }
    pop.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    let left = r.left + window.scrollX;
    const top = r.bottom + window.scrollY + 6;
    const maxLeft = window.scrollX + document.documentElement.clientWidth - pr.width - 8;
    if (left > maxLeft) left = maxLeft;
    if (left < window.scrollX + 8) left = window.scrollX + 8;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    if (pop._closeTimer) clearTimeout(pop._closeTimer);
    const closeFn = (ev) => {
      if (pop.contains(ev.target)) return;
      hideCitePopup();
      document.removeEventListener('click', closeFn, true);
    };
    setTimeout(() => document.addEventListener('click', closeFn, true), 0);
  }
  function hideCitePopup() {
    if (citePopupEl) citePopupEl.classList.add('hidden');
  }

  // 代码语法高亮已移除（富文本库精简）：代码块以带语言的纯文本展示。

  /* ================= DOM 辅助 ================= */

  function hideWelcome() {
    const w = $('welcome');
    if (w) w.remove();
  }

  function nearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 90;
  }

  function scrollDown(force) {
    if (force || nearBottom()) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addMessage(role, id) {
    hideWelcome();
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + role;
    wrap.dataset.id = id || '';
    const roleEl = document.createElement('div');
    roleEl.className = 'role';
    roleEl.textContent = role === 'user' ? t('你') : t('狐狸 AI');
    wrap.appendChild(roleEl);
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    wrap.appendChild(bubble);
    // 助手消息内部预留步骤容器，放在正文下方，让执行步骤卡片紧跟产生它的那段正文，避免压在开头或割裂流式输出
    if (role === 'assistant') {
      const steps = document.createElement('div');
      steps.className = 'steps';
      wrap.appendChild(steps);
    }
    messagesEl.appendChild(wrap);
    return { wrap, bubble };
  }

  function renderAttachments() {
    if (!attachmentsEl) return;
    if (!attachments.length) {
      attachmentsEl.innerHTML = '';
      attachmentsEl.classList.add('hidden');
      return;
    }
    attachmentsEl.classList.remove('hidden');
    attachmentsEl.innerHTML = attachments.map((a) =>
      '<span class="att-chip" data-id="' + escapeHtml(a.id) + '">' +
      (a.isImage ? '🖼 ' : '📄 ') +
      escapeHtml(a.name) +
      '<button data-act="remove" data-id="' + escapeHtml(a.id) + '">×</button>' +
      '</span>'
    ).join('');
  }

  function formatTokens(n) {
    if (n >= 10000) return (n / 1000).toFixed(1) + 'K';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  function updateCacheStatus(data) {
    if (!cacheStatusEl) return;
    const cached = typeof data.cachedTokens === 'number' ? data.cachedTokens : 0;
    const prompt = typeof data.promptTokens === 'number' ? data.promptTokens : 0;
    const completion = typeof data.completionTokens === 'number' ? data.completionTokens : 0;
    const hitRate = typeof data.hitRate === 'number' ? data.hitRate : 0;
    const hitPct = Math.round(hitRate * 100);
    const sessionHitRate = typeof data.sessionHitRate === 'number' ? data.sessionHitRate : null;
    const sessionPct = sessionHitRate == null ? null : Math.round(sessionHitRate * 100);
    // 估算节省：DeepSeek/OpenAI 命中部分约按 50% 计费，保守按命中 token 的 50% 算
    const saved = Math.round(cached * 0.5);
    let cls = 'cache-status';
    let icon = '🦊';
    if (prompt === 0 && completion === 0) {
      cacheStatusEl.classList.add('hidden');
      return;
    }
    if (hitPct >= 80) { cls += ' hit-high'; icon = '✨'; }
    else if (hitPct >= 40) { cls += ' hit-mid'; icon = '🔥'; }
    else if (hitPct > 0) { cls += ' hit-low'; icon = '💨'; }
    else { cls += ' hit-none'; icon = '🧊'; }
    if (data.driftByHash) cls += ' drift';
    if (data.hitDrop) cls += ' drop';
    const hitLabel = sessionPct == null
      ? icon + ' 前缀缓存命中 ' + hitPct + '%'
      : icon + ' 本轮命中 ' + hitPct + '% · 会话累计 ' + sessionPct + '%';
    const parts = [
      hitLabel,
      '命中 ' + formatTokens(cached),
      '输出 ' + formatTokens(completion)
    ];
    if (saved > 0) parts.push('约省 ' + formatTokens(saved));
    if (data.driftByHash) parts.push('⚠️ 前缀漂移');
    if (data.hitDrop) parts.push('⚠️ 命中骤降');
    cacheStatusEl.className = cls;
    cacheStatusEl.textContent = parts.join(' · ');
  }

  function renderContextUsage(data) {
    if (!contextBody) return;
    // 回填「上限」输入框（仅在不聚焦时，避免打断正在输入）
    const ctxInput = document.getElementById('contextWindowInput');
    if (ctxInput && data && document.activeElement !== ctxInput) {
      ctxInput.value = (data.contextWindow && data.contextWindow > 0) ? String(data.contextWindow) : '';
    }
    if (!data || !data.items || !data.items.length) {
      contextBody.innerHTML = '<div class="context-empty">' + t('发送消息后，这里会显示当前 prompt 的估算 token 分布。') + '</div>';
      return;
    }
    const total = data.totalMeasured || 0;
    const limit = data.contextWindow || 0;
    const pct = data.percentage || 0;
    const limitText = limit > 0 ? formatTokens(total) + ' / ' + formatTokens(limit) : formatTokens(total) + ' tokens';
    const head = limit > 0
      ? '<div class="context-summary">' +
          '<div class="context-percent">' + pct + '%</div>' +
          '<div class="context-bar"><div class="context-bar-fill" style="--p:' + (Math.min(100, pct) / 100) + ';width:100%"></div></div>' +
          '<div class="context-limit">' + t('已使用 ') + limitText + '</div>' +
        '</div>'
      : '<div class="context-summary">' +
          '<div class="context-limit">' + t('估算输入：') + limitText + '</div>' +
          '<div class="context-hint">' + t('在设置里填 foxAi.contextWindow 可显示占比') + '</div>' +
        '</div>';

    const palette = {
      system: 'var(--vscode-charts-blue, #3794ff)',
      tools: 'var(--vscode-charts-purple, #b180d7)',
      history: 'var(--vscode-charts-yellow, #d7ba7d)',
      memory: 'var(--vscode-charts-green, #3fb950)',
      skills: 'var(--vscode-charts-orange, #d18616)',
      planTasks: 'var(--vscode-charts-red, #f14c4c)',
      knowledge: 'var(--vscode-charts-cyan, #4ec9b0)'
    };

    const rows = data.items.map((it) => {
      const color = palette[it.key] || 'var(--vscode-charts-foreground, #999)';
      const rowPct = total > 0 ? Math.round((it.tokens / total) * 1000) / 10 : 0;
      return (
        '<div class="context-item">' +
          '<div class="context-item-top">' +
            '<span class="context-dot" style="background:' + color + '"></span>' +
            '<span class="context-label">' + escapeHtml(it.label) + '</span>' +
            '<span class="context-value">' + formatTokens(it.tokens) + ' tokens (' + rowPct + '%)</span>' +
          '</div>' +
          '<div class="context-item-bar"><div class="context-item-fill" style="--p:' + (Math.min(100, rowPct) / 100) + ';width:100%;background:' + color + '"></div></div>' +
        '</div>'
      );
    }).join('');

    // 「距离自动压缩」状态区：避免只显示总占用量误导用户
    let compressHtml = '';
    const cm = data.compressMeta;
    if (cm && cm.enabled && limit > 0) {
      const thrPct = Math.round(cm.threshold * 1000) / 10;
      const fillPct = thrPct > 0 ? Math.min(100, (pct / thrPct) * 100) : 0;
      if (pct >= thrPct) {
        if (cm.compressible >= 1) {
          compressHtml =
            '<div class="context-compress ready">' +
              '<div class="cc-title">🗜️ 自动压缩 · 阈值 ' + thrPct + '%</div>' +
              '<div class="context-compress-bar"><div class="context-compress-fill" style="--p:1;width:100%"></div></div>' +
              '<div class="cc-status warn">已达阈值，下次对话后将自动压缩</div>' +
            '</div>';
        } else {
          compressHtml =
            '<div class="context-compress no-content">' +
              '<div class="cc-title">🗜️ 自动压缩 · 阈值 ' + thrPct + '%</div>' +
              '<div class="context-compress-bar"><div class="context-compress-fill" style="--p:1;width:100%"></div></div>' +
              '<div class="cc-status muted">已达阈值，但可压缩对话不足（占用多为固定开销），暂不压缩</div>' +
            '</div>';
        }
      } else {
        const gapPct = Math.max(0, Math.round((thrPct - pct) * 10) / 10);
        const gapTokens = Math.max(0, Math.round((thrPct / 100) * limit - total));
        compressHtml =
          '<div class="context-compress">' +
            '<div class="cc-title">🗜️ 自动压缩 · 阈值 ' + thrPct + '%</div>' +
            '<div class="context-compress-bar"><div class="context-compress-fill" style="--p:' + (fillPct / 100) + ';width:100%"></div></div>' +
            '<div class="cc-status ok">距离自动压缩还需约 ' + gapPct + '%（约 +' + formatTokens(gapTokens) + ' tokens）</div>' +
          '</div>';
      }
    } else if (cm && cm.enabled && limit <= 0) {
      const toGo = Math.max(0, 6 - cm.compressible);
      compressHtml =
        '<div class="context-compress">' +
          '<div class="cc-title">🗜️ 自动压缩（按对话轮数）</div>' +
          (cm.compressible >= 6
            ? '<div class="cc-status warn">已达到轮数阈值，下次对话后压缩</div>'
            : '<div class="cc-status ok">还差约 ' + toGo + ' 条对话消息触发</div>') +
        '</div>';
    } else if (cm && !cm.enabled) {
      compressHtml =
        '<div class="context-compress off">' +
          '<div class="cc-title">🗜️ 自动压缩</div>' +
          '<div class="cc-status off">未开启（设置 foxAi.knowledgeBase.autoSummarize.enabled）</div>' +
        '</div>';
    }

    contextBody.innerHTML = head + compressHtml + '<div class="context-list">' + rows + '</div>';
  }

  function renderPlanTasks(items) {
    if (!planList) return;
    if (!items || !items.length) {
      planList.innerHTML = '<div class="plan-empty">' + t('暂无任务，让狐狸 AI 用 create_plan_task 拆分项目步骤吧～') + '</div>';
      return;
    }
    planList.innerHTML = items.map((it) => {
      const cls = 'plan-item ' + (it.status === 'completed' ? 'completed' : it.status === 'in_progress' ? 'in-progress' : 'pending');
      const icon = it.status === 'completed' ? '✓'
        : it.status === 'in_progress' ? '<span class="spinner"></span>'
        : '○';
      return (
        '<div class="' + cls + '" data-id="' + escapeHtml(it.id) + '">' +
          '<span class="plan-icon">' + icon + '</span>' +
          '<span class="plan-text">' +
            '<span class="plan-subject">' + escapeHtml(it.subject) + '</span>' +
            (it.description ? '<span class="plan-desc">' + escapeHtml(it.description) + '</span>' : '') +
          '</span>' +
          '<button class="plan-del" data-act="del" title="' + t('删除任务') + '" aria-label="' + t('删除任务') + '">🗑</button>' +
        '</div>'
      );
    }).join('');
  }

  // 对「无标点、无 markdown 结构」的推理文本做兜底分段，避免一整坨“看了个寂寞”。
  // 断点只由字符索引 / 句索引决定（在固定窗口内就近找停顿），随文本增长单调不变，流式重绘不抖动。
  function softSegment(t) {
    if (!t || t.length < 90) return t;
    if (/^#{1,6}\s|^[-*+]\s|^\d+[.)]\s/m.test(t)) return t; // 已有 markdown 结构，不动
    const SEG = 90, LOOK = 14;
    // 有标点：按句末标点切句，每 3 句拼成一段（段边界按句索引，单调稳定，不抖动）
    if (/[。！？!?；;…\n]/.test(t)) {
      const sents = (t.match(/[^。！？!?；;…\n]+[。！？!?；;…\n]?/g) || [t]).filter(Boolean);
      if (sents.length <= 3) return t;
      const pieces = [];
      for (let i = 0; i < sents.length; i += 3) pieces.push(sents.slice(i, i + 3).join(''));
      return pieces.length > 1 ? pieces.join('\n\n') : t;
    }
    // 无标点：按固定索引窗口就近找停顿符切（断点由字符索引决定，单调稳定）
    const pieces = [];
    let idx = 0;
    while (idx < t.length) {
      let end = Math.min(idx + SEG, t.length);
      if (end < t.length) {
        let at = end + LOOK;
        for (let j = end; j <= end + LOOK && j < t.length; j++) {
          const c = t[j];
          if (c === '，' || c === ',' || c === '、' || c === '；' || c === '：' || c === ':' || c === ' ' || c === '\n') { at = j; break; }
          if ('的了着呢吧啊吗呀与和及或在对为把被从向给到这那你我他它她'.indexOf(c) !== -1) { at = j; break; }
        }
        end = at;
      }
      pieces.push(t.slice(idx, end));
      idx = end;
    }
    return pieces.length > 1 ? pieces.join('\n\n') : t;
  }

  function renderReasoning(text) {
    const t = String(text || '').trim();
    if (!t) return '';
    // 用 markdown 渲染，让标题/列表/加粗/代码等结构清晰可见；
    // 无标点/无结构的意识流先做兜底分段，至少从「一坨」变成「可读的多段」。
    return '<div class="reasoning-md">' + renderMarkdown(softSegment(t)) + '</div>';
  }

  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const stick = nearBottom();
      for (const id of Object.keys(live)) {
        const m = live[id];
        if (!m.dirty) {
          // 即使本轮没有新 delta，已结束的气泡也要在最后清理一次
          if (m.ended) finalizeLive(id, m);
          continue;
        }
        m.dirty = false;
        if (!m.bubble.isConnected) { delete live[id]; continue; }
        m.bubble.innerHTML = m.raw ? renderAssistant(m.raw, id) : '<span class="typing"></span>';
        if (m.raw) m.bubble.dataset.raw = m.raw;
        if (m.images && m.images.length) {
          for (const img of m.images) {
            const wrapper = document.createElement('div');
            wrapper.className = 'generated-image';
            const el = document.createElement('img');
            el.src = img.src || '';
            el.alt = img.alt || t('模型生成图片');
            el.title = img.alt || t('模型生成图片');
            el.onerror = () => { el.style.display = 'none'; wrapper.textContent = '（图片加载失败）'; };
            wrapper.appendChild(el);
            const saveBtn = document.createElement('button');
            saveBtn.className = 'gen-image-save';
            saveBtn.textContent = t('保存');
            saveBtn.title = t('保存图片到本地');
            saveBtn.addEventListener('click', () => {
              vscode.postMessage({ type: 'saveImage', src: img.src, name: img.alt || 'generated-image' });
            });
            wrapper.appendChild(saveBtn);
            m.bubble.appendChild(wrapper);
          }
        }
        if (m.reasoning) {
          if (!m.reasonEl) {
            m.reasonEl = document.createElement('div');
            m.reasonEl.className = 'reasoning open';
            m.reasonEl.innerHTML =
              '<div class="reasoning-head">' +
                '<span class="reasoning-title">' + t('已思考') + '</span>' +
                '<span class="reasoning-caret">▾</span>' +
              '</div>' +
              '<div class="reasoning-body"></div>';
            m.reasonEl.querySelector('.reasoning-head').addEventListener('click', () => {
              m.reasonEl.classList.toggle('open');
            });
            const wrap = m.bubble.parentElement;
            // 插入到消息容器最前（角色标签「狐狸 AI」之上），使思考链成为独立、全宽的一行，
            // 避免被插在角色标签与气泡之间造成视觉错位；父节点缺失（已结束的消息）时跳过。
            if (wrap) wrap.insertBefore(m.reasonEl, wrap.firstChild || m.bubble);
          }
          if (!m.reasoningStart) m.reasoningStart = Date.now();
          const body = m.reasonEl.querySelector('.reasoning-body');
          // 内容长度未变则不重建 innerHTML，减少长会话下的重排抖动
          const rev = String(m.reasoning.length);
          if (body.dataset.rev !== rev) {
            body.innerHTML = renderReasoning(m.reasoning);
            body.dataset.rev = rev;
          }
          body.scrollTop = body.scrollHeight;
        }
        if (m.ended) finalizeLive(id, m);
      }
      if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function finalizeLive(id, m) {
    // 思考结束后在标题补上用时，并保持展开（参考 DeepSeek 的「已思考（用时 X 秒）」面板）
    if (m.reasonEl) {
      const titleEl = m.reasonEl.querySelector('.reasoning-title');
      const secs = m.reasoningStart ? Math.max(1, Math.round((Date.now() - m.reasoningStart) / 1000)) : 0;
      if (titleEl) titleEl.textContent = secs ? (t('已思考（用时 ') + secs + t(' 秒）')) : t('已思考');
    }
    if (!m.raw && !m.reasoning && m.bubble && m.bubble.parentElement) m.bubble.parentElement.remove();
    delete live[id];
  }

  function renderDiff(text) {
    const lines = String(text || '').split('\n');
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      let cls = 'diff-line-ctx';
      let gutter = ' ';
      if (l.startsWith('+')) { cls = 'diff-line-add'; gutter = '+'; }
      else if (l.startsWith('-')) { cls = 'diff-line-del'; gutter = '-'; }
      const content = escapeHtml(l.slice(1));
      rows.push(
        '<div class="diff-row ' + cls + '">' +
        '<span class="diff-gutter">' + gutter + '</span>' +
        '<code class="diff-code">' + (content || '&nbsp;') + '</code>' +
        '</div>'
      );
    }
    return '<div class="diff-inline">' + rows.join('') + '</div>';
  }

  const KIND_ICON = { read: '📖', edit: '✏️', exec: '⚡' };
  const STATUS_ICON = { running: '⏳', ok: '✅', error: '❌', rejected: '🚫' };
  const STEP_ICON = { llm: '🧠', read: '🔍', write: '✏️', edit: '✏️', delete: '🗑️', exec: '🖥️', command: '🖥️', info: '•', review: '🔎', approval: '⏳', done: '✅', error: '❌', system_status: '📊' };
  // 思考链按类型归类用的小图标（主聊天区状态轨迹 & 步骤分组）
  const GROUP_ICON = { tool: '🔧', reason: '🧠', error: '❌', warn: '⚠️', llm: '✅' };

  // 把增量消息合并进步骤节点的结构化元数据（tool_name/parameters/result/timestamp/duration/status/group）
  function applyStepMeta(el, msg) {
    const m = el._meta || (el._meta = {});
    if (msg.tool_name !== undefined) m.tool_name = msg.tool_name;
    if (msg.parameters !== undefined) m.parameters = msg.parameters;
    if (msg.result !== undefined) m.result = msg.result;
    if (msg.summary !== undefined) m.summary = msg.summary;
    if (msg.title !== undefined) m.title = msg.title;
    if (msg.status !== undefined) m.status = msg.status;
    if (msg.group !== undefined) m.group = msg.group;
    if (msg.stepType !== undefined) m.stepType = msg.stepType;
    if (msg.timestamp !== undefined) m.timestamp = msg.timestamp;
    if (msg.duration !== undefined) m.duration = msg.duration;
    if (msg.detail !== undefined) m.detail = msg.detail;
    if (msg.kind !== undefined) m.kind = msg.kind;
    return m;
  }

  // 结构化参数渲染成可读文本（对象折叠成紧凑 JSON，其余直接转字符串）
  function formatParams(p) {
    if (p == null) return '';
    if (typeof p === 'string') return p;
    try { return JSON.stringify(p, null, 2); } catch (_) { return String(p); }
  }

  function fmtDuration(ms) {
    if (!ms || ms < 0) return '';
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  }

  function addToolCard(msg) {
    hideWelcome();
    const card = document.createElement('div');
    card.className = 'tool-card kind-' + (msg.kind || 'read') + ' status-running grp-tool';
    card.dataset.id = msg.id;
    card.dataset.grp = 'tool';
    const meta = applyStepMeta(card, msg);

    const stat = msg.preview && msg.preview.stat
      ? `+${msg.preview.stat.added} -${msg.preview.stat.removed}`
      : '';

    const isEdit = msg.kind === 'edit' || (msg.preview && msg.preview.text);
    card.dataset.hasPreview = isEdit ? '1' : '';

    card.innerHTML =
      '<div class="step-rail"></div>' +
      '<div class="step-node"><span class="step-dot">' + (KIND_ICON[msg.kind] || '🔧') + '</span></div>' +
      '<div class="step-main">' +
        '<div class="tool-head">' +
          '<span class="icon">' + (KIND_ICON[msg.kind] || '🔧') + '</span>' +
          '<span class="title"></span>' +
          '<span class="stat">' + escapeHtml(stat) + '</span>' +
          '<span class="step-dur"></span>' +
          '<span class="state">⏳</span>' +
          '<span class="caret">▾</span>' +
        '</div>' +
        '<div class="step-detail">' +
          '<div class="step-params"></div>' +
          '<div class="tool-body">' +
            '<div class="args"></div>' +
            '<pre class="out"></pre>' +
          '</div>' +
        '</div>' +
      '</div>';

    card.querySelector('.title').textContent = msg.title || msg.name;
    // 点击表头折叠/展开详情（结构化参数 + 工具输出）
    card.querySelector('.tool-head').addEventListener('click', () => card.classList.toggle('open'));
    const paramsEl = card.querySelector('.step-params');
    const ptext = formatParams(meta.parameters);
    if (ptext) {
      const pre = document.createElement('pre');
      pre.className = 'params-pre';
      pre.textContent = ptext;
      paramsEl.appendChild(pre);
    } else {
      paramsEl.remove();
    }

    const argsEl = card.querySelector('.args');
    if (msg.preview && msg.preview.text) {
      argsEl.innerHTML = renderDiff(msg.preview.text);
      card.classList.add('open');
    } else if (msg.argsText) {
      const pre = document.createElement('pre');
      pre.textContent = msg.argsText;
      argsEl.appendChild(pre);
      if (isEdit) card.classList.add('open');
    } else {
      argsEl.remove();
    }

    if (msg.preview) {
      const actions = document.createElement('div');
      actions.className = 'tool-actions';
      actions.innerHTML =
        '<button class="mini ghost" data-act="open">' + t('打开文件') + '</button>' +
        '<button class="mini" data-act="diff">' + t('🔍 在 Diff 视图中打开') + '</button>';
      actions.dataset.path = msg.preview.path || '';
      card.querySelector('.tool-body').appendChild(actions);
    }

    // 工具卡片物理隔离到独立工作链面板，不再和正文流抢同一个轨道，杜绝插中间问题
    if (workchainList) workchainList.appendChild(card);
    else messagesEl.appendChild(card);
    toolCards[msg.id] = card;
    updateWorkchainCount();
    scrollDown();
    return card;
  }

  function updateToolCard(msg) {
    const card = toolCards[msg.id];
    if (!card) return;
    card.classList.remove('status-running');
    card.classList.add('status-' + msg.status);
    if (msg.status === 'ok') {
      card.classList.remove('just-done');
      void card.offsetWidth; // 重置动画，保证每次成功都脉冲一次
      card.classList.add('just-done');
      setTimeout(() => card.classList.remove('just-done'), 760);
    }
    const state = card.querySelector('.state');
    if (state) state.textContent = STATUS_ICON[msg.status] || '';
    const durEl = card.querySelector('.step-dur');
    if (durEl) durEl.textContent = fmtDuration(msg.duration);
    const out = card.querySelector('.out');
    if (out && msg.output) {
      out.textContent = msg.output;
      if (msg.status === 'error') card.classList.add('open');
    }
    // 收割搜索结果里的「标题 → 网址」，供引用角标反查真实链接；
    // 只有索引真有变化才重渲染，且用防抖避免工具流多次 delta 反复全量重排。
    if (msg.output) { const hadNew = harvestSourceUrls(msg.output); if (hadNew) refreshAssistantBubbles(); }
    // 写入/编辑类工具的改动预览默认保持展开，不用反复点
    if (card.dataset.hasPreview && msg.status === 'ok') {
      card.classList.add('open');
    }
    scrollDown();
  }

  // 实际创建/更新步骤卡片 DOM（时间线节点：左圆点 + 摘要行 + 折叠详情）
  function renderStepItem(msg) {
    let el = stepItems[msg.id];
    if (!el) {
      el = document.createElement('div');
      el.className = 'step-item';
      el.dataset.id = msg.id;
      el.innerHTML =
        '<div class="step-rail"></div>' +
        '<div class="step-node"><span class="step-dot"></span></div>' +
        '<div class="step-main">' +
          '<div class="step-row">' +
            '<span class="step-icon"></span>' +
            '<span class="step-title"></span>' +
            '<span class="step-dur"></span>' +
            '<span class="step-state"></span>' +
            '<span class="step-caret">▾</span>' +
          '</div>' +
          '<div class="step-detail">' +
            '<div class="step-params"><span class="step-label" data-k="params">参数</span></div>' +
            '<div class="step-result"><span class="step-label" data-k="result">结果</span></div>' +
            '<div class="step-thinking"></div>' +
          '</div>' +
        '</div>';
      el.querySelector('.step-row').addEventListener('click', () => el.classList.toggle('open'));
      stepItems[msg.id] = el;
    }
    return refreshStepNode(el, msg);
  }

  // 依据 _meta + 当前消息重新渲染步骤节点的摘要行与折叠详情
  function refreshStepNode(el, msg) {
    if (msg) applyStepMeta(el, msg);
    const m = el._meta || {};
    const isThinking = String(el.dataset.id).startsWith('thinking-');
    const grp = m.group || (isThinking ? 'reason' : 'llm');
    el.dataset.grp = grp;
    el.className = 'step-item kind-' + (m.kind || 'info') + ' status-' + (m.status || 'running') +
      ' grp-' + grp + (m.detail || m.result || m.parameters ? ' has-detail' : '') + (isThinking ? ' open' : '');
    const icon = STEP_ICON[m.kind] || GROUP_ICON[grp] || '•';
    el.querySelector('.step-icon').textContent = icon;
    el.querySelector('.step-dot').textContent = icon;
    el.querySelector('.step-title').textContent = m.summary || m.title || (grp === 'reason' ? t('调用模型') : '');
    el.querySelector('.step-dur').textContent = fmtDuration(m.duration);
    const st = m.status || 'running';
    el.querySelector('.step-state').textContent = st === 'ok' ? '✓' : st === 'error' || st === 'rejected' ? '✗' : '⏳';
    // 结构化参数
    const paramsEl = el.querySelector('.step-params');
    const ptext = formatParams(m.parameters);
    if (ptext) {
      paramsEl.innerHTML = '<span class="step-label">参数</span>';
      const pre = document.createElement('pre');
      pre.className = 'params-pre';
      pre.textContent = ptext;
      paramsEl.appendChild(pre);
      paramsEl.style.display = '';
    } else if (paramsEl) paramsEl.style.display = 'none';
    // 结构化结果
    const resEl = el.querySelector('.step-result');
    if (m.result) { resEl.textContent = String(m.result).slice(0, 2000); resEl.style.display = ''; }
    else if (resEl) resEl.style.display = 'none';
    // 普通 detail 文本（无结构化 result 时兜底）
    const thinkEl = el.querySelector('.step-thinking');
    if (m.detail && !m.result) { thinkEl.textContent = String(m.detail); thinkEl.style.display = ''; }
    else if (thinkEl) thinkEl.style.display = 'none';
    return el;
  }

  function addStep(msg) {
    hideWelcome();
    const el = renderStepItem(msg);
    // 步骤卡片物理隔离到独立工作链面板，不再污染主聊天正文流
    if (workchainList) workchainList.appendChild(el);
    else messagesEl.appendChild(el);
    // thinking 步骤（调用模型）初始化内容容器，供后续 delta/reasoning/image 写入
    if (String(msg.id).startsWith('thinking-') || (msg.kind === 'llm' && msg.status === 'running')) {
      thinkingSteps[msg.id] = { el, raw: '', reasoning: '', images: [] };
    }
    updateWorkchainCount();
    scrollDown();
    return el;
  }

  function updateStepMeta(id, patch) {
    const el = stepItems[id];
    if (!el) return;
    refreshStepNode(el, patch);
    if (patch && patch.status === 'running') scrollDown();
  }

  function updateThinkingStep(msg_id, type, data) {
    const ts = thinkingSteps[msg_id];
    if (!ts || !ts.el) return;
    if (type === 'text') {
      ts.raw += data.text || '';
    } else if (type === 'reasoning') {
      const t = data.text || '';
      if (ts.reasoning) {
        if (t.length > ts.reasoning.length && t.startsWith(ts.reasoning)) {
          ts.reasoning = t;
        } else if (t.length > 0 && ts.reasoning.includes(t)) {
          // 完全相同片段已存在，跳过
        } else {
          ts.reasoning += t;
        }
      } else {
        ts.reasoning = t;
      }
    } else if (type === 'image') {
      if (!ts.images) ts.images = [];
      ts.images.push({ src: data.src, alt: data.alt || '模型生成图片' });
    }
    const thinkEl = ts.el.querySelector('.step-thinking');
    if (!thinkEl) return;
    const parts = [];
    if (ts.reasoning && String(ts.reasoning).trim()) {
      parts.push('<div class="thinking-section"><div class="thinking-section-title">已思考</div>' + renderReasoning(ts.reasoning) + '</div>');
    }
    if (ts.raw && String(ts.raw).trim()) {
      parts.push('<div class="thinking-section"><div class="thinking-section-title">输出</div>' + renderAssistant(ts.raw) + '</div>');
    }
    if (ts.images && ts.images.length) {
      for (const img of ts.images) {
        parts.push('<div class="generated-image"><img src="' + escapeHtml(img.src) + '" alt="' + escapeHtml(img.alt) + '"></div>');
      }
    }
    if (parts.length) {
      thinkEl.innerHTML = parts.join('');
      thinkEl.style.display = '';
      ts.el.classList.add('has-detail');
      // thinking 步骤一旦有内容就自动展开，避免用户看不到思考过程
      ts.el.classList.add('open');
    }
  }

  function appendToolStream(msg) {
    const card = toolCards[msg.id];
    if (!card) return;
    const out = card.querySelector('.out');
    if (!out) return;
    card.classList.add('open');
    out.textContent += msg.text;
    if (out.textContent.length > 20000) out.textContent = out.textContent.slice(-20000);
    out.scrollTop = out.scrollHeight;
    scrollDown();
  }

  function addApproval(msg) {
    hideWelcome();
    const box = document.createElement('div');
    box.className = 'approval';
    box.dataset.id = msg.id;
    const risky = msg.kind === 'exec' ? t('执行命令') : msg.kind === 'edit' ? t('修改文件') : t('读取');
    box.innerHTML =
      '<span class="q">' + t('要允许「{0}」吗？（{1}）', escapeHtml(msg.title || msg.name), risky) + '</span>' +
      '<button class="mini primary" data-d="approve">' + t('允许') + '</button>' +
      '<button class="mini" data-d="always">' + t('总是允许') + '</button>' +
      '<button class="mini danger" data-d="reject">' + t('拒绝') + '</button>';
    messagesEl.appendChild(box);
    scrollDown(true);
  }

  function addPlanPending(msg) {
    hideWelcome();
    const plan = msg.plan || [];
    const itemsHtml = plan.length
      ? plan.map((it) => {
          const icon = it.status === 'completed' ? '✓' : it.status === 'in_progress' ? '🔄' : '○';
          return '<li><span class="plan-icon">' + icon + '</span> ' +
            '<b>' + escapeHtml(it.subject) + '</b>' +
            (it.description ? ' — ' + escapeHtml(it.description) : '') + '</li>';
        }).join('')
      : '<li class="plan-empty">（计划为空，模型尚未用 create_plan_task 列出步骤）</li>';
    const box = document.createElement('div');
    box.className = 'plan-pending';
    box.innerHTML =
      '<div class="plan-pending-head">' +
        (msg.revised ? t('🔄 计划已修订，请再次确认') : t('📋 狐狸 AI 已提交执行计划，请确认')) +
      '</div>' +
      '<ol class="plan-pending-list">' + itemsHtml + '</ol>' +
      '<div class="plan-pending-actions">' +
        '<button class="mini primary" id="planConfirmBtn">' + t('✅ 确认执行') + '</button>' +
      '</div>' +
      '<div class="plan-pending-modify">' +
        '<textarea id="planModifyInput" rows="2" placeholder="' + t('想修改计划？在此输入意见，点「提交修改」让狐狸 AI 重新规划…') + '"></textarea>' +
        '<button class="mini" id="planModifyBtn">' + t('✏️ 提交修改') + '</button>' +
      '</div>';
    messagesEl.appendChild(box);
    scrollDown(true);
    box.querySelector('#planConfirmBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'planApprove' });
    });
    box.querySelector('#planModifyBtn').addEventListener('click', () => {
      const text = (box.querySelector('#planModifyInput').value || '').trim();
      const full = text ? '【修改计划】' + text : '请重新规划并再次提交计划以待确认。';
      vscode.postMessage({ type: 'send', text: full });
    });
  }

  function addPlan(msg) {
    const steps = msg.steps || [];
    if (!steps.length) return;
    hideWelcome();
    const itemsHtml = steps.map((s) => {
      const dep = (s.dependsOn && s.dependsOn.length) ? ' <span class="plan-dep">' + t('依赖：') + escapeHtml(s.dependsOn.join('、')) + '</span>' : '';
      const par = s.parallel ? ' <span class="plan-par">' + t('并行') + '</span>' : '';
      return '<li><b>' + escapeHtml(s.title) + '</b>' + dep + par + '</li>';
    }).join('');
    const box = document.createElement('div');
    box.className = 'plan-card';
    box.innerHTML =
      '<div class="plan-card-head">' + t('📋 执行计划（{0} 步）', steps.length) + '</div>' +
      '<ol class="plan-card-list">' + itemsHtml + '</ol>';
    messagesEl.appendChild(box);
    scrollDown(true);
  }

  function miniMarkdown(src) {
    return escapeHtml(src)
      .replace(/^### (.*)$/gm, '<h4>$1</h4>')
      .replace(/^## (.*)$/gm, '<h3>$1</h3>')
      .replace(/^\s*[-*] (.*)$/gm, '<span class="li">• $1</span>')
      .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
      .replace(/\n/g, '<br>');
  }

  function addReview(msg) {
    hideWelcome();
    const files = msg.files || [];
    const text = msg.text || '';
    const id = msg.id || '';
    const filesHtml = files.length
      ? '<div class="review-files">' + t('审查文件：') + files.map((f) => '<code>' + escapeHtml(f) + '</code>').join('、') + '</div>'
      : '';
    const box = document.createElement('div');
    box.className = 'review-card';
    if (id) box.dataset.reviewId = id;
    box.innerHTML =
      '<div class="review-head">' + t('🔍 代码审查意见（自动）') + '</div>' +
      filesHtml +
      '<div class="review-body">' + miniMarkdown(text) + '</div>' +
      '<div class="review-actions">' +
        '<button class="mini primary" data-act="apply-review">' + t('✅ 按审查意见修正') + '</button>' +
        '<span class="review-status"></span>' +
      '</div>';
    const applyBtn = box.querySelector('[data-act="apply-review"]');
    const statusEl = box.querySelector('.review-status');
    if (applyBtn) {
      applyBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'applyReview', text, id });
        applyBtn.disabled = true;
        applyBtn.textContent = t('修正中…');
        if (statusEl) statusEl.textContent = '';
      });
    }
    messagesEl.appendChild(box);
    scrollDown(true);
  }

  function fmtTokenCount(n) {
    const v = Number(n) || 0;
    return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v);
  }

  function buildArtifactReport(msg) {
    const files = (msg && msg.files) || [];
    const title = (msg && msg.title) || '';
    const text = (msg && msg.text) || '';
    const lines = [];
    lines.push('# 狐狸 AI 任务报告');
    lines.push('');
    lines.push('> 生成时间：' + new Date().toLocaleString('zh-CN'));
    if (title) { lines.push(''); lines.push('## 任务'); lines.push(''); lines.push(String(title).replace(/\s+/g, ' ')); }
    lines.push('');
    lines.push('## 改动文件（' + files.length + ' 个）');
    lines.push('');
    if (files.length) {
      lines.push('| 操作 | 文件 | 增 | 删 |');
      lines.push('| --- | --- | --- | --- |');
      for (const f of files) {
        lines.push('| ' + (f.op || '') + ' | `' + (f.path || '') + '` | +' + (f.added || 0) + ' | -' + (f.removed || 0) + ' |');
      }
    } else {
      lines.push('（无）');
    }
    if (typeof msg.sessionHitRate === 'number') {
      lines.push('');
      lines.push('## Token 用量（本任务）');
      lines.push('');
      lines.push('- 输入：约 ' + fmtTokenCount(msg.promptTokens) + ' token');
      lines.push('- 输出：约 ' + fmtTokenCount(msg.completionTokens) + ' token');
      lines.push('- 缓存命中：' + fmtTokenCount(msg.cachedTokens) + ' token（命中率 ' + msg.sessionHitRate + '%）');
    }
    if (text && String(text).trim()) {
      lines.push('');
      lines.push('## 完成总结');
      lines.push('');
      lines.push(String(text).slice(0, 4000));
    }
    return lines.join('\n');
  }

  function addArtifact(msg) {
    hideWelcome();
    const files = (msg && msg.files) || [];
    const title = (msg && msg.title) || '';
    const OP_LABEL = { '新增': '➕ 新增', '覆盖': '✏️ 覆盖', '修改': '✏️ 修改', '删除': '🗑 删除' };
    const box = document.createElement('div');
    box.className = 'review-card artifact-card';
    let head = t('📦 本次任务产物');
    if (title) head += ' · ' + escapeHtml(title);
    const filesHtml = files.length
      ? '<div class="artifact-files">' +
        files.map(function (f) {
          const p = f && f.path ? String(f.path) : '';
          const op = OP_LABEL[f && f.op] || '📄';
          const added = Number((f && f.added) || 0);
          const removed = Number((f && f.removed) || 0);
          const diff = (added || removed) ? '<span class="artifact-diff">+' + added + ' -' + removed + '</span>' : '';
          return '<div class="artifact-file" data-path="' + escapeHtml(p) + '" title="' + t('点击打开') + '：' + escapeHtml(p) + '" role="button" tabindex="0">' +
            '<span class="artifact-op">' + op + '</span>' +
            '<code>' + escapeHtml(p) + '</code>' +
            diff +
            '</div>';
        }).join('') +
        '</div>'
      : '<div class="review-body">' + t('（本次任务未修改文件）') + '</div>';
    const statsHtml = (typeof msg.sessionHitRate === 'number')
      ? '<div class="artifact-stats">🦊 输入 ' + fmtTokenCount(msg.promptTokens) +
        ' · 输出 ' + fmtTokenCount(msg.completionTokens) +
        ' · 缓存命中 ' + msg.sessionHitRate + '%（' + fmtTokenCount(msg.cachedTokens) + ' token）</div>'
      : '';
    box.innerHTML =
      '<div class="review-head">' + head + '</div>' +
      filesHtml +
      statsHtml +
      '<div class="artifact-actions">' +
        '<button class="mini primary" data-act="export-report">📄 ' + t('导出报告（Markdown）') + '</button>' +
      '</div>';
    box.querySelectorAll('.artifact-file').forEach(function (el) {
      const open = function () {
        const p = el.getAttribute('data-path');
        if (p) vscode.postMessage({ type: 'openFile', path: p });
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
    const exportBtn = box.querySelector('[data-act="export-report"]');
    if (exportBtn) {
      exportBtn.addEventListener('click', function () {
        // 复用 newFile 通道：把 Markdown 报告作为新文档打开（带 markdown 语法高亮），用户可另存
        vscode.postMessage({ type: 'newFile', lang: 'markdown', code: buildArtifactReport(msg) });
      });
    }
    messagesEl.appendChild(box);
    scrollDown(true);
  }

  function updateReviewButton(msg) {
    const box = msg.id ? messagesEl.querySelector('.review-card[data-review-id="' + msg.id + '"]') : messagesEl.querySelector('.review-card:last-child');
    if (!box) return;
    const btn = box.querySelector('[data-act="apply-review"]');
    const statusEl = box.querySelector('.review-status');
    if (msg.state === 'queued') {
      if (btn) { btn.disabled = true; btn.textContent = t('排队中'); }
      if (statusEl) statusEl.textContent = msg.text || t('主任务结束后自动应用');
    } else if (msg.state === 'applied') {
      if (btn) { btn.disabled = true; btn.textContent = t('已应用'); }
      if (statusEl) statusEl.textContent = '';
    }
  }

  function addNotice(text) {
    hideWelcome();
    const el = document.createElement('div');
    el.className = 'notice';
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollDown();
  }

  // RAG 直答后，在输入栏上方提示用户可切换智能体模式
  function showRagHint() {
    if (!ragHintEl) return;
    ragHintEl.innerHTML = '';
    const body = document.createElement('span');
    body.className = 'rag-hint-body';
    const sentence = t('〔RAG 直答〕如果这条回答不准确或没解决你的问题，可再次输入「换agent」切换到智能体模式。');
    const kw = '换agent';
    const idx = sentence.indexOf(kw);
    if (idx >= 0) {
      const before = document.createElement('span');
      before.textContent = sentence.slice(0, idx);
      const kwEl = document.createElement('span');
      kwEl.className = 'rag-hint-kw';
      kwEl.textContent = kw;
      kwEl.title = t('点击自动填入并切换到智能体模式');
      kwEl.addEventListener('click', function () {
        inputEl.value = '换agent';
        autoGrow();
        inputEl.focus();
      });
      const after = document.createElement('span');
      after.textContent = sentence.slice(idx + kw.length);
      body.appendChild(before);
      body.appendChild(kwEl);
      body.appendChild(after);
    } else {
      body.textContent = sentence;
    }
    const close = document.createElement('button');
    close.className = 'rag-hint-close';
    close.textContent = '×';
    close.setAttribute('aria-label', t('关闭提示'));
    close.addEventListener('click', hideRagHint);
    ragHintEl.appendChild(body);
    ragHintEl.appendChild(close);
    ragHintEl.classList.remove('hidden');
    scrollDown();
  }

  function hideRagHint() {
    if (ragHintEl) ragHintEl.classList.add('hidden');
  }

  function showError(text) {
    errorText.textContent = text;
    errorBar.classList.remove('hidden');
  }

  /* ================= 交互 ================= */

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
  }

  /* —— 正反馈：轻量 toast（复制成功 / 操作确认） —— */
  let toastWrap = null;
  function toast(msg, icon) {
    try {
      if (!toastWrap) {
        toastWrap = document.createElement('div');
        toastWrap.className = 'toast-wrap';
        document.body.appendChild(toastWrap);
      }
      const el = document.createElement('div');
      el.className = 'toast';
      el.innerHTML = (icon ? '<span class="toast-ico">' + escapeHtml(icon) + '</span>' : '') + escapeHtml(msg);
      toastWrap.appendChild(el);
      setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 1900);
    } catch (_) { /* 提示失败不影响主流程 */ }
  }

  /* —— 正反馈：发送时狐狸橙迸发粒子 —— */
  function foxBurst(btn) {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const rect = btn.getBoundingClientRect();
      const layer = document.createElement('div');
      layer.className = 'fox-burst';
      layer.style.position = 'fixed';
      layer.style.left = (rect.left + rect.width / 2) + 'px';
      layer.style.top = (rect.top + rect.height / 2) + 'px';
      document.body.appendChild(layer);
      const n = 7;
      for (let i = 0; i < n; i++) {
        const s = document.createElement('span');
        s.className = 'fox-spark';
        const ang = (Math.PI * 2 * i) / n + (Math.random() - 0.5) * 0.5;
        const dist = 24 + Math.random() * 28;
        s.style.setProperty('--dx', (Math.cos(ang) * dist) + 'px');
        s.style.setProperty('--dy', (Math.sin(ang) * dist) + 'px');
        layer.appendChild(s);
      }
      setTimeout(() => { if (layer.parentNode) layer.parentNode.removeChild(layer); }, 720);
    } catch (_) { /* 动效失败不影响发送 */ }
  }

  function send() {
    const text = inputEl.value.trim();
    if ((!text && !attachments.length) || busy) return;
    hideRagHint();
    errorBar.classList.add('hidden');
    // 先把要发送的附件快照下来，再清空本地，避免连续快速操作时残留
    const toSend = attachments.slice();
    attachments = [];
    renderAttachments();
    foxBurst(btnSend);
    vscode.postMessage({ type: 'send', text, attachments: toSend });
    inputEl.value = '';
    autoGrow();
  }

  btnSend.addEventListener('click', send);
  btnAttach.addEventListener('click', () => vscode.postMessage({ type: 'addAttachments' }));
  btnPause.addEventListener('click', () => vscode.postMessage({ type: 'pause' }));
  btnResume.addEventListener('click', () => vscode.postMessage({ type: 'resume' }));
  btnStop.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  btnUndo.addEventListener('click', () => vscode.postMessage({ type: 'undo' }));
  btnReadTerminal.addEventListener('click', () => vscode.postMessage({ type: 'readTerminal' }));
  $('btnSettings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));

  // 工作链面板：点击标题折叠/展开，专用按钮 also 切换；清空按钮清空前缀缓存
  function syncWorkchainToggleText() {
    if (!workchainToggle || !workchainPanel) return;
    workchainToggle.textContent = workchainPanel.classList.contains('collapsed') ? t('展开') : t('收起');
  }
  if (workchainHead) {
    workchainHead.addEventListener('click', (e) => {
      // 独立工作链页面不需要折叠功能
      if (document.body.classList.contains('workchain-only')) return;
      if (e.target === workchainClear || workchainClear.contains(e.target)) return;
      if (e.target === workchainToggle || workchainToggle && workchainToggle.contains(e.target)) return;
      workchainPanel.classList.toggle('collapsed');
      workchainPanel.classList.toggle('open');
      syncWorkchainToggleText();
    });
  }
  if (workchainToggle) {
    workchainToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const collapsed = workchainPanel.classList.toggle('collapsed');
      workchainPanel.classList.toggle('open', !collapsed);
      syncWorkchainToggleText();
    });
  }
  if (workchainClear) {
    workchainClear.addEventListener('click', (e) => {
      e.stopPropagation();
      if (workchainList) workchainList.innerHTML = '';
      updateWorkchainCount();
    });
  }
  // 工作链子栏：分类筛选（全部/工具/思考/错误/状态）+ 详细程度切换（简洁/详细）
  if (wcFilters) {
    wcFilters.addEventListener('click', (e) => {
      const btn = e.target.closest('.wc-f');
      if (!btn) return;
      const grp = btn.dataset.grp || 'all';
      wcFilters.querySelectorAll('.wc-f').forEach((b) => b.classList.toggle('active', b === btn));
      if (workchainList) {
        workchainList.classList.remove('filter-all', 'filter-tool', 'filter-reason', 'filter-error', 'filter-info');
        if (grp !== 'all') workchainList.classList.add('filter-' + grp);
      }
    });
  }
  if (wcDetail) {
    wcDetail.addEventListener('click', () => {
      if (!workchainList) return;
      const on = workchainList.classList.toggle('detailed');
      wcDetail.classList.toggle('active', on);
      wcDetail.textContent = on ? t('简洁') : t('详细');
    });
  }
  function updateWorkchainCount() {
    if (!workchainCount || !workchainPanel) return;
    const n = workchainList ? workchainList.children.length : 0;
    workchainCount.textContent = n ? String(n) : '';
    workchainPanel.classList.toggle('has-items', n > 0);
    if (n > 0 && workchainPanel.classList.contains('collapsed')) {
      workchainPanel.classList.remove('collapsed');
      workchainPanel.classList.add('open');
      syncWorkchainToggleText();
    }
  }
  // 进度栏已移除（用户要求）：原 miniStatusBar 状态轨迹不再渲染，工作链面板仍独立展示步骤。
  function focusWorkchainStep(id) {
    if (!id) return;
    const safe = String(id).replace(/"/g, '\\"');
    const el = (workchainList && workchainList.querySelector('[data-id="' + safe + '"]')) || stepItems[id] || toolCards[id];
    if (!el) return;
    if (workchainPanel) { workchainPanel.classList.remove('collapsed'); workchainPanel.classList.add('open'); }
    el.classList.add('open', 'flash');
    setTimeout(() => el.classList.remove('flash'), 900);
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  providerChip.addEventListener('click', () => vscode.postMessage({ type: 'pickProvider' }));
  modelChip.addEventListener('click', () => vscode.postMessage({ type: 'pickModel' }));
  apiModeChip.addEventListener('click', () => vscode.postMessage({ type: 'pickApiMode' }));
  // 深度思考：左键一键开关，右键弹出强度选择（关闭 / low / medium / high）
  if (thinkChip) {
    thinkChip.addEventListener('click', () => vscode.postMessage({ type: 'toggleDeepThinking' }));
    thinkChip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'toggleDeepThinking', pick: true });
    });
  }
  agentChip.addEventListener('click', () => vscode.postMessage({ type: 'toggleAgent' }));
  approveChip.addEventListener('click', () => {
    const i = APPROVE_LEVELS.indexOf(approveLevel);
    const next = APPROVE_LEVELS[(i + 1) % APPROVE_LEVELS.length];
    vscode.postMessage({ type: 'setApprove', value: next });
  });
  $('errorClose').addEventListener('click', () => errorBar.classList.add('hidden'));

  btnPlanTasks.addEventListener('click', () => planPanel.classList.toggle('hidden'));
  $('btnPlanClose').addEventListener('click', () => planPanel.classList.add('hidden'));
  $('btnPlanOpenFile').addEventListener('click', () => vscode.postMessage({ type: 'openPlanTasks' }));
  if (btnPlanClearDone) {
    btnPlanClearDone.addEventListener('click', () => {
      btnPlanClearDone.disabled = true;
      btnPlanClearDone.textContent = t('清理中…');
      vscode.postMessage({ type: 'planTaskClearCompleted' });
    });
  }
  planList.addEventListener('click', (e) => {
    const delBtn = e.target.closest('.plan-del');
    if (delBtn) {
      e.stopPropagation();
      const item = delBtn.closest('.plan-item');
      if (item) vscode.postMessage({ type: 'planTaskRemove', id: item.dataset.id });
      return;
    }
    const item = e.target.closest('.plan-item');
    if (!item) return;
    vscode.postMessage({ type: 'planTaskToggle', id: item.dataset.id });
  });

  btnContextUsage.addEventListener('click', () => contextPanel.classList.toggle('hidden'));
  $('btnContextClose').addEventListener('click', () => contextPanel.classList.add('hidden'));
  $('btnContextOpenSettings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
  const contextWindowInput = $('contextWindowInput');
  if (contextWindowInput) {
    contextWindowInput.addEventListener('change', () => {
      const v = parseInt(contextWindowInput.value, 10);
      vscode.postMessage({ type: 'setContextWindow', value: isNaN(v) || v <= 0 ? 0 : v });
    });
  }
  btnStorage.addEventListener('click', () => vscode.postMessage({ type: 'manageStorage' }));

  /* ================= /mcp 斜杠补全浮窗 ================= */

  function getSlashQuery() {
    const val = inputEl.value;
    const m = val.match(/^\/mcp\s*/i);
    if (!m) return null;
    return val.slice(m[0].length);
  }

  function closeSlashPopup() {
    slashPopup.classList.add('hidden');
    slashPopup.innerHTML = '';
    slashIndex = -1;
  }

  function applySlashItem(item) {
    // 改为让狐狸 AI 自动调用：插入自然语言请求，用户补全参数后发送即可
    const text = '请使用 mcp__' + item.serverId + '__' + item.toolName + ' 工具：';
    inputEl.value = text;
    autoGrow();
    inputEl.focus();
    // 光标放到末尾，方便用户补全参数
    inputEl.setSelectionRange(text.length, text.length);
    closeSlashPopup();
  }

  function renderSlashPopup(query) {
    const q = (query || '').trim().toLowerCase();
    const filtered = slashCandidates.filter((it) => {
      const hay = (it.serverId + ' ' + it.toolName + ' ' + (it.description || '')).toLowerCase();
      return !q || hay.includes(q);
    });

    const html = [];
    // 根据后端返回的 MCP 策略显示状态横幅
    if (!slashMcpPolicy.enabled) {
      html.push('<div class="slash-banner slash-banner-warn">' + t('MCP 总开关未开启：请打开左侧「🌐 MCP」面板，勾选「启用」') + '</div>');
    } else if (!slashMcpPolicy.autoInject) {
      html.push('<div class="slash-banner slash-banner-warn">' + t('MCP 已启用但未注入模型：请在设置开启 foxAi.mcp.autoInject，否则狐狸 AI 无法自动调用') + '</div>');
    } else {
      html.push('<div class="slash-banner">' + t('MCP 已启用并注入模型，选择工具即可让狐狸 AI 自动调用') + '</div>');
    }

    if (!filtered.length) {
      slashPopup.innerHTML = html.join('') + '<div class="slash-empty">' + t('没有匹配的 MCP 工具') + '</div>';
      slashPopup.classList.remove('hidden');
      slashIndex = -1;
      return;
    }

    html.push('<div class="slash-hint">' + t('↑↓ 选择，Enter 让狐狸 AI 调用，Esc 关闭') + '</div>');
    for (let i = 0; i < filtered.length; i++) {
      const it = filtered[i];
      const kind = it.kind === 'edit' ? 'write' : (it.kind || 'read');
      html.push(
        '<div class="slash-item' + (i === slashIndex ? ' active' : '') + '" data-idx="' + i + '">' +
        '<span class="icon">🔧</span>' +
        '<span class="label">' + escapeHtml(it.serverId + '.' + it.toolName) + '</span>' +
        '<span class="desc">' + escapeHtml(it.description || '') + '</span>' +
        '<span class="kind">' + escapeHtml(kind) + '</span>' +
        '</div>'
      );
    }
    slashPopup.innerHTML = html.join('');
    slashPopup.classList.remove('hidden');

    // 默认选中第一项
    if (slashIndex < 0) slashIndex = 0;
    if (slashIndex >= filtered.length) slashIndex = filtered.length - 1;
    updateSlashActive();
  }

  function updateSlashActive() {
    const items = slashPopup.querySelectorAll('.slash-item');
    items.forEach((el, i) => el.classList.toggle('active', i === slashIndex));
    const active = items[slashIndex];
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function requestMcpCandidates() {
    const myId = ++slashReqId;
    vscode.postMessage({ type: 'requestMcpTools' });
    slashPending = true;
    // 超时保护：500ms 还没返回就先显示等待提示
    slashTimer = setTimeout(() => {
      if (slashPending && slashReqId === myId) {
        slashPopup.innerHTML = '<div class="slash-empty">' + t('正在加载 MCP 工具…') + '</div>';
        slashPopup.classList.remove('hidden');
      }
    }, 80);
  }

  function onSlashInput() {
    const query = getSlashQuery();
    if (query === null) {
      closeSlashPopup();
      return;
    }
    if (!slashCandidates.length && !slashPending) {
      requestMcpCandidates();
    }
    renderSlashPopup(query);
  }

  slashPopup.addEventListener('click', (e) => {
    const item = e.target.closest('.slash-item');
    if (!item) return;
    const idx = Number(item.dataset.idx);
    const filtered = getFilteredSlashItems();
    const it = filtered[idx];
    if (it) applySlashItem(it);
  });

  function getFilteredSlashItems() {
    const query = getSlashQuery();
    const q = ((query === null ? '' : query) || '').trim().toLowerCase();
    return slashCandidates.filter((it) => {
      const hay = (it.serverId + ' ' + it.toolName + ' ' + (it.description || '')).toLowerCase();
      return !q || hay.includes(q);
    });
  }

  inputEl.addEventListener('input', () => {
    autoGrow();
    onSlashInput();
  });
  inputEl.addEventListener('keydown', (e) => {
    const open = !slashPopup.classList.contains('hidden');
    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const list = getFilteredSlashItems();
        slashIndex = (slashIndex + 1) % list.length;
        renderSlashPopup(getSlashQuery());
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const list = getFilteredSlashItems();
        slashIndex = (slashIndex - 1 + list.length) % list.length;
        renderSlashPopup(getSlashQuery());
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSlashPopup();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        const list = getFilteredSlashItems();
        const it = list[slashIndex];
        if (it) {
          e.preventDefault();
          applySlashItem(it);
          return;
        }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  inputEl.addEventListener('blur', () => {
    // 延迟关闭，给 click 事件留出时间
    setTimeout(() => closeSlashPopup(), 180);
  });

  attachmentsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act="remove"]');
    if (!btn) return;
    const id = btn.dataset.id;
    attachments = attachments.filter((a) => a.id !== id);
    renderAttachments();
    vscode.postMessage({ type: 'removeAttachment', id });
  });

  messagesEl.addEventListener('click', (e) => {
    // 引用角标 / 来源项：优先处理 data-source-id，弹浮窗展示来源（有 URL 则提供跳转）
    const citeEl = e.target.closest('sup[data-source-id], a[data-source-id]');
    if (citeEl) {
      const parts = String(citeEl.dataset.sourceId || '').split(':');
      const src = getSource(parts[0], parts[1]);
      if (src) {
        e.preventDefault();
        e.stopPropagation();
        showCitePopup(citeEl, src);
      }
      return;
    }
    // 外链 / 引用角标：交给扩展端用系统默认浏览器打开
    const linkEl = e.target.closest('[data-url]');
    if (linkEl) {
      const url = linkEl.getAttribute('data-url') || '';
      if (/^https?:\/\//i.test(url)) {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({ type: 'openExternal', url });
        return;
      }
    }

    const quick = e.target.closest('.quick-btn');
    if (quick) {
      inputEl.value = quick.dataset.q || '';
      autoGrow();
      send();
      return;
    }

    const approvalBtn = e.target.closest('.approval button');
    if (approvalBtn) {
      const box = approvalBtn.closest('.approval');
      const decision = approvalBtn.dataset.d;
      vscode.postMessage({ type: 'approval', id: box.dataset.id, decision });
      box.innerHTML =
        '<span class="q">' +
        (decision === 'reject' ? t('已拒绝这次操作') : decision === 'always' ? t('已允许，并记住该工具') : t('已允许')) +
        '</span>';
      return;
    }

    const head = e.target.closest('.tool-head');
    if (head) {
      head.parentElement.classList.toggle('open');
      return;
    }

    const toolBtn = e.target.closest('.tool-actions button');
    if (toolBtn) {
      const card = toolBtn.closest('.tool-card');
      const actions = toolBtn.closest('.tool-actions');
      if (toolBtn.dataset.act === 'diff') vscode.postMessage({ type: 'showDiff', id: card.dataset.id });
      else vscode.postMessage({ type: 'openFile', path: actions.dataset.path });
      return;
    }

    const btn = e.target.closest('.code-head button[data-act]');
    if (!btn) return;
    const block = btn.closest('.code-block');
    const code = block ? block.querySelector('code').textContent : '';
    const act = btn.dataset.act;
    if (act === 'copy') { vscode.postMessage({ type: 'copy', code }); toast(t('已复制'), '✓'); }
    else if (act === 'insert') vscode.postMessage({ type: 'insertCode', code });
    else if (act === 'newfile') vscode.postMessage({ type: 'newFile', code });
  });

  /* ================= 状态 ================= */

  const STATE_TEXT = {
    thinking: t('模型思考中…'),
    running: t('执行中…'),
    tool: t('正在调用工具…'),
    pausing: t('将在当前步骤结束后暂停…'),
    paused: t('已暂停，点「继续」接着干'),
    'awaiting-approval': t('等待你确认操作…'),
    cancelled: t('已取消')
  };

  function applyStatus(msg) {
    if (msg.provider) $('providerName').textContent = msg.provider;
    if (msg.model) $('modelName').textContent = msg.model;
    if (msg.apiMode) apiModeChip.textContent = t(msg.apiMode === 'responses' ? '协议: Responses' : '协议: Chat');

    if (thinkChip && msg.deepThinking !== undefined) {
      const on = !!msg.deepThinking;
      const eff = msg.thinkEffort || 'medium';
      thinkChip.textContent = on ? '🧠 ' + t('思考') + ': ' + eff : '🧠 ' + t('思考') + ': ' + t('关');
      thinkChip.classList.toggle('on', on);
      thinkChip.classList.toggle('off', !on);
      thinkChip.title = on
        ? t('深度思考已开启（强度 {0}）：模型先推理再作答。左键关闭，右键改强度', eff)
        : t('深度思考已关闭：模型直接作答。左键开启，右键选强度');
    }

    agentChip.textContent = msg.agent ? t('智能体') : t('纯问答');
    agentChip.classList.toggle('on', !!msg.agent);
    agentChip.classList.toggle('off', !msg.agent);

    if (msg.approve) {
      approveLevel = msg.approve;
      approveChip.textContent = t(APPROVE_LABEL[msg.approve] || msg.approve);
    }

    const state = msg.state || 'idle';
    busy = state !== 'idle' && state !== 'cancelled';
    providerChip.classList.toggle('busy', busy);
    runBar.classList.toggle('hidden', !busy);
    runBar.classList.toggle('paused', state === 'paused');
    runText.textContent = STATE_TEXT[state] || t('运行中…');
    btnPause.classList.toggle('hidden', state === 'paused' || state === 'pausing');
    // pausing 是「已点暂停、等待工具/请求走到下一个闸口」的过渡态：此时保留「继续」可点，
    // 让用户能立即反悔取消暂停，而不是两个按钮都被隐藏、只能干等或点停止。
    btnResume.classList.toggle('hidden', state !== 'paused' && state !== 'pausing');
    btnSend.textContent = busy ? t('运行中…') : t('发送');
    btnSend.disabled = busy;
    btnAttach.disabled = busy;
    btnReadTerminal.disabled = busy;
    if (typeof msg.undoCount === 'number') {
      btnUndo.classList.toggle('hidden', msg.undoCount === 0);
      btnUndo.textContent = t('↩ 撤销改动 ({0})', msg.undoCount);
    }
    if (typeof msg.redoCount === 'number') {
      btnRedo.classList.toggle('hidden', msg.redoCount === 0);
      btnRedo.textContent = t('↪ 重做 ({0})', msg.redoCount);
    }
  }

  function handle(msg) {
    try {
      switch (msg.type) {
        case 'status':
          applyStatus(msg);
          break;
        case 'user': {
          const { bubble } = addMessage('user', msg.id);
          bubble.textContent = msg.text || '';
          if (msg.attachments && msg.attachments.length) {
            const att = document.createElement('div');
            att.className = 'user-attachments';
            att.innerHTML = msg.attachments.map((a) =>
              '<span class="att-chip">' + (a.isImage ? '🖼 ' : '📄 ') + escapeHtml(a.name) + '</span>'
            ).join('');
            bubble.appendChild(att);
          }
          scrollDown(true);
          break;
        }
        case 'assistantStart': {
          if (msg.channel === 'thinking') {
            // thinking 通道：复用 state:thinking 已创建的步骤卡片，只初始化内容容器
            if (!thinkingSteps[msg.msg_id]) {
              const el = stepItems[msg.msg_id];
              if (el) {
                thinkingSteps[msg.msg_id] = { el, raw: '', reasoning: '', images: [] };
              }
            }
            break;
          }
          // final 通道：主正文气泡
          const fid = msg.msg_id || msg.id;
          // 防御性清理：如果同 ID 的 live 气泡已存在（seq 冲突或旧状态残留），先移除旧 DOM，
          // 避免一个 bubbleId 同时对应两个 DOM 元素导致内容写到错误位置。
          if (live[fid]) {
            const old = live[fid];
            if (old.bubble && old.bubble.parentElement) old.bubble.parentElement.remove();
            delete live[fid];
          }
          const { bubble } = addMessage('assistant', fid);
          live[fid] = { raw: '', reasoning: '', bubble, reasonEl: null, dirty: true };
          scheduleRender();
          break;
        }
        case 'delta': {
          if (msg.channel === 'thinking') {
            updateThinkingStep(msg.msg_id, 'text', msg);
            break;
          }
          const fid = msg.msg_id || msg.id;
          let m = live[fid];
          if (!m) {
            // 兜底：transcript 缺失 assistantStart 锚点（如长会话锚点被挤出、或旧版本存档）时，
            // 自动建一个 assistant 气泡承载内容，避免 restore 重放时 delta 被静默丢弃导致对话栏变空。
            // 额外防御：如果同 id 的气泡已存在 DOM 中（如 assistantEnd 已 finalize 但仍有延迟 delta），
            // 复用该气泡而不是新建第二气泡，防止同一答案被截断拆成两个。
            let bubble = null;
            let reasonEl = null;
            if (fid) {
              const existingWrap = messagesEl.querySelector('.msg.assistant[data-id="' + CSS.escape(fid) + '"]');
              if (existingWrap) {
                bubble = existingWrap.querySelector('.bubble');
                reasonEl = existingWrap.querySelector('.reasoning');
              }
            }
            if (!bubble) {
              const created = addMessage('assistant', fid);
              bubble = created.bubble;
            }
            m = live[fid] = { raw: bubble.dataset.raw || '', reasoning: '', bubble, reasonEl, dirty: true };
          }
          // 如果该气泡已经从 DOM 里移除（例如用户清屏、切换会话），不再追加内容，
          // 防止残存 delta 误写入其他同 ID 的泡泡。
          if (!m.bubble.isConnected) { delete live[fid]; break; }
          m.raw += msg.text;
          m.dirty = true;
          scheduleRender();
          break;
        }
        case 'reasoning': {
          if (msg.channel === 'thinking') {
            updateThinkingStep(msg.msg_id, 'reasoning', msg);
            break;
          }
          const fid = msg.msg_id || msg.id;
          let m = live[fid];
          if (!m) {
            // 同上：缺锚点时自动建气泡，保证深度思考链也能被还原
            const { bubble } = addMessage('assistant', fid);
            m = live[fid] = { raw: '', reasoning: '', bubble, reasonEl: null, dirty: true };
          }
          if (!m.bubble.isConnected) { delete live[fid]; break; }
          const t = msg.text || '';
          // 兼容「增量」「全量重发」「完全相同片段循环重发」三种后端行为，避免思考链文字重复错位：
          // 1) 全量重发（t 是 m 的扩展前缀）→ 替换为最新全量；
          // 2) 相同片段已存在于 m（循环重复重发）→ 跳过；
          // 3) 其余 → 正常追加。
          if (m.reasoning) {
            if (t.length > m.reasoning.length && t.startsWith(m.reasoning)) {
              m.reasoning = t;
            } else if (t.length > 0 && m.reasoning.includes(t)) {
              // 完全相同片段已存在，跳过，避免重复拼接
            } else {
              m.reasoning += t;
            }
          } else {
            m.reasoning = t;
          }
          m.dirty = true;
          scheduleRender();
          break;
        }
        case 'image': {
          if (msg.channel === 'thinking') {
            updateThinkingStep(msg.msg_id, 'image', msg);
            break;
          }
          const fid = msg.msg_id || msg.id;
          let m = live[fid];
          if (!m || !m.bubble.isConnected) {
            if (m) delete live[fid];
            const { bubble } = addMessage('assistant', fid);
            m = { raw: '', reasoning: '', bubble, reasonEl: null, dirty: true, images: [] };
            live[fid] = m;
          }
          if (!m.images) m.images = [];
          m.images.push({ src: msg.src, alt: msg.alt || '模型生成图片' });
          m.dirty = true;
          scheduleRender();
          scrollDown(true);
          break;
        }
        case 'assistant': {
          // 一次性完整回答（如 RAG 直答）按 id 聚合，避免同 id 重复创建气泡
          const id = msg.id;
          let bubble;
          if (id && live[id] && live[id].bubble && live[id].bubble.isConnected) {
            bubble = live[id].bubble;
            live[id].raw = msg.text || '';
            live[id].dirty = true;
          } else {
            // 若 DOM 里已存在同 id 的 assistant 气泡（无 live 状态），直接复用
            if (id) {
              const existing = messagesEl.querySelector('.msg.assistant[data-id="' + CSS.escape(id) + '"] .bubble');
              if (existing) {
                bubble = existing;
                const wrap = bubble.closest('.msg');
                if (wrap && wrap.parentElement) {
                  // 清理旧的 steps 容器，避免残留
                  const oldSteps = wrap.querySelector('.steps');
                  if (oldSteps) oldSteps.innerHTML = '';
                }
              }
            }
            if (!bubble) {
              const created = addMessage('assistant', id);
              bubble = created.bubble;
            }
            if (id) live[id] = { raw: msg.text || '', reasoning: '', bubble, reasonEl: null, dirty: true };
          }
          const text = msg.text || '';
          bubble.innerHTML = renderAssistant(text, id);
          bubble.dataset.raw = text;
          scheduleRender();
          scrollDown(true);
          break;
        }
        case 'replaceLastAssistant': {
          // force-agent / 切换智能体重新回答时，移除上一轮 assistant 回答气泡，避免新旧回答并存
          const wraps = messagesEl.querySelectorAll('.msg.assistant');
          if (wraps.length) {
            const last = wraps[wraps.length - 1];
            const id = last.dataset.id;
            if (id && live[id]) delete live[id];
            last.remove();
          }
          break;
        }
        case 'assistantEnd': {
          if (msg.channel === 'thinking') {
            const ts = thinkingSteps[msg.msg_id];
            if (ts && ts.el) {
              // 用结构化刷新收尾思考步骤（保留分组/类型，仅把状态置 ok）
              refreshStepNode(ts.el, { status: 'ok' });
              delete thinkingSteps[msg.msg_id];
            }
            break;
          }
          const fid = msg.msg_id || msg.id;
          const m = live[fid];
          if (m) {
            m.dirty = true;
            m.ended = true;
            scheduleRender();
          }
          break;
        }
        case 'finalText':
          // 文本已由 delta 实时显示，这里仅作兜底占位
          break;
        case 'attachments':
          attachments = msg.items || [];
          renderAttachments();
          break;
        case 'tool':
          addToolCard(msg);
          break;
        case 'step':
          addStep(msg);
          break;
        case 'toolStream':
          appendToolStream(msg);
          break;
        case 'toolUpdate':
          updateToolCard(msg);
          break;
        case 'searchSources':
          // 原生联网（Responses 的 web_search_call）结果：收割标题→网址索引，补全引用角标链接
          if (msg.text) { harvestSourceUrls(msg.text); refreshAssistantBubbles(); }
          break;
        case 'kbSources':
          // 本地知识库命中来源（相对路径 label + 绝对路径 file）：建档，使中文来源标签角标可定位到本地文件
          if (Array.isArray(msg.sources)) {
            for (const s of msg.sources) {
              if (s && s.label && s.file) kbSourceMap[String(s.label)] = { label: s.label, file: s.file };
            }
            refreshAssistantBubbles();
          }
          break;
        case 'cacheStats':
          updateCacheStatus(msg);
          break;
        case 'cacheUnsupported': {
          // 点对点适配：本模型/服务商不支持服务端前缀缓存，仅提醒一次后静默
          const ukey = 'foxai_cache_unsupported_' + (msg.provider || 'unknown');
          let warned = null;
          try { warned = sessionStorage.getItem(ukey); } catch (_) {}
          if (!warned) {
            try { sessionStorage.setItem(ukey, '1'); } catch (_) {}
            toast(msg.reason || '当前模型不支持服务端前缀缓存，已静默跳过缓存优化', '⚠️');
          }
          if (cacheStatusEl) {
            cacheStatusEl.className = 'cache-status cache-unsupported';
            cacheStatusEl.textContent = '🧊 本模型不支持上下文缓存';
            setTimeout(() => { if (cacheStatusEl && cacheStatusEl.classList.contains('cache-unsupported')) cacheStatusEl.classList.add('hidden'); }, 4500);
          }
          break;
        }
        case 'approval':
          addApproval(msg);
          break;
        case 'notice':
          addNotice(msg.text);
          break;
        case 'ragHint':
          showRagHint();
          break;
        case 'error':
          showError(msg.text || '出错了');
          break;
        case 'clear':
          messagesEl.innerHTML = '';
          if (workchainList) workchainList.innerHTML = '';
          hideRagHint();
          for (const k of Object.keys(live)) delete live[k];
          for (const k of Object.keys(toolCards)) delete toolCards[k];
          for (const k of Object.keys(stepItems)) delete stepItems[k];
          for (const k of Object.keys(thinkingSteps)) delete thinkingSteps[k];
          // 重置搜索来源索引，避免上一会话的网址串到新会话的引用角标上
          for (const k of Object.keys(citeUrlByNum)) delete citeUrlByNum[k];
          citeUrlIndex.length = 0;
          // 清掉待执行的重渲染防抖，避免旧会话 timer 在清屏后误触
          if (refreshAssistantBubblesTimer) { clearTimeout(refreshAssistantBubblesTimer); refreshAssistantBubblesTimer = null; }
          // 同时清空按消息存档的引用来源，避免旧会话数据串到新会话角标浮窗
          for (const k of Object.keys(sourceStore)) delete sourceStore[k];
          hideCitePopup();
          attachments = [];
          renderAttachments();
          updateWorkchainCount();
          break;
        case 'prefill':
          inputEl.value = msg.text || '';
          autoGrow();
          inputEl.focus();
          break;
        case 'restore':
          messagesEl.innerHTML = '';
          if (workchainList) workchainList.innerHTML = '';
          for (const item of msg.items || []) handle(item);
          scrollDown(true);
          updateWorkchainCount();
          break;
        case 'planTasks':
          renderPlanTasks(msg.items);
          if (btnPlanClearDone) {
            btnPlanClearDone.disabled = false;
            btnPlanClearDone.textContent = t('清理已完成');
          }
          break;
        case 'planPending':
          addPlanPending(msg);
          break;
        case 'plan':
          addPlan(msg);
          break;
        case 'review':
          addReview(msg);
          break;
        case 'artifact':
          addArtifact(msg);
          break;
        case 'reviewApplied':
          updateReviewButton(msg);
          break;
        case 'contextUsage':
          renderContextUsage(msg);
          break;
        case 'mcpTools': {
          slashPending = false;
          if (slashTimer) { clearTimeout(slashTimer); slashTimer = null; }
          slashCandidates = Array.isArray(msg.tools) ? msg.tools : [];
          slashMcpPolicy = msg.policy || { enabled: false, autoInject: false };
          if (msg.error) {
            slashPopup.innerHTML = '<div class="slash-empty">' + escapeHtml(String(msg.error)) + '</div>';
            slashPopup.classList.remove('hidden');
            slashIndex = -1;
          } else {
            onSlashInput();
          }
          break;
        }
        default:
          break;
      }
    } catch (e) {
      console.error('[fox-ai] webview render error', e);
    }
  }

  function applyStaticI18n() {
    document.documentElement.lang = window.__FOX_LOCALE__ || 'zh-cn';
    document.title = t('狐狸 AI');
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
  }
  applyStaticI18n();

  window.addEventListener('message', (e) => handle(e.data || {}));
  vscode.postMessage({ type: 'ready' });

  // 仅在 Node 测试环境下导出纯函数（浏览器中 module 未定义，此块不执行）
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      renderMarkdown, renderInline, renderAssistant, extractCitations, softSegment,
      codeBlockHtml, escapeHtml, imgTag, linkTag, splitRow, isSepRow, isTableRow, renderMath,
      harvestSourceUrls, pickUrlFromLabel, lookupCiteUrl, normKey, citeUrlByNum, getSource, recordSources, setKbSources,
      normalizeForKbLookup, findKbSource
    };
  }
})();
