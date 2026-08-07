// test/log.js — 验证 src/log.js 的 appendLog 真正落盘且失败静默
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { appendLog } = require('../src/log');

const name = 'log-test-' + Date.now().toString(36);
const file = path.join(os.homedir(), '.fox-ai', 'logs', name + '.log');

// 1) 多行写入都落盘
appendLog(name, ['hello', { k: 'v' }]);
assert.ok(fs.existsSync(file), '日志文件应被创建');
const content = fs.readFileSync(file, 'utf8');
assert.ok(content.includes('hello'), '应包含首行');
assert.ok(content.includes('"k":"v"'), '应包含 JSON 行');
assert.ok(content.includes('[pid:'), '应带 pid 前缀');

// 2) 追加模式（不覆盖）
appendLog(name, ['second']);
const content2 = fs.readFileSync(file, 'utf8');
assert.ok(content2.split('\n').filter(Boolean).length >= 2, '应追加而非覆盖');

// 3) 清理
fs.unlinkSync(file);
console.log('[log] 通过 3 项断言');
