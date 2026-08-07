'use strict';

/*
 * 针对「代码层面节省 Token / 优化内存」改造的新增测试：
 *  - knowledgeBase BM25 中文命中
 *  - messageSanitize 单条截断 + 总字节硬上限
 *  - projectScan astSkeleton / buildSkeletonMap / queryGraph
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.error('  ✗ ' + name + ' -> ' + e.message); process.exitCode = 1; }
}

/* ========== 1) knowledgeBase BM25 中文命中 ========== */
(function () {
  // 用 mock 的 vscode 配置
  const Module = require('module');
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (req) { if (req === 'vscode') return req; return orig.apply(this, arguments); };
  require.cache.vscode = {
    id: 'vscode',
    exports: {
      workspace: { getConfiguration: () => ({ get: () => null }) },
      ConfigurationTarget: { Global: 1 }
    }
  };
  delete require.cache[require.resolve('../src/knowledgeBase')];
  const kb = require('../src/knowledgeBase');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-bm25-'));
  fs.writeFileSync(path.join(root, 'fox.md'), '酒月狐的设定是一只修行三百年的狐狸。', 'utf8');
  fs.writeFileSync(path.join(root, 'fruit.md'), '这是一个关于苹果和香蕉的水果故事。', 'utf8');

  const cfg = { knowledgeBase: { enabled: true, paths: [root], bm25Enabled: true, topK: 5, chunkSize: 200 } };
  require.cache.vscode.exports.workspace.getConfiguration = (section) => ({
    get: (k) => (k === 'knowledgeBase' ? cfg.knowledgeBase : (cfg[k] !== undefined ? cfg[k] : null))
  });

  ok('BM25 中文查询命中相关片段', () => {
    kb.invalidate();
    const r = kb.retrieve('酒月狐', 8000);
    assert.ok(r.indexOf('酒月狐') !== -1, '应检索到酒月狐片段');
  });
  ok('BM25 中文查询不把无关片段排到前面', () => {
    kb.invalidate();
    const r = kb.retrieve('酒月狐', 8000);
    // 相关片段应排在无关（水果）片段之前
    const iFox = r.indexOf('酒月狐');
    const iFruit = r.indexOf('水果');
    assert.ok(iFox !== -1 && (iFruit === -1 || iFox < iFruit), '酒月狐应优先于水果出现');
  });
  ok('topK 限制返回片段数量', () => {
    kb.invalidate();
    const r = kb.retrieve('内容', 8000);
    const blocks = r.split('\n\n---\n\n').filter(Boolean);
    assert.ok(blocks.length <= 5, '片段数不超过 topK(5)，实际 ' + blocks.length);
  });
})();

/* ========== 2) messageSanitize 单条截断 + 总字节硬上限 ========== */
(function () {
  const ms = require('../src/messageSanitize');
  ok('clampText 超过上限截断并标注', () => {
    const out = ms.clampText('abcdefghij', 5);
    assert.ok(out.startsWith('abcde'), '保留前 5 字');
    assert.ok(out.indexOf('已截断') !== -1, '应标注截断');
    assert.ok(out.length > 5 && out.length < 5000, '长度合理');
  });
  ok('clampMessage 对超长字符串消息截断', () => {
    const m = { role: 'user', content: 'x'.repeat(5000) };
    const out = ms.clampMessage(m, 100);
    assert.ok(out.content.length < 5000, 'content 应被压缩');
  });
  ok('clampMessage 对数组 content 截断文本段', () => {
    const m = { role: 'user', content: [{ type: 'text', text: 'y'.repeat(5000) }, { type: 'image_url', image_url: { url: 'z' } }] };
    const out = ms.clampMessage(m, 100);
    const txt = out.content.find((c) => c.type === 'text');
    assert.ok(txt.text.length < 5000, '文本段应被压缩，图片段保留');
    const img = out.content.find((c) => c.type === 'image_url');
    assert.ok(img && img.image_url.url === 'z', '图片段不被破坏');
  });
  ok('trimHistory 总字节硬上限：丢弃最早的消息', () => {
    const msgs = [];
    for (let i = 0; i < 30; i++) msgs.push({ role: 'user', content: 'msg' + i + ' '.repeat(500) });
    const out = ms.trimHistory(msgs, 'native', 100, { maxBytesPerMessage: 100000, maxTotalBytes: 2000 });
    const total = out.reduce((s, m) => s + (m.content ? m.content.length : 0), 0);
    assert.ok(total <= 2000 + 600, '总字节应被限制到阈值附近，实际 ' + total);
    assert.ok(out.length < msgs.length, '应丢弃部分消息');
  });
  ok('trimHistory 不切断合法 tool 对（native）', () => {
    const msgs = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'big'.repeat(100) }
    ];
    const out = ms.trimHistory(msgs, 'native', 100, { maxBytesPerMessage: 50, maxTotalBytes: 1000000 });
    const hasA = out.some((m) => m.role === 'assistant' && m.tool_calls);
    const hasT = out.some((m) => m.role === 'tool');
    assert.ok(hasA === hasT, 'assistant 与 tool 同时存在或同时不存在');
  });
})();

