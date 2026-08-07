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

module.exports = { shouldAutoContinue };
