'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
function ok(name, cond) {
  assert.ok(cond, '❌ ' + name);
  console.log('  ✓ ' + name);
  pass++;
}

// 模拟 vscode.workspace.getConfiguration，覆盖 knowledgeBase 配置
let mockCfg = {};
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'vscode') return request;
  return originalResolve.call(this, request, parent, isMain, options);
};
require.cache.vscode = {
  id: 'vscode',
  exports: {
    workspace: {
      getConfiguration: () => ({
        get: (key) => (mockCfg[key] === undefined ? null : mockCfg[key])
      })
    },
    ConfigurationTarget: { Global: 1 }
  }
};

// 清掉缓存，确保下面 require 拿到带 mock 的新实例
delete require.cache[require.resolve('../src/knowledgeBase')];
const kb = require('../src/knowledgeBase');
const contextUsage = require('../src/contextUsage');

// 关键：整理产物目录默认是 ~/.fox-ai/knowledge（真实环境里可能存在，会污染单测）。
// 这里始终显式给一个空临时目录作为 organize.outputDir，让 defaultOutputDir 返回受控目录、
// 不再回退到真实默认目录，从而保证单测结果确定、与用户机器上的真实知识库无关。
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-kb-out-'));
function noRealDirCfg(extra) {
  return Object.assign({ knowledgeBase: { organize: { enabled: false, outputDir: tmpOut } } }, extra);
}

