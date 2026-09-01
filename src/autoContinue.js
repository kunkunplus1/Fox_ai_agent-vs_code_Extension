'use strict';

/**
 * 判断本次模型返回是否因长度限制截断，且仍可自动继续。
 * 抽出为独立纯函数，便于单测且不依赖 vscode。
 *
 * @param {{content?:string, reasoning?:string, images?:Array, finishReason?:string}} result
 * @param {{maxContinues?:number}} cfg
 * @param {number} continuesUsed 已用继续次数
 * @returns {boolean}
 */
function shouldAutoContinue(result, cfg, continuesUsed) {
  const finishReason = result && result.finishReason;
  const truncated = finishReason === 'length' || finishReason === 'incomplete';
  const content = String((result && result.content) || '');
  const reasoning = String((result && result.reasoning) || '');
  const images = Array.isArray(result && result.images) ? result.images : [];
  const hasContent = !!(content.trim() || reasoning.trim() || images.length);
  const cfgMax = cfg && cfg.maxContinues;
  const maxContinues = cfgMax === undefined || cfgMax === null || cfgMax === '' ? 3 : Math.max(0, Number(cfgMax));
  return truncated && hasContent && continuesUsed < maxContinues;
}

/**
 * 构造「续写」提示：把上一轮被截断内容的末尾若干字回传给模型，
 * 让它明确从哪之后继续，避免从头重复（长度截断续跑失败的常见根因）。
 *
 * 1.1.18g（对齐 DSH goal_round 的中文本土化）：续轮不是纯「接着写」——
 * 模型被截断后容易脱离整体目标、只补眼前一段。传入可选 goalText 时，
 * 构造「【目标续轮】」结构化块（当前目标/已推进轮次/验证再完成），
 * 让续写始终锚定任务目标而不是原地续字。
 * @param {string} lastText 上一轮（被截断的）可见文本
 * @param {{goalText?:string, round?:number}} opts 可选：整体目标描述与已推进轮次
 * @returns {string}
 */
function buildContinuePrompt(lastText, opts) {
  const tail = String(lastText || '').trim();
  const goal = (opts && opts.goalText) ? String(opts.goalText).trim().slice(0, 400) : '';
  const round = opts && opts.round ? Number(opts.round) : 0;
  const head = goal
    ? `【目标续轮】\n当前整体目标：${goal}\n本次是同一任务的第 ${round} 次续写。请始终围绕上述目标继续推进，不要偏离到无关内容；续写完成后检查是否达到目标，若已达到就明确收尾，不要空转。\n\n`
    : '';

  // ---- 半截工具块续写分支（对齐 dsh 续轮收口，1.1.24）----
  // 病灶：模型输出被 max_tokens 掐断时，若截断点正好卡在工具调用中间
  // （如 <foxtool name="read_file">\n{"path":"… 有开无合，或 [[tool:read_file]] 只有开头），
  // 旧续写提示只让模型「续正文」，模型照着补了一段话而不是补完工具块 →
  // 下一轮 parseTextCalls 依旧 count=0（无合法完整块）→ 空轮 ×2 → 会话中断（日志 pid:16484 08-30 02:31 实锤）。
  // 检测必须是「最后一个开标签之后【没有】对应闭合标签」才算半截——
  // 不能用「末尾存在开标签」就判定：已闭合的 <foxtool>…</foxtool> 后跟正文，
  // 开标签同样出现在尾部，但并非半截（1.1.24 回归第 6 用例实锤误判）。
  // 命中时回传「从开标签处起的完整半截块」，明确要求补闭合标签并继续执行该工具。
  const halfBlock = _halfOpenBlock(tail);
  if (halfBlock) {
    const half = halfBlock.slice(0, 600); // 只回传半截块本体（从开标签起，最多 600 字）
    return (
      head + '你刚才的输出因达到单次长度上限被截断，截断点正好落在【还没写完的工具调用块】中间。' +
      '你最后写到的工具块是下面这段（不完整，缺少闭合标签）：\n' +
      '「' + half + '」\n\n' +
      '请【接着把该工具调用块补完整】：补上缺失的参数 JSON（如 {"path": "…"}）、补上闭合标签 ' +
      '</foxtool>（或对应的 [[/tool]]），然后立即停止输出并等待该工具结果——不要输出正文、不要另起新工具块、不要重复上面的内容。'
    );
  }

  if (tail.length > 400) {
    const slice = tail.slice(tail.length - 400);
    return (
      head + '你刚才的输出因达到单次长度上限被截断。你最后写到的内容是下面这段（请务必从它之后继续，' +
      '绝对不要重复这段，直接续写后续内容；本次只输出续写文本，不要调用任何工具、不要输出工具标签）：\n' +
      '「' + slice + '」'
    );
  }
  return head + '继续输出剩余内容，保持与上文连贯，不要重复已经输出的部分；本次只输出续写文本，不要调用任何工具。';
}

