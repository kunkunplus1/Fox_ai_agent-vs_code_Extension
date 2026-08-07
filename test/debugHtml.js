'use strict';
const Module = require('module');
const fs = require('fs');
const path = require('path');

let captured = null;
function makeVscode() {
  return {
    window: {
      createWebviewPanel: () => ({
        webview: {
          set html(v) { captured = v; },
          get html() { return captured; },
          onDidReceiveMessage: () => ({ dispose() {} }),
          postMessage: () => Promise.resolve(true),
        },
        reveal() {}, onDidDispose() {},
      }),
      showOpenDialog: async () => undefined,
      showErrorMessage: () => {},
    },
    workspace: { getConfiguration: () => ({ get: () => undefined, update: async () => {} }) },
    ViewColumn: { Active: 1 },
    ConfigurationTarget: { Global: 1 },
  };
}
const orig = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'vscode') return makeVscode();
  if (req === './runtimes') return { listRuntimes: () => ([{ id: 'py', name: 'Python', defaultVersion: '3.12' }, { id: 'node', name: 'Node.js', defaultVersion: '20' }]) };
  if (req === './extensionBridge') return { listExtensions: () => [], allowedCommands: () => [] };
  if (req === './knowledgeOrganizer') return { defaultOutputDir: () => 'C:/x' };
  if (req === './knowledgeBase') return { stats: () => ({ files: 0, chunks: 0 }), invalidate() {}, retrieve() {} };
  if (req === './harness') return { TASK_STATES: { CANCELLED: 'cancelled' } };
  return orig.apply(this, arguments);
};

const envView = require(path.join(__dirname, '..', 'src', 'envView'));
envView.openEnvPanel({}, { taskManager: { listTasks: async () => [] } }, 'env');

if (!captured) { console.error('NO HTML CAPTURED'); process.exit(1); }
const out = path.join(__dirname, 'env.out.html');
fs.writeFileSync(out, captured);
console.log('HTML length:', captured.length);
console.log('written to', out);

// 1) script 块能否编译
const m = captured.match(/<script[^>]*>([\s\S]*?)<\/script>/);
if (m) {
  try { new Function(m[1]); console.log('SCRIPT COMPILE: OK'); }
  catch (e) { console.error('SCRIPT SYNTAX ERROR:', e.message); }
} else {
  console.log('NO <script> block found');
}

// 2) 可疑字符
console.log('contains backtick ` :', captured.includes('`'));
console.log('contains ${ :', captured.includes('${'));
const open = (captured.match(/<script>/g) || []).length;
const close = (captured.match(/<\/script>/g) || []).length;
console.log('script open/close tags:', open, close);

// 3) 控制字符（form feed / vertical tab / 裸换行已正常在 HTML 中）
const ctrl = captured.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || [];
console.log('control chars (excluding \\n\\r\\t):', ctrl.length, ctrl.slice(0, 12).map(c => '0x' + c.charCodeAt(0).toString(16)));

// 4) placeholder 里的反斜杠
const ph = captured.match(/placeholder="([^"]*)"/g) || [];
console.log('placeholders:', ph);
