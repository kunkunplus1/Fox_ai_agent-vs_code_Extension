'use strict';
const fs = require('fs');
const h = fs.readFileSync('src/envView.js', 'utf8');
const m = h.match(/<script>([\s\S]*)<\/script>/);
const s = m[1];
// 找脚本块内所有字面反斜杠+n（会被模板字符串提前求值为真实换行）
let i = s.indexOf('\\n');
let n = 0;
while (i >= 0) {
  n++;
  console.log('@' + i, JSON.stringify(s.substr(i - 34, 48)));
  i = s.indexOf('\\n', i + 2);
}
console.log('script-block \\n count:', n);

// 同时在整文件里找，定位行号
const lines = h.split('\n');
console.log('--- 整文件含字面 \\n 的行 ---');
lines.forEach((ln, idx) => {
  if (ln.includes('\\n')) console.log((idx + 1) + ': ' + JSON.stringify(ln));
});