/**
 * 非推进检测：若本轮续写内容几乎全落在上一轮文本里（去掉末尾 tail 回传区与开头 echo 区后），
 * 说明模型在原地重复空转，应提前停止自动续跑，而不是白白耗光次数。
 * @param {string} prevChunk 上一轮续写的可见文本
 * @param {string} newChunk 本轮续写的可见文本
 * @returns {boolean}
 */
function isStuckRepeat(prevChunk, newChunk) {
  const a = String(prevChunk || '').trim();
  const b = String(newChunk || '').trim();
  if (a.length < 80 || b.length < 80) return false;
  // 去掉 a 的末尾 400 字（可能作为 hint 回传给模型）与 b 的开头 400 字（模型可能 echo 该 hint）
  const aCore = a.slice(0, Math.max(0, a.length - 400));
  const bCore = b.slice(Math.min(400, Math.floor(b.length / 3)));
  if (aCore.length < 40 || bCore.length < 40) return false;
  const setA = new Set();
  for (let i = 0; i + 5 <= aCore.length; i++) setA.add(aCore.slice(i, i + 5));
  let hit = 0, total = 0;
  for (let i = 0; i + 5 <= bCore.length; i++) { total++; if (setA.has(bCore.slice(i, i + 5))) hit++; }
  return total > 0 && hit / total > 0.85;
}

/**
 * 检测文本尾部是否存在【未闭合】的工具调用块（对齐 dsh 续轮收口，1.1.24）。
 * 规则：取【最后一个】工具开标签，检查其之后是否有对应的闭合标签——
 *   有闭合 → 不是半截（已闭合完整块后跟正文属正常轮，不误判）；
 *   无闭合 → 半截块（<foxtool/<fox:tool/<fox-tool/<tool/<function 或自定义 [[tool:…]]）。
 * 返回半截块原文（从开标签起），无半截返回 null。
 * @param {string} text 上一轮被截断的可见文本
 * @returns {string|null}
 */
function _halfOpenBlock(text) {
  const s = String(text || '');
  if (!s) return null;
  // 标准 XML 风格开标签
  const OPEN_RE = /<(fox:?tool|fox-tool|tool|function)\s+name\s*=\s*["'][^"']+["']\s*>/gi;
  // 自定义 [[tool:name]] 开标签
  const OPEN_CUSTOM_RE = /\[\[tool:[^\]\n]*\]\]/gi;
  let lastOpen = null;
  let lastIndex = -1;
  let m;
  OPEN_RE.lastIndex = 0;
  while ((m = OPEN_RE.exec(s)) !== null) { lastOpen = m[0]; lastIndex = m.index; }
  OPEN_CUSTOM_RE.lastIndex = 0;
  while ((m = OPEN_CUSTOM_RE.exec(s)) !== null) { lastOpen = m[0]; lastIndex = m.index; }
  if (!lastOpen) return null;
  const after = s.slice(lastIndex + lastOpen.length);
  // 找对应闭合标签：标准 </...tool> 或自定义 [[/tool]]
  const closeRe = /<\/(fox:?tool|fox-tool|tool|function)\s*>/i.test(after) || /\[\[\/tool\]\]/.test(after);
  if (closeRe) return null; // 已有闭合 → 不是半截
  return s.slice(lastIndex);
}

module.exports = { shouldAutoContinue, buildContinuePrompt, isStuckRepeat, _halfOpenBlock };
