'use strict';

/**
 * 离线测试：知识库「向量模型」适配层（src/embedding.js）纯函数。
 * 不发起任何外网请求，仅验证 厂商分类 / URL 拼接 / 响应解析 / 归一化 / 余弦 /
 * 批量上限 / 可重试判定 / 配置解析 等纯逻辑。
 * 运行：node test/embedding.js
 */

const assert = require('assert');
const Module = require('module');

/* ---------- 最小 vscode mock（仅供 resolveEmbeddingConfig 经 config 读取设置） ---------- */
const configStore = {
  'knowledgeBase.embedding': {
    enabled: false, provider: 'ollama', baseUrl: '', model: '',
    dimensions: 0, batchSize: 0, timeout: 30000, hybrid: true
  }
};
const vscodeMock = {
  workspace: {
    getConfiguration: () => ({
      get: (k, d) => (k in configStore ? configStore[k] : d)
    })
  }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const emb = require('../src/embedding');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); }
}
async function checkA(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); }
}
function close(a, b, eps = 1e-6) {
  assert.strictEqual(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i] - b[i]) <= eps, `idx ${i}: ${a[i]} vs ${b[i]}`);
  }
}

(async () => {
  console.log('embedding 适配层单测：');

  // 1) classifyEmbedProvider
  check('classifyEmbedProvider: ollama provider → ollama', () => {
    assert.strictEqual(emb.classifyEmbedProvider({ provider: 'ollama' }), 'ollama');
  });
  check('classifyEmbedProvider: /api/embed baseUrl → ollama', () => {
    assert.strictEqual(emb.classifyEmbedProvider({ baseUrl: 'http://127.0.0.1:11434/api/embed' }), 'ollama');
  });
  check('classifyEmbedProvider: :11434 端口 → ollama', () => {
    assert.strictEqual(emb.classifyEmbedProvider({ baseUrl: 'http://localhost:11434/v1' }), 'ollama');
  });
  check('classifyEmbedProvider: dashscope → openai', () => {
    assert.strictEqual(emb.classifyEmbedProvider({ provider: 'dashscope' }), 'openai');
  });
  check('classifyEmbedProvider: openai/custom/zhipu/siliconflow → openai', () => {
    assert.strictEqual(emb.classifyEmbedProvider({ provider: 'openai' }), 'openai');
    assert.strictEqual(emb.classifyEmbedProvider({ provider: 'custom' }), 'openai');
    assert.strictEqual(emb.classifyEmbedProvider({ provider: 'zhipu' }), 'openai');
    assert.strictEqual(emb.classifyEmbedProvider({ provider: 'siliconflow' }), 'openai');
  });

  // 2) buildEmbedUrl
  check('buildEmbedUrl: ollama 根地址 → /api/embed', () => {
    assert.strictEqual(emb.buildEmbedUrl('ollama', 'http://localhost:11434'), 'http://localhost:11434/api/embed');
  });
  check('buildEmbedUrl: ollama 去掉旧的 /api/embeddings', () => {
    assert.strictEqual(emb.buildEmbedUrl('ollama', 'http://localhost:11434/api/embeddings'), 'http://localhost:11434/api/embed');
  });
  check('buildEmbedUrl: ollama legacy → /api/embeddings', () => {
    assert.strictEqual(emb.buildEmbedUrl('ollama', 'http://localhost:11434', { legacy: true }), 'http://localhost:11434/api/embeddings');
  });
  check('buildEmbedUrl: openai 追加 /embeddings', () => {
    assert.strictEqual(emb.buildEmbedUrl('openai', 'https://api.openai.com/v1'), 'https://api.openai.com/v1/embeddings');
  });
  check('buildEmbedUrl: 百炼 compatible-mode', () => {
    assert.strictEqual(emb.buildEmbedUrl('openai', 'https://dashscope.aliyuncs.com/compatible-mode/v1'), 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');
  });
  check('buildEmbedUrl: 已是 /embeddings 不重复追加', () => {
    assert.strictEqual(emb.buildEmbedUrl('openai', 'https://x/v1/embeddings'), 'https://x/v1/embeddings');
  });
  check('buildEmbedUrl: 空 baseUrl → 空串', () => {
    assert.strictEqual(emb.buildEmbedUrl('openai', ''), '');
  });

  // 3) buildEmbedBody
  check('buildEmbedBody: ollama 批量用 input', () => {
    const b = emb.buildEmbedBody('ollama', { model: 'nomic-embed-text', texts: ['a', 'b'] });
    assert.deepStrictEqual(b, { model: 'nomic-embed-text', input: ['a', 'b'] });
  });
  check('buildEmbedBody: ollama legacy 用 prompt 单条', () => {
    const b = emb.buildEmbedBody('ollama', { model: 'x', texts: ['hello'], legacy: true });
    assert.deepStrictEqual(b, { model: 'x', prompt: 'hello' });
  });
  check('buildEmbedBody: openai 含 encoding_format 且无 dimensions', () => {
    const b = emb.buildEmbedBody('openai', { model: 'text-embedding-3-small', texts: ['a'] });
    assert.strictEqual(b.model, 'text-embedding-3-small');
    assert.deepStrictEqual(b.input, ['a']);
    assert.strictEqual(b.encoding_format, 'float');
    assert.ok(!('dimensions' in b));
  });
  check('buildEmbedBody: openai 带 dimensions', () => {
    const b = emb.buildEmbedBody('openai', { model: 'text-embedding-v4', texts: ['a'], dimensions: 1024 });
    assert.strictEqual(b.dimensions, 1024);
  });

  // 4) parseEmbedResponse
  check('parseEmbedResponse: ollama embeddings 数组', () => {
    const r = emb.parseEmbedResponse('ollama', { embeddings: [[1, 0, 0], [0, 1, 0]] });
    assert.strictEqual(r.length, 2);
    close(r[0], [1, 0, 0]);
  });
  check('parseEmbedResponse: ollama 单条 embedding', () => {
    const r = emb.parseEmbedResponse('ollama', { embedding: [0.5, 0.5] });
    assert.strictEqual(r.length, 1);
    close(r[0], [0.5, 0.5]);
  });
  check('parseEmbedResponse: ollama 过滤非有限值', () => {
    const r = emb.parseEmbedResponse('ollama', { embeddings: [[1, 0, 0], ['x', 1]] });
    assert.strictEqual(r.length, 1);
  });
  check('parseEmbedResponse: openai data 按 index 归位', () => {
    const r = emb.parseEmbedResponse('openai', { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] });
    assert.strictEqual(r.length, 2);
    close(r[0], [1, 0]);
    close(r[1], [0, 1]);
  });
  check('parseEmbedResponse: 百炼 output.embeddings', () => {
    const r = emb.parseEmbedResponse('openai', { output: { embeddings: [{ text_index: 0, embedding: [1, 0] }, { text_index: 1, embedding: [0, 1] }] } });
    assert.strictEqual(r.length, 2);
    close(r[0], [1, 0]);
  });
  check('parseEmbedResponse: base64 解码', () => {
    const b64 = Buffer.from(new Float32Array([1, 0, 0]).buffer).toString('base64');
    const r = emb.parseEmbedResponse('openai', { data: [{ index: 0, embedding: b64 }] });
    assert.strictEqual(r.length, 1);
    close(r[0], [1, 0, 0], 1e-4);
  });
  check('parseEmbedResponse: 空/非法 → []', () => {
    assert.strictEqual(emb.parseEmbedResponse('openai', null).length, 0);
    assert.strictEqual(emb.parseEmbedResponse('openai', {}).length, 0);
  });

  // 5) normalizeVector
  check('normalizeVector: [3,4] → [0.6,0.8]', () => {
    close(emb.normalizeVector([3, 4]), [0.6, 0.8]);
  });
  check('normalizeVector: 零向量返回等长副本', () => {
    const n = emb.normalizeVector([0, 0, 0]);
    assert.strictEqual(n.length, 3);
    assert.deepStrictEqual(n, [0, 0, 0]);
  });

  // 6) cosineSimilarity
  check('cosineSimilarity: 相同向量 → 1', () => {
    assert.ok(Math.abs(emb.cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
  });
  check('cosineSimilarity: 正交向量 → 0', () => {
    assert.ok(Math.abs(emb.cosineSimilarity([1, 0], [0, 1])) < 1e-9);
  });
  check('cosineSimilarity: 空向量 → 0', () => {
    assert.strictEqual(emb.cosineSimilarity([], []), 0);
  });
  check('cosineSimilarity: 归一化后等价点积', () => {
    const a = emb.normalizeVector([1, 2, 3]);
    const b = emb.normalizeVector([4, 5, 6]);
    assert.ok(Math.abs(emb.cosineSimilarity(a, b) - emb.cosineSimilarity([1, 2, 3], [4, 5, 6])) < 1e-9);
  });

  // 7) batchLimitFor
  check('batchLimitFor: 百炼 → 10', () => {
    assert.strictEqual(emb.batchLimitFor('dashscope', 'openai', 0), 10);
  });
  check('batchLimitFor: ollama → 32', () => {
    assert.strictEqual(emb.batchLimitFor('ollama', 'ollama', 0), 32);
  });
  check('batchLimitFor: 自定义上限被钳制到 64 / 透传小值', () => {
    assert.strictEqual(emb.batchLimitFor('openai', 'openai', 100), 64);
    assert.strictEqual(emb.batchLimitFor('openai', 'openai', 8), 8);
  });
  check('batchLimitFor: 默认 openai → 16', () => {
    assert.strictEqual(emb.batchLimitFor('openai', 'openai', 0), 16);
  });

  // 8) isRetriable
  check('isRetriable: 429/5xx 可重试', () => {
    assert.strictEqual(emb.isRetriable({ status: 429 }), true);
    assert.strictEqual(emb.isRetriable({ status: 503 }), true);
  });
  check('isRetriable: 超时文案可重试', () => {
    assert.strictEqual(emb.isRetriable({ message: 'request timeout' }), true);
  });
  check('isRetriable: 400/401 不可重试', () => {
    assert.strictEqual(emb.isRetriable({ status: 400 }), false);
    assert.strictEqual(emb.isRetriable({ status: 401 }), false);
  });

  // 9) isEmbedUsable
  check('isEmbedUsable: 齐全 → true', () => {
    assert.strictEqual(emb.isEmbedUsable({ enabled: true, baseUrl: 'http://x', model: 'm' }), true);
  });
  check('isEmbedUsable: 未启用/缺 baseUrl/缺 model → false', () => {
    assert.strictEqual(emb.isEmbedUsable({ enabled: false, baseUrl: 'http://x', model: 'm' }), false);
    assert.strictEqual(emb.isEmbedUsable({ enabled: true, baseUrl: '', model: 'm' }), false);
    assert.strictEqual(emb.isEmbedUsable({ enabled: true, baseUrl: 'http://x', model: '' }), false);
  });

  // 10) 常量
  check('DEFAULT_EMBED_MODELS 关键厂商默认模型', () => {
    assert.strictEqual(emb.DEFAULT_EMBED_MODELS.ollama, 'nomic-embed-text');
    assert.strictEqual(emb.DEFAULT_EMBED_MODELS.dashscope, 'text-embedding-v4');
    assert.strictEqual(emb.DEFAULT_EMBED_MODELS.zhipu, 'embedding-3');
    assert.strictEqual(emb.DEFAULT_EMBED_MODELS.siliconflow, 'BAAI/bge-m3');
  });
  check('NO_EMBED_PROVIDERS 含 deepseek/moonshot/claude', () => {
    assert.ok(emb.NO_EMBED_PROVIDERS.has('deepseek'));
    assert.ok(emb.NO_EMBED_PROVIDERS.has('moonshot'));
    assert.ok(emb.NO_EMBED_PROVIDERS.has('claude'));
  });

  // 11) 工具函数
  check('decodeBase64Floats', () => {
    const b64 = Buffer.from(new Float32Array([1.5, -2, 3.25]).buffer).toString('base64');
    close(emb.decodeBase64Floats(b64), [1.5, -2, 3.25], 1e-5);
  });
  check('chunkArray', () => {
    assert.deepStrictEqual(emb.chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });
  check('normalizeBase 去空白与尾部斜杠', () => {
    assert.strictEqual(emb.normalizeBase('  http://x/v1/  '), 'http://x/v1');
    assert.strictEqual(emb.normalizeBase(''), '');
  });

  // 12) resolveEmbeddingConfig（依赖 vscode mock）
  await checkA('resolveEmbeddingConfig: ollama 本地', async () => {
    configStore['knowledgeBase.embedding'] = {
      enabled: true, provider: 'ollama', baseUrl: 'http://localhost:11434',
      model: 'nomic-embed-text', dimensions: 0, batchSize: 0, timeout: 30000, hybrid: true
    };
    const e = await emb.resolveEmbeddingConfig(null);
    assert.strictEqual(e.enabled, true);
    assert.strictEqual(e.kind, 'ollama');
    assert.strictEqual(e.baseUrl, 'http://localhost:11434');
    assert.strictEqual(e.model, 'nomic-embed-text');
    assert.strictEqual(e.local, true);
    assert.strictEqual(e.batchSize, 32);
    assert.strictEqual(e.hybrid, true);
  });
  await checkA('resolveEmbeddingConfig: 百炼云端 + 独立密钥', async () => {
    const ctx = { secrets: { get: async () => 'sk-test', store: async () => {} } };
    configStore['knowledgeBase.embedding'] = {
      enabled: true, provider: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'text-embedding-v4', dimensions: 1024, batchSize: 0, timeout: 30000, hybrid: true
    };
    const e = await emb.resolveEmbeddingConfig(ctx);
    assert.strictEqual(e.kind, 'openai');
    assert.strictEqual(e.model, 'text-embedding-v4');
    assert.strictEqual(e.dimensions, 1024);
    assert.strictEqual(e.batchSize, 10);
    assert.strictEqual(e.local, false);
    assert.strictEqual(e.apiKey, 'sk-test');
  });
  await checkA('resolveEmbeddingConfig: 缺模型时回退默认', async () => {
    configStore['knowledgeBase.embedding'] = {
      enabled: true, provider: 'zhipu', baseUrl: 'http://zhipu',
      model: '', dimensions: 0, batchSize: 0, timeout: 30000, hybrid: true
    };
    const e = await emb.resolveEmbeddingConfig(null);
    assert.strictEqual(e.model, 'embedding-3');
  });

  check('isMultimodalEmbedModel: vl-embedding / vision 识别为多模态', () => {
    assert.strictEqual(emb.isMultimodalEmbedModel('qwen3-vl-embedding'), true);
    assert.strictEqual(emb.isMultimodalEmbedModel('tongyi-embedding-vision-plus'), true);
    assert.strictEqual(emb.isMultimodalEmbedModel('multimodal-embedding-v1'), true);
  });
  check('isMultimodalEmbedModel: 文本向量模型不误判', () => {
    assert.strictEqual(emb.isMultimodalEmbedModel('text-embedding-v4'), false);
    assert.strictEqual(emb.isMultimodalEmbedModel('qwen3-embedding'), false);
    assert.strictEqual(emb.isMultimodalEmbedModel('nomic-embed-text'), false);
    assert.strictEqual(emb.isMultimodalEmbedModel('embedding-3'), false);
  });
  await checkA('resolveEmbeddingConfig: 多模态模型标记 multimodal=true（回退 BM25 不被误用）', async () => {
    configStore['knowledgeBase.embedding'] = {
      enabled: true, provider: 'dashscope',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3-vl-embedding', dimensions: 0, batchSize: 0, timeout: 30000, hybrid: true
    };
    const e = await emb.resolveEmbeddingConfig(null);
    assert.strictEqual(e.multimodal, true);
  });

  console.log(`\nembedding 测试：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
