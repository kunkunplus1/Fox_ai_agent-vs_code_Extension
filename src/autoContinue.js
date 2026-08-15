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
 * @param {string} lastText 上一轮（被截断的）可见文本
 * @returns {string}
 */
function buildContinuePrompt(lastText) {
  const tail = String(lastText || '').trim();
  if (tail.length > 400) {
    const slice = tail.slice(tail.length - 400);
    return (
      '你刚才的输出因达到单次长度上限被截断。你最后写到的内容是下面这段（请务必从它之后继续，' +
      '绝对不要重复这段，直接续写后续内容；本次只输出续写文本，不要调用任何工具、不要输出工具标签）：\n' +
      '「' + slice + '」'
    );
  }
  return '继续输出剩余内容，保持与上文连贯，不要重复已经输出的部分；本次只输出续写文本，不要调用任何工具。';
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

module.exports = { shouldAutoContinue, buildContinuePrompt, isStuckRepeat };
