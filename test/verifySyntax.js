'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { verifyNodeSyntax } = require('../src/harness');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' -> ' + e.message); }
}

const tmp = path.join(os.tmpdir(), 'fox-verify-' + Date.now());
fs.mkdirSync(tmp, { recursive: true });

const goodJs = path.join(tmp, 'good.js');
const badJs = path.join(tmp, 'bad.js');
const other = path.join(tmp, 'note.md');
fs.writeFileSync(goodJs, 'const x = 1;\nmodule.exports = x;\n');
fs.writeFileSync(badJs, 'const x = (\nmodule.exports = x;\n');
fs.writeFileSync(other, '# hi\n');

console.log('[verifyNodeSyntax]');
check('合法 .js 通过', () => {
  const r = verifyNodeSyntax(goodJs);
  assert.ok(r.ok, '应 ok：' + r.feedback);
});
check('非法 .js 被拦截', () => {
  const r = verifyNodeSyntax(badJs);
  assert.ok(!r.ok, '应不 ok');
  assert.ok(/node --check/.test(r.feedback), '反馈应提及 node --check');
});
check('非 .js 跳过', () => {
  const r = verifyNodeSyntax(other);
  assert.ok(r.ok && r.skipped, '非 JS 应跳过');
});
check('指定 nodePath 生效', () => {
  const r = verifyNodeSyntax(goodJs, process.execPath);
  assert.ok(r.ok, '用 execPath 应 ok：' + r.feedback);
});
check('找不到 node 时跳过而非报错', () => {
  const r = verifyNodeSyntax(goodJs, '/no/such/node-binary');
  assert.ok(r.ok && r.skipped, '找不到 node 应跳过');
});

console.log(`\nverifySyntax: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
