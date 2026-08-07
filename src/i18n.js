'use strict';

/**
 * 零依赖国际化模块。
 *
 * 设计原则：所有用户可见文案以「中文」作为代码内嵌默认值（fallback），
 * 英文等其它语言通过 l10n/<locale>.json 覆盖包提供。这样中文用户永远不会
 * 因为语言包缺失而看到空白或乱码，且无需引入任何第三方运行时依赖。
 *
 * 解析链（以 key 为例）：
 *   1) 当前语言包（如 en）命中 -> 返回英文
 *   2) 语言前缀包（如 zh）命中 -> 返回
 *   3) 英文包（en）命中 -> 返回英文（作为通用兜底）
 *   4) 都没有 -> 返回调用处传入的中文 fallback
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const bundles = Object.create(null);

function bundlePath(locale) {
  return path.join(__dirname, '..', 'l10n', locale + '.json');
}

function loadBundles() {
  for (const loc of ['en', 'zh-cn', 'zh']) {
    try {
      const raw = fs.readFileSync(bundlePath(loc), 'utf8');
      bundles[loc] = JSON.parse(raw);
    } catch (_) {
      bundles[loc] = Object.create(null);
    }
  }
  // 确保 en 至少存在，避免兜底失败
  if (!bundles.en) bundles.en = Object.create(null);
}

/** 返回当前 VS Code 显示语言，统一小写，如 en / zh-cn / zh */
function currentLocale() {
  const lang = (vscode.env && vscode.env.language) || 'zh-cn';
  return String(lang).toLowerCase();
}

/**
 * 取本地化字符串。
 * @param {string} key 文案键
 * @param {string} fallback 中文默认值（代码内嵌）
 * @returns {string}
 */
function t(key, fallback) {
  const loc = currentLocale();
  const exact = bundles[loc];
  if (exact && exact[key] !== undefined && exact[key] !== '') return exact[key];
  const prefix = loc.split('-')[0];
  if (prefix !== loc) {
    const pb = bundles[prefix];
    if (pb && pb[key] !== undefined && pb[key] !== '') return pb[key];
  }
  const en = bundles.en;
  if (en && en[key] !== undefined && en[key] !== '') return en[key];
  return fallback === undefined ? key : fallback;
}

/**
 * 取某个语言包的纯字典（供 webview 注入）。
 * @param {string} locale
 * @returns {Object}
 */
function bundleFor(locale) {
  const loc = (locale || currentLocale()).toLowerCase();
  if (bundles[loc]) return bundles[loc];
  const prefix = loc.split('-')[0];
  if (prefix !== loc && bundles[prefix]) return bundles[prefix];
  return Object.create(null);
}

/**
 * 以「中文原文」为 key 的翻译函数，供后端（Node 侧）运行时提示使用，
 * 与 webview 共用 l10n/webview.en.json（中文 -> 英文）映射表。
 * 中文环境直接返回原文（零回退风险）；其它语言查映射表，命中返回英文，未命中回退原文。
 * 支持 {0} {1} 占位符替换。
 * @param {string} text 中文原文（同时作为 key 与中文 fallback）
 * @param {...string} args 占位符替换值
 * @returns {string}
 */
let twMap = null;
function loadTwMap() {
  if (twMap) return twMap;
  try {
    twMap = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'l10n', 'webview.en.json'), 'utf8'));
  } catch (_) {
    twMap = Object.create(null);
  }
  return twMap;
}
function tw(text) {
  if (typeof text !== 'string') return text;
  const loc = currentLocale().toLowerCase();
  const map = loadTwMap();
  let out = (loc.indexOf('zh') === 0) ? text : (map[text] !== undefined && map[text] !== '' ? map[text] : text);
  const args = Array.prototype.slice.call(arguments, 1);
  if (args.length) {
    out = out.replace(/\{(\d+)\}/g, function (_m, i) {
      const idx = Number(i);
      return idx < args.length ? args[idx] : ('{' + i + '}');
    });
  }
  return out;
}

module.exports = { loadBundles, currentLocale, t, bundleFor, tw };
