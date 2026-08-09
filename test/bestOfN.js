'use strict';

// Best-of-N 单测：纯 Node、零 vscode 依赖，注入桩 callModel / llm，覆盖并发/缓存/评委/异常。
const assert = require('assert');
const bestOfN = require('../src/bestOfN');

let pass = 0;
let fail = 0;
function ok(name, cond) {
  try {
    assert.ok(cond, name);
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.error('  ✗ ' + name + ' -> ' + e.message);
  }
}

// 构造一个可记录调用次数的桩 callModel
function makeCallModel(responders, { delay = 0, tracker = null } = {}) {
  let calls = 0;
  const fn = async (c, req) => {
    const idx = c.__idx;
    calls++;
    if (tracker) tracker();
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const resp = responders[idx];
    if (resp && resp.error) return { ok: false, error: resp.error };
    return { ok: true, text: resp ? resp.text : ('resp-' + idx) };
  };
  fn.calls = () => calls;
  return fn;
}

// 给候选打 __idx 标记，使桩能按序取到对应 responder（与并发无关，仅索引映射）
function W(arr) { return arr.map((c, i) => Object.assign({ __idx: i }, c)); }

async function main() {
  console.log('Best-of-N: prompt 校验');
  let r = await bestOfN.runBestOfN({ prompt: '', candidates: [{ model: 'm' }], callModel: async () => ({ ok: true, text: 'x' }) });
  ok('空 prompt 返回 ok:false', r.ok === false && /prompt/.test(r.error || ''));

  r = await bestOfN.runBestOfN({ prompt: 'hi', candidates: [], callModel: async () => ({ ok: true, text: 'x' }) });
  ok('无候选返回 ok:false', r.ok === false && /候选/.test(r.error || ''));

  r = await bestOfN.runBestOfN({ prompt: 'hi', candidates: [{ model: 'm' }] });
  ok('无 callModel 返回 ok:false', r.ok === false && /callModel/.test(r.error || ''));

  console.log('Best-of-N: length 评委');
  const cm1 = makeCallModel([{ text: '短' }, { text: '长长长长长长长' }]);
  r = await bestOfN.runBestOfN({ prompt: 'q-len', candidates: W([{ model: 'a' }, { model: 'b' }]), callModel: cm1 });
  ok('length 评委挑更长的候选', r.ok && r.best && r.best.index === 1);
  ok('结果含全部候选与 scores', r.results.length === 2 && r.scores.length === 2);

  console.log('Best-of-N: first 评委');
  const cm2 = makeCallModel([{ text: 'A 回答' }, { text: 'B 更长回答' }]);
  r = await bestOfN.runBestOfN({ prompt: 'q-first', candidates: W([{ model: 'a' }, { model: 'b' }]), callModel: cm2, judge: 'first' });
  ok('first 评委挑第一个有效候选', r.best && r.best.index === 0);

  console.log('Best-of-N: 错误候选被排除');
  const cm3 = makeCallModel([{ error: 'boom' }, { text: 'OK' }]);
  r = await bestOfN.runBestOfN({ prompt: 'q-err', candidates: W([{ model: 'a' }, { model: 'b' }]), callModel: cm3 });
  ok('错误候选不参与挑选', r.best && r.best.index === 1 && r.results[0].error === 'boom');

  const cmAllErr = makeCallModel([{ error: 'e1' }, { error: 'e2' }]);
  r = await bestOfN.runBestOfN({ prompt: 'q-allerr', candidates: W([{ model: 'a' }, { model: 'b' }]), callModel: cmAllErr });
  ok('全部失败 best 为 null', r.ok && r.best === null);

  console.log('Best-of-N: llm 评委');
  const cm4 = makeCallModel([{ text: 'A' }, { text: 'B' }]);
  // llm 桩返回 JSON 选 index 1
  const llmJson = async () => '{"best":1,"reason":"B 更好"}';
  r = await bestOfN.runBestOfN({ prompt: 'q-llmjson', candidates: W([{ model: 'a' }, { model: 'b' }]), callModel: cm4, judge: 'llm', llm: llmJson });
  ok('llm(JSON) 评委按返回选 index', r.best && r.best.index === 1);

  // llm 桩返回纯文本带噪声，退路正则
  const llmNoise = async () => '我觉得 best: 0 这个最合适，因为…';
  r = await bestOfN.runBestOfN({ prompt: 'q-llmnoise', candidates: W([{ model: 'a' }, { model: 'b' }]), callModel: cm4, judge: 'llm', llm: llmNoise });
  ok('llm(噪声文本) 正则退路命中', r.best && r.best.index === 0);

  // llm 抛异常 → 退到 score 挑选
  const llmThrow = async () => { throw new Error('llm down'); };
  r = await bestOfN.runBestOfN({ prompt: 'q-llmthrow', candidates: W([{ model: 'a' }, { model: 'b' }]), callModel: makeCallModel([{ text: 'x' }, { text: 'yyyy' }]), judge: 'llm', llm: llmThrow });
  ok('llm 异常退到 score 挑选', r.best && r.best.index === 1);

  console.log('Best-of-N: 缓存');
  const cm5 = makeCallModel([{ text: 'aaa' }, { text: 'bb' }]);
  const p = '缓存测试 prompt';
  const cands = W([{ model: 'a' }, { model: 'b' }]);
  r = await bestOfN.runBestOfN({ prompt: p, candidates: cands, callModel: cm5 });
  ok('首次调用 callModel 被调用 2 次', cm5.calls() === 2);
  const r2 = await bestOfN.runBestOfN({ prompt: p, candidates: cands, callModel: cm5 });
  ok('二次调用命中缓存(fromCache)', r2.fromCache === true && cm5.calls() === 2);
  ok('缓存内容与首次一致', r2.best && r.best && r2.best.index === r.best.index);

  bestOfN.invalidate();
  const r3 = await bestOfN.runBestOfN({ prompt: p, candidates: cands, callModel: cm5 });
  ok('invalidate 后缓存清空、重新调用', r3.fromCache !== true && cm5.calls() === 4);

  console.log('Best-of-N: 指纹稳定性');
  ok('promptHash 稳定', bestOfN.promptHash('x', 's') === bestOfN.promptHash('x', 's'));
  ok('promptHash 异参不同', bestOfN.promptHash('x', 's') !== bestOfN.promptHash('x', 't'));
  ok('candidatesHash 同配置稳定', bestOfN.candidatesHash([{ model: 'a' }, { model: 'b' }]) === bestOfN.candidatesHash([{ model: 'a' }, { model: 'b' }]));
  ok('candidatesHash 异模型不同', bestOfN.candidatesHash([{ model: 'a' }]) !== bestOfN.candidatesHash([{ model: 'b' }]));

  console.log('Best-of-N: 打分');
  ok('scoreText 空为 0', bestOfN.scoreText('') === 0);
  ok('scoreText 空白为 0', bestOfN.scoreText('   \n\t ') === 0);
  ok('scoreText 计非空白', bestOfN.scoreText('ab cd') === 4);

  console.log('Best-of-N: 有界并发');
  let maxInFlight = 0;
  let inFlight = 0;
  const tracker = () => { inFlight++; if (inFlight > maxInFlight) maxInFlight = inFlight; };
  const release = () => { inFlight--; };
  const cm6 = async (c, req) => { tracker(); await new Promise((r) => setTimeout(r, 20)); release(); return { ok: true, text: 'r' + c.__idx }; };
  // 给每个候选打标 __idx
  const many = Array.from({ length: 8 }, (_, i) => ({ model: 'm' + i, __idx: i }));
  await bestOfN.runBestOfN({ prompt: 'q-conc', candidates: many, callModel: cm6, judge: 'length' });
  ok('并发不超过 MAX_CONCURRENT(' + bestOfN.MAX_CONCURRENT + ')', maxInFlight <= bestOfN.MAX_CONCURRENT);
  ok('并发确实被分桶(8 个 > MAX)', maxInFlight < 8);

  console.log('\nBest-of-N 测试: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
