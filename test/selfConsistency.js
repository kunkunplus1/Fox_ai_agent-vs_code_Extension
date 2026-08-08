'use strict';
// 幻觉·双重验证（Self-Consistency）单元测试（纯逻辑，无 vscode 依赖）
const assert = require('assert');
const { areConsistent, normalizeArgs, argSimilarity, GUARD_DEFAULT, parseToolCall, verifyCall } = require('../src/selfConsistency');

let pass = 0;
function ok(name, cond) {
  assert.ok(cond, 'FAIL: ' + name);
  pass += 1;
  console.log('  ✓ ' + name);
}

// ---- normalizeArgs ----
ok('normalizeArgs 排序键', JSON.stringify(normalizeArgs({ b: 1, a: 2 })) === JSON.stringify({ a: '2', b: '1' }));
ok('normalizeArgs 对象参数转 JSON', normalizeArgs({ x: { k: 1 } }).x === JSON.stringify({ k: 1 }));
ok('normalizeArgs null -> {}', JSON.stringify(normalizeArgs(null)) === '{}');

// ---- argSimilarity ----
ok('完全相同的参数相似度=1', argSimilarity(normalizeArgs({ a: 1, b: 2 }), normalizeArgs({ a: 1, b: 2 })) === 1);
ok('空参数 vs 有参数 = 0', argSimilarity({}, { a: 1 }) === 0);
ok('部分重叠键相似度介于 0~1', argSimilarity(normalizeArgs({ a: 1, b: 2 }), normalizeArgs({ a: 1, c: 3 })) > 0 && argSimilarity(normalizeArgs({ a: 1, b: 2 }), normalizeArgs({ a: 1, c: 3 })) < 1);

// ---- areConsistent ----
ok('同名+相似参数一致', areConsistent({ name: 'edit_file', args: { path: '/a', content: 'hello world' } }, { name: 'edit_file', args: { path: '/a', content: 'hello world!' } }));
ok('不同工具名不一致', !areConsistent({ name: 'edit_file', args: {} }, { name: 'write_file', args: {} }));
ok('参数差异过大不一致', !areConsistent({ name: 'run_command', args: { command: 'rm -rf /a' } }, { name: 'run_command', args: { command: 'ls /b' } }));

// ---- GUARD_DEFAULT ----
ok('默认守卫含高风险工具', GUARD_DEFAULT.includes('run_command') && GUARD_DEFAULT.includes('edit_file') && GUARD_DEFAULT.includes('security_audit'));

// ---- parseToolCall ----
const tc = parseToolCall('下一步：<fox:tool name="run_command">{"command":"ls"}</fox:tool> 完成');
ok('解析工具名', tc && tc.name === 'run_command');
ok('解析参数', tc && tc.args.command === 'ls');
ok('无工具调用返回 null', parseToolCall('没有调用') === null);
// 容错：二次推导常把 <fox:tool> 包进 ```json 代码块
const tcFence = parseToolCall('```json\n<fox:tool name="run_command">{"command":"ls"}</fox:tool>\n```');
ok('解析带 ```json 围栏的工具调用', tcFence && tcFence.name === 'run_command' && tcFence.args.command === 'ls');
// 容错：单引号 JSON 变体
const tcSingle = parseToolCall("<fox:tool name=\"edit_file\">{'path':'/a'}</fox:tool>");
ok('解析单引号 JSON 变体', tcSingle && tcSingle.name === 'edit_file' && tcSingle.args.path === '/a');
// 容错：部分模型会输出 <foxtool>（不带冒号）
const tcNoColon = parseToolCall('<foxtool name="run_command">{"command":"pwd"}</foxtool>');
ok('解析无冒号 foxtool 标签', tcNoColon && tcNoColon.name === 'run_command' && tcNoColon.args.command === 'pwd');
// 容错：裸 JSON 形态 {name, args}
const tcBare = parseToolCall('我觉得应该调用 {"name":"write_file","args":{"path":"/b"}}');
ok('解析裸 JSON 工具调用', tcBare && tcBare.name === 'write_file' && tcBare.args.path === '/b');

// ---- verifyCall ----
(async () => {
  const cfg = { selfConsistency: { enabled: true, tools: [], sampleTemp: 0.8 } };
  // 二次推导与原始一致
  const callModelSame = async () => '<fox:tool name="edit_file">{"path":"/a","content":"hello"}</fox:tool>';
  const v1 = await verifyCall({ name: 'edit_file', args: { path: '/a', content: 'hello' } }, [{ role: 'user', content: '改文件' }], cfg, callModelSame);
  ok('二次推导一致 -> consistent', v1.consistent === true && v1.guarded === true);

  // 二次推导不一致
  const callModelDiff = async () => '<fox:tool name="write_file">{"path":"/b","content":"x"}</fox:tool>';
  const v2 = await verifyCall({ name: 'edit_file', args: { path: '/a', content: 'hello' } }, [{ role: 'user', content: '改文件' }], cfg, callModelDiff);
  ok('二次推导不一致 -> 不一致', v2.consistent === false && v2.reason.indexOf('write_file') > -1);

  // 非守卫工具跳过验证
  const v3 = await verifyCall({ name: 'read_file', args: { path: '/a' } }, [], cfg, callModelDiff);
  ok('非守卫工具不验证', v3.guarded === false && v3.consistent === true);

  // 自定义守卫列表
  const cfg2 = { selfConsistency: { enabled: true, tools: ['read_file'], sampleTemp: 0.5 } };
  const v4 = await verifyCall({ name: 'read_file', args: { path: '/a' } }, [], cfg2, callModelSame);
  ok('自定义守卫列表生效', v4.guarded === true);

  // 二次推导解析失败 -> 视为不一致（保守）
  const v5 = await verifyCall({ name: 'edit_file', args: {} }, [], cfg, async () => '无法解析');
  ok('二次推导解析失败 -> 不一致', v5.consistent === false);

  console.log('\n[selfConsistency] 通过 ' + pass + ' 项断言');
})().catch((e) => { console.error(e); process.exit(1); });
