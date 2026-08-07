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

// 2) 知识库-2 目录会被纳入检索
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-kb2-'));
fs.writeFileSync(path.join(tmp, 'note.md'), '酒月狐的设定是一只修行三百年的狐狸。', 'utf8');
mockCfg = { knowledgeBase: { enabled: false, autoSummarize: { enabled: true, dir: tmp } } };
kb.invalidate();
const r = kb.retrieve('酒月狐', 8000);
ok('autoSummarize 开启时检索到知识库-2 内容', r.indexOf('酒月狐') !== -1);

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

console.log(`\n结果：通过 ${pass} / 失败 0`);