/* ========== 3) projectScan 骨架 / 图谱 ========== */
(function () {
  const ps = require('../src/projectScan');
  ok('astSkeleton 提取 JS 函数/类', () => {
    const src = [
      'function foo(a) {',
      '  return a;',
      '}',
      'class Bar {',
      '  baz() {}',
      '}',
      'const qux = (x) => x * 2;'
    ].join('\n');
    const sk = ps.astSkeleton('a.js', src);
    assert.ok(sk.indexOf('function foo') !== -1, '应识别 foo');
    assert.ok(sk.indexOf('class Bar') !== -1, '应识别 Bar');
  });
  ok('astSkeleton 提取 Python def/class', () => {
    const src = ['def load():', '    pass', 'class Model:', '    def __init__(self):', '        pass'].join('\n');
    const sk = ps.astSkeleton('m.py', src);
    assert.ok(sk.indexOf('function load') !== -1, '应识别 def load');
    assert.ok(sk.indexOf('class Model') !== -1, '应识别 class Model');
  });
  ok('astSkeleton 上限 80 行', () => {
    const src = Array.from({ length: 200 }, (_, i) => 'function f' + i + '() {}').join('\n');
    const sk = ps.astSkeleton('big.js', src);
    assert.ok(sk.split('\n').length <= 80, '骨架不超过 80 行');
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-sk-'));
  fs.writeFileSync(path.join(root, 'a.js'), 'function alpha() {}\nfunction beta() {}\n', 'utf8');
  fs.writeFileSync(path.join(root, 'b.py'), 'def gamma():\n    pass\n', 'utf8');
  fs.writeFileSync(path.join(root, 'note.md'), '忽略我', 'utf8');
  ok('buildSkeletonMap 只收代码文件且生成骨架', () => {
    const map = ps.buildSkeletonMap(root);
    assert.ok(map['a.js'] && map['a.js'].indexOf('function alpha') !== -1, 'a.js 骨架');
    assert.ok(map['b.py'] && map['b.py'].indexOf('function gamma') !== -1, 'b.py 骨架');
    assert.ok(!map['note.md'], 'md 不应进骨架');
  });

  const proj = {
    relationships: [
      { from: 'main.js', to: 'util.js', type: 'import' },
      { from: 'main.js', to: 'config.js', type: 'import' },
      { from: 'app.py', to: 'lib.py', type: 'import' }
    ]
  };
  ok('queryGraph who-calls 返回导入者', () => {
    const r = ps.queryGraph(proj, 'who-calls', 'util.js');
    assert.ok(r.indexOf('main.js') !== -1, '应列出 main.js');
  });
  ok('queryGraph depends-on 返回依赖', () => {
    const r = ps.queryGraph(proj, 'depends-on', 'main.js');
    assert.ok(r.indexOf('util.js') !== -1 && r.indexOf('config.js') !== -1, '应列出 util/config');
  });
  ok('queryGraph 无关系时给空提示', () => {
    const r = ps.queryGraph({ relationships: [] }, 'who-calls', 'x.js');
    assert.ok(r.indexOf('未检测') !== -1, '应提示未检测');
  });
  ok('detectProjectCached 返回稳定结果', () => {
    const d = ps.detectProjectCached(root);
    assert.ok(d && typeof d.framework === 'string', '应返回 project 对象');
    const d2 = ps.detectProjectCached(root);
    assert.strictEqual(d2.framework, d.framework, '两次调用结果稳定');
  });

  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-ctx-'));
  fs.mkdirSync(path.join(root2, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root2, 'package.json'), '{"name":"demo"}', 'utf8');
  fs.writeFileSync(path.join(root2, 'src', 'main.js'), 'function main() {}\n', 'utf8');
  fs.writeFileSync(path.join(root2, 'src', 'util.js'), 'function helper() {}\n', 'utf8');
  const currentFile = path.join(root2, 'src', 'main.js');

  ok('findProjectRoot 通过 package.json 向上定位根目录', () => {
    const r = ps.findProjectRoot(currentFile);
    assert.strictEqual(r, root2, '应定位到含 package.json 的目录');
  });

  ok('buildSkeletonMapCached 缓存骨架结果', () => {
    const m1 = ps.buildSkeletonMapCached(root2);
    assert.ok(m1['src/main.js'] && m1['src/main.js'].indexOf('function main') !== -1, '应含 main.js 骨架');
    const m2 = ps.buildSkeletonMapCached(root2);
    assert.strictEqual(JSON.stringify(m2), JSON.stringify(m1), '缓存应返回相同结果');
  });

  ok('renderProjectContext 返回项目上下文字符串', () => {
    const ctx = ps.renderProjectContext(root2, currentFile, { maxChars: 2000, includeNeighbors: true });
    assert.ok(ctx.length > 0, '上下文不应为空');
    assert.ok(ctx.indexOf('demo') !== -1 || ctx.indexOf('package.json') !== -1, '应含项目概览');
    assert.ok(ctx.indexOf('src/main.js') !== -1, '应含当前文件');
    assert.ok(ctx.indexOf('src/util.js') !== -1, '应含同目录邻居文件');
  });

  ok('renderProjectContext 按 maxChars 截断', () => {
    const ctx = ps.renderProjectContext(root2, currentFile, { maxChars: 50, includeSkeleton: false, includeNeighbors: false });
    assert.ok(ctx.length <= 60, '应被截断到接近上限，实际 ' + ctx.length);
    assert.ok(ctx.indexOf('…') !== -1, '截断处应有省略号');
  });
})();

console.log(`\ntokenOptimization: ${pass} 通过 / 失败 ${process.exitCode ? 1 : 0}`);
