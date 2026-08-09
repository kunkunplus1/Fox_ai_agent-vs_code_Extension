'use strict';

/**
 * test/subagents.js — 子代理 / 并行 Agent / Agent Teams（src/subagents.js）离线测试
 * 运行：node test/subagents.js
 */

const assert = require('assert');
const S = require('../src/subagents');
const {
  SubagentRunner, ROLES, ROLE_NAMES, GLOBAL_DENY,
  resolveRole, allowedToolNames, normalizeSpec, normalizeSpecs,
  topoStages, buildSubagentSystem, buildSubagentUser, renderResults, renderRoleCatalog, clip
} = S;

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + (e && e.message)); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + (e && e.message)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 模拟全量工具表（对齐 tools/index.js 的 {name, kind} 结构）
const ALL_TOOLS = [
  { name: 'read_file', kind: 'read' },
  { name: 'list_dir', kind: 'read' },
  { name: 'search_text', kind: 'read' },
  { name: 'write_file', kind: 'edit' },
  { name: 'edit_file', kind: 'edit' },
  { name: 'delete_file', kind: 'delete' },
  { name: 'run_command', kind: 'exec' },
  { name: 'web_search', kind: 'read' },
  { name: 'current_time', kind: 'read' },
  { name: 'generate_image', kind: 'read' },
  { name: 'spawn_subagent', kind: 'exec' },
  { name: 'create_skill', kind: 'edit' }
];

/** 造一个按脚本回放的 callModel：scripts 是每一轮要返回的内容 */
function scriptedModel(scripts, opts) {
  opts = opts || {};
  const calls = [];
  let i = 0;
  const fn = async (payload) => {
    calls.push(payload);
    if (opts.delay) await sleep(opts.delay);
    if (opts.throwAt === i + 1) { i++; throw new Error('模型炸了'); }
    const s = scripts[Math.min(i, scripts.length - 1)];
    i++;
    return typeof s === 'function' ? s(payload) : s;
  };
  fn.calls = calls;
  return fn;
}
function newRunner(over) {
  return new SubagentRunner(Object.assign({
    listTools: () => ALL_TOOLS,
    callModel: scriptedModel([{ content: '结论。\n结果：成功' }]),
    execute: async () => 'ok'
  }, over || {}));
}

console.log('\n[subagents] 角色与权限');

t('resolveRole 命中已知角色', () => {
  assert.strictEqual(resolveRole('explorer').key, 'explorer');
  assert.strictEqual(resolveRole('coder').key, 'coder');
});
t('resolveRole 大小写与空白不敏感', () => {
  assert.strictEqual(resolveRole('  ReViewer ').key, 'reviewer');
});
t('resolveRole 支持常见别名', () => {
  assert.strictEqual(resolveRole('explore').key, 'explorer');
  assert.strictEqual(resolveRole('developer').key, 'coder');
  assert.strictEqual(resolveRole('qa').key, 'tester');
  assert.strictEqual(resolveRole('architect').key, 'planner');
});
t('resolveRole 未知角色兜底 generalist', () => {
  assert.strictEqual(resolveRole('狐狸').key, 'generalist');
  assert.strictEqual(resolveRole(undefined).key, 'generalist');
});
t('所有角色都有 system/title/kinds', () => {
  for (const k of ROLE_NAMES) {
    assert.ok(ROLES[k].system && ROLES[k].system.length > 30, k + ' 缺 system');
    assert.ok(ROLES[k].title, k + ' 缺 title');
    assert.ok(Array.isArray(ROLES[k].kinds) && ROLES[k].kinds.length, k + ' 缺 kinds');
  }
});
t('explorer 只有只读工具，拿不到写/执行', () => {
  const { names } = allowedToolNames('explorer', ALL_TOOLS);
  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('search_text'));
  assert.ok(!names.includes('write_file'));
  assert.ok(!names.includes('run_command'));
  assert.ok(!names.includes('delete_file'));
});
t('explorer 明确禁用 generate_image', () => {
  const { names } = allowedToolNames('explorer', ALL_TOOLS);
  assert.ok(!names.includes('generate_image'));
});
t('coder 可写但不可执行命令', () => {
  const { names } = allowedToolNames('coder', ALL_TOOLS);
  assert.ok(names.includes('edit_file'));
  assert.ok(names.includes('write_file'));
  assert.ok(names.includes('read_file'));
  assert.ok(!names.includes('run_command'));
});
t('tester 可执行命令但不可写文件', () => {
  const { names } = allowedToolNames('tester', ALL_TOOLS);
  assert.ok(names.includes('run_command'));
  assert.ok(!names.includes('write_file'));
});
t('researcher 通过 extra 拿到 web_search', () => {
  const { names } = allowedToolNames('researcher', ALL_TOOLS);
  assert.ok(names.includes('web_search'));
  assert.ok(names.includes('current_time'));
  assert.ok(!names.includes('edit_file'));
});
t('全局黑名单对所有角色生效（防递归派生）', () => {
  for (const k of ROLE_NAMES) {
    const { names } = allowedToolNames(k, ALL_TOOLS);
    assert.ok(!names.includes('spawn_subagent'), k + ' 竟能派生子代理');
    assert.ok(!names.includes('create_skill'), k + ' 竟能建技能');
  }
  assert.ok(GLOBAL_DENY.has('spawn_subagent'));
});
t('override 可收窄工具集', () => {
  const { names } = allowedToolNames('coder', ALL_TOOLS, ['read_file', 'edit_file']);
  assert.deepStrictEqual(names.sort(), ['edit_file', 'read_file']);
});
t('override 不能越权放开黑名单工具', () => {
  const { names } = allowedToolNames('explorer', ALL_TOOLS, ['run_command', 'spawn_subagent', 'read_file']);
  assert.deepStrictEqual(names, ['read_file']);
});
t('override 全部不命中时忽略 override', () => {
  const { names } = allowedToolNames('explorer', ALL_TOOLS, ['run_command']);
  assert.ok(names.length > 1 && names.includes('read_file'));
});
t('工具表为空时不炸', () => {
  const { names } = allowedToolNames('coder', []);
  assert.deepStrictEqual(names, []);
});

