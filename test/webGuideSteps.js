'use strict';
// 探针：验证三步引导各步 payload（对齐 agent.js 三步分离逻辑）
// 期望：① 引导（独立user）② 工具结果（独立user）③ 真实问题+动态上下文（独立user）
// 关键：每步 messages 都只有一条 user，不带 system/历史 → parseTextRequest 无上下文 → 网页独立成条

const DYN_MARK = '狐狸AI·动态上下文';
function fp(s) { return require('crypto').createHash('sha1').update(String(s || ''), 'utf8').digest('hex').slice(0, 16); }

// 模拟状态
const preparedHistory = [{ role: 'user', content: '帮我创建文件，第4行写你好' }];
const varAppendix = '【深度思考】\n强度high\n【当前环境】\nwin32';

// —— 复制三步逻辑 ——
const steps = [];
const b = { nonStream: async (o) => { steps.push(o.messages); return { content: 'ok', reasoning: '', toolCalls: [], finishReason: 'stop', empty: false }; } };
const mkOpts = (messages) => ({ baseUrl: 'x', apiKey: 'x', model: 'm', messages, temperature: 1 });
const llmLimiter = { run: (f) => f() };

let webGuideResult = null;
const isWebTextSess = true;
const resumedSession = false, toolGuideFetched = false, prependedGuide = false;

(async () => {
  if (isWebTextSess && !resumedSession && !toolGuideFetched && !prependedGuide) {
    // ① 引导轮
    const guideBody = { role: 'user', content: '[系统] 本任务的第一步必须先调用 get_tools 获取可用工具清单...' };
    await llmLimiter.run(() => b.nonStream(mkOpts([guideBody])));
    // 模拟模型输出 get_tools 调用 → 执行 → toolFeed
    const toolFeed = '[工具 get_tools 的结果]\n共45个工具...';
    // ② 工具结果轮
    if (toolFeed) await llmLimiter.run(() => b.nonStream(mkOpts([{ role: 'user', content: toolFeed }])));
    // ③ 真实问题轮
    const lastU = preparedHistory.slice().reverse().find((m) => m && m.role === 'user');
    const userContent = typeof lastU.content === 'string' ? lastU.content : '';
    if (userContent) {
      let finalContent = userContent;
      if (varAppendix) finalContent = userContent + '\n\n【' + DYN_MARK + '】\n' + varAppendix + '\n【' + DYN_MARK + '·完】';
      webGuideResult = await llmLimiter.run(() => b.nonStream(mkOpts([{ role: 'user', content: finalContent }])));
    }
  }

  console.log('总步数:', steps.length, steps.length === 3 ? '✓ 三步' : '✗ 应为3步');
  steps.forEach((msgs, i) => {
    const okSingle = msgs.length === 1 && msgs[0].role === 'user';
    const hasSystem = msgs.some((m) => m.role === 'system');
    const hasHistory = msgs.length > 1;
    console.log('  步' + (i + 1) + ':', okSingle ? '✓ 单条独立user' : '✗', 
      hasSystem ? '✗ 含system!' : '', hasHistory ? '✗ 含历史!' : '',
      '| 内容开头:', msgs[0].content.slice(0, 24).replace(/\n/g, ' '));
  });
  const s3 = steps[2][0].content;
  console.log('步3 含动态上下文:', s3.includes(DYN_MARK) ? '✓' : '✗ 缺动态上下文!');
  console.log('步3 含真实问题:', s3.includes('帮我创建文件') ? '✓' : '✗');
  console.log('步1 含引导:', steps[0][0].content.includes('get_tools') ? '✓' : '✗');
  console.log('步2 含工具结果:', steps[1][0].content.includes('工具 get_tools 的结果') ? '✓' : '✗');
})();
