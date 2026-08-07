'use strict';
// 测试 review_changes 工具：
// - buildDeepThinkSystem / focusLabel 纯函数（各焦点角色与规则）
// - run 在非 git 目录优雅降级为友好提示（无需真实 git/模型）
// 通过拦截 require('vscode') 在纯 Node 环境运行。

const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'vscode') {
    return {
      workspace: {
        workspaceFolders: null,
        getConfiguration: () => ({ get: () => '' })
      },
      window: { showTextDocument: async () => ({}) }
    };
  }
  return origLoad.apply(this, arguments);
};

const rc = require('../src/tools/reviewChanges');

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

async function run() {
  console.log('测试1：buildDeepThinkSystem 纯函数');
  const f = rc.buildDeepThinkSystem('feasibility');
  ok('可行性焦点含「可行性结论」', f.includes('可行性结论'));
  ok('可行性焦点含「回归与破坏性评估」', f.includes('回归'));
  const s = rc.buildDeepThinkSystem('security');
  ok('安全焦点含「安全专家」角色', s.includes('安全专家'));
  ok('安全焦点含注入/越权排查', s.includes('注入') && s.includes('越权'));
  const p = rc.buildDeepThinkSystem('performance');
  ok('性能焦点含复杂度评估', p.includes('复杂度'));
  const b = rc.buildDeepThinkSystem('bugs');
  ok('缺陷焦点含空指针/竞态排查', b.includes('空指针') || b.includes('竞态'));

  console.log('测试2：focusLabel 映射');
  ok('feasibility → 改动可行性与风险', rc.focusLabel('feasibility') === '改动可行性与风险');
  ok('未知焦点 → 改动分析', rc.focusLabel('xyz') === '改动分析');

  console.log('测试3：run 在非 git 目录优雅降级');
  const out = await rc.run({}, {});
  ok('非 git 目录返回警告提示', typeof out === 'string' && out.includes('⚠️') && out.includes('git'));

  console.log('测试4：getGitRoot 在非 git 目录返回 null');
  const root = rc.getGitRoot(require('os').tmpdir());
  ok('非 git 目录 getGitRoot 为 null', root === null);

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  if (fail) process.exit(1);
}

run().catch((e) => { console.error('测试异常：', e); process.exit(1); });
