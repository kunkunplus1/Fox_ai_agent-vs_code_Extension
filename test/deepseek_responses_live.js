'use strict';
// 实测 DeepSeek Responses API（使用狐狸 AI 自带 client 实现）
const client = require('../src/client');

const KEY = process.env.DEEPSEEK_KEY;
const BASE = 'https://api.deepseek.com';
const MODEL = 'deepseek-v4-flash';

if (!KEY) {
  console.log('跳过：未设置 DEEPSEEK_KEY 环境变量（这是一次性的实测脚本，不内置密钥）。');
  console.log('用法：DEEPSEEK_KEY=sk-xxx node test/deepseek_responses_live.js');
  process.exit(0);
}

function streamP(options) {
  return new Promise((resolve, reject) => {
    let r = { content: '', reasoning: '', toolCalls: [] };
    client.streamResponses(Object.assign({}, options, {
      onDelta: (t) => { r.content += t; },
      onReasoning: (t) => { r.reasoning += t; },
      onToolCallStart: (n) => { r.toolCalls.push({ name: n, arguments: '' }); },
      onDone: (res) => resolve(res),
      onError: (e) => reject(e)
    }));
  });
}

async function main() {
  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
    else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
  };

  console.log('\n=== 1) 非流式连接测试（无工具）===');
  try {
    const r1 = await client.chatNonStreamResponses({
      baseUrl: BASE, apiKey: KEY, model: MODEL,
      messages: [
        { role: 'system', content: 'You are a concise assistant.' },
        { role: 'user', content: '用一句话回复：你好，今天几号？' }
      ],
      temperature: 0
    });
    console.log('    回复:', (r1.content || '').slice(0, 120));
    check('连接成功且返回文本', !!r1.content && r1.content.length > 0, 'len=' + r1.content.length);
    check('无工具调用', r1.toolCalls.length === 0);
  } catch (e) {
    fail++; console.log('  ✗ 连接失败:', e.message);
  }

  console.log('\n=== 2) 工具调用测试（get_weather 函数）===');
  const tools = [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: '获取指定城市的天气',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: '城市名' } },
        required: ['city']
      }
    }
  }];
  try {
    const r2 = await client.chatNonStreamResponses({
      baseUrl: BASE, apiKey: KEY, model: MODEL,
      messages: [
        { role: 'system', content: 'You are a concise assistant that uses tools.' },
        { role: 'user', content: '帮我查一下北京的天气' }
      ],
      tools, toolChoice: 'auto', temperature: 0
    });
    console.log('    toolCalls:', JSON.stringify(r2.toolCalls, null, 2));
    check('模型返回了工具调用', r2.toolCalls.length > 0, 'count=' + r2.toolCalls.length);
    if (r2.toolCalls.length) {
      const tc = r2.toolCalls[0];
      check('工具名为 get_weather', tc.name === 'get_weather', 'name=' + tc.name);
      try {
        const args = JSON.parse(tc.arguments || '{}');
        check('参数为合法 JSON 且含 city', !!args.city, 'city=' + args.city);
      } catch (e) { fail++; console.log('  ✗ 参数非 JSON:', tc.arguments); }
    }
  } catch (e) {
    fail++; console.log('  ✗ 工具调用测试失败:', e.message);
  }

  console.log('\n=== 3) 工具结果回填后再问（多轮函数调用闭环）===');
  try {
    const r3 = await client.chatNonStreamResponses({
      baseUrl: BASE, apiKey: KEY, model: MODEL,
      messages: [
        { role: 'system', content: 'You are a concise assistant that uses tools.' },
        { role: 'user', content: '帮我查一下北京的天气' },
        { role: 'assistant', content: null, reasoning: '用户想查天气，需要先调用天气工具获取北京的数据。', tool_calls: [
          { id: 'call_w1', type: 'function', function: { name: 'get_weather', arguments: JSON.stringify({ city: '北京' }) } }
        ] },
        { role: 'tool', tool_call_id: 'call_w1', content: '北京：晴，26℃，微风' }
      ],
      tools, toolChoice: 'auto', temperature: 0
    });
    console.log('    最终回复:', (r3.content || '').slice(0, 160));
    check('回填工具结果后能继续回答', !!r3.content && r3.content.length > 0, 'len=' + r3.content.length);
  } catch (e) {
    fail++; console.log('  ✗ 回填测试失败:', e.message);
  }

  console.log('\n=== 4) 流式文本测试 ===');
  try {
    const r4 = await streamP({
      baseUrl: BASE, apiKey: KEY, model: MODEL,
      messages: [{ role: 'user', content: '数到三，用逗号分隔' }],
      temperature: 0
    });
    check('流式返回文本', !!r4.content && r4.content.length > 0, 'content=' + JSON.stringify(r4.content));
  } catch (e) {
    fail++; console.log('  ✗ 流式测试失败:', e.message);
  }

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
