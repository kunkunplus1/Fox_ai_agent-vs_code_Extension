'use strict';

/**
 * 幻觉·双重验证（Self-Consistency，纯逻辑可单测）
 *
 * 对高风险工具调用，执行前用「不同温度」再请模型推导一次同一决策：
 * - 一致（工具名相同 + 参数足够相似）→ 放行执行；
 * - 不一致 → 暂停该操作并提示人工复核（不盲执行）。
 *
 * - normalizeArgs / argSimilarity / areConsistent：纯比较逻辑，已单测覆盖。
 * - verifyCall(call, messages, cfg, callModel)：执行实际的二次推导。
 *   模型再推导通过注入的 callModel(messages, opts) => Promise<string> 完成，
 *   本模块不依赖 vscode / client，调用方（agent.js）提供 callModel。
 *
 * 默认守卫的高风险工具：执行类（run_command）、写类（edit/write/delete_file）、
 * 以及代码审查/安全自检这类「改动或判断影响大」的工具。
 */

const GUARD_DEFAULT = ['run_command', 'edit_file', 'write_file', 'delete_file', 'security_audit', 'review_changes'];

function normalizeArgs(args) {
  if (args == null) return {};
  if (typeof args !== 'object') return { _scalar: String(args) };
  const out = {};
  for (const k of Object.keys(args).sort()) {
    const v = args[k];
    if (v == null) continue;
    out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

function argSimilarity(a, b) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (!ka.length && !kb.length) return 1;
  if (!ka.length || !kb.length) return 0;
  const setA = new Set(ka);
  const setB = new Set(kb);
  let inter = 0;
  for (const k of setA) if (setB.has(k)) inter += 1;
  const union = new Set([...ka, ...kb]).size;
  const jaccard = inter / union;
  let valHit = 0;
  let valTot = 0;
  for (const k of ka) {
    if (!setB.has(k)) continue;
    valTot += 1;
    const va = a[k];
    const vb = b[k];
    if (va === vb) { valHit += 1; continue; }
    // 长文本：用「较短串是否被较长串包含 50% 前缀」近似，容忍小幅改写
    const shorter = va.length <= vb.length ? va : vb;
    const longer = va.length <= vb.length ? vb : va;
    if (shorter.length > 40 && longer.includes(shorter.slice(0, Math.min(shorter.length, 60)))) valHit += 0.5;
  }
  const valSim = valTot ? valHit / valTot : 0;
  // 键集合（结构性）占 40%，值相似占 60%
  return jaccard * 0.4 + valSim * 0.6;
}

function areConsistent(orig, alt, threshold = 0.7) {
  if (!orig || !alt) return false;
  if (orig.name !== alt.name) return false;
  return argSimilarity(normalizeArgs(orig.args), normalizeArgs(alt.args)) >= threshold;
}

function parseToolCall(text) {
  if (!text) return null;
  // 去掉 ```json / ``` 围栏（模型二次推导常把 <fox:tool> 包进代码块）
  let s = String(text)
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim();
  // 优先匹配 <foxtool> / <fox:tool> 标记（容忍单/双引号变体，冒号可选）
  const m = s.match(/<fox:?tool\s+name="([^"]+)"\s*>([\s\S]*?)<\/fox:?tool>/i)
    || s.match(/<fox:?tool\s+name=([^\s>]+)\s*>([\s\S]*?)<\/fox:?tool>/i);
  let name = null;
  let argsRaw = null;
  if (m) {
    name = m[1];
    argsRaw = m[2];
  } else {
    // 退路：裸 JSON 形态 {name, args|parameters|arguments}
    const jm = s.match(/\{[\s\S]*\}/);
    if (jm) {
      try {
        const obj = JSON.parse(jm[0].replace(/'/g, '"'));
        if (obj && obj.name) {
          name = obj.name;
          const a = obj.args != null ? obj.args : obj.parameters != null ? obj.parameters : obj.arguments != null ? obj.arguments : {};
          argsRaw = JSON.stringify(a);
        }
      } catch (_) { /* ignore */ }
    }
  }
  if (!name) return null;
  let args = {};
  try {
    args = JSON.parse(argsRaw);
  } catch (_) {
    try { args = JSON.parse(String(argsRaw).replace(/'/g, '"')); } catch (_) { args = {}; }
  }
  return { name, args };
}

async function verifyCall(call, messages, cfg, callModel) {
  const sc = (cfg && cfg.selfConsistency) || {};
  const guard = Array.isArray(sc.tools) && sc.tools.length ? sc.tools : GUARD_DEFAULT;
  if (guard.indexOf(call.name) === -1) {
    return { consistent: true, guarded: false };
  }
  const sys = '你正在复核下一步要调用的工具。基于对话，只输出接下来应执行的单个工具调用，'
    + '格式：<foxtool name="工具名">JSON参数</foxtool>。不要解释。';
  const prompt = '请重新确认：基于以上上下文，下一步最应该调用哪个工具、参数是什么？';
  const out = await callModel([...messages, { role: 'user', content: prompt }], {
    system: sys,
    temperature: sc.sampleTemp != null ? sc.sampleTemp : 0.8,
    maxTokens: 600
  });
  const alt = parseToolCall(out);
  if (!alt) {
    return { consistent: false, guarded: true, reason: '复核未能解析出工具调用', alt: null };
  }
  const consistent = areConsistent(call, alt);
  return {
    consistent,
    guarded: true,
    alt,
    reason: consistent ? '' : `复核建议改用：${alt.name}(${JSON.stringify(alt.args).slice(0, 200)})`
  };
}

module.exports = { areConsistent, normalizeArgs, argSimilarity, verifyCall, GUARD_DEFAULT, parseToolCall };
