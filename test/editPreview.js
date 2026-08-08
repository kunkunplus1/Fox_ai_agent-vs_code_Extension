'use strict';

/**
 * 离线测试 edit_file 的 preview 与实际编辑一致性：
 *  - CRLF 文件在审批卡片中也能正确显示 +N -M
 *  - previewEditFile 与 editFile 产生相同的 after
 *  - start_line/end_line 范围替换 preview 一致
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-ai-edit-preview-'));

const vscodeMock = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: tmp } }],
    textDocuments: [],
    fs: {
      async stat(uri) {
        const s = fs.statSync(uri.fsPath);
        return { size: s.size, type: s.isDirectory() ? 2 : 1 };
      },
      async readFile(uri) {
        return fs.readFileSync(uri.fsPath);
      },
      async writeFile(uri, buf) {
        fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true });
        fs.writeFileSync(uri.fsPath, Buffer.from(buf));
      },
      async createDirectory(uri) {
        fs.mkdirSync(uri.fsPath, { recursive: true });
      },
      async delete() {}
    },
    async openTextDocument(uri) {
      return {
        getText: () => (fs.existsSync(uri.fsPath) ? fs.readFileSync(uri.fsPath, 'utf8') : ''),
        positionAt: (off) => ({ line: 0, character: off }),
        save: async () => {}
      };
    },
    async applyEdit(edit) {
      for (const op of edit._ops) {
        if (op.kind === 'create') {
          fs.mkdirSync(path.dirname(op.uri.fsPath), { recursive: true });
          if (!fs.existsSync(op.uri.fsPath)) fs.writeFileSync(op.uri.fsPath, '');
        } else if (op.kind === 'replace') {
          fs.writeFileSync(op.uri.fsPath, op.text);
        } else if (op.kind === 'insert') {
          const cur = fs.existsSync(op.uri.fsPath) ? fs.readFileSync(uri.fsPath, 'utf8') : '';
          fs.writeFileSync(op.uri.fsPath, op.text + cur);
        }
      }
      return true;
    },
    getConfiguration: () => ({ get: () => true }),
    registerTextDocumentContentProvider: () => {}
  },
  window: { showInformationMessage: () => {}, showErrorMessage: () => {} },
  Uri: {
    file: (p) => ({ fsPath: p, toString: () => 'file://' + p }),
    parse: (s) => ({ fsPath: s, toString: () => s }),
    joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts), toString: () => 'file://' + path.join(base.fsPath, ...parts) })
  },
  WorkspaceEdit: class {
    constructor() { this._ops = []; }
    createFile(uri) { this._ops.push({ kind: 'create', uri }); }
    replace(uri, range, text) { this._ops.push({ kind: 'replace', uri, text }); }
    insert(uri, pos, text) { this._ops.push({ kind: 'insert', uri, text }); }
  },
  Position: class {},
  Range: class {},
  FileType: { File: 1, Directory: 2 },
  ConfigurationTarget: { Global: 1 }
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const ws = require('../src/tools/workspace');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + ' → ' + e.message);
  }
}

check('CRLF 文件 old_text LF 时 previewEditFile 仍能算出差异', () => {
  const rawBefore = 'line1\r\nline2\r\nline3\r\nline4\r\n';
  const args = {
    path: 'crlf.txt',
    old_text: 'line2\nline3\n',
    new_text: 'L2\nL3\n'
  };
  const result = ws.previewEditFile(args, rawBefore);
  assert.strictEqual(result.before, rawBefore, 'before 应保持原始 CRLF');
  assert.strictEqual(result.after, 'line1\r\nL2\r\nL3\r\nline4\r\n', 'after 应保留 CRLF');

  const delta = ws.diffStat(result.before, result.after);
  assert.strictEqual(delta.added, 2, '应新增 2 行');
  assert.strictEqual(delta.removed, 2, '应删除 2 行');
});

check('previewEditFile 与 editFile 在 CRLF 文件上结果一致', async () => {
  const file = path.join(tmp, 'cr.txt');
  const rawBefore = 'a\r\nb\r\nc\r\n';
  fs.writeFileSync(file, rawBefore);
  const args = {
    path: file,
    old_text: 'b',
    new_text: 'BB'
  };
  const preview = ws.previewEditFile(args, rawBefore);
  await ws.editFile(args, {});
  const diskAfter = fs.readFileSync(file, 'utf8');
  assert.strictEqual(diskAfter, preview.after, 'editFile 写入结果应与 preview 一致');
});

check('start_line/end_line 范围替换 preview 正确', () => {
  const rawBefore = 'A\nB\nC\nD\nE\n';
  const args = {
    path: 'range.txt',
    old_text: 'B\nC',
    new_text: 'X',
    start_line: 2,
    end_line: 3
  };
  const result = ws.previewEditFile(args, rawBefore);
  assert.strictEqual(result.after, 'A\nX\nD\nE\n');
});

check('replace_all preview 统计正确', () => {
  const rawBefore = 'foo\nbar\nfoo\nbar\n';
  const args = {
    path: 'multi.txt',
    old_text: 'bar',
    new_text: 'BAR',
    replace_all: true
  };
  const result = ws.previewEditFile(args, rawBefore);
  assert.strictEqual(result.after, 'foo\nBAR\nfoo\nBAR\n');
  const delta = ws.diffStat(result.before, result.after);
  assert.strictEqual(delta.added, 2);
  assert.strictEqual(delta.removed, 2);
});

check('new_text 含 $$/$& 等特殊符号时不该被 replace 模式解释', () => {
  const rawBefore = 'const x = $eval();\n';
  const args = {
    path: 'dollar.txt',
    old_text: '$eval',
    new_text: '$$eval'
  };
  const result = ws.previewEditFile(args, rawBefore);
  assert.strictEqual(result.after, 'const x = $$eval();\n', '$$eval 应原样写入，不应变成 $eval');
});

check('new_text 含 $& 不应回插匹配原文', () => {
  const rawBefore = 'abc\n';
  const args = {
    path: 'amp.txt',
    old_text: 'abc',
    new_text: 'pre$&post'
  };
  const result = ws.previewEditFile(args, rawBefore);
  assert.strictEqual(result.after, 'pre$&post\n', '$& 应原样保留，不应替换为 abc');
});

check('old_text/new_text 含首尾空格应原样保留（不 trim）', () => {
  const rawBefore = 'const a = 1;\n';
  const args = {
    path: 'ws.txt',
    old_text: '= 1',
    new_text: '=  2  '
  };
  const result = ws.previewEditFile(args, rawBefore);
  assert.strictEqual(result.after, 'const a =  2  ;\n', 'new_text 内部与首尾空格应保留');
});

check('制表符 \\t 应原样保留', () => {
  const rawBefore = 'function f() {\n\treturn 1;\n}\n';
  const args = {
    path: 'tab.txt',
    old_text: '\treturn 1;',
    new_text: '\treturn 2;'
  };
  const result = ws.previewEditFile(args, rawBefore);
  assert.strictEqual(result.after, 'function f() {\n\treturn 2;\n}\n', '缩进制表符应保留');
});

check('edit_file 在 CRLF 文件上保留换行符', () => {
  const rawBefore = 'line1\r\nline2\r\n';
  const args = {
    path: 'cr.txt',
    old_text: 'line2',
    new_text: 'LINE2'
  };
  const result = ws.previewEditFile(args, rawBefore);
  assert.strictEqual(result.after, 'line1\r\nLINE2\r\n', 'CRLF 应原样保留');
});

check('old_text 含 CRLF 也能匹配 LF 归一化后的内容', () => {
  const rawBefore = 'a\r\nb\r\nc\r\n';
  const args = {
    path: 'mix.txt',
    old_text: 'a\r\nb',
    new_text: 'A\r\nB'
  };
  const result = ws.previewEditFile(args, rawBefore);
  assert.strictEqual(result.after, 'A\r\nB\r\nc\r\n', '无论 old_text 用 CR/LF，都应正确匹配并保留 CRLF');
});

check('字符级范围替换保留其中的空格', () => {
  const rawBefore = 'if (x)  do();\n';
  const args = {
    path: 'charws.txt',
    old_text: '',
    new_text: '  Y  ',
    start_line: 1,
    start_char: 8,
    end_line: 1,
    end_char: 13
  };
  const result = ws.previewEditFile(args, rawBefore);
  // 字符范围 [8,13] 含分号，故分号也被替换掉；保留新文本内部空格
  assert.strictEqual(result.after, 'if (x)   Y  \n', '字符范围内替换应保留新文本中的空格');
});

check('write_file 保留原文件 CRLF 换行符', async () => {
  const file = path.join(tmp, 'w.txt');
  fs.writeFileSync(file, 'a\r\nb\r\n');
  await ws.writeFile({ path: file, content: 'a\r\nB\r\n' }, {});
  const disk = fs.readFileSync(file, 'utf8');
  assert.strictEqual(disk, 'a\r\nB\r\n', 'write_file 不应把 CRLF 改写成 LF');
});

check('Playwright $$eval API 不被折叠成 $eval（真实死循环场景回归）', () => {
  const rawBefore = "const titles = await page.$eval('.title', el => el.textContent);\n";
  const args = {
    path: 'pw.test.js',
    old_text: "page.$eval('.title', el => el.textContent)",
    new_text: "page.$$eval('.title', els => els.map(e => e.textContent))"
  };
  const result = ws.previewEditFile(args, rawBefore);
  assert.strictEqual(
    result.after,
    "const titles = await page.$$eval('.title', els => els.map(e => e.textContent));\n",
    '$$eval 必须原样保留，绝不能被折成 $eval'
  );
});

check('字符级范围替换 preview 正确', () => {
  const rawBefore = 'hello world\n';
  const args = {
    path: 'char.txt',
    old_text: '',
    new_text: 'VS Code',
    start_line: 1,
    start_char: 7,
    end_line: 1,
    end_char: 11
  };
  const result = ws.previewEditFile(args, rawBefore);
  assert.strictEqual(result.after, 'hello VS Code\n');
});

console.log(`\neditPreview: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
