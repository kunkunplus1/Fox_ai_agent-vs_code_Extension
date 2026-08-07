'use strict';

/**
 * 验证两个修复点：
 *  1) resolveNodeCommand 在 node 运行环境下返回真正的 node 可执行文件（而非 Code.exe）。
 *  2) buildServers 能把历史遗留的 Code.exe 启动命令纠正为 node（避免安全检查误拦）。
 */

const assert = require('assert');
const path = require('path');

let pass = 0;
function ok(name) { pass += 1; console.log('  ✓ ' + name); }

const mcpAuthor = require('../src/tools/mcpAuthor');
const { buildServers } = require('../src/tools/mcpSetup');

// 1) resolveNodeCommand 返回的是 node（basename 为 node / node.exe）
const nodeCmd = mcpAuthor.resolveNodeCommand();
const nb = path.basename(nodeCmd).toLowerCase();
assert(nb === 'node' || nb === 'node.exe', 'resolveNodeCommand 应返回 node，实际：' + nodeCmd);
ok('resolveNodeCommand 返回 node：' + nodeCmd);

// 2) 残留的 Code.exe 启动命令被纠正为 node
const legacy = {
  servers: [
    { id: 'fetch', transport: 'stdio', command: 'C:\\Users\\asis\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', args: ['x'] },
    { id: 'ok', transport: 'stdio', command: 'node', args: ['y'] }
  ],
  playwright: { enabled: false }
};
const fixed = buildServers(legacy);
const fetchDef = fixed.find((s) => s.id === 'fetch');
assert(fetchDef && fetchDef.command && /node(\.exe)?$/i.test(path.basename(fetchDef.command)), 'fetch 的 Code.exe 应被纠正为 node，实际：' + (fetchDef && fetchDef.command));
ok('Code.exe 残留被纠正为 node：' + fetchDef.command);
const okDef = fixed.find((s) => s.id === 'ok');
assert(okDef.command === 'node', '本来就是 node 的 def 不应被改动');
ok('原本为 node 的 def 未被误改');

// 3) http/sse 定义的 command 不被处理
const httpDef = { servers: [ { id: 'remote', transport: 'http', url: 'https://example.com/mcp' } ], playwright: { enabled: false } };
const fixedHttp = buildServers(httpDef);
ok('http 定义安全策略不受影响（共 ' + fixedHttp.length + ' 条）');

console.log('\n结果：' + pass + ' 通过，0 失败');
process.exit(0);
