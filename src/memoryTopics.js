'use strict';

/**
 * src/memoryTopics.js — 结构化跨会话记忆（主题化 + 按需加载 + 自动沉淀）
 *
 * 原来的 src/memory.js 是「一个扁平列表，全量注入提示词」，条目一多就挤爆上下文，
 * 且全靠模型主动调 save_memory，用户说过的约定经常没被记下来。
 *
 * 本模块对标 Claude Code 的 Auto Memory / Copilot 的 Memory+Spaces：
 *   1. 主题化：记忆按主题分文件存放（项目约定 / 用户偏好 / 踩坑教训 / 架构决策 / 工作流…）
 *   2. 索引：MEMORY.md 汇总每个主题的条目数与摘要，模型先看索引再决定读哪个主题
 *   3. 按需加载：根据当前问题只注入最相关的 1-3 个主题，而非全量倾倒
 *   4. 自动沉淀：会话结束时从对话里规则式抽取「用户纠正 / 明确约定 / 偏好声明」自动入库
 *
 * 存储（Markdown，人可读可手改）：
 *   <base>/memory-topics/MEMORY.md
 *   <base>/memory-topics/topics/<slug>.md
 *
 * 零外部依赖，可离线单测。
 */

const fs = require('fs');
const path = require('path');
const { appendLog } = require('./log');

/** 内置主题定义：slug → { title, desc, keywords } */
const TOPICS = {
  'project-conventions': {
    title: '项目约定',
    desc: '代码规范、目录结构、命名习惯、构建与提交流程等团队/项目层面的硬性约定',
    keywords: ['约定', '规范', '规约', '风格', '统一', '目录', '命名', '必须', '禁止', '流程', '提交', '构建', '打包', 'lint', 'eslint', 'prettier', 'convention', 'standard']
  },
  'user-preferences': {
    title: '用户偏好',
    desc: '用户希望的沟通方式、回答风格、常用技术栈与工具选择',
    keywords: ['偏好', '喜欢', '习惯', '希望', '风格', '简洁', '详细', '中文', '英文', '不要', '别再', '语气', 'prefer', 'style']
  },
  'debugging-lessons': {
    title: '踩坑教训',
    desc: '排查过的 bug、根因、修复方式与「下次别再犯」的经验',
    keywords: ['bug', '报错', '错误', '异常', '崩溃', '失败', '坑', '教训', '根因', '原因', '修复', '解决', '注意', 'fix', 'error', 'issue', '排查']
  },
  'architecture-decisions': {
    title: '架构决策',
    desc: '技术选型、模块划分、依赖取舍及其理由',
    keywords: ['架构', '设计', '选型', '方案', '模块', '拆分', '依赖', '框架', '技术栈', '决定', '采用', '改用', 'architecture', 'design', '重构']
  },
  workflows: {
    title: '工作流程',
    desc: '可复用的操作步骤：部署、测试、发布、环境准备等',
    keywords: ['流程', '步骤', '部署', '发布', '测试', '环境', '启动', '运行', '命令', '脚本', '每次', '先', '再', 'deploy', 'release', 'workflow']
  },
  'domain-knowledge': {
    title: '领域知识',
    desc: '业务规则、术语定义、外部系统的接口约定',
    keywords: ['业务', '术语', '定义', '规则', '接口', 'api', '字段', '含义', '文档', '需求', 'domain']
  },
  general: {
    title: '其它',
    desc: '未归入以上主题的零散记忆',
    keywords: []
  }
};

const TOPIC_SLUGS = Object.keys(TOPICS);
const DEFAULT_BUDGET = 2500; // 按需加载注入提示词的字符预算

/* ---------------- 工具 ---------------- */

function normalizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * 剥离条目行上的元信息（来源标注、日期注释），只留正文。
 * 去重比对必须用正文，否则「原文」与「带注释的已存条目」永远比不出相同，
 * 会导致同一条记忆被反复写入（自动沉淀每次会话都追加一遍）。
 */
function bodyOf(line) {
  return normalizeText(
    String(line || '')
      .replace(/\s*<!--[\s\S]*?-->\s*$/, '')
      .replace(/（来源：[^）]*）\s*$/, '')
      .replace(/\(来源：[^)]*\)\s*$/, '')
  );
}

function bigrams(s) {
  const out = [];
  const str = String(s || '');
  for (let i = 0; i < str.length - 1; i++) out.push(str.slice(i, i + 2));
  return out;
}

