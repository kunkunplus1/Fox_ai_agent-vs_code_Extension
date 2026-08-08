'use strict';
/*
 * test/imageBase64Trim.js — 离线验证「超窗口历史图片 base64 就地释放」
 * 不依赖 vscode，纯逻辑测试 messageSanitize.stripOldImageBase64。
 */
const assert = require('assert');
const { stripOldImageBase64, isImagePartLocal, trimHistory } = require('../src/messageSanitize');

function bigImg(seed) {
  // 用 2000 个重复字符模拟「几 MB 的 base64 大字符串」驻留
  return { type: 'image_url', image_url: { url: 'data:image/png;base64,' + seed.repeat(2000) } };
}
function userMsg(seed, withImg) {
  const content = [{ type: 'text', text: 'user turn ' + seed }];
  if (withImg) content.push(bigImg(seed));
  return { role: 'user', content };
}

const seeds = ['X', 'Y', 'Z', 'W'];
const msgs = [];
for (const s of seeds) {
  msgs.push(userMsg(s, true));
  msgs.push({ role: 'assistant', content: 'reply ' + s });
}

// ① keepTurns=1：应移除前 3 张图的 base64，仅保留最后一条（W）
const removed = stripOldImageBase64(msgs, 1);
assert.strictEqual(removed, 3, '应释放 3 张较早图片的 base64，实际 ' + removed);

const lastUser = msgs[msgs.length - 2];
assert.ok(isImagePartLocal(lastUser.content.find((c) => c.type === 'image_url')), '最近一次上传的图片应保留');

const json = JSON.stringify(msgs);
assert.ok(!json.includes('X'.repeat(2000)), 'X 的 base64 应已释放');
assert.ok(!json.includes('Y'.repeat(2000)), 'Y 的 base64 应已释放');
assert.ok(!json.includes('Z'.repeat(2000)), 'Z 的 base64 应已释放');
assert.ok(json.includes('W'.repeat(2000)), 'W 的 base64 应保留');

// ② keepTurns 足够大：不移除任何图片
const msgs2 = [];
for (const s of seeds) {
  msgs2.push(userMsg(s, true));
  msgs2.push({ role: 'assistant', content: 'r' });
}
assert.strictEqual(stripOldImageBase64(msgs2, 10), 0, 'keep>=count 时不应移除任何图片');

// ③ keepTurns=0：全部移除
const msgs3 = [];
for (const s of seeds) {
  msgs3.push(userMsg(s, true));
  msgs3.push({ role: 'assistant', content: 'r' });
}
assert.strictEqual(stripOldImageBase64(msgs3, 0), 4, 'keep=0 时应移除全部 4 张图片');

// ④ 降级后带图消息仍应是合法结构（纯文本或含占位文本 part）
for (const m of msgs) {
  if (m.role === 'user') {
    if (typeof m.content === 'string') assert.ok(m.content.includes('历史图片已省略') || m.content.startsWith('user turn'), '降级后应含占位或原文本');
    else assert.ok(m.content.some((c) => c.type === 'text'), '降级后 content 数组应含文本 part');
  }
}

// ⑤ 降级后整体 trimHistory 仍能正常产出数组、不抛
const out = trimHistory(msgs, 'native', 20, { maxTotalBytes: 1024 * 1024 });
assert.ok(Array.isArray(out), 'trimHistory 应返回数组');
assert.ok(out.every((m) => m && m.role), 'trimHistory 产出每条都应有 role');

// ⑥ 空输入 / 非数组安全
assert.strictEqual(stripOldImageBase64(null, 1), 0, 'null 输入安全');
assert.strictEqual(stripOldImageBase64([], 1), 0, '空数组安全');

console.log('imageBase64Trim: PASS (6 groups, all assertions passed)');