console.log('\n[subagents] 规格规范化');

t('缺少 task 返回 null', () => {
  assert.strictEqual(normalizeSpec({ role: 'coder' }, 0), null);
  assert.strictEqual(normalizeSpec(null, 0), null);
  assert.strictEqual(normalizeSpec('字符串', 0), null);
});
t('task 支持 goal/prompt 别名', () => {
  assert.strictEqual(normalizeSpec({ goal: 'A' }, 0).task, 'A');
  assert.strictEqual(normalizeSpec({ prompt: 'B' }, 0).task, 'B');
});
t('未指定 name 时按角色自动命名', () => {
  assert.strictEqual(normalizeSpec({ role: 'coder', task: 'x' }, 0).name, 'coder-1');
  assert.strictEqual(normalizeSpec({ role: 'zzz', task: 'x' }, 2).name, 'generalist-3');
});
t('dependsOn 支持 depends_on/deps/单字符串', () => {
  assert.deepStrictEqual(normalizeSpec({ task: 'x', depends_on: ['a'] }, 0).dependsOn, ['a']);
  assert.deepStrictEqual(normalizeSpec({ task: 'x', deps: 'b' }, 0).dependsOn, ['b']);
  assert.deepStrictEqual(normalizeSpec({ task: 'x' }, 0).dependsOn, []);
});
t('maxSteps 被钳位到硬上限', () => {
  assert.strictEqual(normalizeSpec({ task: 'x', maxSteps: 999 }, 0).maxSteps, 16);
  assert.strictEqual(normalizeSpec({ task: 'x', maxSteps: -3 }, 0).maxSteps, 0);
});
t('超长 task/context 被截断', () => {
  const s = normalizeSpec({ task: 'a'.repeat(9000), context: 'b'.repeat(9000) }, 0);
  assert.strictEqual(s.task.length, 4000);
  assert.strictEqual(s.context.length, 6000);
});
t('normalizeSpecs 过滤无效项并重命名重复', () => {
  const out = normalizeSpecs([
    { name: 'a', task: '1' },
    { name: 'a', task: '2' },
    { role: 'coder' },
    { name: 'a', task: '3' }
  ]);
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out.map((s) => s.name), ['a', 'a-2', 'a-3']);
});
t('normalizeSpecs 限制成员数量上限', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ task: 't' + i }));
  assert.strictEqual(normalizeSpecs(many).length, S.MAX_MEMBERS);
});
t('normalizeSpecs 接受非数组输入', () => {
  assert.strictEqual(normalizeSpecs({ task: 'solo' }).length, 1);
  assert.strictEqual(normalizeSpecs(null).length, 0);
});

