'use strict';

/**
 * Auto Mode：用一次轻量 LLM 分类对“即将执行的动作”做门控（allow / deny / ask）。
 *
 * 设计原则（用户硬约束）：
 *  - 零 vscode 依赖：纯 Node 模块，单测友好，不常驻内存。
 *  - 懒加载：仅在 foxAi.autoMode.enabled 时由 agent.js require，平时不进内存。
 *  - 配置门控：默认关；规则快路径（allow/deny 名单）命中即返回，不调 LLM。
 *  - 有界缓存：tool + argHash -> decision，Map 上限 + 淘汰最早项，不保留对话历史。
 *  - 用完即弃：LLM 兜底只回一个 JSON 决策，缓存结构化结论，不留存任何上下文。
 *
 * 与既有底座的关系：策略引擎(policy)、Agent 模式门控、preToolUse 钩子仍是硬约束，
 * Auto Mode 只是在“需要人工审批的动作”上补一层“自动放行 / 自动拒绝”的智能判断。
 */

const crypto = require('crypto');

const MAX_CACHE = 256;
const _cache = new Map(); // key = toolName\x00argHash -> { decision, reason }

/** 有界淘汰：超过上限时删最早写入项（Map 保持插入顺序即近似 LRU）。 */
function _cacheSet(key, val) {
  if (_cache.size >= MAX_CACHE && _cache.size > 0) {
    const fk = _cache.keys().next().value;
    if (fk !== undefined) _cache.delete(fk);
  }
  _cache.set(key, val);
}

/** 参数指纹：同一 tool+同一参数只分类一次，避免重复烧 LLM。 */
function argHash(args) {
  try {
    return crypto.createHash('sha1').update(JSON.stringify(args || {})).digest('hex').slice(0, 16);
  } catch (_) {
    return '0';
  }
}

/** 规则快路径：allow/deny 名单命中即返回，零 LLM 开销。 */
function ruleFastPath(toolName, cfg) {
  const allow = (cfg && cfg.allow) || [];
  const deny = (cfg && cfg.deny) || [];
  if (deny.indexOf(toolName) !== -1) return { decision: 'deny', reason: '命中拒绝名单' };
  if (allow.indexOf(toolName) !== -1) return { decision: 'allow', reason: '命中放行名单' };
  return null;
}

/** 把工具调用压成给 LLM 的简短描述，长字段截断，避免把大文件塞进分类提示词。 */
function describeCall(toolName, kind, args) {
  let s = '工具: ' + toolName + ' (kind=' + (kind || '?') + ')\n';
  if (args && typeof args === 'object') {
    const safe = {};
    for (const k of Object.keys(args)) {
      let v = args[k];
      if (k === 'command' || k === 'path' || k === 'old_text' || k === 'new_text' || k === 'content') {
        v = String(v == null ? '' : v).slice(0, 300);
      } else if (typeof v === 'string') {
        v = v.length > 120 ? v.slice(0, 120) + '…' : v;
      }
      safe[k] = v;
    }
    s += '参数摘要: ' + JSON.stringify(safe);
  }
  return s;
}

/** 容错解析 LLM 回包：优先 JSON，失败再退到关键词，再不行就 ask。 */
function parseDecision(text) {
  if (!text) return { decision: 'ask', reason: '' };
  const m = String(text).match(/\{[\s\S]*\}/);
  let obj = null;
  if (m) {
    try { obj = JSON.parse(m[0]); } catch (_) { obj = null; }
  }
  if (!obj) {
    const low = String(text).toLowerCase();
    if (/\bdeny\b/.test(low)) return { decision: 'deny', reason: 'LLM 判定为拒绝' };
    if (/\ballow\b/.test(low)) return { decision: 'allow', reason: 'LLM 判定为放行' };
    return { decision: 'ask', reason: '' };
  }
  const d = obj.decision;
  if (d !== 'allow' && d !== 'deny' && d !== 'ask') return { decision: 'ask', reason: '' };
  return { decision: d, reason: String(obj.reason || '') };
}

/**
 * 主分类入口。
 * @param {string} toolName
 * @param {string} kind 工具 kind（edit/write/delete/exec/read/search/query…）
 * @param {object} args 工具参数
 * @param {object} opts { config, llm }
 *   - config: foxAi.autoMode 配置对象（含 allow/deny 名单）
 *   - llm: 可选兜底函数 (prompt:string) => Promise<string>，由调用方注入（内部复用 _silentCall）
 * @returns {Promise<{decision:'allow'|'deny'|'ask', reason:string, fromRule?:boolean, fromCache?:boolean, fromLLM?:boolean}>}
 */
async function classify(toolName, kind, args, opts) {
  opts = opts || {};
  const cfg = opts.config || {};

  // 1) 规则快路径（零 LLM 开销）
  const rp = ruleFastPath(toolName, cfg);
  if (rp) return Object.assign({ fromRule: true }, rp);

  // 2) 缓存命中（tool + 参数指纹）
  const key = toolName + '\x00' + argHash(args);
  const hit = _cache.get(key);
  if (hit) return { decision: hit.decision, reason: hit.reason, fromCache: true };

  // 3) 没有 LLM 兜底 → 转人工（保持默认审批流）
  if (typeof opts.llm !== 'function') {
    return { decision: 'ask', reason: '未配置 LLM 兜底分类，按默认审批流程', fromRule: false };
  }

  const prompt = [
    '你是智能体动作安全门。根据下面的工具调用，判断应自动放行(allow)、拒绝(deny)还是转人工(ask)。',
    '放行标准：改动范围明确且可逆、不触碰系统敏感路径、不执行破坏性强命令（如 rm -rf、git push --force、清空数据库）。',
    '拒绝标准：删除/覆盖大量文件、推送到远端仓库、强制覆盖、读写系统敏感区、命令或参数中含有明文密钥/令牌。',
    '其余情况一律 ask。只输出一个 JSON 对象，不要任何解释：{"decision":"allow|deny|ask","reason":"简短中文理由"}',
    '---',
    describeCall(toolName, kind, args)
  ].join('\n');

  let res;
  try {
    res = await opts.llm(prompt);
  } catch (_) {
    return { decision: 'ask', reason: 'LLM 分类调用异常，转人工', fromLLM: false };
  }
  const parsed = parseDecision(typeof res === 'string' ? res : (res && res.text ? res.text : (res && res.content ? res.content : '')));
  const val = { decision: parsed.decision, reason: parsed.reason };
  _cacheSet(key, val);
  return Object.assign({ fromLLM: true }, val);
}

function invalidate() { _cache.clear(); }
function cacheSize() { return _cache.size; }

module.exports = { classify, invalidate, cacheSize, describeCall, ruleFastPath, argHash, parseDecision };