(async () => {
  // 1) 各开关组合
  mockCfg = { knowledgeBase: { enabled: true } };
  ok('knowledgeBase.enabled=true 时启用', kb.isEnabled() === true);

  mockCfg = { knowledgeBase: { enabled: false, organize: { enabled: true } } };
  ok('organize.enabled=true 时也启用', kb.isEnabled() === true);

  mockCfg = { knowledgeBase: { enabled: false, autoSummarize: { enabled: true } } };
  ok('autoSummarize.enabled=true 时也启用', kb.isEnabled() === true);

  mockCfg = { knowledgeBase: { enabled: false, organize: { enabled: false } } };
  ok('都关闭时未启用', kb.isEnabled() === false);

  mockCfg = { knowledgeBase: { enabled: false } };
  ok('无 organize 字段时未启用', kb.isEnabled() === false);

  // 2) 显式配置的源目录（paths）会被检索到
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-kb-paths-'));
  fs.writeFileSync(path.join(tmp, 'note.md'), 'foxkbtestnote 这是单元测试专用的知识库内容，用于验证检索。', 'utf8');
  mockCfg = noRealDirCfg({ knowledgeBase: { enabled: true, paths: [tmp] } });
  kb.invalidate();
  const r = kb.retrieve('foxkbtestnote', 8000);
  ok('paths 配置的源目录被检索到', r.indexOf('foxkbtestnote') !== -1);

  // 3) 整理模式下按文件名全量注入，不再依赖查询关键词
  const tmpOrg = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-kb-org-'));
  fs.writeFileSync(path.join(tmpOrg, 'a.md'), '# 苹果\n这是一个关于苹果的故事。', 'utf8');
  fs.writeFileSync(path.join(tmpOrg, 'b.md'), '# 香蕉\n这是一个关于香蕉的故事。', 'utf8');
  mockCfg = { knowledgeBase: { enabled: false, organize: { enabled: true, outputDir: tmpOrg }, chunkSize: 200 } };
  kb.invalidate();
  const rOrg = kb.retrieve('任意查询甚至无关关键词', 8000);
  ok('整理模式全量注入：包含苹果', rOrg.indexOf('苹果') !== -1);
  ok('整理模式全量注入：包含香蕉', rOrg.indexOf('香蕉') !== -1);
  ok('整理模式列出文件清单', kb.listKnowledgeFiles().map((f) => f.source).sort().join(',') === 'a.md,b.md');
  const system = kb.augmentSystemPrompt('base', '无关');
  ok('augmentSystemPrompt 包含文件清单', system.indexOf('当前可用的知识库文件') !== -1);
  ok('augmentSystemPrompt 包含整理内容', system.indexOf('苹果') !== -1);

  // 4) contextUsage.estimateMessages 估算
  ok('estimateMessages 对空数组返回 0', contextUsage.estimateMessages([]) === 0);
  const est = contextUsage.estimateMessages([
    { role: 'user', content: '你好世界' },
    { role: 'assistant', content: '我是酒月狐' }
  ]);
  ok('estimateMessages 对真实消息返回正数', est > 0);

  // 5) 纯函数：dedupTop / textHash / embedSignature（不改写文件、无网络依赖，供单测）
  const dupList = [
    { file: 'a.md', text: '狐狸是修行三百年的小妖怪，喜欢睡觉' },
    { file: 'a.md', text: '狐狸是修行三百年的小妖怪，喜欢睡觉' }, // 同文件同内容 → 应去重
    { file: 'b.md', text: '苹果是一种常见的水果，酸甜可口' },
    { file: 'c.md', text: '香蕉富含钾元素，口感软糯' }
  ];
  const deduped = kb.dedupTop(dupList, 2);
  ok('dedupTop 去重同文件同内容并限制 topK=2', deduped.length === 2 && deduped[0].file === 'a.md' && deduped[1].file === 'b.md');

  ok('textHash 确定性：同输入同输出', kb.textHash('酒月狐') === kb.textHash('酒月狐'));
  ok('textHash 区分不同输入', kb.textHash('酒月狐') !== kb.textHash('狐狸月酒'));
  ok('textHash 返回 24 位十六进制', /^[0-9a-f]{24}$/.test(kb.textHash('x')));

  const sig = kb.embedSignature({ pid: 'dashscope', model: 'text-embedding-v4', dimensions: 1024, kind: 'openai' });
  ok('embedSignature 含 provider 与 model', sig === 'dashscope|text-embedding-v4|1024|openai' && sig.indexOf('text-embedding-v4') !== -1);

  // 6) BM25 关键词命中排序：高频命中文件应排在低频命中文件之前
  const tmpRank = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-kb-rank-'));
  fs.writeFileSync(path.join(tmpRank, 'fox-a.md'), '狐狸狐狸狐狸狐狸狐狸，九条尾巴的狐狸精在月光下打盹。');
  fs.writeFileSync(path.join(tmpRank, 'fox-b.md'), '森林里有一只狐狸在奔跑，惊起了几只飞鸟。');
  mockCfg = noRealDirCfg({ knowledgeBase: { enabled: true, paths: [tmpRank], bm25Enabled: true } });
  kb.invalidate();
  const rRank = kb.retrieve('狐狸', 8000);
  const idxA = rRank.indexOf('九条尾巴');
  const idxB = rRank.indexOf('森林里');
  ok('retrieve BM25：高频命中文件被召回', idxA !== -1);
  ok('retrieve BM25：低频命中文件也被召回', idxB !== -1);
  ok('retrieve BM25：更相关的片段排在更前面', idxA < idxB);

  // 7) retrieveAsync 向量模型关闭时直接走 BM25（不触网），与同步 retrieve 结果一致
  const tmpAsync = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-kb-async-'));
  fs.writeFileSync(path.join(tmpAsync, 'grape.md'), '葡萄是一种甜甜的水果，葡萄可以酿酒，葡萄也做葡萄干。', 'utf8');
  mockCfg = noRealDirCfg({ knowledgeBase: { enabled: true, paths: [tmpAsync], bm25Enabled: true } });
  kb.invalidate();
  const rAsync = await kb.retrieveAsync('葡萄', 8000);
  ok('retrieveAsync 向量关闭时回退 BM25 且不触网', typeof rAsync === 'string' && rAsync.indexOf('葡萄') !== -1);
  ok('retrieveAsync 与同步 retrieve 走同一 BM25 路径结果一致', rAsync === kb.retrieve('葡萄', 8000));

  console.log(`\n结果：通过 ${pass} / 失败 0`);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
