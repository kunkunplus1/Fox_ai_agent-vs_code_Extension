'use strict';
// 修复前探针：复现三个问题的现状
const tools = require('../src/tools');

// 问题1复现：stripToolBlocks 不剥自定义符号
// 模拟模型输出「正文 + [[tool:list_dir]]{json}[[/tool]] 混合」
const fakeModelOut = '我先查看工作区里是否已有解包好的插件文件。\n[[tool:list_dir]]{"path":"f://project-01","depth":2}[[/tool]]\n工作区里目前只有三个 Python 文件。';
const stripped = fakeModelOut.replace(/\x5B\x5Btool:/g, '<foxtool name="').replace(/\x5B\x5B\/tool\x5D\x5D/g, '</foxtool>');
console.log('=== 问题1：当前 stripToolBlocks（只认 <foxtool>）===');
console.log('剥后（应只留正文，若裸露 [[tool:...]] 即复现）:');
console.log(JSON.stringify(stripped.replace(/<foxtool[\s\S]*?<\/foxtool>/g, '')));

// 问题3复现：本地折叠标记是否保留语义
console.log('\n=== 问题3：本地折叠标记 ===');
const note = '[本地折叠] 因自动压缩不可用（缺少有效的「上下文整理」API Key 或调用失败），已在本机把最早的 6 条对话就地折叠，以释放上下文空间。原始内容未做语义摘要，如需完整回顾请改用带有效 API Key 的上下文整理。';
console.log(note.slice(0, 120) + '…');
console.log('语义保留: 无（纯丢弃说明）→ 后续检索不到旧任务内容');

// 问题2：extractCacheStats 对硅基流动的判定
const { extractCacheStats } = require('../src/client');
console.log('\n=== 问题2：硅基流动 (OpenAI 兼容) 缓存口径 ===');
const siliconUsage = { prompt_tokens: 1425, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens: 100 };
const stats = extractCacheStats(siliconUsage);
console.log('硅基流动 usage →', JSON.stringify(stats));
console.log('cached=0 → 命中率 0%，全量计费', stats ? '命中率=' + Math.round(stats.hitRate * 100) + '%' : 'null');
