'use strict';
// 验证 memoryTopics.js harvest 协议噪音加固（1.1.15 内增强）
const { harvest } = require('../src/memoryTopics.js');

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}

// 1. 真实污染样本：含动态上下文残留 + 工具报错的全文粘贴
const dirty = [
  { role: 'user', content: '不要重复错误。 - 工具 write_file 的参数不是合法 JSON：Unexpected token \'和\', "和" is not valid JSON' },
  { role: 'user', content: '不要堆在单文件；每个文件只负责一块清晰的功能。 - 可用 read_file / list_dir / search_text 进一步核实每个文件的具体内容；改动后用 diagnostics 验证。 【狐狸AI·动态上下文】 【深度思考】 【深' },
  { role: 'user', content: '【狐狸AI·动态上下文】【深度思考】根据当前环境继续…【当前环境】c:/Users/…【狐狸AI·动态上下文·完】 不要堆在单文件；每个文件只负责一块清晰的功能。' }
];
const r1 = harvest(dirty, { maxItems: 8 });
console.log('  候选数(期望 0):', r1.length);
t('污染样本整体不沉淀', r1.length === 0);

// 2. 正常用户偏好仍能沉淀（不误伤）
const clean = [
  { role: 'user', content: '不要用 tabs，统一用两个空格缩进' },
  { role: 'user', content: '以后都用中文回复我，别用英文' },
  { role: 'user', content: '记住：打包前必须先跑全部测试' }
];
const r2 = harvest(clean, { maxItems: 8 });
console.log('  候选:', r2.map((c) => c.text));
t('正常偏好仍沉淀(>=2)', r2.length >= 2);
t('正常偏好无噪音残留', r2.every((c) => !/<foxtool|Unexpected token|动态上下文/.test(c.text)));

// 3. 含动态块的消息：属 WebAI2API 回灌/系统拼装，整体跳过（宁可少收、不可错收）
const mixed = [
  { role: 'user', content: '【狐狸AI·动态上下文】【深度思考】xxx【狐狸AI·动态上下文·完】 以后写文件都用 CRLF 换行' }
];
const r3 = harvest(mixed, { maxItems: 8 });
console.log('  候选(期望 0):', r3.length);
t('含动态块消息整体跳过', r3.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
