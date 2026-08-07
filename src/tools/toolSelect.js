'use strict';

/**
 * src/tools/toolSelect.js — 「手术刀式」工具子集选择（纯函数，无 vscode 依赖，可独立单测）
 *
 * 对应生产级落地方法论「工具按语义动态检索子集」：只把与当前问题最相关的少量工具
 * 注入系统提示词，避免 31 个工具描述（占 context 30%+）全量常驻烧 Token。
 *
 * 设计要点（防回归）：
 * - 只决定「注入哪些工具名」，不禁用任何工具——执行仍走 getTool(name) 解析全量工具，
 *   被子集排除的工具模型只是「看不到」，绝不会调用失败。
 * - 一组核心工具永远注入（时效性/联网/文件读写/执行/检索），避免子集误判导致能力丧失。
 * - query 为空或子集未开启时返回 null（调用方据此注入全量）。
 */

// 中文停用词/无意义单字，减少噪声
const TOOL_STOP = new Set([
  '的', '了', '吗', '呢', '吧', '啊', '是', '在', '我', '你', '他', '它',
  '这', '那', '把', '被', '用', '和', '与', '或', '请', '怎么', '如何', '什么', '为什么'
]);

// 无论如何都注入的核心工具（子集误判也不能丢这些能力）
const CORE_ALWAYS = new Set([
  'current_time', 'web_search', 'read_file', 'write_file', 'edit_file',
  'run_command', 'search_text', 'list_dir', 'find_files', 'get_diagnostics',
  'get_terminal_output',
  // 技能 / 规划 / 记忆 / 知识库：英文名在中文 query 下基本匹配不上，必须常驻，
  // 否则开启 dynamicSubset 后原生 function calling 里这些工具「看不到」也就调不了，
  // 导致能力①规划执行分离、能力⑤分层记忆、用户技能、MCP 静默失效。
  'create_skill', 'use_skill',
  'create_plan_task', 'update_plan_task', 'list_plan_tasks',
  'save_memory', 'get_memory',
  'write_organize', 'read_organize'
]);

function tokenize(text) {
  const t = String(text || '');
  const tokens = new Set();
  const en = t.toLowerCase().match(/[a-z0-9_]+/g);
  if (en) for (const w of en) if (w.length >= 2) tokens.add(w);
  const cn = t.match(/[一-龥]+/g);
  if (cn) for (const seg of cn) {
    if (seg.length === 1) { if (!TOOL_STOP.has(seg)) tokens.add(seg); }
    else for (let i = 0; i < seg.length - 1; i++) tokens.add(seg.slice(i, i + 2));
  }
  return tokens;
}

function toolCorpus(t) {
  const props = (t.parameters && t.parameters.properties) ? Object.keys(t.parameters.properties) : [];
  return (t.name + ' ' + (t.description || '') + ' ' + props.join(' '));
}

function scoreTool(name, corpus, qt) {
  if (!qt || !qt.size) return 0;
  const ct = tokenize(corpus);
  let hit = 0;
  for (const q of qt) {
    if (name.includes(q)) hit += 3; // 工具名命中权重最高
    if (ct.has(q)) hit += 1;
  }
  return hit;
}

/**
 * @param {Array<{name:string, description?:string, parameters?:object}>} tools 全量工具
 * @param {string} query 当前用户问题
 * @param {{enabled?:boolean, topK?:number, alwaysInclude?:string}} ds 动态子集配置
 * @returns {string[]|null} 应注入的工具名数组；未开启或 query 无信号返回 null（注入全量）
 */
function selectSubsetNames(tools, query, ds) {
  if (!ds || !ds.enabled) return null;
  const qt = tokenize(query);
  if (!qt.size) return null; // 空 query 不推断，注入全量更安全
  const topK = Math.max(3, Number(ds.topK) || 12);
  const userAlways = new Set(String(ds.alwaysInclude || '').split(',').map((s) => s.trim()).filter(Boolean));
  const forced = new Set([...CORE_ALWAYS, ...userAlways]);
  // 所有 MCP 接入的工具（mcp__*）一律强制保留：它们数量不固定、名字带服务器前缀，
  // 在中文 query 下几乎不可能被语义匹配命中，一旦被子集排除就再也调不到。
  for (const t of tools) {
    if (typeof t.name === 'string' && t.name.startsWith('mcp__')) forced.add(t.name);
  }

  const scored = tools.map((t) => ({ name: t.name, score: scoreTool(t.name, toolCorpus(t), qt) }));
  const forcedList = scored.filter((s) => forced.has(s.name));
  const rest = scored.filter((s) => !forced.has(s.name)).sort((a, b) => b.score - a.score);
  const picked = rest.filter((s) => s.score > 0).slice(0, topK);
  return [...forcedList, ...picked].map((s) => s.name);
}

module.exports = { TOOL_STOP, CORE_ALWAYS, tokenize, toolCorpus, scoreTool, selectSubsetNames };
