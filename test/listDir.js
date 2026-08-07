'use strict';

/**
 * 回归测试：list_dir 在碰到系统保护目录（如 System Volume Information，读取被拒绝）
 * 时必须跳过该项并继续列举其余内容，而不是整体 throw 中断。
 * 运行：node test/listDir.js
 */

const Module = require('module');
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const vscodeMock = {
  workspace: {
    workspaceFolders: null,
    getConfiguration: () => ({ get: (k, d) => d, update: async () => {} }),
    fs: {
      // 默认行为：根目录能列，但 System Volume Information 抛权限拒绝（模拟 Windows 系统保护目录）
      readDirectory: async (uri) => {
        const p = (uri.fsPath || '').replace(/\//g, '\\');
        if (p === 'D:\\') {
          return [
            ['Program Files', 2],
            ['System Volume Information', 2],
            ['readme.txt', 1]
          ];
        }
        if (p === 'D:\\System Volume Information') {
          const e = new Error('EACCES: permission denied');
          e.code = 'EACCES';
          throw e;
        }
        return [];
      }
    }
  },
  Uri: {
    file: (p) => ({ fsPath: p, toString: () => 'file://' + p }),
    joinPath: (base, name) => {
      const sep = base.fsPath.endsWith('\\') || base.fsPath.endsWith('/') ? '' : '\\';
      return { fsPath: base.fsPath + sep + name, toString: () => 'file://' + base.fsPath + sep + name };
    }
  },
  FileType: { File: 1, Directory: 2 }
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const ws = require('../src/tools/workspace');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); }
}

(async () => {
  console.log('\n[list_dir 系统保护目录容错]');

  // 场景1：子目录（System Volume Information）读取被拒绝，不应中断整体列举
  let out = '';
  try {
    out = await ws.listDir({ path: 'D:\\' });
  } catch (e) {
    check('list_dir 不应因子目录拒绝访问而整体失败', () => assert.fail('抛出了: ' + e.message));
  }
  check('返回内容包含根目录其它条目 Program Files', () => assert.ok(out.includes('Program Files'), 'out=' + out));
  check('返回内容包含根目录其它条目 readme.txt', () => assert.ok(out.includes('readme.txt'), 'out=' + out));
  check('仍列出 System Volume Information（被标记或作为目录出现）', () => assert.ok(out.includes('System Volume Information'), 'out=' + out));
  check('未抛出根目录级“无法读取目录”错误', () => assert.ok(!out.includes('无法读取目录：D'), 'out=' + out));

  // 场景2：根目录本身 VS Code fs 拒绝，应回退 Node fs 兜底（跨平台用真实临时目录）
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxai-list-'));
  fs.writeFileSync(path.join(tmpRoot, 'hello.txt'), 'x');
  vscodeMock.workspace.fs.readDirectory = async () => { throw new Error('EPERM root'); };
  let out2 = '';
  try {
    out2 = await ws.listDir({ path: tmpRoot });
  } catch (e) {
    check('根目录回退 Node fs 也不应整体失败', () => assert.fail('抛出了: ' + e.message));
  }
  check('根目录 VS Code fs 拒绝时回退 Node fs 成功返回内容', () => assert.ok(out2.includes('hello.txt'), 'out2=' + out2));

  // 清理
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
