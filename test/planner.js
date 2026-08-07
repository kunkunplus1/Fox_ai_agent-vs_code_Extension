'use strict';
// 架构·规划-执行分离 单元测试（纯逻辑，无 vscode 依赖）
const assert = require('assert');
const { parsePlan, generatePlan, normalizeStep } = require('../src/planner');

// 注入的假 callModel：把传入的 system 透传逻辑，这里直接返回固定 JSON 计划
async function fakeCallModel(messages, opts) {
  return JSON.stringify([
    { id: 's1', title: '读取配置', dependsOn: [], parallel: false },
    { id: 's2', title: '写单元测试', dependsOn: ['s1'], parallel: true },
    { id: 's3', title: '跑构建', dependsOn: ['s2'], parallel: false }
  ]);
}

let pass = 0;
function ok(name, cond) {
  assert.ok(cond, 'FAIL: ' + name);
  pass += 1;
  console.log('  ✓ ' + name);
}

// ---- parsePlan：JSON 数组 ----
const j = parsePlan('```json\n[{"id":"s1","title":"A"},{"title":"B","dependsOn":["s1"],"parallel":true}]\n```');
ok('JSON 解析出 2 步', j.length === 2);
ok('步骤含 id', j[0].id === 's1');
ok('步骤含依赖', j[1].dependsOn[0] === 's1');
ok('步骤含并行标记', j[1].parallel === true);
ok('缺 title 的步骤被过滤', parsePlan('[{"id":"x"}]').length === 0);

// ---- parsePlan：裸 JSON（带无关文本包裹） ----
const wrap = parsePlan('好的，计划如下：\n{"steps":[{"id":"a","title":"第一步"},{"id":"b","title":"第二步","dependsOn":["a"]}]}\n完毕');
ok('裸 JSON 容错解析', wrap.length === 2);

// ---- parsePlan：编号列表 ----
const list = parsePlan('1. 安装依赖\n2. 写代码（依赖：1）\n3. 测试（并行）');
ok('编号列表解析 3 步', list.length === 3);
ok('列表依赖解析', list[1].dependsOn[0] === '1');
ok('列表并行标记', list[2].parallel === true);

// ---- normalizeStep 兜底 ----
ok('normalizeStep 非对象返回 null', normalizeStep(null, 0) === null);

// ---- generatePlan：调用注入的 callModel ----
(async () => {
  const steps = await generatePlan(
    [{ role: 'user', content: '帮我加个登录功能' }],
    { planner: { maxTokens: 700 } },
    fakeCallModel
  );
  ok('generatePlan 返回 3 步', steps.length === 3);
  ok('generatePlan 步骤标题正确', steps[0].title === '读取配置');

  // callModel 抛错时 generatePlan 应抛错（由调用方 try 兜底）
  let threw = false;
  try {
    await generatePlan([{ role: 'user', content: 'x' }], {}, async () => { throw new Error('net'); });
  } catch (e) { threw = e.message === 'net'; }
  ok('generatePlan 透传 callModel 异常', threw);

  console.log('\n[planner] 通过 ' + pass + ' 项断言');
})().catch((e) => { console.error(e); process.exit(1); });