console.log('\n[subagents] 依赖拓扑分批');

t('无依赖时全部并行一批', () => {
  const st = topoStages(normalizeSpecs([{ name: 'a', task: '1' }, { name: 'b', task: '2' }]));
  assert.strictEqual(st.length, 1);
  assert.strictEqual(st[0].length, 2);
});
t('链式依赖拆成多批', () => {
  const st = topoStages(normalizeSpecs([
    { name: 'c', task: '3', dependsOn: ['b'] },
    { name: 'b', task: '2', dependsOn: ['a'] },
    { name: 'a', task: '1' }
  ]));
  assert.deepStrictEqual(st.map((s) => s.map((x) => x.name)), [['a'], ['b'], ['c']]);
});
t('菱形依赖：中间两个并行', () => {
  const st = topoStages(normalizeSpecs([
    { name: 'a', task: '1' },
    { name: 'b', task: '2', dependsOn: ['a'] },
    { name: 'c', task: '3', dependsOn: ['a'] },
    { name: 'd', task: '4', dependsOn: ['b', 'c'] }
  ]));
  assert.deepStrictEqual(st.map((s) => s.map((x) => x.name)), [['a'], ['b', 'c'], ['d']]);
});
t('依赖不存在的成员时忽略该依赖', () => {
  const st = topoStages(normalizeSpecs([{ name: 'a', task: '1', dependsOn: ['ghost'] }]));
  assert.deepStrictEqual(st, [[st[0][0]]]);
  assert.strictEqual(st[0][0].name, 'a');
});
t('自依赖不会死锁', () => {
  const st = topoStages(normalizeSpecs([{ name: 'a', task: '1', dependsOn: ['a'] }]));
  assert.strictEqual(st.length, 1);
});
t('循环依赖降级为一批放行，不死锁', () => {
  const st = topoStages(normalizeSpecs([
    { name: 'a', task: '1', dependsOn: ['b'] },
    { name: 'b', task: '2', dependsOn: ['a'] }
  ]));
  assert.strictEqual(st.length, 1);
  assert.strictEqual(st[0].length, 2);
});

console.log('\n[subagents] 提示词构造');

t('系统提示含角色定位、工具清单与通用规则', () => {
  const spec = normalizeSpec({ role: 'explorer', task: 'x' }, 0);
  const sys = buildSubagentSystem(spec, ['read_file', 'list_dir'], '');
  assert.ok(sys.includes('探索员'));
  assert.ok(sys.includes('read_file、list_dir'));
  assert.ok(sys.includes('子代理'));
  assert.ok(sys.includes('结果：成功'));
});
t('无可用工具时给出明确说明', () => {
  const sys = buildSubagentSystem(normalizeSpec({ task: 'x' }, 0), [], '');
  assert.ok(sys.includes('没有可用工具'));
});
t('主代理附加约定被拼进系统提示', () => {
  const sys = buildSubagentSystem(normalizeSpec({ task: 'x' }, 0), ['read_file'], '禁止碰 node_modules');
  assert.ok(sys.includes('禁止碰 node_modules'));
});
t('用户消息含任务与背景', () => {
  const u = buildSubagentUser(normalizeSpec({ task: '找登录逻辑', context: '这是 express 项目' }, 0), null);
  assert.ok(u.includes('找登录逻辑'));
  assert.ok(u.includes('express'));
});
t('前置产出被注入用户消息', () => {
  const u = buildSubagentUser(normalizeSpec({ task: 'x' }, 0), [{ name: 'a', roleTitle: '探索员', summary: '入口在 src/app.js' }]);
  assert.ok(u.includes('来自「a」'));
  assert.ok(u.includes('src/app.js'));
});
t('renderRoleCatalog 列出全部角色', () => {
  const c = renderRoleCatalog();
  for (const k of ROLE_NAMES) assert.ok(c.includes('`' + k + '`'), '缺 ' + k);
});
t('clip 截断超长文本并标注字数', () => {
  const out = clip('x'.repeat(100), 10);
  assert.ok(out.startsWith('xxxxxxxxxx'));
  assert.ok(out.includes('共 100 字'));
  assert.strictEqual(clip(null, 10), '');
  assert.strictEqual(clip({ a: 1 }, 100), '{"a":1}');
});

