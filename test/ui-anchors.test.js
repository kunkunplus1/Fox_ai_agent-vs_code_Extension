'use strict';
/**
 * 第三层：ID 锚定静态校验（verify_ui_anchors）测试。
 */
const { analyzeHtml, verifyUiAnchors } = require('../src/tools/uiAnchors');

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; } else { failed++; console.log('  ✗ ' + name); } }

// A. 锚点完整：HTML 有 id、JS 引用同一 id
const htmlOk = `<!doctype html><html><body>
  <button id="btn">go</button>
  <script>document.getElementById('btn').addEventListener('click', ()=>{});</script>
</body></html>`;
const a = analyzeHtml(htmlOk);
ok('A 无错误', a.ok === true);
ok('A 无 issues', a.issues.length === 0);

// B. 锚点失效：JS 引用不存在的 id
const htmlMissing = `<!doctype html><html><body>
  <script>document.getElementById('ghost').addEventListener('click', ()=>{});</script>
</body></html>`;
const b = analyzeHtml(htmlMissing);
ok('B 报错', b.ok === false);
ok('B 报 missing 锚点', b.issues.some((i) => i.level === 'error' && i.id === 'ghost' && i.msg.includes('ghost')));

// C. fox-modal 缺 onclose（契约缺失）
const htmlModalBad = `<!doctype html><html><body>
  <fox-modal id="m" visible><p>hi</p></fox-modal>
</body></html>`;
const c = analyzeHtml(htmlModalBad);
ok('C 报 modal 缺 onclose', c.issues.some((i) => i.level === 'error' && i.msg.includes('onclose')));

// D. fox-modal 有 onclose 属性 → 不报
const htmlModalOk = `<!doctype html><html><body>
  <fox-modal id="m" visible onclose="closeModal"><p>hi</p></fox-modal>
</body></html>`;
const d = analyzeHtml(htmlModalOk);
ok('D 不报 modal 错', !d.issues.some((i) => i.level === 'error' && i.msg.includes('onclose')));

// E. querySelector('#id') 也能识别引用
const htmlQs = `<!doctype html><html><body><div id="box"></div>
  <script>document.querySelector('#box').style.color='red';</script></body></html>`;
const e = analyzeHtml(htmlQs);
ok('E querySelector 引用被识别且无错', e.ok === true && e.refs.includes('box'));

// F. verifyUiAnchors 文本化入口
const txtOk = verifyUiAnchors({ html: htmlOk });
ok('F 通过文案含 ✅', txtOk.includes('✅'));
const txtBad = verifyUiAnchors({ html: htmlMissing });
ok('F 失败文案含 ❌', txtBad.includes('❌'));

console.log(`ui-anchors: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
