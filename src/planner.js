'use strict';

/**
 * 架构·规划-执行分离（轻量规划器，纯逻辑可单测）
 *
 * 用一次「低成本、低随机」的调用把用户请求拆成带依赖/并行标记的步骤清单（DAG），
 * 与后续执行解耦，避免 agent 在长链路里「边想边错」。
 *
 * - parsePlan(text)：把模型输出（JSON 数组或编号列表）解析为标准化步骤。
 *   纯函数，已单测覆盖。
 * - generatePlan(messages, cfg, callModel)：执行轻量规划调用。
 *   模型再推导通过「注入的 callModel」完成，本模块不依赖 vscode / client，
 *   调用方（agent.js）负责提供一个 callModel(messages, opts) => Promise<string>。
 *
 * 注意：fox-ai 宿主是单线程串行执行，真正的「并行 worker 并发」暂未实现；
 * 这里的价值是「先想清楚再动手」（思考与执行解耦），并把依赖/并行关系结构化，
 * 为将来并行执行预留 DAG。
 */

function normalizeStep(s, i) {
  if (!s || typeof s !== 'object') return null;
  const title = String(s.title || s.name || s.step || '').trim();
  if (!title) return null;
  let deps = s.dependsOn || s.depends_on || s.dependencies || [];
  if (typeof deps === 'string') deps = deps.split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
  const parallel = !!(s.parallel || s.concurrent);
  return {
    id: String(s.id || 's' + (i + 1)),
    title,
    dependsOn: Array.isArray(deps) ? deps.map(String) : [],
    parallel: parallel
  };
}

function parseListPlan(t) {
  const lines = String(t).split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const steps = [];
  let idx = 0;
  for (const line of lines) {
    const m = line.match(/^(?:\d+[.、)]\s*|[-*]\s*)(.+)$/);
    if (!m) continue;
    let body = m[1];
    const parallel = /并行|同时|concurren/i.test(body);
    let deps = [];
    const dm = body.match(/[（(]\s*依赖[:：]?\s*([^）)]+)[）)]/i);
    if (dm) {
      deps = dm[1].split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
      body = body.replace(dm[0], '').trim();
    }
    body = body.replace(/[（(][^）)]*[）)]$/, '').trim();
    if (!body) continue;
    idx += 1;
    steps.push({ id: 's' + idx, title: body, dependsOn: deps, parallel });
  }
  return steps;
}

function parsePlan(text) {
  if (!text) return [];
  const t = String(text).trim();
  // 先尝试从 ```json 围栏或裸 JSON 解析
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : t;
  const jsonMatch = candidate.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const arr = Array.isArray(parsed) ? parsed : (parsed.steps || parsed.plan || []);
      if (Array.isArray(arr) && arr.length) {
        return arr.map((s, i) => normalizeStep(s, i)).filter(Boolean);
      }
    } catch (_) {
      // 落到编号列表解析
    }
  }
  return parseListPlan(t);
}

async function generatePlan(messages, cfg, callModel) {
  const plannerCfg = (cfg && cfg.planner) || {};
  const sys = '把用户需求拆成可执行步骤。只输出 JSON 数组：\n'
    + '[{"id":"s1","title":"步骤","dependsOn":[],"parallel":false}]\n'
    + 'dependsOn=前置步骤id列表，可并行的设parallel=true。仅输出数组，别加解释。';
  const out = await callModel(messages, {
    system: sys,
    temperature: 0,
    maxTokens: plannerCfg.maxTokens || 700
  });
  return parsePlan(out);
}

module.exports = { parsePlan, generatePlan, normalizeStep, parseListPlan };