/** 字符 bigram Jaccard 相似度，用于近重复判定 */
function similarity(a, b) {
  const x = normalizeText(a).toLowerCase().replace(/\s/g, '');
  const y = normalizeText(b).toLowerCase().replace(/\s/g, '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 6 || y.length < 6) return x === y ? 1 : 0;
  const A = new Set(bigrams(x));
  const B = new Set(bigrams(y));
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * 按关键词把一条记忆路由到主题。
 * @returns {string} slug
 */
function routeTopic(text, hint) {
  const s = String(text || '').toLowerCase();
  if (hint && TOPICS[hint]) return hint;
  let best = 'general';
  let bestScore = 0;
  for (const slug of TOPIC_SLUGS) {
    if (slug === 'general') continue;
    let score = 0;
    for (const kw of TOPICS[slug].keywords) {
      if (s.includes(String(kw).toLowerCase())) score += kw.length >= 3 ? 2 : 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = slug;
    }
  }
  return bestScore > 0 ? best : 'general';
}

/* ---------------- 自动沉淀（从对话里抽取） ---------------- */

// 触发「值得记住」的句式
const HARVEST_PATTERNS = [
  { re: /(?:请?)?记住[:：]?\s*(.{4,120})/, weight: 3 },
  { re: /(?:以后|下次|今后|之后)(?:都|请|要|记得)?\s*(.{4,120})/, weight: 2 },
  { re: /(?:我们|本项目|这个项目|团队)(?:的)?(?:约定|规范|要求|规则)(?:是)?[:：]?\s*(.{4,120})/, weight: 3 },
  { re: /(?:不要|别再|禁止|千万别)\s*(.{4,120})/, weight: 2 },
  { re: /(?:必须|一定要|务必)\s*(.{4,120})/, weight: 2 },
  { re: /(?:我)(?:喜欢|偏好|习惯)\s*(.{4,120})/, weight: 2 },
  { re: /(?:错了|不对|不是这样|你搞错了|重来)[，,。.\s]*(.{6,120})/, weight: 2 }
];

// 明显不值得记的（一次性指令、闲聊）
const HARVEST_BLOCK = /^(?:好的|谢谢|收到|继续|嗯+|ok|okay|行|可以|试试|再来|停|等等)[\s。.!！]*$/i;

/**
 * 从对话消息里抽取候选记忆。纯规则式，零模型调用，不产生额外开销。
 * @param {Array<{role:string, content:any}>} messages
 * @param {object} [opts] { maxItems }
 * @returns {Array<{text:string, topic:string, weight:number}>}
 */
function harvest(messages, opts) {
  const o = opts || {};
  const maxItems = o.maxItems || 8;
  const found = [];
  const list = Array.isArray(messages) ? messages : [];
  for (const m of list) {
    if (!m || m.role !== 'user') continue;
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.map((p) => (p && typeof p === 'object' ? p.text || '' : String(p || ''))).join(' ');
    }
    const text = normalizeText(content);
    if (!text || text.length < 6) continue;
    if (HARVEST_BLOCK.test(text)) continue;
    if (text.startsWith('[系统]')) continue;
    for (const p of HARVEST_PATTERNS) {
      const mm = text.match(p.re);
      if (!mm) continue;
      // 取匹配到的整句（含触发词），更完整可读
      let sentence = normalizeText(mm[0]);
      // 截到句末标点。注意：英文点号只有在后跟空白/结尾时才算句末，
      // 否则 "不要带 console.log" 会被截成 "不要带 console."（丢掉关键信息）。
      const cut = sentence.search(/[。！？；]|[.!?;](?=\s|$)/);
      if (cut > 8) sentence = sentence.slice(0, cut + 1);
      sentence = sentence.slice(0, 160).trim();
      if (sentence.length < 6) continue;
      if (found.some((f) => similarity(f.text, sentence) >= 0.8)) continue;
      found.push({ text: sentence, topic: routeTopic(sentence), weight: p.weight });
      break; // 一条消息只取最先命中的一个模式
    }
  }
  found.sort((a, b) => b.weight - a.weight);
  return found.slice(0, maxItems);
}

/* ---------------- 主题记忆库 ---------------- */

class TopicMemory {
  /**
   * @param {object} opts
   * @param {string} opts.baseDir 存储根目录
   * @param {boolean} [opts.enabled]
   * @param {number} [opts.budget] 按需加载的字符预算
   */
  constructor(opts) {
    const o = opts || {};
    this.enabled = o.enabled !== false;
    this.dir = path.join(o.baseDir || process.cwd(), 'memory-topics');
    this.topicDir = path.join(this.dir, 'topics');
    this.indexFile = path.join(this.dir, 'MEMORY.md');
    this.budget = Number(o.budget) > 0 ? Number(o.budget) : DEFAULT_BUDGET;
  }

  _file(slug) {
    return path.join(this.topicDir, slug + '.md');
  }

  /** 读取某主题的全部条目（一行一条，以 "- " 开头） */
  read(slug) {
    if (!TOPICS[slug]) return [];
    try {
      const f = this._file(slug);
      if (!fs.existsSync(f)) return [];
      return fs
        .readFileSync(f, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim().startsWith('- '))
        .map((l) => l.trim().slice(2).trim())
        .filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  /**
   * 写入一条记忆（自动路由主题、近重复去重）。
   * @param {string} text
   * @param {object} [opts] { topic, source }
   * @returns {{ok:boolean, topic:string, duplicated:boolean, text:string}}
   */
  write(text, opts) {
    const o = opts || {};
    const t = normalizeText(text);
    if (!this.enabled || !t || t.length < 4) return { ok: false, topic: '', duplicated: false, text: t };
    const slug = TOPICS[o.topic] ? o.topic : routeTopic(t);
    const existing = this.read(slug);
    for (const e of existing) {
      // 比对正文，忽略来源标注与日期注释（否则自动沉淀会每轮重复写入）
      if (similarity(bodyOf(e), t) >= 0.85) {
        appendLog('memoryTopics', '[skip-dup] topic=' + slug + ' text=' + t.slice(0, 50));
        return { ok: true, topic: slug, duplicated: true, text: t };
      }
    }
    try {
      fs.mkdirSync(this.topicDir, { recursive: true });
      const f = this._file(slug);
      if (!fs.existsSync(f)) {
        fs.writeFileSync(f, `# ${TOPICS[slug].title}\n\n> ${TOPICS[slug].desc}\n\n`, 'utf8');
      }
      const stamp = new Date().toISOString().slice(0, 10);
      fs.appendFileSync(f, `- ${t}${o.source ? `（来源：${o.source}）` : ''} <!-- ${stamp} -->\n`, 'utf8');
      this.writeIndex();
      appendLog('memoryTopics', '[write] topic=' + slug + ' text=' + t.slice(0, 60));
      return { ok: true, topic: slug, duplicated: false, text: t };
    } catch (e) {
      appendLog('memoryTopics', '[write-fail] ' + (e && e.message));
      return { ok: false, topic: slug, duplicated: false, text: t };
    }
  }

  /** 批量写入（自动沉淀用） */
  writeMany(items) {
    const res = { written: 0, skipped: 0, topics: {} };
    for (const it of items || []) {
      const text = typeof it === 'string' ? it : it && it.text;
      const topic = typeof it === 'object' && it ? it.topic : undefined;
      const r = this.write(text, { topic, source: (it && it.source) || undefined });
      if (!r.ok) continue;
      if (r.duplicated) res.skipped++;
      else {
        res.written++;
        res.topics[r.topic] = (res.topics[r.topic] || 0) + 1;
      }
    }
    return res;
  }

  /** 删除某条（按完全匹配或包含） */
  remove(slug, text) {
    const f = this._file(slug);
    if (!fs.existsSync(f)) return false;
    try {
      const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
      const target = normalizeText(text);
      let removed = false;
      const kept = lines.filter((l) => {
        if (!l.trim().startsWith('- ')) return true;
        const body = l.trim().slice(2);
        if (!removed && (body === target || body.includes(target))) {
          removed = true;
          return false;
        }
        return true;
      });
      if (removed) {
        fs.writeFileSync(f, kept.join('\n'), 'utf8');
        this.writeIndex();
      }
      return removed;
    } catch (_) {
      return false;
    }
  }

  /** 所有主题概况 */
  listTopics() {
    return TOPIC_SLUGS.map((slug) => ({
      slug,
      title: TOPICS[slug].title,
      desc: TOPICS[slug].desc,
      count: this.read(slug).length
    })).filter((t) => t.count > 0 || t.slug !== 'general');
  }

  get totalCount() {
    return TOPIC_SLUGS.reduce((n, s) => n + this.read(s).length, 0);
  }

  /** 重写 MEMORY.md 索引 */
  writeIndex() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const lines = [
        '# 长期记忆索引',
        '',
        '> 由狐狸 AI 自动维护。每个主题一个文件，位于 topics/ 目录，可直接手动编辑。',
        ''
      ];
      let total = 0;
      for (const slug of TOPIC_SLUGS) {
        const items = this.read(slug);
        if (!items.length) continue;
        total += items.length;
        lines.push(`## ${TOPICS[slug].title} \`${slug}\` — ${items.length} 条`);
        lines.push(`${TOPICS[slug].desc}`);
        // 摘要：取最近 3 条
        for (const it of items.slice(-3)) lines.push(`- ${bodyOf(it)}`);
        lines.push('');
      }
      lines.splice(3, 0, `共 ${total} 条记忆，${this.listTopics().filter((t) => t.count).length} 个主题。更新于 ${new Date().toLocaleString('zh-CN')}`, '');
      fs.writeFileSync(this.indexFile, lines.join('\n'), 'utf8');
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * 按需加载：根据当前问题挑最相关的主题内容注入。
   * @param {string} query
   * @param {object} [opts] { budget, maxTopics, always }
   * @returns {{text:string, topics:string[], items:number}}
   */
  loadRelevant(query, opts) {
    const o = opts || {};
    if (!this.enabled) return { text: '', topics: [], items: 0 };
    const budget = o.budget || this.budget;
    const maxTopics = o.maxTopics || 3;
    const q = String(query || '').toLowerCase();

    const scored = [];
    for (const slug of TOPIC_SLUGS) {
      const items = this.read(slug);
      if (!items.length) continue;
      let score = 0;
      // 主题关键词命中
      for (const kw of TOPICS[slug].keywords) {
        if (q.includes(String(kw).toLowerCase())) score += 3;
      }
      // 条目内容命中（词面重合）
      for (const it of items) {
        const low = it.toLowerCase();
        // 取查询里长度 >= 2 的片段做粗匹配
        const words = q.match(/[a-z0-9_]{3,}|[\u4e00-\u9fa5]{2,}/g) || [];
        for (const w of words) if (low.includes(w)) score += 2;
      }
      // 「用户偏好」和「项目约定」是全局性的，始终给一点基础分
      if (slug === 'user-preferences' || slug === 'project-conventions') score += 1.5;
      scored.push({ slug, score, items });
    }

    if (!scored.length) return { text: '', topics: [], items: 0 };
    scored.sort((a, b) => b.score - a.score);

    const picked = [];
    const alwaysSet = new Set(o.always || []);
    for (const s of scored) {
      if (picked.length >= maxTopics && !alwaysSet.has(s.slug)) continue;
      if (s.score <= 0 && !alwaysSet.has(s.slug)) continue;
      picked.push(s);
    }
    if (!picked.length) picked.push(scored[0]);

    const lines = ['你拥有跨会话的结构化长期记忆，以下是与当前任务最相关的部分：'];
    let chars = 0;
    let count = 0;
    const usedTopics = [];
    for (const p of picked) {
      const head = `\n【${TOPICS[p.slug].title}】`;
      if (chars + head.length > budget) break;
      lines.push(head);
      chars += head.length;
      usedTopics.push(p.slug);
      // 越新的越靠后写入文件，倒序取（新的优先）
      for (const it of p.items.slice().reverse()) {
        const clean = bodyOf(it);
        const line = `- ${clean}`;
        if (chars + line.length > budget) break;
        lines.push(line);
        chars += line.length;
        count++;
      }
    }
    if (!count) return { text: '', topics: [], items: 0 };
    lines.push('\n（与当前任务无关的可忽略；用户提出新约定或纠正你时，用 save_memory 记下来。）');
    return { text: lines.join('\n'), topics: usedTopics, items: count };
  }

  /** 生成主题目录清单（给模型看的"有哪些主题可读"） */
  renderTopicIndex() {
    const list = this.listTopics().filter((t) => t.count > 0);
    if (!list.length) return '';
    return (
      '【记忆主题目录】（可用 get_memory 指定 topic 读取完整内容）\n' +
      list.map((t) => `- ${t.slug}（${t.title}）：${t.count} 条 — ${t.desc}`).join('\n')
    );
  }

  /**
   * 会话结束时自动沉淀。
   * @param {Array} messages
   * @param {object} [opts]
   * @returns {{written:number, skipped:number, topics:object, candidates:number}}
   */
  autoHarvest(messages, opts) {
    if (!this.enabled) return { written: 0, skipped: 0, topics: {}, candidates: 0 };
    const cands = harvest(messages, opts);
    const r = this.writeMany(cands.map((c) => ({ text: c.text, topic: c.topic, source: '自动沉淀' })));
    appendLog('memoryTopics', '[auto-harvest] candidates=' + cands.length + ' written=' + r.written + ' skipped=' + r.skipped);
    return Object.assign(r, { candidates: cands.length });
  }

  clear() {
    try {
      if (fs.existsSync(this.topicDir)) fs.rmSync(this.topicDir, { recursive: true, force: true });
      if (fs.existsSync(this.indexFile)) fs.unlinkSync(this.indexFile);
    } catch (_) {}
  }
}

module.exports = { TopicMemory, TOPICS, TOPIC_SLUGS, routeTopic, harvest, similarity, bodyOf };
