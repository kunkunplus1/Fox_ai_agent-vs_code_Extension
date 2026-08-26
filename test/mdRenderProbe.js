/* 探针 v2：同步「最新 chat.js 渲染器（含 GFM 表格预扫描）」复现用户原文，验证表格/标题/列表/hr 修复。 */
'use strict';

/* ===== 最新 chat.js 渲染器副本（68-267 行 + 表格预扫描） ===== */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderInline(s) {
  let out = escapeHtml(s);
  const holds = [];
  const hold = (html) => {
    holds.push(html);
    return '\u0004H' + (holds.length - 1) + '\u0004';
  };
  out = out.replace(/`([^`\n]+)`/g, (m, c) => hold('<code class="inline">' + c + '</code>'));
  out = out.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+|data:image\/[a-zA-Z0-9.+-]+;base64,[^\s)]+)\)/g,
    (m, alt, url) => hold(imgTag(alt, url)));
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, txt, url) => hold(linkTag(url, txt)));
  out = out.replace(/(https?:\/\/\S+\.(png|jpe?g|gif|webp|svg|bmp))(?:\?\S*)?/gi, (m) => hold(imgTag('', m)));
  out = out.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[^\s<]+/g, (m) => hold(imgTag('', m)));
  out = out.replace(/https?:\/\/[^\s<>"'（）()【】\[\]、，。；]+/g, (m) => {
    const clean = m.replace(/[.,;:!?]+$/, '');
    return hold(linkTag(clean, clean)) + m.slice(clean.length);
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  out = out.replace(/\u0004H(\d+)\u0004/g, (m, i) => holds[Number(i)]);
  return out;
}

function imgTag(alt, url) {
  const a = escapeHtml(alt || '');
  return '<img class="ext-img" src="' + url + '" alt="' + a + '" title="' + (a || '图片') + '" loading="lazy" />';
}

function linkTag(url, text) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return text;
  return '<a class="ext-link" data-url="' + u + '" title="' + u + '" role="link" tabindex="0">' + text + '</a>';
}

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
  } catch (_) {}
  return (display ? '<div class="math-fallback">$$' : '$') +
    escapeHtml(tex) + (display ? '$$</div>' : '$');
}

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

  // 数学公式（同 chat.js）
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
    if (/\s/.test(tt) && !/[\\^_{}=+\-*/<>|&%:;]/.test(tt)) return m;
    math.push({ display: false, tex: tt });
    return '\u0002M' + (math.length - 1) + '\u0002';
  });
  text = text.replace(/\u0005IC(\d+)\u0005/g, (m, i) => inlineCodes[Number(i)] || m);

  // GFM 表格预扫描（与 chat.js 192-216 一致）
  const tables = [];
  text = text.replace(/([ \t]*\|?[^\n|]+(?:\|[^\n|]+)+\|?[ \t]*)\n[ \t]*\|?[ \t:|\-]+\|?[ \t]*(?:\n[ \t]*\|?[^\n|]+(?:\|[^\n|]+)+\|?[ \t]*)*/g, (m, headSeg) => {
    const lines = m.replace(/^\n/, '').split('\n');
    const head = splitRow(lines[0]);
    if (!head.length || !isSepRow(lines[1])) return m;
    const aligns = splitRow(lines[1]).map((c) => {
      const left = c.startsWith(':'), right = c.endsWith(':');
      return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
    });
    const al = (k) => (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '');
    const rows = [];
    for (let k = 2; k < lines.length; k++) {
      const ln = lines[k].trim();
      if (!ln || !ln.includes('|') || isSepRow(ln)) continue;
      rows.push(splitRow(ln));
    }
    const thead = '<tr>' + head.map((c, k) => '<th' + al(k) + '>' + renderInline(c) + '</th>').join('') + '</tr>';
    const tbody = rows.map((r) => '<tr>' + head.map((_, k) => '<td' + al(k) + '>' + renderInline(r[k] || '') + '</td>').join('') + '</tr>').join('');
    tables.push('<table><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table>');
    return '\u0001TBL' + (tables.length - 1) + '\u0001';
  });

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
    // 表格占位符还原
    const tph = line.match(/^\u0001TBL(\d+)\u0001$/);
    if (tph) { flushPara(); closeList(); html.push(tables[Number(tph[1])]); continue; }
    if (!line.trim()) { flushPara(); closeList(); continue; }

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
      i = j - 1;
      continue;
    }

    const h = line.match(/^(#{1,6})[ \t]*(.*)$/);
    if (h) { flushPara(); closeList(); html.push('<h' + h[1].length + '>' + renderInline(h[2]) + '</h' + h[1].length + '>'); continue; }
    // hr 兼容粘连文字（---建议顺序）：--- 后允许直接跟非空内容
    if (/^\s*([-*_])\1{2,}[ \t]*(?:[^\s].*)?$/.test(line)) { flushPara(); closeList(); html.push('<hr>'); continue; }
    const q = line.match(/^>\s?(.*)$/);
    if (q) { flushPara(); closeList(); html.push('<blockquote>' + renderInline(q[1]) + '</blockquote>'); continue; }
    const ul = line.match(/^\s*[-*+][ \t]*(.*)$/);
    if (ul) {
      flushPara();
      if (listType !== 'ul') { closeList(); html.push('<ul>'); listType = 'ul'; }
      html.push('<li>' + renderInline(ul[1]) + '</li>');
      continue;
    }
    const ol = line.match(/^\s*\d+[.)][ \t]*(.*)$/);
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
    '<button data-act="copy">复制</button>' +
    '<button data-act="insert">插入</button>' +
    '<button data-act="newfile">新文件</button>' +
    '</div><pre><code class="language-' + escapeHtml(lang) + '">' + escapeHtml(b.code) + '</code></pre></div>'
  );
}

/* ===== 用户真实报告的内容 ===== */
const SAMPLE = [
  'VSCode提示「编辑器是只读」通常有几种原因，按最可能到最不可能排查：',
  '##1.最快解决：切换文件只读状态（80%的情况）',
  '-按Ctrl+Shift+P→输入ToggleFileReadonly（文件：切换只读）回车',
  '-或点击编辑器右下角状态栏的「只读」文字，可直接切换',
  '##2.文件系统层面被设为只读（Windows）',
  '-在资源管理器里右键该文件→属性→取消勾选「只读」→确定',
  '-若文件在U盘、网络盘、或权限受限目录里，也会被判定为只读，需先取得写权限',
  '##3.VSCode设置把文件强制设为只读打开设置（Ctrl+,）检查这几项：',
  '|设置项|作用|',
  '|---|---|',
  '|files.readonlyInclude|匹配到的文件强制只读|',
  '|files.readonlyFromPermission|按文件系统权限判断（设为false可关闭）|',
  '|files.readonlyExclude|从不设为只读的文件|',
  '如果readonlyInclude/readonlyFromPermission被配置了，去掉相关条目即可。',
  '##4.整个工作区以「只读模式」打开',
  '-若VSCode是用--read-only参数启动，或标题栏/窗口显示「只读」标识，需要关闭窗口重新用正常方式打开文件夹。',
  '---建议顺序：先试第1步的ToggleFileReadonly（最常见）；不行再看第2步文件属性；仍不行查第3步设置。'
].join('\n');

function assert(cond, label, detail) {
  if (cond) { console.log('✅ ' + label); }
  else { console.log('❌ ' + label + (detail ? '  ' + detail : '')); process.exitCode = 1; }
}

const html = renderMarkdown(SAMPLE);
console.log('========== 渲染输出 ==========');
console.log(html);
console.log('==============================');
console.log('--- 结构统计 ---');
console.log('含 <table>:', html.includes('<table>'));
console.log('含 <thead>:', html.includes('<thead>'));
console.log('含 <th> 单元格:', (html.match(/<th>/g) || []).length);
console.log('含 <td> 单元格:', (html.match(/<td>/g) || []).length);
console.log('含 <h2>:', (html.match(/<h2>/g) || []).length);
console.log('含 <ul>:', html.includes('<ul>'));
console.log('含 <ol>:', html.includes('<ol>'));
console.log('含 <hr>:', html.includes('<hr>'));
console.log('含 <li>:', (html.match(/<li>/g) || []).length);

assert(html.includes('<table>'), '表格应渲染为 <table>');
assert((html.match(/<th>/g) || []).length === 2, '表头 2 个 <th>', '实际 ' + (html.match(/<th>/g) || []).length);
assert((html.match(/<td>/g) || []).length === 6, '数据 6 个 <td>', '实际 ' + (html.match(/<td>/g) || []).length);
assert((html.match(/<h2>/g) || []).length === 4, '4 个标题（##1~##4）', '实际 ' + (html.match(/<h2>/g) || []).length);
assert(html.includes('<ul>'), '无序列表应渲染');
assert((html.match(/<li>/g) || []).length >= 5, '至少 5 个列表项', '实际 ' + (html.match(/<li>/g) || []).length);
assert(html.includes('<hr>'), '---建议 前应渲染 <hr>');

console.log('\n完成。');