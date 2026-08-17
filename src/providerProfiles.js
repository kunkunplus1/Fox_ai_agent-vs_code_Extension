'use strict';

/**
 * src/providerProfiles.js — 各厂商的「专属适配提示词 + 速度调优」
 *
 * 目标：缩小「厂商原生 agent（Claude Code / Copilot / DeepSeek 官方套件）」与「第三方 agent（狐狸 AI）」
 * 在同一模型上的产出质量差距，并按各厂商的延迟 / 输出特性做速度调优。
 *
 * 质量层（text）：按 provider 注入一小段「专属工作风格 / 格式约定」——DeepSeek 走 text 协议需强化
 * <foxtool> 格式；OpenAI 原生 function calling 强调结构化输出；Claude 思考深但易过度询问。
 * 速度层（speed）：按厂商设默认 timeout（快的厂商设短、慢的设长，避免假超时或长时间挂起）与默认
 * maxTokens（限制单次输出上限，避免生成过慢 / 过长）。
 *
 * 文本随 system 前缀一起缓存、字节稳定；速度参数在 config.resolve 阶段应用、用户显式配置优先。
 * 纯数据 + 纯函数，零外部依赖，可离线单测。
 */

const PROFILES = {
  deepseek: {
    label: 'DeepSeek',
    text: `【DeepSeek 专属适配】
1. 你通过 <foxtool name="工具名">{"参数":"值"}</foxtool> 调用工具：工具块必须独立成段、参数是合法 JSON，写完立刻停止输出，等结果再继续。
2. 先读后改、小步精确：用 read_file 看真实内容，用 edit_file 做最小修改，不要整文件重写，也不要反复读同一段。
3. 直接推进任务、结论先行；回答用简体中文，代码块完整可运行，不冗长铺垫、不反复确认。`,
    speed: { timeout: 45000, maxTokens: 4096 }
  },
  openai: {
    label: 'OpenAI',
    text: `【OpenAI 专属适配】
1. 你通过原生 function calling 调用工具，参数按工具 schema 填写合法 JSON。
2. 多步任务先想清步骤再逐步执行；回答优先结构化（列表 / 要点 / 代码块），结论先行。
3. 只基于工具返回与检索内容下结论，不编造路径 / 版本号 / 数据；拿不准就明确说明不确定性。`,
    speed: { timeout: 60000, maxTokens: 4096 }
  },
  claude: {
    label: 'Claude',
    text: `【Claude 专属适配】
1. 你通过原生 tool_use 调用工具；改文件前必须 read_file 看真实内容，改动最小化、可逆优先。
2. 思考时先暴露假设与风险，方案相悖就明说、不折中平均；给出方案后再动手。
3. 回答用简体中文、重点突出、避免过度冗长；不要在不必要处反复询问确认——能安全推进就直接做，声称完成前用工具核实结果。`,
    speed: { timeout: 120000, maxTokens: 4096 }
  }
};

// 本地 / 未识别厂商的通用速度默认（本地模型加载慢、上下文小）
const LOCAL_SPEED = { timeout: 120000, maxTokens: 1536 };

/** 按 provider / transport / model 识别厂商 key（deepseek / openai / claude / null） */
function detectProvider(cfg) {
  cfg = cfg || {};
  const provider = String(cfg.provider || '').toLowerCase();
  const model = String(cfg.model || '').toLowerCase();
  const transport = String(cfg.transport || '').toLowerCase();

  if (provider === 'claude' || provider === 'anthropic' || transport === 'anthropic') return 'claude';
  if (provider === 'openai') return 'openai';
  if (provider === 'deepseek') return 'deepseek';
  // 中转 / 代理透传的模型名兜底
  if (/deepseek/.test(model)) return 'deepseek';
  if (/claude|anthropic/.test(model)) return 'claude';
  if (/^(gpt-|o[0-9])/.test(model)) return 'openai';
  return null;
}

/**
 * 解析本次请求应注入的厂商专属适配文本。
 * @param {object} cfg 会话配置（provider / model / transport / providerProfile）
 * @returns {string} 适配文本；无匹配返回空串
 */
function resolveProfile(cfg) {
  cfg = cfg || {};
  const explicit = String(cfg.providerProfile || 'auto').trim();

  // 显式关闭
  if (explicit === 'none' || explicit === 'off') return '';
  // 显式指定某个内置 profile
  if (explicit && explicit !== 'auto') {
    if (PROFILES[explicit]) return PROFILES[explicit].text;
    return explicit; // 用户直接填自定义文本
  }

  const key = detectProvider(cfg);
  return key ? PROFILES[key].text : '';
}

/**
 * 解析厂商速度默认值（timeout / maxTokens）。
 * @param {object} cfg { provider, model, transport, local }
 * @returns {{timeout:number, maxTokens:number}|null} 未识别厂商返回 null（用全局默认）
 */
function resolveSpeed(cfg) {
  cfg = cfg || {};
  const key = detectProvider(cfg);
  if (key) return PROFILES[key].speed;
  if (cfg.local) return LOCAL_SPEED;
  return null;
}

module.exports = { PROFILES, LOCAL_SPEED, detectProvider, resolveProfile, resolveSpeed };
