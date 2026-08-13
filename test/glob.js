// globToRegex 单测：中文/英文 glob、通配符不再抛错
// 运行：node test/glob.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'tools', 'workspace.js'), 'utf8');
const m = src.match(/function globToRegex\(glob\) \{[\s\S]*?\n\}/);
assert.ok(m, '源码中未找到 globToRegex 函数');
const globToRegex = new Function(m[0] + '\nreturn globToRegex;')();

function check(glob, p, expect) {
  const re = globToRegex(glob);
  assert.strictEqual(re.test(p), expect,
    `glob=${JSON.stringify(glob)} path=${JSON.stringify(p)} 期望 ${expect} 实际 ${re.test(p)}`);
}

// 中文 glob（修复核心：global 模式文件查找支持中文名/中文路径）
check('**/测试*.js', '测试登录.js', true);
check('**/测试*.js', 'src/组件/测试登录.js', true);
check('**/测试*.js', 'foo.txt', false);
check('中文目录/**/*.ts', '中文目录/子/a.ts', true);
check('中文目录/**/*.ts', '中文目录/a.ts', true);
check('*报告*.txt', '年度报告2026.txt', true);
check('*报告*.txt', 'readme.txt', false);

// 英文 glob
check('**/*.js', 'a/b/c.js', true);
check('src/*.ts', 'src/foo.ts', true);
check('src/*.ts', 'src/a/foo.ts', false);
check('*.md', 'README.md', true);
check('*.md', 'docs/README.md', false);

// 通配符不再抛 Unterminated character class（历史双反斜杠 bug 回归）
assert.doesNotThrow(() => globToRegex('**/*.js'), '含 * 的 glob 不应抛错');
assert.doesNotThrow(() => globToRegex('src/foo?bar.ts'), '含 ? 的 glob 不应抛错');
assert.doesNotThrow(() => globToRegex('**/中文*.ts'), '含中文与 * 的 glob 不应抛错');

console.log('✓ glob.js 全部断言通过（中文/英文 glob + 通配符无崩溃）');
