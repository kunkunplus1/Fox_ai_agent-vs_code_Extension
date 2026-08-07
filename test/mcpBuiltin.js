'use strict';

/**
 * 测试内置（builtin）MCP 服务器：time / fetch / git / sequentialthinking
 * 这些服务器没有稳定 npm 包，因此用 fox-ai 自写 MCP 能力生成纯 Node 实现。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const assert = require('assert');

const mcpAuthor = require('../src/tools/mcpAuthor');

function speakWithServer(serverPath, env) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, [serverPath], { env: Object.assign({}, process.env, env || {}) });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('服务器调用超时'));
    }, 15000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        return reject(new Error('服务器退出码 ' + code + (err ? '\n' + err : '')));
      }
      const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
      const responses = lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
      resolve({ responses, err });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get-current-time', arguments: { timezone: 'Asia/Shanghai' } } }) + '\n');
    child.stdin.end();
  });
}

function speakWithServerEx(serverPath, calls, env) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, [serverPath], { env: Object.assign({}, process.env, env || {}) });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('服务器调用超时')); }, 15000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) return reject(new Error('服务器退出码 ' + code + (err ? '\n' + err : '')));
      const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
      const responses = lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
      resolve({ responses, err });
    });
    for (const c of (calls || [])) child.stdin.write(JSON.stringify(c) + '\n');
    child.stdin.end();
  });
}

function nodeCheck(filePath) {
  cp.execSync('"' + process.execPath + '" --check "' + filePath + '"', { windowsHide: true, stdio: 'pipe' });
}

(async () => {
  let passed = 0;
  let failed = 0;
  const log = (ok, name) => {
    if (ok) { passed++; console.log('  \u2713 ' + name); }
    else { failed++; console.log('  \u2717 ' + name); }
  };

  console.log('builtin MCP 服务器测试');

  // 1. spec 存在
  {
    const spec = mcpAuthor.getBuiltinSpec('time');
    log(spec && spec.tools && spec.tools.some((t) => t.name === 'get-current-time'), 'getBuiltinSpec(time) 返回有效定义');
  }

  // 2. 未知 builtin 返回 null
  log(mcpAuthor.buildBuiltinServer('no-such-builtin') === null, 'buildBuiltinServer(unknown) 返回 null');

  // 3. time 生成 + 语法检查 + 调用
  {
    const baseDir = path.join(os.homedir(), '.fox-ai', 'mcp-servers-test', 'builtin-test-' + Date.now());
    const serverPath = path.join(baseDir, 'time', 'server.js');
    const source = mcpAuthor.buildBuiltinServer('time');
    fs.mkdirSync(path.dirname(serverPath), { recursive: true });
    fs.writeFileSync(serverPath, source, 'utf8');
    let syntaxOk = false;
    try { nodeCheck(serverPath); syntaxOk = true; } catch (_) {}
    log(syntaxOk, 'time builtin 脚本语法检查通过');

    let callOk = false;
    try {
      const { responses } = await speakWithServer(serverPath);
      const initOk = responses.some((r) => r.id === 1 && r.result && r.result.serverInfo);
      const toolListed = responses.some((r) => r.id === 2 && r.result && r.result.tools && r.result.tools.some((t) => t.name === 'get-current-time'));
      const callRes = responses.find((r) => r.id === 3 && r.result && r.result.content);
      const text = callRes && callRes.result.content[0] && callRes.result.content[0].text;
      callOk = initOk && toolListed && text && text.includes('当前时间');
    } catch (e) { console.error('    time call error:', e.message); }
    log(callOk, 'time builtin 调用 get-current-time 返回当前时间');
  }

  // 4. fetch / git 生成 + 语法检查
  {
    const baseDir = path.join(os.homedir(), '.fox-ai', 'mcp-servers-test', 'builtin-test-' + Date.now());
    for (const id of ['fetch', 'git']) {
      const source = mcpAuthor.buildBuiltinServer(id);
      const serverPath = path.join(baseDir, id, 'server.js');
      fs.mkdirSync(path.dirname(serverPath), { recursive: true });
      fs.writeFileSync(serverPath, source, 'utf8');
      let syntaxOk = false;
      try { nodeCheck(serverPath); syntaxOk = true; } catch (_) {}
      log(syntaxOk, id + ' builtin 脚本语法检查通过');
    }
  }

  // 5. sequentialthinking builtin 生成 + 语法 + 调用
  {
    const spec = mcpAuthor.getBuiltinSpec('sequentialthinking');
    log(spec && spec.tools && spec.tools.some((t) => t.name === 'sequentialthinking'), 'getBuiltinSpec(sequentialthinking) 返回有效定义');

    const baseDir = path.join(os.homedir(), '.fox-ai', 'mcp-servers-test', 'builtin-test-' + Date.now());
    const source = mcpAuthor.buildBuiltinServer('sequentialthinking');
    log(!!source && source.includes('sequentialthinking'), 'buildBuiltinServer(sequentialthinking) 返回源码');
    const serverPath = path.join(baseDir, 'sequentialthinking', 'server.js');
    fs.mkdirSync(path.dirname(serverPath), { recursive: true });
    fs.writeFileSync(serverPath, source, 'utf8');
    let syntaxOk = false;
    try { nodeCheck(serverPath); syntaxOk = true; } catch (e) { console.error('    syntax error:', e.message); }
    log(syntaxOk, 'sequentialthinking builtin 脚本语法检查通过');

    let callOk = false;
    try {
      const { responses } = await speakWithServerEx(serverPath, [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sequentialthinking', arguments: { thought: '先分析需求', nextThoughtNeeded: true, thoughtNumber: 1, totalThoughts: 3 } } }
      ]);
      const initOk = responses.some((r) => r.id === 1 && r.result && r.result.serverInfo);
      const toolListed = responses.some((r) => r.id === 2 && r.result && r.result.tools && r.result.tools.some((t) => t.name === 'sequentialthinking'));
      const callRes = responses.find((r) => r.id === 3 && r.result && r.result.content);
      const text = callRes && callRes.result.content[0] && callRes.result.content[0].text;
      callOk = initOk && toolListed && text && text.includes('已记录第 1 步思考');
    } catch (e) { console.error('    sequentialthinking call error:', e.message); }
    log(callOk, 'sequentialthinking builtin 调用返回思考链状态');
  }

  // 6. mock builtin 生成 + 语法 + 调用
  {
    const spec = mcpAuthor.getBuiltinSpec('mock');
    log(spec && spec.tools && spec.tools.some((t) => t.name === 'hello'), 'getBuiltinSpec(mock) 返回有效定义');

    const baseDir = path.join(os.homedir(), '.fox-ai', 'mcp-servers-test', 'builtin-test-' + Date.now());
    const source = mcpAuthor.buildBuiltinServer('mock');
    log(!!source && source.includes('hello'), 'buildBuiltinServer(mock) 返回源码');
    const serverPath = path.join(baseDir, 'mock', 'server.js');
    fs.mkdirSync(path.dirname(serverPath), { recursive: true });
    fs.writeFileSync(serverPath, source, 'utf8');
    let syntaxOk = false;
    try { nodeCheck(serverPath); syntaxOk = true; } catch (e) { console.error('    syntax error:', e.message); }
    log(syntaxOk, 'mock builtin 脚本语法检查通过');

    let callOk = false;
    try {
      const { responses } = await speakWithServerEx(serverPath, [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hello', arguments: { name: 'fox' } } }
      ]);
      const initOk = responses.some((r) => r.id === 1 && r.result && r.result.serverInfo);
      const toolListed = responses.some((r) => r.id === 2 && r.result && r.result.tools && r.result.tools.some((t) => t.name === 'hello'));
      const callRes = responses.find((r) => r.id === 3 && r.result && r.result.content);
      const text = callRes && callRes.result.content[0] && callRes.result.content[0].text;
      callOk = initOk && toolListed && text && text.includes('Hello from fox-ai mock server');
    } catch (e) { console.error('    mock call error:', e.message); }
    log(callOk, 'mock builtin 调用返回固定问候');
  }

  console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();
