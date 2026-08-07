'use strict';

/**
 * 回归测试：插件联动
 * 1) call_extension_command 工具已注册
 * 2) 系统提示词包含已授权扩展命令清单
 * 3) 白名单内的命令在政策评估中被放行
 * 运行：node test/extensionBridge.js
 */

const Module = require('module');
const assert = require('assert');

/* ---------- mock vscode ---------- */
let storedAllowed = ['foxAi.optimizeMemory'];
const vscodeMock = {
  workspace: {
    workspaceFolders: null,
    getConfiguration: () => ({
      get: (k, d) => {
        if (k === 'bridge.allowedCommands') return storedAllowed;
        if (k === 'bridge.silentAllowed') return false;
        return d;
      },
      update: async (k, v) => { if (k === 'bridge.allowedCommands') storedAllowed = v; }
    }),
    textDocuments: [], fs: {}
  },
  window: {
    activeTextEditor: null, activeTerminal: null, tabGroups: { all: [] },
    showWarningMessage: async () => '允许一次',
    showInformationMessage: async () => {}
  },
  languages: { getDiagnostics: () => [] },
  commands: { executeCommand: async (cmd, ...args) => ({ cmd, args }) },
  env: { clipboard: { readText: async () => '', writeText: async () => {} } },
  Uri: { file: (p) => ({ fsPath: p, toString: () => 'file://' + p }), joinPath: () => ({}) },
  Position: class {}, Range: class {}, Selection: class {}, ThemeIcon: class {},
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  FileType: { File: 1, Directory: 2 }, InlineCompletionItem: class {},
  ConfigurationTarget: { Global: 1 }, TextEditorRevealType: { InCenter: 2 },
  extensions: {
    all: [{
      id: 'fox-ai',
      isBuiltin: false,
      isActive: true,
      packageJSON: { contributes: { commands: [{ command: 'foxAi.optimizeMemory', title: '内存优化' }] } }
    }, {
      id: 'some.other',
      isBuiltin: false,
      isActive: true,
      packageJSON: { contributes: { commands: [{ command: 'some.other.cmd', title: '其它命令' }] } }
    }]
  }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const tools = require('../src/tools');
const { buildSystemPrompt } = require('../src/agent');
const harness = require('../src/harness');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); }
}

function assertContains(hay, needle) {
  if (!hay.includes(needle)) throw new Error('expected to include: ' + needle + '\ngot: ' + hay.slice(0, 200));
}

(async () => {
  check('call_extension_command 在 allTools 中', () => {
    const names = tools.allTools().map((t) => t.name);
    assert.ok(names.includes('call_extension_command'), names.join(', '));
  });

  check('call_extension_command 参数包含 command 与 args', () => {
    const t = tools.getTool('call_extension_command');
    assert.ok(t);
    const props = t.parameters.properties;
    assert.ok(props.command);
    assert.ok(props.args);
  });

  check('系统提示词（text 协议）注入已授权扩展命令', () => {
    const sys = buildSystemPrompt({
      systemPrompt: '', structuredOutput: false, planAndExecute: { enabled: false }
    }, '工作区：test', 'text');
    assertContains(sys, 'call_extension_command');
    assertContains(sys, 'foxAi.optimizeMemory');
    assertContains(sys, '内存优化');
  });

  check('系统提示词（native 协议）同样注入', () => {
    const sys = buildSystemPrompt({
      systemPrompt: '', structuredOutput: false, planAndExecute: { enabled: false }
    }, '工作区：test', 'native');
    assertContains(sys, '已授权的扩展命令');
    assertContains(sys, 'foxAi.optimizeMemory');
  });

  check('call_extension_command 被政策引擎识别为 CALL_EXT', () => {
    const pe = new harness.PolicyEngine({ autoApprove: 'read', policy: { allowedCommands: ['foxAi.optimizeMemory'] } });
    const v = pe.evaluate(harness.OP.CALL_EXT, { command: 'foxAi.optimizeMemory' });
    assert.equal(v.decision, 'auto');
  });

  check('未在白名单的扩展命令走 ask 而不是 deny', () => {
    const pe = new harness.PolicyEngine({ autoApprove: 'read', policy: { allowedCommands: [] } });
    const v = pe.evaluate(harness.OP.CALL_EXT, { command: 'some.other.cmd' });
    assert.equal(v.decision, 'ask');
  });

  check('execute 对 undefined 返回值不抛 length 错误', async () => {
    // 模拟一个返回 undefined 的本地工具
    const t = tools.getTool('call_extension_command');
    const origRun = t.run;
    t.run = async () => undefined;
    try {
      const out = await tools.execute('call_extension_command', { command: 'foxAi.optimizeMemory' }, { context: { logUri: { fsPath: require('os').tmpdir() } } });
      assert.ok(typeof out === 'string', '返回应为字符串，实际：' + typeof out);
      assert.ok(out.includes('已执行完成'), out);
    } finally {
      t.run = origRun;
    }
  });

  check('execute 对普通对象返回值正常 JSON 化', async () => {
    const t = tools.getTool('call_extension_command');
    const origRun = t.run;
    t.run = async () => ({ freedBytes: 123 });
    try {
      const out = await tools.execute('call_extension_command', { command: 'foxAi.optimizeMemory' }, { context: { logUri: { fsPath: require('os').tmpdir() } } });
      assert.ok(out.includes('freedBytes'), out);
    } finally {
      t.run = origRun;
    }
  });

  console.log(`\n插件联动测试：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