(async function main() {
  console.log('\n[subagents] 单个子代理执行');

  await ta('无工具调用直接给结论 → 成功', async () => {
    const r = await newRunner().spawn(normalizeSpec({ role: 'planner', task: '拆解任务' }, 0));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.stopReason, 'done');
    assert.strictEqual(r.steps, 1);
    assert.ok(r.summary.includes('结果：成功'));
    assert.strictEqual(r.roleTitle, '规划员');
  });

  await ta('工具调用循环：调用后拿到结果再给结论', async () => {
    const executed = [];
    const runner = newRunner({
      callModel: scriptedModel([
        { content: '', toolCalls: [{ id: 'c1', name: 'read_file', rawArgs: '{"path":"a.js"}' }] },
        { content: '读到了。\n结果：成功' }
      ]),
      execute: async (name, args) => { executed.push([name, args.path]); return 'file body'; }
    });
    const r = await runner.spawn(normalizeSpec({ role: 'explorer', task: '读 a.js' }, 0));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.steps, 2);
    assert.deepStrictEqual(executed, [['read_file', 'a.js']]);
    assert.strictEqual(r.toolCalls.length, 1);
    assert.strictEqual(r.toolCalls[0].ok, true);
  });

  await ta('越权工具被拒绝且不执行，回灌提示让它换路', async () => {
    let ran = 0;
    const runner = newRunner({
      callModel: scriptedModel([
        { content: '', toolCalls: [{ id: 'c1', name: 'write_file', rawArgs: '{"path":"a.js"}' }] },
        { content: '改用只读方式。\n结果：成功' }
      ]),
      execute: async () => { ran++; return 'x'; }
    });
    const r = await runner.spawn(normalizeSpec({ role: 'explorer', task: '偷偷写文件' }, 0));
    assert.strictEqual(ran, 0, '越权工具竟被执行');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.toolCalls.length, 0);
    const toolMsg = runner.callModel.calls[1].messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg.content.includes('无权使用'));
  });

  await ta('工具执行抛错被收敛成观察，不打断子代理', async () => {
    const runner = newRunner({
      callModel: scriptedModel([
        { content: '', toolCalls: [{ id: 'c1', name: 'read_file', rawArgs: '{"path":"nope"}' }] },
        { content: '文件不存在。\n结果：失败（文件缺失）' }
      ]),
      execute: async () => { throw new Error('ENOENT'); }
    });
    const r = await runner.spawn(normalizeSpec({ role: 'explorer', task: '读不存在的文件' }, 0));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.toolCalls[0].ok, false);
    const toolMsg = runner.callModel.calls[1].messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg.content.includes('ENOENT'));
  });

  await ta('rawArgs 非法 JSON 时降级为空参数，不崩', async () => {
    let got = null;
    const runner = newRunner({
      callModel: scriptedModel([
        { content: '', toolCalls: [{ id: 'c1', name: 'read_file', rawArgs: '{坏JSON' }] },
        { content: '完事。\n结果：成功' }
      ]),
      execute: async (name, args) => { got = args; return 'x'; }
    });
    const r = await runner.spawn(normalizeSpec({ role: 'explorer', task: 'x' }, 0));
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(got, {});
  });

  await ta('步数用尽触发强制收尾，stopReason=maxSteps', async () => {
    const runner = newRunner({
      limits: { maxSteps: 2 },
      callModel: scriptedModel([
        (p) => (p.tools && p.tools.length
          ? { content: '', toolCalls: [{ id: 'c', name: 'read_file', rawArgs: '{}' }] }
          : { content: '被逼总结：只查到一半。\n结果：失败（信息不足）' })
      ]),
      execute: async () => 'partial'
    });
    const r = await runner.spawn(normalizeSpec({ role: 'explorer', task: '无限查' }, 0));
    assert.strictEqual(r.stopReason, 'maxSteps');
    assert.strictEqual(r.steps, 2);
    assert.ok(r.summary.includes('被逼总结'));
    const last = runner.callModel.calls[runner.callModel.calls.length - 1];
    assert.deepStrictEqual(last.tools, [], '强制收尾时不应再给工具');
    assert.ok(last.messages[last.messages.length - 1].content.includes('禁止再调用任何工具'));
  });

  await ta('工具调用预算用尽后拒绝继续执行', async () => {
    let ran = 0;
    const runner = newRunner({
      limits: { maxSteps: 5, maxToolCalls: 2 },
      callModel: scriptedModel([
        (p) => (p.tools && p.tools.length
          ? { content: '', toolCalls: [{ id: 'c', name: 'read_file', rawArgs: '{}' }] }
          : { content: '收工。\n结果：成功' })
      ]),
      execute: async () => { ran++; return 'x'; }
    });
    const r = await runner.spawn(normalizeSpec({ role: 'explorer', task: 'x' }, 0));
    assert.strictEqual(ran, 2, '实际执行次数应被预算限制');
    assert.strictEqual(r.toolCalls.length, 2);
  });

  await ta('墙钟超时 → stopReason=timeout', async () => {
    const runner = newRunner({
      limits: { maxSteps: 5, timeoutMs: 200 },
      callModel: scriptedModel([
        (p) => (p.tools && p.tools.length
          ? { content: '', toolCalls: [{ id: 'c', name: 'read_file', rawArgs: '{}' }] }
          : { content: '超时前的结论。\n结果：失败（超时）' })
      ], { delay: 260 }),
      execute: async () => 'x'
    });
    const r = await runner.spawn(normalizeSpec({ role: 'explorer', task: 'x' }, 0));
    assert.strictEqual(r.stopReason, 'timeout');
    assert.ok(r.summary.includes('超时前的结论'));
  });

  await ta('主会话取消时立即中止，不做强制收尾', async () => {
    let modelCalls = 0;
    const runner = newRunner({
      isCancelled: () => true,
      callModel: async () => { modelCalls++; return { content: 'x' }; }
    });
    const r = await runner.spawn(normalizeSpec({ task: 'x' }, 0));
    assert.strictEqual(modelCalls, 0);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stopReason, 'cancelled');
    assert.ok(r.error.includes('取消'));
  });

  await ta('模型调用抛错收敛为 ok:false，不向主流程冒泡', async () => {
    const runner = newRunner({ callModel: async () => { throw new Error('502 上游炸了'); } });
    const r = await runner.spawn(normalizeSpec({ task: 'x' }, 0));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stopReason, 'error');
    assert.ok(r.error.includes('502'));
  });

  await ta('缺 task 的规格返回失败结果而非抛错', async () => {
    const r = await newRunner().spawn({ role: 'coder' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('task'));
  });

  await ta('上下文隔离：子代理消息不外泄，主代理只拿 summary', async () => {
    const runner = newRunner({
      callModel: scriptedModel([
        { content: '', toolCalls: [{ id: 'c1', name: 'read_file', rawArgs: '{"path":"secret.js"}' }] },
        { content: '结论。\n结果：成功' }
      ]),
      execute: async () => '一大堆中间过程内容 '.repeat(200)
    });
    const r = await runner.spawn(normalizeSpec({ role: 'explorer', task: 'x' }, 0));
    assert.ok(!r.summary.includes('一大堆中间过程内容'), '中间过程不应出现在结论里');
    assert.ok(r.summary.length < 100);
    // 子代理自己的 messages 里确实有中间过程（隔离在内部）
    const inner = runner.callModel.calls[1].messages;
    assert.ok(inner.some((m) => m.role === 'tool' && m.content.includes('一大堆中间过程内容')));
  });

  await ta('超长工具输出在子代理内部即被截断', async () => {
    const runner = newRunner({
      callModel: scriptedModel([
        { content: '', toolCalls: [{ id: 'c1', name: 'read_file', rawArgs: '{}' }] },
        { content: '好。\n结果：成功' }
      ]),
      execute: async () => 'y'.repeat(50000)
    });
    await runner.spawn(normalizeSpec({ role: 'explorer', task: 'x' }, 0));
    const toolMsg = runner.callModel.calls[1].messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg.content.length < 4300, '工具输出未被截断：' + toolMsg.content.length);
    assert.ok(toolMsg.content.includes('已截断'));
  });

  await ta('超长结论被截断到上限', async () => {
    const runner = newRunner({ callModel: scriptedModel([{ content: 'z'.repeat(9000) }]) });
    const r = await runner.spawn(normalizeSpec({ task: 'x' }, 0));
    assert.ok(r.summary.length < 2500);
  });

  await ta('事件回调按序发出 start/tool/end', async () => {
    const events = [];
    const runner = newRunner({
      onEvent: (e) => events.push(e.type),
      callModel: scriptedModel([
        { content: '', toolCalls: [{ id: 'c1', name: 'read_file', rawArgs: '{}' }] },
        { content: 'done' }
      ])
    });
    await runner.spawn(normalizeSpec({ role: 'explorer', task: 'x' }, 0));
    assert.deepStrictEqual(events, ['subagentStart', 'subagentTool', 'subagentEnd']);
  });

  await ta('事件回调自身抛错不影响子代理', async () => {
    const runner = newRunner({ onEvent: () => { throw new Error('UI 炸了'); } });
    const r = await runner.spawn(normalizeSpec({ task: 'x' }, 0));
    assert.strictEqual(r.ok, true);
  });

  console.log('\n[subagents] 并行执行');

  await ta('多个子代理并行返回，结果顺序与输入一致', async () => {
    const runner = newRunner({
      callModel: async (p) => ({ content: '完成 ' + p.spec.name })
    });
    const rs = await runner.runParallel([
      { name: 'x', role: 'explorer', task: '1' },
      { name: 'y', role: 'reviewer', task: '2' },
      { name: 'z', role: 'planner', task: '3' }
    ]);
    assert.deepStrictEqual(rs.map((r) => r.name), ['x', 'y', 'z']);
    assert.ok(rs.every((r) => r.ok));
    assert.strictEqual(rs[1].roleTitle, '审查员');
  });

  await ta('并发上限生效（峰值不超过 concurrency）', async () => {
    let active = 0;
    let peak = 0;
    const runner = newRunner({
      limits: { concurrency: 2 },
      callModel: async () => {
        active++; peak = Math.max(peak, active);
        await sleep(30);
        active--;
        return { content: 'ok' };
      }
    });
    const rs = await runner.runParallel(Array.from({ length: 5 }, (_, i) => ({ name: 'a' + i, task: 't' })));
    assert.strictEqual(rs.length, 5);
    assert.ok(peak <= 2, '并发峰值 ' + peak + ' 超过上限 2');
  });

  await ta('单个子代理失败不影响其它', async () => {
    const runner = newRunner({
      callModel: async (p) => { if (p.spec.name === 'bad') throw new Error('挂了'); return { content: 'ok' }; }
    });
    const rs = await runner.runParallel([
      { name: 'good', task: '1' },
      { name: 'bad', task: '2' },
      { name: 'good2', task: '3' }
    ]);
    assert.deepStrictEqual(rs.map((r) => r.ok), [true, false, true]);
    assert.ok(rs[1].error.includes('挂了'));
  });

  await ta('空规格列表返回空数组', async () => {
    assert.deepStrictEqual(await newRunner().runParallel([]), []);
    assert.deepStrictEqual(await newRunner().runParallel([{ role: 'coder' }]), []);
  });

  console.log('\n[subagents] Agent Team 协作');

  await ta('按依赖分批执行，前置结论注入后置上下文', async () => {
    const order = [];
    const runner = newRunner({
      callModel: async (p) => {
        order.push(p.spec.name);
        return { content: p.spec.name + ' 的产出' };
      }
    });
    const out = await runner.runTeam({
      goal: '修复登录 bug',
      members: [
        { name: 'find', role: 'explorer', task: '定位' },
        { name: 'fix', role: 'coder', task: '修复', dependsOn: ['find'] },
        { name: 'check', role: 'reviewer', task: '复查', dependsOn: ['fix'] }
      ]
    });
    assert.deepStrictEqual(order, ['find', 'fix', 'check']);
    assert.deepStrictEqual(out.stages, [['find'], ['fix'], ['check']]);
    assert.strictEqual(out.results.length, 3);
    assert.strictEqual(out.goal, '修复登录 bug');
  });

  await ta('后置成员真的看得到前置产出', async () => {
    let fixPrompt = '';
    const runner = newRunner({
      callModel: async (p) => {
        if (p.spec.name === 'fix') fixPrompt = p.messages[1].content;
        return { content: p.spec.name === 'find' ? '问题在 src/auth.js:42' : '已修' };
      }
    });
    await runner.runTeam({
      members: [
        { name: 'find', role: 'explorer', task: '定位' },
        { name: 'fix', role: 'coder', task: '修复', dependsOn: ['find'] }
      ]
    });
    assert.ok(fixPrompt.includes('src/auth.js:42'), '前置产出未注入：' + fixPrompt.slice(0, 120));
    assert.ok(fixPrompt.includes('来自「find」'));
  });

  await ta('同批成员之间互不注入（真正并行隔离）', async () => {
    const prompts = {};
    const runner = newRunner({
      callModel: async (p) => { prompts[p.spec.name] = p.messages[1].content; return { content: p.spec.name + '-秘密产出' }; }
    });
    await runner.runTeam({ members: [{ name: 'a', task: '1' }, { name: 'b', task: '2' }] });
    assert.ok(!prompts.a.includes('b-秘密产出'));
    assert.ok(!prompts.b.includes('a-秘密产出'));
  });

  await ta('无显式依赖时自动继承上一批产出', async () => {
    let second = '';
    const runner = newRunner({
      callModel: async (p) => {
        if (p.spec.name === 'c') second = p.messages[1].content;
        return { content: p.spec.name + ' 结论' };
      }
    });
    await runner.runTeam({
      members: [
        { name: 'a', task: '1' },
        { name: 'b', task: '2', dependsOn: ['a'] },
        { name: 'c', task: '3', dependsOn: ['b'] }
      ]
    });
    assert.ok(second.includes('b 结论'));
  });

  await ta('team 中途取消则停止后续批次', async () => {
    let cancelled = false;
    const runner = new SubagentRunner({
      listTools: () => ALL_TOOLS,
      isCancelled: () => cancelled,
      callModel: async (p) => { cancelled = true; return { content: p.spec.name }; },
      execute: async () => 'x'
    });
    const out = await runner.runTeam({
      members: [{ name: 'a', task: '1' }, { name: 'b', task: '2', dependsOn: ['a'] }]
    });
    assert.strictEqual(out.results.length, 1);
    assert.strictEqual(out.results[0].name, 'a');
  });

  await ta('空 team 返回空结果', async () => {
    const out = await newRunner().runTeam({ members: [] });
    assert.deepStrictEqual(out.results, []);
    assert.deepStrictEqual(await newRunner().runTeam({}).then((o) => o.results), []);
  });

  console.log('\n[subagents] 结果渲染与自述');

  t('renderResults 汇总成功数与各成员结论', () => {
    const md = renderResults([
      { name: 'a', roleTitle: '探索员', emoji: '🔍', ok: true, summary: '找到了', steps: 2, toolCalls: [{}], durationMs: 1500, stopReason: 'done' },
      { name: 'b', roleTitle: '编码员', emoji: '🛠️', ok: false, error: '模型超时', steps: 1, toolCalls: [], durationMs: 800, stopReason: 'error' }
    ]);
    assert.ok(md.includes('1/2 成功'));
    assert.ok(md.includes('✅') && md.includes('❌'));
    assert.ok(md.includes('找到了'));
    assert.ok(md.includes('模型超时'));
    assert.ok(md.includes('1.5s'));
    assert.ok(md.includes('有子代理未完成'));
  });
  t('renderResults 全成功时给出继续提示', () => {
    const md = renderResults([{ name: 'a', ok: true, summary: 'ok', steps: 1, toolCalls: [], durationMs: 100 }], { goal: 'G' });
    assert.ok(md.includes('2/2 成功') === false);
    assert.ok(md.includes('1/1 成功'));
    assert.ok(md.includes('目标：G'));
    assert.ok(md.includes('中间探索过程未进入你的上下文'));
  });
  t('renderResults 空列表有明确说明', () => {
    assert.ok(renderResults([]).includes('没有派生'));
    assert.ok(renderResults(null).includes('没有派生'));
  });
  t('describe 输出角色与预算', () => {
    const d = newRunner({ limits: { maxSteps: 3, concurrency: 2 } }).describe();
    assert.strictEqual(d.limits.maxSteps, 3);
    assert.strictEqual(d.limits.concurrency, 2);
    assert.ok(d.roles.includes('coder'));
    assert.strictEqual(d.maxMembers, S.MAX_MEMBERS);
  });
  t('预算参数被钳位在硬上限内', () => {
    const d = newRunner({ limits: { maxSteps: 999, maxToolCalls: 999, concurrency: 99, timeoutMs: 99999999 } }).describe();
    assert.strictEqual(d.limits.maxSteps, 16);
    assert.strictEqual(d.limits.maxToolCalls, 40);
    assert.strictEqual(d.limits.concurrency, 6);
    assert.strictEqual(d.limits.timeoutMs, 600000);
  });

  console.log(`\n[subagents] ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
