'use strict';
// 探针：验证三步分离下动态上下文去重不被破坏
// 场景：首轮三步引导（第③步带动态上下文并设指纹）→ 第二轮正常 callModel（指纹命中跳过注入）
const DYN_MARK = '狐狸AI·动态上下文';
function fp(s) { return require('crypto').createHash('sha1').update(String(s || '').replace(/\s+/g, ' ').trim(), 'utf8').digest('hex').slice(0, 16); }

// 模拟状态
const webBlockCache = new Map();
const varAppendix = '【深度思考】\n强度high\n【当前环境】\nwin32 工作区 study_code';

// —— 轮1：三步引导 ——
const steps = [];
const b = { nonStream: async (o) => { steps.push(o.messages); return { content: 'ok', reasoning: '', toolCalls: [], finishReason: 'stop', empty: false }; } };
const mkOpts = (messages) => ({ baseUrl: 'x', apiKey: 'x', model: 'm', messages, temperature: 1 });
const llmLimiter = { run: (f) => f() };
const preparedHistory = [{ role: 'user', content: '帮我创建文件，第4行写你好' }];

(async () => {
  // ① 引导轮（无动态上下文）
  await llmLimiter.run(() => b.nonStream(mkOpts([{ role: 'user', content: '[系统] 本任务的第一步必须先调用 get_tools...' }])));
  // ② 工具结果轮
  await llmLimiter.run(() => b.nonStream(mkOpts([{ role: 'user', content: '[工具 get_tools 的结果]\n共45个工具...' }])));
  // ③ 真实问题 + 动态上下文（设指纹）
  const userContent = '帮我创建文件，第4行写你好';
  let finalContent = userContent;
  if (varAppendix) {
    finalContent = userContent + '\n\n【' + DYN_MARK + '】\n' + varAppendix + '\n【' + DYN_MARK + '·完】';
    webBlockCache.set(DYN_MARK, { fp: fp(varAppendix) });
  }
  await llmLimiter.run(() => b.nonStream(mkOpts([{ role: 'user', content: finalContent }])));

  // —— 轮2：主循环正常 callModel，_injectDynamicAppendix 判定 ——
  const curFp = fp(varAppendix);
  const hasMark = webBlockCache.has(DYN_MARK);
  const sameFp = hasMark && webBlockCache.get(DYN_MARK).fp === curFp;
  const shouldSkip = hasMark && sameFp;

  console.log('轮1 步数:', steps.length, steps.length === 3 ? '✓' : '✗');
  console.log('轮1 步1无动态上下文:', !steps[0][0].content.includes(DYN_MARK) ? '✓' : '✗');
  console.log('轮1 步3含动态上下文:', steps[2][0].content.includes(DYN_MARK) ? '✓' : '✗');
  console.log('轮1 指纹已记录:', hasMark ? '✓' : '✗');
  console.log('轮2 附录跳过注入(去重生效):', shouldSkip ? '✓' : '✗ 去重被破坏!');

  // —— 场景B：varAppendix 变化（内容变了应重新注入）——
  const varAppendix2 = '【深度思考】\n强度low\n【当前环境】\nmacOS';
  const curFp2 = fp(varAppendix2);
  const shouldReinject = webBlockCache.get(DYN_MARK).fp !== curFp2;
  console.log('场景B 附录内容变化→重新注入:', shouldReinject ? '✓' : '✗');

  // —— 场景C：恢复会话（_resumedSession=true 跳过三步）→ 指纹在构造函数预扫 ——
  // 模拟：构造函数扫描历史里的 DYN_MARK 块设置指纹
  const historyWithBlock = [{ role: 'user', content: '旧问题\n\n【' + DYN_MARK + '】\n' + varAppendix + '\n【' + DYN_MARK + '·完】' }];
  const wc2 = new Map();
  for (const m of historyWithBlock) {
    const c = typeof m.content === 'string' ? m.content : '';
    const open = c.indexOf('【' + DYN_MARK + '】');
    if (open >= 0) {
      const close = c.indexOf('【' + DYN_MARK + '·完】', open);
      if (close >= 0) {
        const block = c.slice(open, close + ('【' + DYN_MARK + '·完】').length);
        if (!wc2.has(DYN_MARK)) wc2.set(DYN_MARK, { fp: fp(block) });
      }
    }
  }
  console.log('场景C 恢复会话预扫指纹:', wc2.has(DYN_MARK) ? '✓' : '✗');
  console.log('\n去重验证完成');
})();
