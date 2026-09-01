'use strict';
/**
 * 第四层：无头自检（ui_selfcheck）测试。
 * - 静态降级路径（_pw:null）：仅静态校验 + 提示安装 Playwright。
 * - 浏览器路径（注入 mock Playwright）：抓取真实坐标/计算样式，断言生效与否。
 */
const { uiSelfCheck, formatReport } = require('../src/tools/uiSelfCheck');

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; } else { failed++; console.log('  ✗ ' + name); } }

const HTML = `<!doctype html><html><head></head><body>
  <div id="modal">x</div>
  <button id="ghost">y</button>
  <script>document.getElementById('ghost').addEventListener('click', ()=>{});</script>
</body></html>`;

// ---- 静态降级：_pw=null ----
(async () => {
  const htmlGap = `<!doctype html><html><body>
  <div id="modal">x</div>
  <script>document.getElementById('ghost2').addEventListener('click', ()=>{});</script>
</body></html>`;
  const r1 = await uiSelfCheck({ html: htmlGap, _pw: null });
  ok('降级路径提示未检测到 Playwright', r1.includes('未检测到 Playwright'));
  ok('降级路径仍抓到静态锚点缺口', r1.includes('❌') && r1.includes('ghost2'));

  // ---- 浏览器路径：样式生效 ----
  const fakePageOk = {
    on() {}, async goto() {}, async setContent() {}, async addScriptTag() {},
    async evaluate(fn, arg) {
      return { id: arg.id, found: true, expect: arg.expect, computed: arg.expect, match: true };
    }
  };
  const fakeBrowserOk = { async newPage() { return fakePageOk; }, async close() {} };
  const pwOk = { chromium: { launch: async () => fakeBrowserOk } };

  const r2 = await uiSelfCheck({ html: HTML, anchors: [{ id: 'modal', expect: { left: '50%' } }], _pw: pwOk });
  ok('浏览器路径样式生效 ✅', r2.includes('✅') && r2.includes('#modal 样式生效'));
  ok('浏览器路径无未检测提示', !r2.includes('未检测到 Playwright'));

  // ---- 浏览器路径：样式未生效 ----
  const fakePageBad = {
    on() {}, async goto() {}, async setContent() {}, async addScriptTag() {},
    async evaluate(fn, arg) {
      return { id: arg.id, found: true, expect: arg.expect, computed: { left: '0px' }, match: false };
    }
  };
  const fakeBrowserBad = { async newPage() { return fakePageBad; }, async close() {} };
  const pwBad = { chromium: { launch: async () => fakeBrowserBad } };

  const r3 = await uiSelfCheck({ html: HTML, anchors: [{ id: 'modal', expect: { left: '50%' } }], _pw: pwBad });
  ok('浏览器路径样式未生效 ❌', r3.includes('❌') && r3.includes('#modal 样式未生效'));

  // ---- 浏览器路径：元素缺失 ----
  const fakePageMissing = {
    on() {}, async goto() {}, async setContent() {}, async addScriptTag() {},
    async evaluate(fn, arg) { return { id: arg.id, found: false }; }
  };
  const fakeBrowserMissing = { async newPage() { return fakePageMissing; }, async close() {} };
  const pwMissing = { chromium: { launch: async () => fakeBrowserMissing } };
  const r4 = await uiSelfCheck({ html: HTML, anchors: [{ id: 'nope', expect: { left: '50%' } }], _pw: pwMissing });
  ok('浏览器路径元素缺失 ❌', r4.includes('❌') && r4.includes('#nope 未找到'));

  // ---- formatReport 直接单测 ----
  const fmt = formatReport({ static: { issues: [] }, browser: 'ok', styles: [{ id: 'x', found: true, expect: { top: '0px' }, computed: { top: '0px' }, match: true }], console: [], pageErrors: [] });
  ok('formatReport 含 ✅ 无阻断', fmt.includes('✅') && fmt.includes('无阻断性错误'));

  console.log(`ui-selfcheck: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
