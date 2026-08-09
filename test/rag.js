'use strict';

/**
 * test/rag.js — 全仓库语义索引与混合检索（src/rag.js）离线测试
 * 运行：node test/rag.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rag = require('../src/rag');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + ' → ' + (e && e.message));
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foxrag-'));
function wf(rel, content) {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

console.log('\n[rag] 全仓库语义索引');

// ---------- 1. 分词 ----------
t('camelCase 被拆成子词', () => {
  const toks = rag.tokenize('getUserName');
  assert.ok(toks.includes('getusername'));
  assert.ok(toks.includes('user'));
  assert.ok(toks.includes('name'));
});

t('snake_case / kebab-case 被拆词', () => {
  assert.ok(rag.tokenize('fetch_remote_data').includes('remote'));
  assert.ok(rag.tokenize('my-cool-widget').includes('cool'));
});

t('连续大写缩写正确切分（HTTPServer）', () => {
  const toks = rag.tokenize('HTTPServer');
  assert.ok(toks.includes('http'), 'HTTP 应被切出');
  assert.ok(toks.includes('server'));
});

t('中文按单字 + bigram 切', () => {
  const toks = rag.tokenize('用户认证');
  assert.ok(toks.includes('用'));
  assert.ok(toks.includes('用户'));
  assert.ok(toks.includes('户认'));
});

t('停用词被过滤', () => {
  const toks = rag.tokenize('const function return');
  assert.ok(!toks.includes('const'));
  assert.ok(!toks.includes('function'));
});

t('空输入返回空数组', () => {
  assert.deepStrictEqual(rag.tokenize(''), []);
  assert.deepStrictEqual(rag.tokenize(null), []);
});

t('termFreq 统计频次', () => {
  const tf = rag.termFreq(['a', 'b', 'a']);
  assert.strictEqual(tf.a, 2);
  assert.strictEqual(tf.b, 1);
});

// ---------- 2. 分块 ----------
t('短文件切成一块', () => {
  const chunks = rag.chunkFile('line1\nline2\nline3 这里要足够长才不会被丢掉哦哦哦');
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(chunks[0].startLine, 1);
});

t('过短内容不产生块', () => {
  assert.strictEqual(rag.chunkFile('a\nb').length, 0);
});

t('在函数定义处断开', () => {
  const src = [
    '// 头部注释，这一段要足够长以免被过滤掉啦啦啦',
    'const x = 1;',
    'const y = 2;',
    'const z = 3;',
    'const w = 4;',
    'function alpha() {',
    '  return 111111;',
    '}',
    'function beta() {',
    '  return 222222;',
    '}'
  ].join('\n');
  const chunks = rag.chunkFile(src);
  assert.ok(chunks.length >= 2, '应至少在定义处切出多块，实际 ' + chunks.length);
  assert.ok(chunks.some((c) => c.text.includes('function alpha')));
});

t('超长段落按窗口切且有重叠', () => {
  const src = Array.from({ length: 120 }, (_, i) => 'const value' + i + ' = ' + i + ';').join('\n');
  const chunks = rag.chunkFile(src, { maxLines: 30, overlap: 5 });
  assert.ok(chunks.length >= 4, '应切成多块，实际 ' + chunks.length);
  assert.ok(chunks[1].startLine < chunks[0].endLine, '相邻块应有重叠');
});

t('块行号覆盖整个文件', () => {
  const src = Array.from({ length: 50 }, (_, i) => 'line ' + i + ' 内容内容内容').join('\n');
  const chunks = rag.chunkFile(src, { maxLines: 20, overlap: 0 });
  assert.strictEqual(chunks[0].startLine, 1);
  assert.strictEqual(chunks[chunks.length - 1].endLine, 50);
});

// ---------- 3. 文件遍历 ----------
t('walkFiles 跳过 node_modules / .git', () => {
  wf('src/a.js', 'console.log(1)');
  wf('node_modules/pkg/index.js', 'ignored');
  wf('.git/config', 'ignored');
  const files = rag.walkFiles(tmp);
  const rels = files.map((f) => f.rel);
  assert.ok(rels.includes('src/a.js'));
  assert.ok(!rels.some((r) => r.includes('node_modules')));
  assert.ok(!rels.some((r) => r.includes('.git')));
});

t('walkFiles 按扩展名过滤', () => {
  wf('bin/data.bin', 'xxxx');
  const files = rag.walkFiles(tmp, { exts: ['.js'] });
  assert.ok(files.every((f) => f.rel.endsWith('.js')));
});

t('walkFiles 跳过超大文件', () => {
  wf('big.js', 'x'.repeat(2000));
  const files = rag.walkFiles(tmp, { maxFileBytes: 1000 });
  assert.ok(!files.some((f) => f.rel === 'big.js'));
});

// ---------- 4. 索引与检索 ----------
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo, { recursive: true });
function rf(rel, content) {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

rf('src/auth.js', `
// 用户登录认证模块
function authenticateUser(username, password) {
  const hashed = hashPassword(password);
  return db.users.findOne({ username, password: hashed });
}
function hashPassword(pwd) {
  return crypto.createHash('sha256').update(pwd).digest('hex');
}
`);
rf('src/payment.js', `
// 支付订单处理
function createOrder(userId, amount) {
  validateAmount(amount);
  return db.orders.insert({ userId, amount, status: 'pending' });
}
function refundOrder(orderId) {
  return db.orders.update(orderId, { status: 'refunded' });
}
`);
rf('docs/readme.md', `
# 项目说明
本项目实现了用户认证与支付订单功能，数据库用 MongoDB。
`);

function newIndex(extra) {
  return new rag.RagIndex(Object.assign({ root: repo, indexFile: path.join(tmp, 'idx', 'i.json') }, extra || {}));
}

t('build 建立索引并统计', () => {
  const idx = newIndex();
  idx.clear();
  const r = idx.build();
  assert.strictEqual(r.files, 3, '应索引 3 个文件，实际 ' + r.files);
  assert.ok(r.chunks >= 3);
  assert.strictEqual(r.added, 3);
});

t('索引可持久化并重新加载', () => {
  const idx = newIndex();
  idx.build();
  const n = idx.chunkCount;
  const idx2 = newIndex();
  assert.strictEqual(idx2.chunkCount, n);
  assert.ok(idx2.fileCount === 3);
});

t('检索能命中语义相关文件', () => {
  const idx = newIndex();
  idx.build();
  const hits = idx.search('用户登录密码校验');
  assert.ok(hits.length > 0, '应有命中');
  assert.strictEqual(hits[0].file, 'src/auth.js', '首位应是 auth.js，实际 ' + hits[0].file);
});

t('检索区分不同主题', () => {
  const idx = newIndex();
  idx.build();
  const hits = idx.search('退款订单金额');
  assert.ok(hits.length > 0);
  assert.strictEqual(hits[0].file, 'src/payment.js');
});

t('camelCase 查询能命中（authenticate user）', () => {
  const idx = newIndex();
  idx.build();
  const hits = idx.search('authenticateUser');
  assert.ok(hits.some((h) => h.file === 'src/auth.js'));
});

t('检索结果带行号与分数', () => {
  const idx = newIndex();
  idx.build();
  const h = idx.search('hashPassword')[0];
  assert.ok(h.startLine >= 1);
  assert.ok(h.endLine >= h.startLine);
  assert.ok(h.score > 0);
  assert.ok(typeof h.preview === 'string');
});

t('withText 回读源文件真实内容', () => {
  const idx = newIndex();
  idx.build();
  const h = idx.search('createOrder', { withText: true })[0];
  assert.ok(h.text.includes('createOrder'), '应回读到真实代码');
});

t('topK 限制结果数', () => {
  const idx = newIndex();
  idx.build();
  assert.ok(idx.search('function', { topK: 1, minScore: 0 }).length <= 1);
});

t('pathFilter 限定检索范围', () => {
  const idx = newIndex();
  idx.build();
  const hits = idx.search('用户', { pathFilter: '^docs/', minScore: 0 });
  assert.ok(hits.every((h) => h.file.startsWith('docs/')));
});

t('毫无关联的查询返回空', () => {
  const idx = newIndex();
  idx.build();
  assert.strictEqual(idx.search('量子色动力学胶子禁闭').length, 0);
});

t('空查询返回空', () => {
  const idx = newIndex();
  idx.build();
  assert.deepStrictEqual(idx.search(''), []);
});

t('文件路径本身参与索引（按模块名可检索）', () => {
  const idx = newIndex();
  idx.build();
  const hits = idx.search('payment', { minScore: 0 });
  assert.strictEqual(hits[0].file, 'src/payment.js');
});

// ---------- 5. 增量更新 ----------
t('未变更文件不重复索引', () => {
  const idx = newIndex();
  idx.build();
  const r = idx.build();
  assert.strictEqual(r.added, 0);
  assert.strictEqual(r.updated, 0);
});

t('文件改动后增量更新', () => {
  const idx = newIndex();
  idx.build();
  const before = idx.chunkCount;
  rf('src/payment.js', `
// 支付订单处理（新增退货物流跟踪）
function createOrder(userId, amount) { return 1; }
function trackShipment(orderId) {
  return logistics.query(orderId);
}
`);
  // mtime 精度问题：强制改 mtime
  const p = path.join(repo, 'src/payment.js');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(p, future, future);
  const r = idx.build();
  assert.strictEqual(r.updated, 1, '应有 1 个文件被更新');
  assert.strictEqual(r.added, 0);
  const hits = idx.search('物流跟踪');
  assert.ok(hits.some((h) => h.file === 'src/payment.js'), '新内容应可被检索到');
  assert.ok(idx.chunkCount > 0 && before > 0);
});

t('新增文件被自动纳入', () => {
  const idx = newIndex();
  idx.build();
  rf('src/cache.js', 'function getCacheKey(k) { return "prefix:" + k; }\n// 缓存键生成器工具函数');
  const r = idx.build();
  assert.strictEqual(r.added, 1);
  assert.ok(idx.search('缓存键生成').length > 0);
});

t('删除的文件被清出索引', () => {
  const idx = newIndex();
  idx.build();
  fs.unlinkSync(path.join(repo, 'src/cache.js'));
  const r = idx.build();
  assert.strictEqual(r.removed, 1);
  assert.ok(!idx.search('缓存键生成').some((h) => h.file === 'src/cache.js'));
});

t('删除文件后 df 表被正确扣减（不残留幽灵词）', () => {
  const idx = newIndex();
  idx.clear();
  rf('src/ghost.js', 'function 幽灵专属词汇xyzzy() { return 1; } // 独一无二的标记 xyzzy');
  idx.build();
  assert.ok(idx.data.df['xyzzy'] > 0, '索引后应有该词');
  fs.unlinkSync(path.join(repo, 'src/ghost.js'));
  idx.build();
  assert.ok(!idx.data.df['xyzzy'], 'df 表应清掉该词，实际 ' + idx.data.df['xyzzy']);
});

t('force 全量重建', () => {
  const idx = newIndex();
  idx.build();
  const r = idx.build({ force: true });
  assert.ok(r.added >= 2, 'force 后所有文件都算新增');
});

t('onProgress 回调被调用', () => {
  const idx = newIndex();
  idx.clear();
  let calls = 0;
  idx.build({ onProgress: () => { calls++; } });
  assert.ok(calls > 0);
});

// ---------- 6. 健壮性 ----------
t('索引文件损坏时自动重置', () => {
  const f = path.join(tmp, 'bad', 'i.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'not json!!', 'utf8');
  const idx = new rag.RagIndex({ root: repo, indexFile: f });
  assert.strictEqual(idx.chunkCount, 0);
  const r = idx.build();
  assert.ok(r.chunks > 0);
});

t('空目录建索引不报错', () => {
  const empty = path.join(tmp, 'emptyrepo');
  fs.mkdirSync(empty, { recursive: true });
  const idx = new rag.RagIndex({ root: empty, indexFile: path.join(tmp, 'e', 'i.json') });
  const r = idx.build();
  assert.strictEqual(r.files, 0);
  assert.deepStrictEqual(idx.search('anything'), []);
});

t('stats 返回索引概况', () => {
  const idx = newIndex();
  idx.build();
  const s = idx.stats();
  assert.ok(s.files > 0);
  assert.ok(s.chunks > 0);
  assert.ok(s.terms > 0);
  assert.ok(s.builtAt > 0);
});

t('renderResults 渲染成文本', () => {
  const idx = newIndex();
  idx.build();
  const txt = rag.renderResults(idx.search('认证', { withText: true }), { maxCharsPerHit: 100 });
  assert.ok(txt.includes('语义检索命中'));
  assert.ok(txt.includes('src/auth.js'));
});

t('renderResults 空结果友好提示', () => {
  assert.ok(rag.renderResults([]).includes('未检索到'));
});

t('clear 清空索引与文件', () => {
  const idx = newIndex();
  idx.build();
  idx.clear();
  assert.strictEqual(idx.chunkCount, 0);
  assert.strictEqual(fs.existsSync(path.join(tmp, 'idx', 'i.json')), false);
});

console.log(`\n[rag] ${pass} 通过 / ${fail} 失败`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
