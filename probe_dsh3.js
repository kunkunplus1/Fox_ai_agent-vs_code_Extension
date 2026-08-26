// 1.1.18c 验证：括号配对剥 STEP 后裸 JSON 尾巴（与 chat.js 626-640 同款逻辑）
const cases = [
  // 1) 完整 [[tool:]] 块：整块归一化为 STEP
  '我先了解工作区实际情况。[[tool:list_dir]]{"path":".","depth":2}[[/tool]]然后继续检查。',
  // 2) 流式打碎：STEP 标记 + 裸 JSON 参数 + 后续思考正文（JSON 后还有正文，不能被误吞）
  '\u0002STEP:run_command\u0002{"command":"Get-Content x","explanation":"检查行160"}让我重新获取chat.css的诊断。',
  // 3) 嵌套 JSON（explanation 里带引号/花括号）
  '\u0002STEP:read_file\u0002{"path":"a.json","ctx":{"a":{"b":1}}}然后继续。',
  // 4) 未闭合 JSON 尾巴（流式最后一段）
  '\u0002STEP:run_command\u0002{"command":"Get-Content',
  // 5) 无 JSON 的 STEP（正常工具卡）
  '\u0002STEP:list_dir\u0002有.vscode目录。',
  // 6) 自定义符号完整块但参数在流式里不完整
  '[[tool:run_command]]{"command":"dir"}然后继续查。',
];
function clean(t) {
  const s = String(t || '');
  return s
    .replace(/\[\[tool:([A-Za-z0-9_]+)\]\]\s*\{[\s\S]*?\}\s*\[\[\/tool\]\]/gi, '\u0002STEP:$1\u0002')
    .replace(/\[\[tool:([A-Za-z0-9_]+)\]\]/gi, '\u0002STEP:$1\u0002')
    .replace(/\[\[\/tool\]\]/gi, '')
    .replace(/<(fox:?tool|fox-tool|tool)\s+name\s*=\s*["']([^\s"'<>]+)["']\s*>([\s\S]*?)<\/(fox:?tool|fox-tool|tool)>/gi, '\u0002STEP:$2\u0002')
    .replace(/<\/?(fox:?tool|fox-tool|tool)[^>]*>/gi, '')
    // 括号配对剥 STEP 后裸 JSON（配对到对应 }，JSON 后正文保留）
    .replace(/\u0002STEP:([A-Za-z0-9_:.-]+)\u0002\s*\{/g, (m, name, off, whole) => {
      let depth = 1, i = m.length - 1, inStr = false, esc = false;
      for (; i < whole.length; i++) {
        const ch = whole[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) break; }
      }
      const end = depth === 0 ? i + 1 : whole.length;
      return '\u0002STEP:' + name + '\u0002' + whole.slice(end);
    })
    .replace(/\u0002STEP:[^\u0002]*$/g, '');
}
for (const c of cases) {
  console.log('IN :', JSON.stringify(c.slice(0, 60)));
  console.log('OUT:', JSON.stringify(clean(c).slice(0, 90)));
}
// 切段验证
const t = '\u0002STEP:run_command\u0002让我重新获取诊断。\u0002STEP:read_file\u0002继续检查。这是最终回答。';
const STEP_RE = /\u0002STEP:([^\u0002]+)\u0002/g;
const segs = [];
let last = 0, m;
while ((m = STEP_RE.exec(t)) !== null) {
  const pre = t.slice(last, m.index);
  if (pre && pre.trim()) segs.push({ kind: 'text', text: pre });
  segs.push({ kind: 'tool', name: m[1] });
  last = m.index + m[0].length;
}
const tail = t.slice(last);
if (tail && tail.trim()) segs.push({ kind: 'text', text: tail });
console.log('segs:', segs.map(s => s.kind === 'tool' ? '#tool:' + s.name : 'text:' + s.text.slice(0, 8)).join(' | '));