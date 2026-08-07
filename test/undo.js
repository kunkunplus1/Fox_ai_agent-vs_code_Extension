'use strict';

/**
 * 离线测试 undo.js，覆盖：
 *  - 撤销新建文件时若 useTrash 失败会回退到强制删除
 *  - 撤销后「重做」能把好的新内容恢复回来
 *  - 编辑 / 删除 改动的撤销与重做往返
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-ai-undo-'));
let deleteOptions = [];

function readF(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

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
      async delete(uri, opts) {
        deleteOptions.push(opts);
        if (opts.useTrash) throw new Error('Cross-disk trash not supported');
        fs.unlinkSync(uri.fsPath);
      }
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
          const cur = fs.existsSync(op.uri.fsPath) ? fs.readFileSync(op.uri.fsPath, 'utf8') : '';
          fs.writeFileSync(op.uri.fsPath, op.text + cur);
        }
      }
      return true;
    }
  },
  window: { showInformationMessage: () => {}, showErrorMessage: () => {} },
  Uri: { file: (p) => ({ fsPath: p, toString: () => 'file://' + p }), joinPath: () => ({}) },
  WorkspaceEdit: class {
    constructor() { this._ops = []; }
    createFile(uri) { this._ops.push({ kind: 'create', uri }); }
    replace(uri, range, text) { this._ops.push({ kind: 'replace', uri, text }); }
    insert(uri, pos, text) { this._ops.push({ kind: 'insert', uri, text }); }
  },
  Position: class {},
  Range: class {},
  ConfigurationTarget: { Global: 1 }
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const undo = require('../src/undo');

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

check('撤销新建文件在回收站失败时回退到强制删除', async () => {
  const file = path.join(tmp, 'new.py');
  fs.writeFileSync(file, 'print(1)\n');
  deleteOptions = [];
  undo.record({ uri: vscodeMock.Uri.file(file), before: '', existed: false });
  const res = await undo.undoLast();
  assert.strictEqual(res.fsPath, file);
  assert(!fs.existsSync(file), '文件应被删除');
  assert.strictEqual(deleteOptions.length, 2, '应先尝试 useTrash 再强制删除');
  assert.strictEqual(deleteOptions[0].useTrash, true);
  assert.strictEqual(deleteOptions[1].useTrash, false);
});

check('撤销后「重做」能恢复新建的好文件与内容', async () => {
  const file = path.join(tmp, 'made.py');
  fs.writeFileSync(file, 'print("hello")\n');
  undo.record({ uri: vscodeMock.Uri.file(file), before: '', existed: false });
  await undo.undoLast();
  assert(!fs.existsSync(file), '撤销后应删掉文件');
  assert.strictEqual(undo.redoSize(), 1, '撤销后应有 1 条可重做');
  await undo.redoLast();
  assert.strictEqual(readF(file), 'print("hello")\n', '重做应恢复文件内容');
});

check('编辑改动的撤销 / 重做往返一致', async () => {
  const file = path.join(tmp, 'edit.txt');
  fs.writeFileSync(file, 'AAA');
  undo.record({ uri: vscodeMock.Uri.file(file), before: 'AAA', after: 'BBB', existed: true });
  await undo.undoLast();
  assert.strictEqual(readF(file), 'AAA', '撤销应回到 before');
  await undo.redoLast();
  assert.strictEqual(readF(file), 'BBB', '重做应回到 after（好的新内容）');
});

check('删除改动的撤销（恢复文件）/ 重做（再删除）', async () => {
  const file = path.join(tmp, 'del.txt');
  fs.writeFileSync(file, 'KEEP');
  undo.record({ uri: vscodeMock.Uri.file(file), before: 'KEEP', existed: true, deleted: true });
  await undo.undoLast();
  assert.strictEqual(readF(file), 'KEEP', '撤销删除应恢复文件');
  await undo.redoLast();
  assert(!fs.existsSync(file), '重做应再次删除');
});

check('新改动会清空重做栈', async () => {
  const a = path.join(tmp, 'a.txt');
  const b = path.join(tmp, 'b.txt');
  fs.writeFileSync(a, 'x');
  fs.writeFileSync(b, 'y');
  undo.record({ uri: vscodeMock.Uri.file(a), before: 'x', after: 'X', existed: true });
  await undo.undoLast();
  assert.strictEqual(undo.redoSize(), 1);
  undo.record({ uri: vscodeMock.Uri.file(b), before: 'y', after: 'Y', existed: true });
  assert.strictEqual(undo.redoSize(), 0, '新 record 应清空重做栈');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
