'use strict';
// 探针：验证「每发一句就 get_tools」修复
// 场景：同会话第二次提问（新 AgentSession，messages 含 get_tools 结果）→ 应跳过三步引导
// 关键：三步引导成功后 get_tools 结果写回 this.messages → 下次构造函数扫到 → _resumedSession=true

const DYN_MARK = '狐狸AI·动态上下文';
function fp(s) { return require('crypto').createHash('sha1').update(String(s || '').replace(/\s+/g, ' ').trim(), 'utf8').digest('hex').slice(0, 16); }

// —— 模拟构造函数判定（agent.js 704-728 同款）——
function constructorScan(messages) {
  let toolGuideFetched = false, resumedSession = false;
  for (const m of messages) {
    if (!m) continue;
    if (typeof m.content === 'string' && /\[工具\s+get_tools\s*的结果\]/.test(m.content)) {
      toolGuideFetched = true; resumedSession = true; break;
    }
    if (m.role === 'tool' && m.name === 'get_tools') {
      toolGuideFetched = true; resumedSession = true; break;
    }
  }
  return { toolGuideFetched, resumedSession };
}

// —— 场景1：新会话（messages 只有当前提问）→ 应触发三步引导 ——
const fresh = constructorScan([{ role: 'user', content: '帮我创建文件' }]);
console.log('场景1 新会话(仅当前提问):',
  fresh.resumedSession ? '✗ 误判恢复→不引导!' : '✓ 触发三步引导');

// —— 场景2：三步引导成功后写回 get_tools 结果 → 同会话第二次提问扫到 → 跳过 ——
const afterGuide = [{ role: 'user', content: '帮我创建文件' }];
const toolFeed = '[工具 get_tools 的结果]\n共45个工具...';
afterGuide.push({ role: 'user', content: toolFeed }); // 写回 this.messages
// 第二次提问：新 AgentSession，messages = 历史 + 新提问
const second = afterGuide.concat([{ role: 'assistant', content: '已获取清单' }, { role: 'user', content: '继续' }]);
const s2 = constructorScan(second);
console.log('场景2 同会话第二次提问(有get_tools结果):',
  s2.resumedSession ? '✓ 跳过三步引导(修复生效)' : '✗ 又触发三步引导!');

// —— 场景3：真·新会话（用户点新建，messages 空）→ 应触发 ——
const fresh3 = constructorScan([]);
console.log('场景3 用户新建会话(空消息):',
  fresh3.resumedSession ? '✗ 误判恢复!' : '✓ 触发三步引导');

// —— 场景4：fox_new_session 只在真新会话带 ——
function decideFresh(preparedHistory) {
  const histUsers = preparedHistory.filter((m) => m && m.role === 'user');
  return histUsers.length <= 1;
}
console.log('场景4a 新会话带fox_new_session:', decideFresh([{ role: 'user', content: '问题' }]) ? '✓' : '✗');
console.log('场景4b 同会话继续不带fox_new_session:', !decideFresh([
  { role: 'user', content: '旧问题' }, { role: 'assistant', content: '答' }, { role: 'user', content: '新问题' }
]) ? '✓' : '✗');
