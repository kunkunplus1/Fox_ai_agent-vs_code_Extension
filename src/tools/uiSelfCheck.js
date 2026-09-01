'use strict';
/**
 * UI 无头自检 —— 第四层：无头浏览器自检（文本化反馈）。
 *
 * 不看图片，只抓文本：控制台报错、页面异常、关键元素的真实坐标 / 计算样式，
 * 以及第三层的 id↔事件锚点缺口。把「文本化报错」喂回给模型修正，最多迭代 2-3 次。
 *
 * 浏览器渲染依赖 Playwright：能解析到就真渲染（坐标级校验）；解析不到或启动失败，
 * 自动降级为「仅静态锚点校验」并给出安装提示，绝不卡死。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { analyzeHtml } = require('./uiAnchors');

function resolvePlaywright() {
  const names = ['playwright', 'playwright-core', '@playwright/test'];
  for (const n of names) {
    try { return require(n); } catch (_) {}
  }
  try {
    const dir = path.join(os.homedir(), '.fox-ai', 'mcp-modules', 'node_modules');
    for (const n of names) {
      const p = path.join(dir, n);
      if (fs.existsSync(path.join(p, 'package.json'))) {
        try { return require(p); } catch (_) {}
      }
    }
  } catch (_) {}
  return null;
}

async function launchBrowser(pw) {
  if (!pw || !pw.chromium) throw new Error('Playwright 无可用的 chromium');
  return pw.chromium.launch({ headless: true });
}

function formatReport(report) {
  const lines = ['🔬 UI 无头自检报告：'];
  const consoleErrs = (report.console || []).filter((c) => /\[error\]|\[warning\]/.test(c));
  const pageErrs = report.pageErrors || [];

  // 1) 控制台 / 页面异常
  if (consoleErrs.length) {
    lines.push('【控制台报错】');
    for (const c of consoleErrs) lines.push('  ❌ ' + c);
  }
  if (pageErrs.length) {
    lines.push('【页面异常（运行时错误）】');
    for (const e of pageErrs) lines.push('  ❌ ' + e);
  }

  // 2) 真实坐标 / 计算样式（仅浏览器可用时）
  if (report.browser === 'ok' && report.styles && report.styles.length) {
    lines.push('【元素坐标 / 计算样式】');
    for (const s of report.styles) {
      if (!s.found) {
        lines.push(`  ❌ #${s.id} 未找到（元素缺失，锚点或拼写错误）`);
        continue;
      }
      if (s.expect) {
        if (s.match) {
          lines.push(`  ✅ #${s.id} 样式生效（${Object.entries(s.expect).map(([k, v]) => k + '=' + v).join('，')}）`);
        } else {
          const got = Object.entries(s.expect).map(([k, v]) => `${k} 期望 ${v} 实际 ${s.computed[k]}`).join('；');
          lines.push(`  ❌ #${s.id} 样式未生效：${got}`);
        }
      } else {
        lines.push(`  ℹ️ #${s.id} 位置 left=${Math.round(s.left)} top=${Math.round(s.top)} size=${Math.round(s.width)}×${Math.round(s.height)}`);
      }
    }
  }

  // 3) 静态锚点缺口（始终执行）
  if (report.static && report.static.issues && report.static.issues.length) {
    lines.push('【锚点 / 原子组件契约】');
    for (const it of report.static.issues) {
      lines.push(`  ${it.level === 'error' ? '❌' : '⚠️'} ${it.msg}`);
    }
  }

  // 4) 浏览器可用性说明
  if (report.browser === 'unavailable') {
    lines.push('ℹ️ 未检测到 Playwright，已仅做静态校验。如需坐标级自检：运行 `npx playwright install chromium` 后重试。');
  } else if (typeof report.browser === 'string' && report.browser.startsWith('error')) {
    lines.push('ℹ️ 浏览器启动失败（' + report.browser + '）。通常需先 `npx playwright install chromium`；已回退为静态校验。');
  }

  const hasError = consoleErrs.length || pageErrs.length ||
    (report.styles || []).some((s) => !s.found || s.expect && !s.match) ||
    (report.static && report.static.issues.some((x) => x.level === 'error'));
  lines.push(hasError ? '（存在 ❌，请修正后重新 ui_selfcheck，最多迭代 3 次）' : '✅ 无阻断性错误。');
  return lines.join('\n');
}

async function uiSelfCheck(opts) {
  opts = opts || {};
  let html = opts.html;
  if (!html && opts.file) {
    try { html = fs.readFileSync(opts.file, 'utf8'); }
    catch (e) { return `无法读取文件 ${opts.file}：${e.message}`; }
  }
  if (!html || typeof html !== 'string') {
    return 'ui_selfcheck 需要 html 字符串或可读的 file 路径。';
  }
  const anchors = Array.isArray(opts.anchors) ? opts.anchors : [];
  const report = { static: analyzeHtml(html), console: [], pageErrors: [], styles: [], browser: null };

  let pw = ('_pw' in opts) ? opts._pw : resolvePlaywright();
  if (!pw) {
    report.browser = 'unavailable';
  } else {
    try {
      const browser = await launchBrowser(pw);
      const page = await browser.newPage();
      const consoleMsgs = [];
      page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
      page.on('pageerror', (e) => report.pageErrors.push(String((e && e.message) || e)));
      if (opts.file) await page.goto('file://' + path.resolve(opts.file), { waitUntil: 'load' });
      else await page.setContent(html, { waitUntil: 'load' });
      await page.addScriptTag({ content: 'try{if(window.initFoxAtoms)window.initFoxAtoms();}catch(e){}' }).catch(() => {});
      for (const a of anchors) {
        const r = await page.evaluate((spec) => {
          const el = document.getElementById(spec.id) || document.querySelector('#' + spec.id);
          if (!el) return { id: spec.id, found: false };
          const cs = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const out = { id: spec.id, found: true, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
          if (spec.expect) {
            out.expect = spec.expect;
            out.computed = {};
            for (const k of Object.keys(spec.expect)) out.computed[k] = cs.getPropertyValue(k);
            out.match = Object.keys(spec.expect).every((k) => String(out.computed[k]).trim() === String(spec.expect[k]).trim());
          }
          return out;
        }, a);
        report.styles.push(r);
      }
      report.console = consoleMsgs;
      report.browser = 'ok';
      await browser.close();
    } catch (e) {
      report.browser = 'error: ' + (e && e.message ? e.message : String(e));
    }
  }
  return formatReport(report);
}

module.exports = { uiSelfCheck, resolvePlaywright, formatReport, launchBrowser };
