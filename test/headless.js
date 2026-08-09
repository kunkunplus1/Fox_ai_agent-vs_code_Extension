'use strict';

/**
 * src/headless.js 纯 Node 单测（零网络、零 vscode）。
 * 通过覆盖 client/anthropic 的导出函数属性来打桩，验证解析、后端选择、运行、
 * 流式与多轮逻辑。所有异步段落集中在 main() 内顺序 await，确保 summary 计数准确。
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const headless = require('../src/headless');
const client = require('../src/client');
const anthropic = require('../src/anthropic');

let passed = 0;
const ok = (name) => { passed++; console.log('  ✓ ' + name); };

// 保存原始后端，测试后恢复
const orig = {
  chatNonStream: client.chatNonStream,
  chatNonStreamResponses: client.chatNonStreamResponses,
  antChat: anthropic.chatNonStream,
  streamChat: client.streamChat,
  streamResponses: client.streamResponses,
  antStream: anthropic.streamChat
};
function stubChat(fn) { client.chatNonStream = fn; }
function stubResponses(fn) { client.chatNonStreamResponses = fn; }
function stubAnt(fn) { anthropic.chatNonStream = fn; }
function restore() {
  client.chatNonStream = orig.chatNonStream;
  client.chatNonStreamResponses = orig.chatNonStreamResponses;
  anthropic.chatNonStream = orig.antChat;
  client.streamChat = orig.streamChat;
  client.streamResponses = orig.streamResponses;
  anthropic.streamChat = orig.antStream;
}

// ── resolveConfig（同步）──
(function () {
  const c = headless.resolveConfig({});
  assert.strictEqual(c.provider, 'llamacpp');
  assert.strictEqual(c.transport, 'openai');
  assert.strictEqual(c.apiMode, 'chat');
  assert.strictEqual(c.apiKey, '');
  assert.strictEqual(typeof c.temperature, 'number');
  ok('resolveConfig 默认回落 llamacpp');

  const c2 = headless.resolveConfig({ provider: 'deepseek' });
  assert.strictEqual(c2.provider, 'deepseek');
  assert.strictEqual(c2.baseUrl, 'https://api.deepseek.com/v1');
  assert.strictEqual(c2.model, 'deepseek-chat');
  assert.strictEqual(c2.apiKey, '');
  ok('resolveConfig 预设 deepseek 带 baseUrl/model');

  const c3 = headless.resolveConfig({ provider: 'claude' });
  assert.strictEqual(c3.transport, 'anthropic');
  assert.strictEqual(c3.apiMode, 'chat');
  ok('resolveConfig claude 走 anthropic 传输');

  const prev = process.env.FOXAI_BASE_URL;
  process.env.FOXAI_BASE_URL = 'http://example.test/v1';
  process.env.FOXAI_MODEL = 'test-model';
  const c4 = headless.resolveConfig({ provider: 'custom' });
  assert.strictEqual(c4.baseUrl, 'http://example.test/v1');
  assert.strictEqual(c4.model, 'test-model');
  if (prev === undefined) delete process.env.FOXAI_BASE_URL; else process.env.FOXAI_BASE_URL = prev;
  delete process.env.FOXAI_MODEL;
  ok('resolveConfig 环境变量覆盖');

  process.env.FOXAI_BASE_URL = 'http://env.test';
  const c5 = headless.resolveConfig({ provider: 'custom', baseUrl: 'http://explicit.test' });
  assert.strictEqual(c5.baseUrl, 'http://explicit.test');
  delete process.env.FOXAI_BASE_URL;
  ok('resolveConfig 显式参数优先于 env');

  const c6 = headless.resolveConfig({ provider: 'custom', temperature: '0.9', maxTokens: '2048', timeout: '5000' });
  assert.strictEqual(c6.temperature, 0.9);
  assert.strictEqual(c6.maxTokens, 2048);
  assert.strictEqual(c6.timeout, 5000);
  ok('resolveConfig 数字解析');
})();

// ── pickNonStream / pickStream 后端选择（同步）──
(function () {
  assert.strictEqual(headless.pickNonStream({ transport: 'openai', apiMode: 'chat' }), client.chatNonStream);
  assert.strictEqual(headless.pickNonStream({ transport: 'openai', apiMode: 'responses' }), client.chatNonStreamResponses);
  assert.strictEqual(headless.pickNonStream({ transport: 'anthropic', apiMode: 'chat' }), anthropic.chatNonStream);
  ok('pickNonStream 与 selectBackend 一致');

  assert.strictEqual(headless.pickStream({ transport: 'openai', apiMode: 'chat' }), client.streamChat);
  assert.strictEqual(headless.pickStream({ transport: 'openai', apiMode: 'responses' }), client.streamResponses);
  assert.strictEqual(headless.pickStream({ transport: 'anthropic', apiMode: 'chat' }), anthropic.streamChat);
  ok('pickStream 与 selectBackend 流式对称');
})();

// ── runHeadless 基本运行（异步）──
async function sectionBasic() {
  let captured = null;
  stubChat(async (o) => { captured = o; return { content: 'hello from model', reasoning: 'think', finishReason: 'stop' }; });
  const r = await headless.runHeadless({ prompt: 'hi', system: 'be brief', config: { provider: 'custom', baseUrl: 'http://x' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'hello from model');
  assert.strictEqual(r.reasoning, 'think');
  assert.strictEqual(captured.messages.length, 2);
  assert.strictEqual(captured.messages[0].role, 'system');
  assert.strictEqual(captured.messages[1].role, 'user');
  ok('runHeadless 单次调用：拼接 messages 成功');

  stubChat(async (o) => ({ content: 'x' }));
  const r2 = await headless.runHeadless({ prompt: 'yo', config: { provider: 'custom', baseUrl: 'http://x' } });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.meta.transport, 'openai');
  ok('runHeadless 无 system 仅 user');

  const r3 = await headless.runHeadless({ prompt: '   ' });
  assert.strictEqual(r3.ok, false);
  assert.ok(/prompt/.test(r3.error));
  ok('runHeadless 空 prompt 报错');

  const r4 = await headless.runHeadless({ prompt: 'hi', config: { provider: 'custom', baseUrl: '' } });
  assert.strictEqual(r4.ok, false);
  assert.ok(/baseUrl/.test(r4.error));
  ok('runHeadless 缺 baseUrl 报错');

  stubChat(async () => { throw new Error('network down'); });
  const r5 = await headless.runHeadless({ prompt: 'hi', config: { provider: 'custom', baseUrl: 'http://x' } });
  assert.strictEqual(r5.ok, false);
  assert.ok(/network down/.test(r5.error));
  ok('runHeadless 后端异常被捕获');

  let antCalled = false;
  stubAnt(async (o) => { antCalled = true; return { content: 'ant result' }; });
  const r6 = await headless.runHeadless({ prompt: 'hi', config: { provider: 'claude', baseUrl: 'http://x', apiKey: 'k' } });
  assert.strictEqual(r6.ok, true);
  assert.strictEqual(r6.text, 'ant result');
  assert.strictEqual(antCalled, true);
  ok('runHeadless anthropic 传输路径');

  let respCalled = false;
  stubResponses(async (o) => { respCalled = true; return { content: 'resp result' }; });
  const r7 = await headless.runHeadless({ prompt: 'hi', config: { provider: 'custom', baseUrl: 'http://x', apiMode: 'responses' } });
  assert.strictEqual(r7.ok, true);
  assert.strictEqual(r7.text, 'resp result');
  assert.strictEqual(respCalled, true);
  ok('runHeadless responses 模式路径');
  restore();
}

// ── cli 解析与输出（异步）──
async function sectionCliBasic() {
  function makeBuf() { const a = []; return { write: (s) => a.push(s), str: () => a.join('') }; }

  stubChat(async () => ({ content: 'x' }));
  const out1 = makeBuf(); const err1 = makeBuf();
  const code1 = await headless.cli(['--help'], out1, err1);
  assert.strictEqual(code1, 0);
  assert.ok(/Headless/.test(out1.str()));
  ok('cli --help 输出帮助');

  stubChat(async () => ({ content: 'json-out' }));
  const out2 = makeBuf(); const err2 = makeBuf();
  const code2 = await headless.cli(['-p', 'hi', '--json', '--base-url', 'http://x', '-P', 'custom'], out2, err2);
  assert.strictEqual(code2, 0);
  const j = JSON.parse(out2.str());
  assert.strictEqual(j.ok, true);
  assert.strictEqual(j.text, 'json-out');
  ok('cli -p + --json 输出 JSON');

  stubChat(async () => ({ content: 'x' }));
  const out3 = makeBuf(); const err3 = makeBuf();
  const code3 = await headless.cli(['-p', '   '], out3, err3);
  assert.strictEqual(code3, 1);
  assert.ok(/prompt/.test(err3.str()) || /prompt/.test(out3.str()));
  ok('cli 空 prompt 退出码 1');
  restore();
}

// ── runHeadless 流式 + cli 流式与多轮（异步）──
async function sectionStreamAndMulti() {
  function fakeStream(makeResult) {
    return function (o) {
      setImmediate(() => {
        if (o.onStart) o.onStart();
        if (o.onDelta) o.onDelta('Hello ');
        if (o.onDelta) o.onDelta('world');
        if (o.onReasoning) o.onReasoning('thinking...');
        if (o.onDone) o.onDone(makeResult());
      });
      return { on: () => {}, destroy: () => {} };
    };
  }
  const realStreamChat = client.streamChat;
  const realResp = client.streamResponses;
  const realAnt = anthropic.streamChat;

  client.streamChat = fakeStream(() => ({ content: 'Hello world', reasoning: 'thinking...', finishReason: 'stop' }));
  const chunks = [];
  const r = await headless.runHeadless({
    prompt: 'hi', config: { provider: 'custom', baseUrl: 'http://x' }, stream: true,
    onChunk: (text, info) => chunks.push({ text, type: info.type })
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'Hello world');
  assert.strictEqual(r.reasoning, 'thinking...');
  const textChunks = chunks.filter((c) => c.type === 'text').map((c) => c.text).join('');
  assert.strictEqual(textChunks, 'Hello world');
  assert.ok(chunks.some((c) => c.type === 'reasoning' && c.text === 'thinking...'));
  ok('runHeadless 流式：onChunk 收到 text+reasoning，结果聚合正确');

  client.streamResponses = fakeStream(() => ({ content: 'resp-stream', reasoning: '', finishReason: 'stop' }));
  const r2 = await headless.runHeadless({
    prompt: 'hi', config: { provider: 'custom', baseUrl: 'http://x', apiMode: 'responses' }, stream: true,
    onChunk: () => {}
  });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.text, 'resp-stream');
  ok('runHeadless 流式 responses 模式');

  anthropic.streamChat = fakeStream(() => ({ content: 'ant-stream', reasoning: 'r', finishReason: 'stop' }));
  const r3 = await headless.runHeadless({
    prompt: 'hi', config: { provider: 'claude', baseUrl: 'http://x', apiKey: 'k' }, stream: true,
    onChunk: () => {}
  });
  assert.strictEqual(r3.ok, true);
  assert.strictEqual(r3.text, 'ant-stream');
  ok('runHeadless 流式 anthropic 模式');

  // 流式但无 onChunk → 退回非流式（走 chatNonStream）
  stubChat(async () => ({ content: 'nonstream-fallback' }));
  const r4 = await headless.runHeadless({ prompt: 'hi', config: { provider: 'custom', baseUrl: 'http://x' }, stream: true });
  assert.strictEqual(r4.ok, true);
  assert.strictEqual(r4.text, 'nonstream-fallback');
  ok('runHeadless stream 无 onChunk 退回非流式');

  client.streamChat = realStreamChat;
  client.streamResponses = realResp;
  anthropic.streamChat = realAnt;

  // ── cli 流式与多轮 ──
  function makeBuf() { const a = []; return { write: (s) => a.push(s), str: () => a.join('') }; }
  function tmp(name) { return path.join(os.tmpdir(), 'foxai-test-' + Date.now() + '-' + Math.random().toString(36).slice(2) + name); }

  client.streamChat = function (o) {
    setImmediate(() => { o.onDelta('A'); o.onDelta('B'); o.onDone({ content: 'AB', reasoning: '', finishReason: 'stop' }); });
    return { on: () => {}, destroy: () => {} };
  };
  const so = makeBuf(); const se = makeBuf();
  const codeS = await headless.cli(['-p', 'hi', '-S', '--base-url', 'http://x', '-P', 'custom'], so, se);
  assert.strictEqual(codeS, 0);
  assert.strictEqual(so.str(), 'AB');
  ok('cli -S 流式逐块输出 stdout');

  stubChat(async (o) => {
    const lastUser = [...o.messages].reverse().find((m) => m.role === 'user');
    const c = lastUser ? lastUser.content : '';
    return { content: /q2/.test(c) ? 'ans2' : 'ans1', reasoning: '', finishReason: 'stop' };
  });
  const turnsFile = tmp('.json');
  fs.writeFileSync(turnsFile, JSON.stringify(['q1', 'q2']));
  const to = makeBuf(); const te = makeBuf();
  const codeT = await headless.cli(['--turns', turnsFile, '--json', '--base-url', 'http://x', '-P', 'custom'], to, te);
  assert.strictEqual(codeT, 0);
  const tj = JSON.parse(to.str());
  assert.strictEqual(tj.ok, true);
  assert.strictEqual(tj.messages.length, 4);
  assert.strictEqual(tj.messages[0].content, 'q1');
  assert.strictEqual(tj.messages[1].content, 'ans1');
  assert.strictEqual(tj.last.text, 'ans2');
  fs.unlinkSync(turnsFile);
  ok('cli --turns 批量多轮（JSON 数组）');

  const sessionFile = tmp('.json');
  const so1 = makeBuf(); const se1 = makeBuf();
  const code1 = await headless.cli(['-p', 'q1', '--session', sessionFile, '--json', '--base-url', 'http://x', '-P', 'custom'], so1, se1);
  assert.strictEqual(code1, 0);
  assert.strictEqual(JSON.parse(so1.str()).messages.length, 2);
  const so2 = makeBuf(); const se2 = makeBuf();
  const code2 = await headless.cli(['-p', 'q2', '--session', sessionFile, '--json', '--base-url', 'http://x', '-P', 'custom'], so2, se2);
  assert.strictEqual(code2, 0);
  const sj = JSON.parse(so2.str());
  assert.strictEqual(sj.messages.length, 4);
  assert.strictEqual(sj.messages[2].content, 'q2');
  fs.unlinkSync(sessionFile);
  ok('cli --session 跨调用持久化多轮');

  const turnsFile2 = tmp('.json');
  fs.writeFileSync(turnsFile2, JSON.stringify({ messages: [{ role: 'system', content: 'sys' }], turns: ['q1'] }));
  const to2 = makeBuf(); const te2 = makeBuf();
  const codeT2 = await headless.cli(['--turns', turnsFile2, '--json', '--base-url', 'http://x', '-P', 'custom'], to2, te2);
  assert.strictEqual(codeT2, 0);
  const tj2 = JSON.parse(to2.str());
  assert.strictEqual(tj2.messages[0].role, 'system');
  assert.strictEqual(tj2.messages.length, 3);
  fs.unlinkSync(turnsFile2);
  ok('cli --turns {messages,turns} 形态');

  restore();
}

(async () => {
  try {
    await sectionBasic();
    await sectionCliBasic();
    await sectionStreamAndMulti();
    console.log('\n✅ headless 单测全部通过：共 ' + passed + ' 项');
  } catch (e) {
    console.error('\n❌ headless 单测失败：', e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
