'use strict';

/**
 * 离线测试 envView.scanProject 对 Python / Node 项目的识别。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-ai-scan-'));

const vscodeMock = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: tmp } }],
    getConfiguration: () => ({ get: (k, d) => d, update: async () => {} })
  },
  window: {},
  Uri: { file: (p) => ({ fsPath: p }) },
  ConfigurationTarget: { Global: 1 }
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const { scanProject } = require('../src/envView');
const projectScan = require('../src/projectScan');

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

function write(rel, text) {
  const fp = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, text);
  return fp;
}

function reset() {
  for (const f of fs.readdirSync(tmp)) {
    const fp = path.join(tmp, f);
    const st = fs.statSync(fp);
    if (st.isDirectory()) fs.rmSync(fp, { recursive: true, force: true });
    else fs.unlinkSync(fp);
  }
}

// 1) Python GUI 项目
reset();
write('guess_number_gui.py', `# 猜数字游戏 GUI\nimport tkinter as tk\nif __name__ == '__main__':\n    main()\n`);
write('guess_number.py', 'def main(): pass\n');

check('Python GUI 项目被识别为 Python GUI', () => {
  const data = scanProject();
  assert.strictEqual(data.framework, 'Python · Python GUI');
  assert(data.roles.some((r) => r.role === '技术栈' && r.name.includes('Python GUI')), '缺少 Python GUI 技术栈');
  assert(data.roles.some((r) => r.name === 'guess_number_gui.py'), '缺少主文件');
  assert(data.roles.some((r) => r.name === 'guess_number.py'), '缺少普通模块文件');
});

// 2) Python Web 项目
reset();
write('app.py', 'from flask import Flask\napp = Flask(__name__)\n');
write('requirements.txt', 'flask\n');

check('Python Flask 项目被识别', () => {
  const data = scanProject();
  assert(data.roles.some((r) => r.role === '技术栈' && r.name.includes('Flask')), '缺少 Flask 技术栈');
  assert(data.roles.some((r) => r.name === 'requirements.txt'), '缺少 requirements.txt');
});

// 3) Node 项目
reset();
write('package.json', JSON.stringify({ dependencies: { react: '^18' }, main: 'index.js' }));
write('index.js', 'console.log("hi")\n');

check('Node React 项目被识别', () => {
  const data = scanProject();
  assert(data.roles.some((r) => r.role === '技术栈' && r.name.includes('React')), '缺少 React 技术栈');
  assert(data.roles.some((r) => r.name === '入口：index.js'), '缺少入口');
});

// 4) 空工作区
vscodeMock.workspace.workspaceFolders = null;
check('未打开工作区返回空', () => {
  const data = scanProject();
  assert.strictEqual(data.roles.length, 0);
  assert(data.framework.includes('未打开'));
});
vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: tmp } }];

// 5) 多语言混搭项目（Python + JavaScript）
reset();
write('guess_number_gui.py', `import tkinter as tk\nif __name__ == '__main__':\n    main()\n`);
write('package.json', JSON.stringify({ dependencies: { react: '^18' }, main: 'index.js' }));
write('index.js', 'console.log("hi")\n');

check('Python + JavaScript 多语言项目被识别', () => {
  const data = scanProject();
  assert(data.framework.includes('多语言'), 'framework 应标记多语言，实际：' + data.framework);
  assert(data.framework.includes('Python') && data.framework.includes('JavaScript'), 'framework 应同时包含 Python 与 JavaScript');
  assert.strictEqual(data.languages.length, 2, 'languages 应为 2 种');
  assert(data.roles.some((r) => r.role === '技术栈' && r.name.includes('Python GUI')), '缺少 Python GUI 技术栈');
  assert(data.roles.some((r) => r.role === '技术栈' && r.name.includes('React')), '缺少 React 技术栈');
});

// 6) Go 项目
reset();
write('main.go', 'package main\nimport "net/http"\nfunc main(){ http.ListenAndServe(":80", nil) }\n');
write('go.mod', 'module demo\n');

check('Go Web 项目被识别', () => {
  const data = scanProject();
  assert.strictEqual(data.framework, 'Go · Go Web 服务');
  assert(data.roles.some((r) => r.name === 'go.mod'), '缺少 go.mod');
});

// 7) 多文件 Python 项目：所有模块都出现并标注 import 关系
reset();
write('guess_number.py', `import game_logic
import guess_number_gui

if __name__ == '__main__':
    guess_number_gui.main()
`);
write('game_logic.py', 'import random\n\ndef check(guess, target):\n    return "中了" if guess == target else ("太小" if guess < target else "太大")\n');
write('guess_number_gui.py', `import tkinter as tk
import game_logic

def main(): pass
`);

check('多文件 Python 项目列出所有模块与 import 关系', () => {
  const data = scanProject();
  assert.strictEqual(data.framework, 'Python · Python GUI');
  const names = data.roles.map((r) => r.name);
  assert(names.includes('guess_number.py'), '缺少 guess_number.py');
  assert(names.includes('game_logic.py'), '缺少 game_logic.py');
  assert(names.includes('guess_number_gui.py'), '缺少 guess_number_gui.py');
  const mainRole = data.roles.find((r) => r.name === 'guess_number.py');
  assert(mainRole && mainRole.role.includes('导入'), '主程序应标注导入的模块');
  const logicRole = data.roles.find((r) => r.name === 'game_logic.py');
  assert(logicRole && logicRole.role.includes('核心逻辑'), 'game_logic 应被识别为核心逻辑模块');
  const guiRole = data.roles.find((r) => r.name === 'guess_number_gui.py');
  assert(guiRole && guiRole.role.includes('GUI'), 'guess_number_gui 应被识别为 GUI 模块');
  assert(data.relationships && data.relationships.some((r) => r.from === 'guess_number.py' && r.to === 'game_logic.py'), '应检测到 guess_number.py → game_logic.py');
  const text = projectScan.projectOverviewText(data, { actionable: true });
  assert(text.includes('guess_number.py → game_logic.py'), '概览应展示模块依赖关系');
});

// 8) projectScan 直接可用 + 多语言概览文本含拆分指导
reset();
write('guess_number_gui.py', `import tkinter as tk\nif __name__ == '__main__':\n    main()\n`);
write('package.json', JSON.stringify({ dependencies: { react: '^18' }, main: 'index.js' }));
write('index.js', 'console.log("hi")\n');
write('main.go', 'package main\nimport "net/http"\nfunc main(){ http.ListenAndServe(":80", nil) }\n');
write('go.mod', 'module demo\n');

check('detectProject 直接识别多语言并生成可操作概览', () => {
  const data = projectScan.detectProject(tmp);
  assert(data.framework.includes('多语言'), 'framework 应标记多语言，实际：' + data.framework);
  assert(data.framework.includes('Python') && data.framework.includes('JavaScript') && data.framework.includes('Go'), 'framework 应同时包含三种语言');
  const text = projectScan.projectOverviewText(data, { actionable: true });
  assert(text.includes('多语言'), '概览应说明多语言');
  assert(text.includes('一个清晰职责 = 一个文件'), '概览应给出按文件拆分指导');
  assert(text.includes('write_file'), '概览应提示用 write_file 创建');
  // maxRoles 截断
  const capped = projectScan.projectOverviewText(data, { actionable: false, maxRoles: 2 });
  assert(capped.includes('等 ' + data.roles.length + ' 个'), '超过 maxRoles 应折叠');
});

// 9) C/C++ 多文件项目：所有源文件都列出，并检测 #include 关系
reset();
write('main.c', '#include "utils.h"\n#include <stdio.h>\nint main(){ printf("%d", add(1,2)); return 0; }\n');
write('utils.c', '#include "utils.h"\nint add(int a,int b){ return a+b; }\n');
write('utils.h', '#ifndef UTILS_H\n#define UTILS_H\nint add(int,int);\n#endif\n');
write('CMakeLists.txt', 'cmake_minimum_required(VERSION 3.10)\n');

check('C/C++ 多文件项目列出所有源文件并标注 #include 关系', () => {
  const data = scanProject();
  assert.strictEqual(data.framework, 'C/C++ · C/C++ 程序');
  const names = data.roles.map((r) => r.name);
  assert(names.includes('main.c'), '缺少 main.c');
  assert(names.includes('utils.c'), '缺少 utils.c');
  assert(names.includes('utils.h'), '缺少 utils.h');
  const mainRole = data.roles.find((r) => r.name === 'main.c');
  assert(mainRole && mainRole.role.includes('主程序'), 'main.c 应被识别为主程序');
  const hRole = data.roles.find((r) => r.name === 'utils.h');
  assert(hRole && hRole.role.includes('头文件'), 'utils.h 应被识别为头文件');
  assert(hRole && hRole.role.includes('被 main.c'), 'utils.h 应标注被 main.c 包含');
  assert(data.relationships && data.relationships.some((r) => r.from === 'main.c' && r.to === 'utils.h' && r.type === 'include'), '应检测到 main.c → utils.h (include)');
  const text = projectScan.projectOverviewText(data, { actionable: true });
  assert(text.includes('main.c → utils.h'), '概览应展示 #include 依赖关系');
});

// 10) Rust 多文件项目：检测 mod 关系
reset();
write('main.rs', 'mod game;\nfn main(){ game::run(); }\n');
write('game.rs', 'pub fn run(){ println!("hi"); }\n');

check('Rust 多文件项目列出所有 .rs 并标注 mod 关系', () => {
  const data = scanProject();
  assert(data.framework.startsWith('Rust'), 'framework 应以 Rust 开头，实际：' + data.framework);
  const names = data.roles.map((r) => r.name);
  assert(names.includes('main.rs'), '缺少 main.rs');
  assert(names.includes('game.rs'), '缺少 game.rs');
  const mainRole = data.roles.find((r) => r.name === 'main.rs');
  assert(mainRole && mainRole.role.includes('主程序'), 'main.rs 应被识别为主程序');
  assert(data.relationships && data.relationships.some((r) => r.from === 'main.rs' && r.to === 'game.rs' && r.type === 'mod'), '应检测到 main.rs → game.rs (mod)');
});

// 11) Go 多文件项目：列出所有 .go 并标注主程序
reset();
write('main.go', 'package main\nimport "fmt"\nfunc main(){ fmt.Println("hi") }\n');
write('calc.go', 'package main\nfunc add(a,b int) int { return a+b }\n');
write('go.mod', 'module demo\n');

check('Go 多文件项目列出所有 .go 并标注主程序', () => {
  const data = scanProject();
  assert.strictEqual(data.framework, 'Go · Go 程序');
  const names = data.roles.map((r) => r.name);
  assert(names.includes('main.go'), '缺少 main.go');
  assert(names.includes('calc.go'), '缺少 calc.go');
  const mainRole = data.roles.find((r) => r.name === 'main.go');
  assert(mainRole && mainRole.role.includes('主程序'), 'main.go 应被识别为主程序');
});

// 12) Java 多文件项目：列出所有 .java 并标注主类
reset();
write('App.java', 'public class App { public static void main(String[] a){} }\n');
write('Calc.java', 'public class Calc { int add(int a,int b){ return a+b; } }\n');

check('Java 多文件项目列出所有 .java 并标注主类', () => {
  const data = scanProject();
  assert(data.framework.startsWith('Java'), 'framework 应以 Java 开头，实际：' + data.framework);
  const names = data.roles.map((r) => r.name);
  assert(names.includes('App.java'), '缺少 App.java');
  assert(names.includes('Calc.java'), '缺少 Calc.java');
  const mainRole = data.roles.find((r) => r.name === 'App.java');
  assert(mainRole && mainRole.role.includes('主类'), 'App.java 应被识别为主类');
});

// 13) C/C++ 项目中的可执行文件被识别，且同名 exe 提升为主程序入口
reset();
write('llama_launcher.c', '#include <stdio.h>\nint main(int argc, char** argv){ return 0; }\n');
write('llama_launcher_ui.c', '#include <stdio.h>\nvoid ui(){ }\n');
write('llama_launcher.exe', Buffer.from([0x4d, 0x5a])); // 最小 PE 头
write('system_info.c', '#include <stdio.h>\nvoid info(){ }\n');

check('C/C++ 项目的可执行文件被识别并提升为主程序入口', () => {
  const data = projectScan.detectProject(tmp);
  assert(data.roles.some((r) => r.name === 'llama_launcher.exe' && r.role.includes('可执行')), '应识别 llama_launcher.exe');
  const cLang = data.languages.find((l) => l.name === 'C/C++');
  assert(cLang && cLang.mainPath.endsWith('llama_launcher.exe'), 'C/C++ 主程序入口应指向同名 exe，实际：' + (cLang && cLang.mainPath));
  const text = projectScan.projectOverviewText(data, { actionable: true });
  assert(text.includes('llama_launcher.exe'), '概览应展示可执行文件');
});

// 14) buildFileTree 按目录层级展开并识别 .gguf 模型文件
reset();
write('llama_launcher.c', 'int main(){ return 0; }\n');
write('ai_models/DeepSeek-R1.gguf', Buffer.alloc(1024));
write('config.json', '{"key":"val"}\n');
write('README.md', '# readme\n');
write('run.log', 'log line\n');

check('buildFileTree 层级展开并识别多种文件类型', () => {
  const tree = projectScan.buildFileTree(tmp, 2);
  assert(tree.nodes.some((n) => n.name === 'llama_launcher.c' && n.fileType === 'code'), '应识别源码文件');
  assert(tree.nodes.some((n) => n.name === 'config.json' && n.fileType === 'config'), '应识别 JSON 配置');
  assert(tree.nodes.some((n) => n.name === 'README.md' && n.fileType === 'doc'), '应识别 Markdown 文档');
  assert(tree.nodes.some((n) => n.name === 'run.log' && n.fileType === 'log'), '应识别日志文件');
  const modelDir = tree.nodes.find((n) => n.type === 'dir' && n.name === 'ai_models');
  assert(modelDir, '应包含 ai_models 目录');
  assert(modelDir.children && modelDir.children.some((n) => n.name === 'DeepSeek-R1.gguf' && n.fileType === 'model'), '子目录应识别 .gguf 模型');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
