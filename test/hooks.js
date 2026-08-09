'use strict';

/**
 * test/hooks.js — 生命周期钩子（src/hooks.js）离线测试
 * 运行：node test/hooks.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hooks = require('../src/hooks');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { pass++; console.log('  ✓ ' + name); },
        (e) => { fail++; console.log('  ✗ ' + name + ' → ' + (e && e.message)); }
      );
    }
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + ' → ' + (e && e.message));
  }
  return Promise.resolve();
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foxhooks-'));
function writeCfg(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  return file;
}

(async () => {
  console.log('\n[hooks] 生命周期钩子');

  // ---------- 1. 配置加载 ----------
  await t('无配置文件时钩子数为 0', () => {
    const r = hooks.loadHooks({ userFile: path.join(tmp, 'nope.json'), workspaceFile: path.join(tmp, 'nope2.json') });
    assert.strictEqual(r.files.length, 0);
    for (const ev of hooks.EVENTS) assert.strictEqual(r.hooks[ev].length, 0);
  });

  await t('能加载 hooks.json 并按事件分组', () => {
    const f = writeCfg(path.join(tmp, 'u1', 'hooks.json'), {
      hooks: {
        preToolUse: [{ name: 'a', matcher: { tool: 'run_command' }, action: { type: 'deny', message: 'no' } }],
        postToolUse: [{ name: 'b', action: { type: 'log' } }]
      }
    });
    const r = hooks.loadHooks({ userFile: f });
    assert.strictEqual(r.hooks.preToolUse.length, 1);
    assert.strictEqual(r.hooks.postToolUse.length, 1);
    assert.strictEqual(r.hooks.preToolUse[0].name, 'a');
    assert.strictEqual(r.hooks.preToolUse[0].source, 'user');
  });

  await t('用户级与工作区级配置会合并', () => {
    const uf = writeCfg(path.join(tmp, 'u2', 'hooks.json'), {
      hooks: { preToolUse: [{ name: 'user-hook', action: { type: 'log' } }] }
    });
    const wf = writeCfg(path.join(tmp, 'w2', 'hooks.json'), {
      hooks: { preToolUse: [{ name: 'ws-hook', action: { type: 'log' } }] }
    });
    const r = hooks.loadHooks({ userFile: uf, workspaceFile: wf });
    assert.strictEqual(r.hooks.preToolUse.length, 2);
    assert.strictEqual(r.hooks.preToolUse[0].source, 'user');
    assert.strictEqual(r.hooks.preToolUse[1].source, 'workspace');
  });

  await t('非法 action 类型被丢弃且不抛错', () => {
    const f = writeCfg(path.join(tmp, 'u3', 'hooks.json'), {
      hooks: { preToolUse: [{ name: 'bad', action: { type: 'nuke' } }, { name: 'ok', action: { type: 'log' } }] }
    });
    const r = hooks.loadHooks({ userFile: f });
    assert.strictEqual(r.hooks.preToolUse.length, 1);
    assert.strictEqual(r.hooks.preToolUse[0].name, 'ok');
    assert.ok(r.errors.length >= 1);
  });

  await t('损坏 JSON 不抛错，静默跳过', () => {
    const f = path.join(tmp, 'broken', 'hooks.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{ not json', 'utf8');
    const r = hooks.loadHooks({ userFile: f });
    assert.strictEqual(r.files.length, 0);
  });

  // ---------- 2. 匹配 ----------
  await t('tool 正则匹配（多选一）', () => {
    const h = hooks.normalizeHook({ name: 'x', matcher: { tool: 'write_file|edit_file' }, action: { type: 'log' } }, 'preToolUse', 'user');
    assert.ok(hooks.matches(h, { tool: 'write_file' }));
    assert.ok(hooks.matches(h, { tool: 'edit_file' }));
    assert.ok(!hooks.matches(h, { tool: 'read_file' }));
  });

  await t('tool 匹配是全词锚定，不会误伤子串', () => {
    const h = hooks.normalizeHook({ name: 'x', matcher: { tool: 'read_file' }, action: { type: 'log' } }, 'preToolUse', 'user');
    assert.ok(hooks.matches(h, { tool: 'read_file' }));
    assert.ok(!hooks.matches(h, { tool: 'read_file_extra' }));
  });

  await t('argsMatch 多字段需全部命中', () => {
    const h = hooks.normalizeHook(
      { name: 'x', matcher: { tool: 'write_file', argsMatch: { path: '\\.env$' } }, action: { type: 'deny' } },
      'preToolUse',
      'user'
    );
    assert.ok(hooks.matches(h, { tool: 'write_file', args: { path: 'a/.env' } }));
    assert.ok(!hooks.matches(h, { tool: 'write_file', args: { path: 'a/index.js' } }));
    assert.ok(!hooks.matches(h, { tool: 'write_file', args: {} }));
  });

  await t('空 matcher 匹配一切', () => {
    const h = hooks.normalizeHook({ name: 'x', matcher: {}, action: { type: 'log' } }, 'preToolUse', 'user');
    assert.ok(hooks.matches(h, { tool: 'anything' }));
    assert.ok(hooks.matches(h, {}));
  });

  await t('enabled:false 的钩子不匹配', () => {
    const h = hooks.normalizeHook({ name: 'x', enabled: false, action: { type: 'log' } }, 'preToolUse', 'user');
    assert.ok(!hooks.matches(h, { tool: 'a' }));
  });

  await t('非法正则不抛错，视为不匹配', () => {
    const h = hooks.normalizeHook({ name: 'x', matcher: { tool: '([' }, action: { type: 'log' } }, 'preToolUse', 'user');
    assert.strictEqual(hooks.matches(h, { tool: 'a' }), false);
  });

  // ---------- 3. 插值 ----------
  await t('插值支持 ${tool} ${path} ${args.xxx}', () => {
    const s = hooks.interpolate('${tool} 改了 ${path}，模式 ${args.mode}', {
      tool: 'write_file',
      args: { path: 'src/a.js', mode: 'fast' }
    });
    assert.strictEqual(s, 'write_file 改了 src/a.js，模式 fast');
  });

  await t('插值剔除换行与控制字符（防日志/命令行污染）', () => {
    const s = hooks.interpolate('${path}', { args: { path: 'a\nb\rc' } });
    assert.ok(!s.includes('\n'));
    assert.ok(!s.includes('\r'));
  });

  await t('未知变量替换为空串', () => {
    assert.strictEqual(hooks.interpolate('[${nope}]', { args: {} }), '[]');
  });

  // ---------- 4. fire 决策 ----------
  await t('deny 钩子命中时返回 deny 并短路', async () => {
    const f = writeCfg(path.join(tmp, 'f1', 'hooks.json'), {
      hooks: {
        preToolUse: [
          { name: '拦截 env', matcher: { argsMatch: { path: '\\.env$' } }, action: { type: 'deny', message: '禁止改 ${path}' } },
          { name: '不该执行', action: { type: 'log' } }
        ]
      }
    });
    const r = new hooks.HookRunner({ userFile: f, workspaceFile: '' });
    const out = await r.fire('preToolUse', { tool: 'write_file', args: { path: '.env' } });
    assert.strictEqual(out.decision, 'deny');
    assert.strictEqual(out.reason, '禁止改 .env');
    assert.strictEqual(out.ran, 1, '应短路，后面的钩子不再执行');
  });

  await t('未命中的 deny 钩子不影响放行', async () => {
    const f = writeCfg(path.join(tmp, 'f2', 'hooks.json'), {
      hooks: { preToolUse: [{ name: 'x', matcher: { tool: 'run_command' }, action: { type: 'deny' } }] }
    });
    const r = new hooks.HookRunner({ userFile: f, workspaceFile: '' });
    const out = await r.fire('preToolUse', { tool: 'read_file', args: {} });
    assert.strictEqual(out.decision, 'allow');
    assert.strictEqual(out.ran, 0);
  });

  await t('ask 钩子返回 ask（强制人工确认）', async () => {
    const f = writeCfg(path.join(tmp, 'f3', 'hooks.json'), {
      hooks: {
        preToolUse: [{ name: '危险命令', matcher: { argsMatch: { command: 'rm\\s+-rf' } }, action: { type: 'ask', message: '高危：${command}' } }]
      }
    });
    const r = new hooks.HookRunner({ userFile: f, workspaceFile: '' });
    const out = await r.fire('preToolUse', { tool: 'run_command', args: { command: 'rm -rf /tmp/x' } });
    assert.strictEqual(out.decision, 'ask');
    assert.ok(out.reason.includes('高危'));
  });

  await t('deny 优先级高于 ask', async () => {
    const f = writeCfg(path.join(tmp, 'f4', 'hooks.json'), {
      hooks: {
        preToolUse: [
          { name: 'ask1', action: { type: 'ask' } },
          { name: 'deny1', action: { type: 'deny', message: 'nope' } }
        ]
      }
    });
    const r = new hooks.HookRunner({ userFile: f, workspaceFile: '' });
    const out = await r.fire('preToolUse', { tool: 'x' });
    assert.strictEqual(out.decision, 'deny');
  });

  await t('allow 钩子显式放行并短路', async () => {
    const f = writeCfg(path.join(tmp, 'f5', 'hooks.json'), {
      hooks: {
        preToolUse: [
          { name: '白名单', matcher: { tool: 'run_command', argsMatch: { command: '^npm test' } }, action: { type: 'allow' } },
          { name: '本该 deny', matcher: { tool: 'run_command' }, action: { type: 'deny' } }
        ]
      }
    });
    const r = new hooks.HookRunner({ userFile: f, workspaceFile: '' });
    const out = await r.fire('preToolUse', { tool: 'run_command', args: { command: 'npm test' } });
    assert.strictEqual(out.decision, 'allow');
    assert.strictEqual(out.ran, 1);
  });

  await t('inject 钩子收集注入文本', async () => {
    const f = writeCfg(path.join(tmp, 'f6', 'hooks.json'), {
      hooks: { userPromptSubmit: [{ name: '规约', action: { type: 'inject', text: '必须写中文注释' } }] }
    });
    const r = new hooks.HookRunner({ userFile: f, workspaceFile: '' });
    const out = await r.fire('userPromptSubmit', { text: '帮我写个函数' });
    assert.deepStrictEqual(out.injects, ['必须写中文注释']);
    assert.strictEqual(out.decision, 'allow');
  });

  // ---------- 5. command 动作 ----------
  await t('command 钩子调用注入的执行器并传插值后的参数', async () => {
    const calls = [];
    const f = writeCfg(path.join(tmp, 'c1', 'hooks.json'), {
      hooks: {
        postToolUse: [
          { name: 'lint', matcher: { tool: 'write_file' }, action: { type: 'command', command: 'node', args: ['--check', '${path}'] } }
        ]
      }
    });
    const r = new hooks.HookRunner({
      userFile: f,
      workspaceFile: '',
      exec: async (cmd, args) => { calls.push({ cmd, args }); return { code: 0, output: 'ok' }; }
    });
    const out = await r.fire('postToolUse', { tool: 'write_file', args: { path: 'src/a.js' } });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].cmd, 'node');
    assert.deepStrictEqual(calls[0].args, ['--check', 'src/a.js']);
    assert.strictEqual(out.results[0].ok, true);
  });

  await t('command 失败 + blockOnFail 会阻断', async () => {
    const f = writeCfg(path.join(tmp, 'c2', 'hooks.json'), {
      hooks: {
        preToolUse: [{ name: 'gate', action: { type: 'command', command: 'x', blockOnFail: true, message: '门禁未通过' } }]
      }
    });
    const r = new hooks.HookRunner({ userFile: f, workspaceFile: '', exec: async () => ({ code: 2, output: 'boom' }) });
    const out = await r.fire('preToolUse', { tool: 'a' });
    assert.strictEqual(out.decision, 'deny');
    assert.ok(out.reason.includes('门禁未通过'));
    assert.ok(out.reason.includes('boom'));
  });

  await t('command 失败但未开 blockOnFail 时不阻断', async () => {
    const f = writeCfg(path.join(tmp, 'c3', 'hooks.json'), {
      hooks: { postToolUse: [{ name: 'soft', action: { type: 'command', command: 'x' } }] }
    });
    const r = new hooks.HookRunner({ userFile: f, workspaceFile: '', exec: async () => ({ code: 1, output: 'warn' }) });
    const out = await r.fire('postToolUse', { tool: 'a' });
    assert.strictEqual(out.decision, 'allow');
    assert.strictEqual(out.results[0].ok, false);
  });

  await t('injectOutput 把命令输出并入注入文本', async () => {
    const f = writeCfg(path.join(tmp, 'c4', 'hooks.json'), {
      hooks: { postToolUse: [{ name: 'tip', action: { type: 'command', command: 'x', injectOutput: true } }] }
    });
    const r = new hooks.HookRunner({ userFile: f, workspaceFile: '', exec: async () => ({ code: 0, output: '发现 2 处告警' }) });
    const out = await r.fire('postToolUse', { tool: 'a' });
    assert.strictEqual(out.injects.length, 1);
    assert.ok(out.injects[0].includes('发现 2 处告警'));
  });

  await t('执行器抛异常时不打断主流程', async () => {
    const f = writeCfg(path.join(tmp, 'c5', 'hooks.json'), {
      hooks: { preToolUse: [{ name: 'boom', action: { type: 'command', command: 'x', blockOnFail: true } }] }
    });
    const r = new hooks.HookRunner({ userFile: f, workspaceFile: '', exec: async () => { throw new Error('执行器炸了'); } });
    const out = await r.fire('preToolUse', { tool: 'a' });
    assert.strictEqual(out.decision, 'allow', '钩子自身异常不应阻断');
    assert.strictEqual(out.results[0].ok, false);
  });

  // ---------- 6. 总开关与描述 ----------
  await t('enabled=false 时 fire 直接放行', async () => {
    const f = writeCfg(path.join(tmp, 'e1', 'hooks.json'), {
      hooks: { preToolUse: [{ name: 'deny-all', action: { type: 'deny' } }] }
    });
    const r = new hooks.HookRunner({ userFile: f, workspaceFile: '', enabled: false });
    const out = await r.fire('preToolUse', { tool: 'a' });
    assert.strictEqual(out.decision, 'allow');
    assert.strictEqual(out.ran, 0);
  });

  await t('未注册事件触发时安全返回', async () => {
    const r = new hooks.HookRunner({ userFile: path.join(tmp, 'none.json'), workspaceFile: '' });
    const out = await r.fire('sessionEnd', {});
    assert.strictEqual(out.decision, 'allow');
    const out2 = await r.fire('不存在的事件', {});
    assert.strictEqual(out2.decision, 'allow');
  });

  await t('describe 无配置时给出创建指引', () => {
    const r = new hooks.HookRunner({ userFile: path.join(tmp, 'none2.json'), workspaceFile: '' });
    const s = r.describe();
    assert.ok(s.includes('未找到钩子配置文件'));
  });

  await t('describe 列出已加载钩子', () => {
    const f = writeCfg(path.join(tmp, 'd1', 'hooks.json'), {
      hooks: { preToolUse: [{ name: '保护 env', matcher: { tool: 'write_file' }, action: { type: 'deny' } }] }
    });
    const r = new hooks.HookRunner({ userFile: f, workspaceFile: '' });
    const s = r.describe();
    assert.ok(s.includes('保护 env'));
    assert.ok(s.includes('preToolUse'));
  });

  await t('reload 能感知配置文件变化', () => {
    const f = writeCfg(path.join(tmp, 'r1', 'hooks.json'), { hooks: { preToolUse: [] } });
    const r = new hooks.HookRunner({ userFile: f, workspaceFile: '' });
    assert.strictEqual(r.count('preToolUse'), 0);
    writeCfg(f, { hooks: { preToolUse: [{ name: 'new', action: { type: 'log' } }] } });
    r.reload();
    assert.strictEqual(r.count('preToolUse'), 1);
  });

  await t('内置示例配置结构合法', () => {
    const r = hooks.loadHooks({ userFile: writeCfg(path.join(tmp, 's1', 'hooks.json'), hooks.SAMPLE_CONFIG) });
    assert.ok(r.hooks.preToolUse.length >= 2, '示例应含至少两条 preToolUse');
    const deny = r.hooks.preToolUse.find((h) => h.action.type === 'deny');
    assert.ok(deny && hooks.matches(deny, { tool: 'write_file', args: { path: 'x/.env' } }));
  });

  console.log(`\n[hooks] ${pass} 通过 / ${fail} 失败`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})();
