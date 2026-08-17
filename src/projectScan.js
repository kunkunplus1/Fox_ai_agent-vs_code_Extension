'use strict';

/**
 * 纯函数版项目扫描（不依赖 vscode，便于 agent 直接复用）。
 * 给定工作区根目录，返回 { framework, languages, roles }。
 * 支持多语言混搭项目的识别与汇总。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * 文件类型识别表：扩展名 → [类别, 角色描述]
 * 类别用于分组与排序：code > config > doc > model > data > media > archive > other
 */
const FILE_TYPES = {
  // 代码（已在各语言扫描中处理，这里兜底常见脚本/标记）
  '.js': ['code', 'JavaScript 源文件'], '.ts': ['code', 'TypeScript 源文件'], '.jsx': ['code', 'JSX 源文件'], '.tsx': ['code', 'TSX 源文件'],
  '.py': ['code', 'Python 源文件'], '.go': ['code', 'Go 源文件'], '.rs': ['code', 'Rust 源文件'], '.java': ['code', 'Java 源文件'], '.kt': ['code', 'Kotlin 源文件'],
  '.c': ['code', 'C 源文件'], '.cpp': ['code', 'C++ 源文件'], '.cc': ['code', 'C++ 源文件'], '.cxx': ['code', 'C++ 源文件'], '.h': ['code', 'C/C++ 头文件'], '.hpp': ['code', 'C/C++ 头文件'],
  '.cs': ['code', 'C# 源文件'], '.swift': ['code', 'Swift 源文件'], '.dart': ['code', 'Dart 源文件'], '.rb': ['code', 'Ruby 源文件'], '.php': ['code', 'PHP 源文件'],
  '.sh': ['code', 'Shell 脚本'], '.bat': ['code', 'Windows 批处理'], '.cmd': ['code', 'Windows 批处理'], '.ps1': ['code', 'PowerShell 脚本'],
  '.html': ['code', 'HTML 文件'], '.htm': ['code', 'HTML 文件'], '.css': ['code', 'CSS 文件'], '.scss': ['code', 'SCSS 文件'], '.less': ['code', 'Less 文件'],
  '.vue': ['code', 'Vue 单文件'], '.svelte': ['code', 'Svelte 文件'], '.json': ['config', 'JSON 配置文件'], '.yaml': ['config', 'YAML 配置文件'], '.yml': ['config', 'YAML 配置文件'],
  '.toml': ['config', 'TOML 配置文件'], '.ini': ['config', 'INI 配置文件'], '.cfg': ['config', 'CFG 配置文件'], '.conf': ['config', 'CONF 配置文件'],
  '.xml': ['config', 'XML 文件'], '.env': ['config', '环境变量文件'], '.lock': ['config', '依赖锁定文件'],
  // 文档
  '.md': ['doc', 'Markdown 文档'], '.txt': ['doc', '文本文件'], '.rst': ['doc', 'reStructuredText 文档'],
  // AI 模型
  '.gguf': ['model', 'GGUF 模型文件'], '.ggml': ['model', 'GGML 模型文件'], '.safetensors': ['model', 'Safetensors 模型文件'], '.pt': ['model', 'PyTorch 模型文件'],
  '.pth': ['model', 'PyTorch 模型文件'], '.onnx': ['model', 'ONNX 模型文件'], '.bin': ['model', '模型/二进制文件'], '.ckpt': ['model', 'Checkpoint 模型文件'],
  // 数据
  '.csv': ['data', 'CSV 数据'], '.tsv': ['data', 'TSV 数据'], '.jsonl': ['data', 'JSON Lines 数据'], '.parquet': ['data', 'Parquet 数据'], '.sqlite': ['data', 'SQLite 数据库'], '.db': ['data', '数据库文件'],
  // 日志
  '.log': ['log', '日志文件'],
  // 媒体
  '.png': ['media', 'PNG 图片'], '.jpg': ['media', 'JPEG 图片'], '.jpeg': ['media', 'JPEG 图片'], '.gif': ['media', 'GIF 图片'], '.webp': ['media', 'WebP 图片'], '.bmp': ['media', 'BMP 图片'], '.svg': ['media', 'SVG 图片'],
  '.mp3': ['media', 'MP3 音频'], '.wav': ['media', 'WAV 音频'], '.mp4': ['media', 'MP4 视频'], '.webm': ['media', 'WebM 视频'], '.mov': ['media', 'MOV 视频'],
  // 压缩/归档
  '.zip': ['archive', 'ZIP 压缩包'], '.tar': ['archive', 'TAR 归档'], '.gz': ['archive', 'GZip 压缩包'], '.rar': ['archive', 'RAR 压缩包'], '.7z': ['archive', '7z 压缩包'],
  // 可执行（已在 executableFiles 段处理，这里做兜底描述）
  '.exe': ['exec', 'Windows 可执行程序'], '.com': ['exec', 'Windows 可执行程序'], '.msi': ['exec', 'Windows 安装包'], '.out': ['exec', '可执行文件'], '.run': ['exec', '可执行文件']
};
const TYPE_ORDER = { code: 0, config: 1, doc: 2, model: 3, data: 4, log: 5, media: 6, exec: 7, archive: 8, other: 9 };
const TYPE_LABEL = { code: '📄 源码', config: '⚙️ 配置', doc: '📖 文档', model: '🧠 模型', data: '📊 数据', log: '📜 日志', media: '🎬 媒体', exec: '⚡ 可执行', archive: '📦 归档', other: '📁 其他' };

function classifyFile(name) {
  const ext = path.extname(name).toLowerCase();
  if (FILE_TYPES[ext]) return FILE_TYPES[ext];
  return ['other', '文件'];
}

function detectProject(root) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {}
  const roles = [];
  const has = (n) => entries.some((e) => e.name === n);
  const fileNames = entries.filter((e) => e.isFile()).map((e) => e.name);
  const extFiles = (exts) => fileNames.filter((n) => exts.some((e) => n.toLowerCase().endsWith(e)));
  const readFileSafe = (rel, len) => {
    try { return fs.readFileSync(path.join(root, rel), 'utf8').slice(0, len || 12000); } catch (_) { return ''; }
  };

  const readme = entries.find((e) => /^readme(\.md)?$/i.test(e.name));
  if (readme) roles.push({ name: readme.name, path: path.join(root, readme.name), role: '项目说明文档' });

  // 收集检测到的语言：{ name, kind, mainPath }
  const langs = [];
  // 收集文件间依赖关系（Python 的 import、C/C++ 的 #include、Rust 的 mod、Go 的本地 import 等）
  const relationships = [];

  // ---- JavaScript / TypeScript (Node / Web) ----
  if (has('package.json')) {
    let pkg = {};
    try { pkg = JSON.parse(readFileSafe('package.json', 6000)); } catch (_) {}
    const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
    const depCount = Object.keys(deps).length;
    roles.push({ name: 'package.json', path: path.join(root, 'package.json'), role: '依赖与脚本（' + depCount + ' 个包）' });
    const entry = pkg.main || (pkg.bin ? 'bin: ' + Object.keys(pkg.bin).join(', ') : '');
    if (entry) roles.push({ name: '入口：' + entry, path: path.join(root, entry), role: '程序入口' });
    let kind = '';
    if (deps.react) kind = 'React';
    else if (deps.vue) kind = 'Vue';
    else if (deps.next) kind = 'Next.js';
    else if (deps.nuxt) kind = 'Nuxt';
    else if (deps.svelte) kind = 'Svelte';
    else if (deps.angular) kind = 'Angular';
    else if (deps.electron) kind = 'Electron 桌面';
    else if (deps.express || deps.koa || deps.fastify) kind = 'Node Web 服务';
    else if (deps.vite) kind = 'Vite 项目';
    else if (depCount) kind = 'Node 项目';
    const jsFiles = extFiles(['.js', '.jsx', '.ts', '.tsx']);
    const isTs = jsFiles.some((n) => /\.tsx?$/.test(n));
    langs.push({
      name: isTs ? 'TypeScript' : 'JavaScript',
      kind: kind || 'Web/Node',
      mainPath: entry ? path.join(root, entry) : (jsFiles[0] && path.join(root, jsFiles[0]))
    });
    if (kind) roles.push({ name: '框架：' + kind, path: path.join(root, 'package.json'), role: '技术栈' });
  }

  // ---- Python ----
  const pyFiles = extFiles(['.py']);
  if (pyFiles.length) {
    if (has('requirements.txt')) roles.push({ name: 'requirements.txt', path: path.join(root, 'requirements.txt'), role: 'Python 依赖清单' });
    let pyProject = '';
    if (has('pyproject.toml')) { pyProject = readFileSafe('pyproject.toml', 8000); roles.push({ name: 'pyproject.toml', path: path.join(root, 'pyproject.toml'), role: 'Python 项目配置' }); }
    if (has('setup.py')) roles.push({ name: 'setup.py', path: path.join(root, 'setup.py'), role: 'Python 安装脚本' });
    if (has('Pipfile')) roles.push({ name: 'Pipfile', path: path.join(root, 'Pipfile'), role: 'Python 依赖清单' });

    // 读取每个 py 文件内容（用于推断角色与依赖关系）
    const pyMeta = {};
    for (const name of pyFiles) {
      const text = readFileSafe(name, 20000);
      const isMain = /if\s+__name__\s*==\s*['\"]__main__['\"]/.test(text);
      pyMeta[name] = { name, path: path.join(root, name), text, isMain };
    }

    // 找主文件
    let mainPy = null;
    for (const name of pyFiles) {
      if (pyMeta[name].isMain) { mainPy = pyMeta[name]; break; }
    }
    if (!mainPy) {
      const candidate = pyFiles.filter((n) => !n.toLowerCase().startsWith('test_') && !n.toLowerCase().endsWith('_test.py')).sort((a, b) => a.length - b.length)[0];
      if (candidate) mainPy = pyMeta[candidate];
    }

    // 推断 Python 技术栈
    const allText = pyFiles.slice(0, 20).map((n) => pyMeta[n].text.slice(0, 12000)).join('\n');
    let pyStack = '';
    if (/\bflask\b/i.test(allText)) pyStack = 'Flask';
    else if (/\bdjango\b/i.test(allText)) pyStack = 'Django';
    else if (/\bfastapi\b/i.test(allText)) pyStack = 'FastAPI';
    else if (/\b(tkinter|PyQt|PySide|wx\.|kivy|dearpygui)\b/i.test(allText)) pyStack = 'Python GUI';
    else if (/\b(pygame|arcade|panda3d)\b/i.test(allText)) pyStack = 'Python 游戏';
    else if (pyProject && /\[tool\.pytest|testpaths|pytest/.test(pyProject)) pyStack = 'Python 测试项目';
    else pyStack = 'Python 脚本';
    langs.push({ name: 'Python', kind: pyStack, mainPath: mainPy ? mainPy.path : path.join(root, pyFiles[0]) });
    roles.push({ name: '框架：' + pyStack, path: (mainPy ? mainPy.path : path.join(root, pyFiles[0])), role: '技术栈' });

    // 检测同目录模块间的 import 关系：A 是否 import / from B（按不含 .py 的模块名匹配）
    const moduleName = (n) => path.basename(n, '.py');
    const pyRelationships = [];
    for (const a of pyFiles) {
      const text = pyMeta[a].text;
      for (const b of pyFiles) {
        if (a === b) continue;
        const mod = moduleName(b).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('(?:^|;)\\s*(?:import\\s+' + mod + '(?:\\s*,|\\s+as|\\s*$)|from\\s+' + mod + '\\s+import)', 'm');
        if (re.test(text)) pyRelationships.push({ from: a, to: b });
      }
    }

    // 为每个 py 文件生成角色
    const pyRoles = [];
    const lowerName = (n) => n.toLowerCase();
    for (const name of pyFiles) {
      const meta = pyMeta[name];
      const importedBy = pyRelationships.filter((r) => r.to === name).map((r) => r.from);
      const imports = pyRelationships.filter((r) => r.from === name).map((r) => r.to);
      let role = '';
      if (mainPy && name === mainPy.name) {
        role = 'Python 主程序';
      } else if (/test_/.test(name) || /_test\.py$/i.test(name)) {
        role = '测试模块';
      } else {
        const ln = lowerName(name);
        const hasGui = /\b(tkinter|PyQt|PySide|wx\.|kivy|dearpygui)\b/i.test(meta.text);
        if (hasGui || /gui|ui|view/i.test(ln)) role = 'GUI / 视图模块';
        else if (/logic|core|model|service|handler|controller|domain|biz/i.test(ln)) role = '核心逻辑模块';
        else if (/util|helper|common|lib|tools|helpers/i.test(ln)) role = '工具模块';
        else if (/config|settings|const/i.test(ln)) role = '配置模块';
        else role = 'Python 模块';
      }
      const extras = [];
      if (imports.length) extras.push('导入 ' + imports.join('、'));
      if (importedBy.length) extras.push('被 ' + importedBy.join('、') + ' 导入');
      const roleText = extras.length ? (role + '（' + extras.join('；') + '）') : role;
      pyRoles.push({ name, path: meta.path, role: roleText, _isMain: mainPy && name === mainPy.name });
    }
    // 排序：主程序在前，其余按文件名
    pyRoles.sort((a, b) => {
      if (a._isMain && !b._isMain) return -1;
      if (!a._isMain && b._isMain) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const r of pyRoles) {
      delete r._isMain;
      roles.push(r);
    }

    if (pyRelationships.length) {
      for (const r of pyRelationships) relationships.push({ from: r.from, to: r.to, type: 'import' });
    }
  }

  // ---- Go ----
  const goFiles = extFiles(['.go']);
  if (goFiles.length) {
    if (has('go.mod')) roles.push({ name: 'go.mod', path: path.join(root, 'go.mod'), role: 'Go 模块定义' });
    const goMeta = {};
    for (const name of goFiles) goMeta[name] = { name, path: path.join(root, name), text: readFileSafe(name, 10000) };
    let goMain = null;
    for (const name of goFiles) {
      if (/package\s+main/.test(goMeta[name].text) && /\bfunc\s+main\s*\(/.test(goMeta[name].text)) { goMain = name; break; }
    }
    // 检测 import "path" → 最佳努力映射到本地子目录（取最后一段）
    const goRelationships = [];
    let subdirs = [];
    try { subdirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (_) {}
    for (const name of goFiles) {
      const text = goMeta[name].text;
      const impRe = /import\s*(?:\(\s*([\s\S]*?)\s*\)|"([^"]+)")/g;
      let m;
      while ((m = impRe.exec(text))) {
        const block = m[1] || m[2] || '';
        const paths = block.split('\n').map((s) => (s.match(/"([^"]+)"/) || [])[1]).filter(Boolean);
        for (const p of paths) {
          const base = p.replace(/\\/g, '/').split('/').pop();
          if (subdirs.includes(base)) goRelationships.push({ from: name, to: base + '/' });
        }
      }
    }
    const goRoles = [];
    for (const name of goFiles) {
      let role;
      if (goMain && name === goMain) role = 'Go 主程序（入口）';
      else if (/_test\.go$/i.test(name)) role = 'Go 测试';
      else if (/package\s+main/.test(goMeta[name].text)) role = 'Go 包（main）';
      else role = 'Go 包';
      const imports = goRelationships.filter((r) => r.from === name).map((r) => r.to);
      if (imports.length) role += '（依赖 ' + imports.join('、') + '）';
      goRoles.push({ name, path: goMeta[name].path, role, _isMain: goMain === name });
    }
    goRoles.sort((a, b) => {
      if (a._isMain && !b._isMain) return -1;
      if (!a._isMain && b._isMain) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const r of goRoles) { delete r._isMain; roles.push(r); }

    const allText = goFiles.slice(0, 20).map((n) => goMeta[n].text).join('\n');
    let kind = 'Go 程序';
    if (/\b(gin|echo|fiber|net\/http)\b/i.test(allText)) kind = 'Go Web 服务';
    else if (/\b(fyne|gioui)\b/i.test(allText)) kind = 'Go GUI';
    langs.push({ name: 'Go', kind, mainPath: path.join(root, (goMain || goFiles[0])) });

    if (goRelationships.length) {
      for (const r of goRelationships) relationships.push({ from: r.from, to: r.to, type: 'import' });
    }
  }

  // ---- Rust ----
  const rsFiles = extFiles(['.rs']);
  if (rsFiles.length) {
    if (has('Cargo.toml')) roles.push({ name: 'Cargo.toml', path: path.join(root, 'Cargo.toml'), role: 'Rust 项目配置' });
    const rsMeta = {};
    for (const name of rsFiles) rsMeta[name] = { name, path: path.join(root, name), text: readFileSafe(name, 12000) };
    let rsMain = null;
    for (const name of rsFiles) {
      if (/\bfn\s+main\s*\(/.test(rsMeta[name].text)) { rsMain = name; break; }
    }
    // 检测 mod foo; → foo.rs / foo/mod.rs
    const rsRelationships = [];
    const rsSet = new Set(rsFiles);
    for (const name of rsFiles) {
      const text = rsMeta[name].text;
      const modRe = /\bmod\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;/g;
      let m;
      while ((m = modRe.exec(text))) {
        const mod = m[1];
        if (rsSet.has(mod + '.rs')) rsRelationships.push({ from: name, to: mod + '.rs' });
        else if (rsSet.has(mod + '/mod.rs')) rsRelationships.push({ from: name, to: mod + '/mod.rs' });
      }
    }
    const rsRoles = [];
    for (const name of rsFiles) {
      let role;
      if (rsMain && name === rsMain) role = 'Rust 主程序（入口）';
      else if (name.toLowerCase() === 'lib.rs') role = 'Rust 库入口';
      else if (/test/i.test(name)) role = 'Rust 测试模块';
      else role = 'Rust 模块';
      const imports = rsRelationships.filter((r) => r.from === name).map((r) => r.to);
      const importedBy = rsRelationships.filter((r) => r.to === name).map((r) => r.from);
      const extras = [];
      if (imports.length) extras.push('引入 ' + imports.join('、'));
      if (importedBy.length) extras.push('被 ' + importedBy.join('、') + ' 引入');
      if (extras.length) role += '（' + extras.join('；') + '）';
      rsRoles.push({ name, path: rsMeta[name].path, role, _isMain: rsMain === name });
    }
    rsRoles.sort((a, b) => {
      if (a._isMain && !b._isMain) return -1;
      if (!a._isMain && b._isMain) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const r of rsRoles) { delete r._isMain; roles.push(r); }

    const allText = rsFiles.slice(0, 20).map((n) => rsMeta[n].text).join('\n');
    let kind = 'Rust 程序';
    if (/(actix|rocket|axum|warp)/i.test(allText)) kind = 'Rust Web 服务';
    else if (/(bevy|piston|macroquad|ggez)/i.test(allText)) kind = 'Rust 游戏';
    else if (/(tauri|iced|druid|egui)/i.test(allText)) kind = 'Rust GUI';
    langs.push({ name: 'Rust', kind, mainPath: path.join(root, (rsMain || rsFiles[0])) });

    if (rsRelationships.length) {
      for (const r of rsRelationships) relationships.push({ from: r.from, to: r.to, type: 'mod' });
    }
  }

  // ---- Java / Kotlin ----
  const javaFiles = extFiles(['.java']);
  const ktFiles = extFiles(['.kt', '.kts']);
  if (javaFiles.length) {
    if (has('pom.xml')) roles.push({ name: 'pom.xml', path: path.join(root, 'pom.xml'), role: 'Maven 配置' });
    else if (has('build.gradle')) roles.push({ name: 'build.gradle', path: path.join(root, 'build.gradle'), role: 'Gradle 配置' });
    else if (has('build.gradle.kts')) roles.push({ name: 'build.gradle.kts', path: path.join(root, 'build.gradle.kts'), role: 'Gradle 配置' });
    const javaMeta = {};
    for (const name of javaFiles) javaMeta[name] = { name, path: path.join(root, name), text: readFileSafe(name, 10000) };
    let javaMain = null;
    for (const name of javaFiles) {
      if (/public\s+static\s+void\s+main\s*\(/.test(javaMeta[name].text)) { javaMain = name; break; }
    }
    const javaRoles = [];
    for (const name of javaFiles) {
      let role;
      if (javaMain && name === javaMain) role = 'Java 主类（入口）';
      else if (/@Test|org\.junit|jupiter/i.test(javaMeta[name].text) || /test/i.test(name)) role = 'Java 测试类';
      else role = 'Java 类';
      javaRoles.push({ name, path: javaMeta[name].path, role, _isMain: javaMain === name });
    }
    javaRoles.sort((a, b) => {
      if (a._isMain && !b._isMain) return -1;
      if (!a._isMain && b._isMain) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const r of javaRoles) { delete r._isMain; roles.push(r); }

    const allText = javaFiles.slice(0, 20).map((n) => javaMeta[n].text).join('\n');
    let kind = 'Java 程序';
    if (/springframework|@SpringBootApplication/i.test(allText)) kind = 'Spring Boot';
    langs.push({ name: 'Java', kind, mainPath: path.join(root, (javaMain || javaFiles[0])) });
  }
  if (ktFiles.length) {
    const allText = ktFiles.slice(0, 10).map((n) => readFileSafe(n, 6000)).join('\n');
    let kind = 'Kotlin 程序';
    if (/androidx|import android\./i.test(allText)) kind = 'Android (Kotlin)';
    langs.push({ name: 'Kotlin', kind, mainPath: path.join(root, ktFiles[0]) });
  }

  // ---- C / C++ ----
  const cFiles = extFiles(['.c', '.cpp', '.cc', '.cxx']);
  const hFiles = extFiles(['.h', '.hpp']);
  if (cFiles.length || hFiles.length) {
    if (has('CMakeLists.txt')) roles.push({ name: 'CMakeLists.txt', path: path.join(root, 'CMakeLists.txt'), role: 'CMake 构建' });
    else if (has('Makefile')) roles.push({ name: 'Makefile', path: path.join(root, 'Makefile'), role: 'Make 配置' });

    // 读取所有 c/c++/h 文件内容
    const cMeta = {};
    for (const name of cFiles.concat(hFiles)) {
      cMeta[name] = { name, path: path.join(root, name), text: readFileSafe(name, 12000) };
    }
    // 找主程序（含 int main）
    let cMain = null;
    for (const name of cFiles) {
      if (/\bint\s+main\s*\(/.test(cMeta[name].text)) { cMain = name; break; }
    }
    // 检测本地 #include "xxx.h"（引号，非 <> 系统头）
    const cRelationships = [];
    const headerSet = new Set(hFiles);
    for (const name of cFiles.concat(hFiles)) {
      const text = cMeta[name].text;
      const incRe = /#include\s*"([^"]+)"/g;
      let m;
      while ((m = incRe.exec(text))) {
        const inc = m[1].replace(/\\/g, '/').split('/').pop(); // 只取文件名
        if (headerSet.has(inc)) cRelationships.push({ from: name, to: inc });
      }
    }
    // 生成角色（头文件在前，主程序置顶）
    const cRoles = [];
    for (const name of hFiles) {
      const importedBy = cRelationships.filter((r) => r.to === name).map((r) => r.from);
      let role = '头文件（声明）';
      if (importedBy.length) role += '（被 ' + importedBy.join('、') + ' 包含）';
      cRoles.push({ name, path: cMeta[name].path, role, _order: 1, _isMain: false });
    }
    for (const name of cFiles) {
      const ext = path.extname(name).toLowerCase();
      let role;
      if (cMain && name === cMain) role = 'C/C++ 主程序（入口）';
      else if (/test/i.test(name)) role = 'C/C++ 测试';
      else role = (ext === '.c') ? 'C 实现模块' : 'C++ 实现模块';
      const imports = cRelationships.filter((r) => r.from === name).map((r) => r.to);
      if (imports.length) role += '（包含 ' + imports.join('、') + '）';
      cRoles.push({ name, path: cMeta[name].path, role, _order: 0, _isMain: cMain === name });
    }
    cRoles.sort((a, b) => {
      if (a._isMain && !b._isMain) return -1;
      if (!a._isMain && b._isMain) return 1;
      if (a._order !== b._order) return a._order - b._order;
      return a.name.localeCompare(b.name);
    });
    for (const r of cRoles) { delete r._order; delete r._isMain; roles.push(r); }

    const allText = cFiles.concat(hFiles).slice(0, 20).map((n) => cMeta[n].text).join('\n');
    let kind = 'C/C++ 程序';
    if (/#include\s*<(SDL|SDL2|raylib|SFML)|glfw|opengl/i.test(allText)) kind = 'C/C++ 图形/游戏';
    else if (/QApplication|#include\s*<Q/i.test(allText)) kind = 'C/C++ Qt GUI';
    langs.push({ name: 'C/C++', kind, mainPath: path.join(root, (cMain || cFiles[0] || hFiles[0])) });

    if (cRelationships.length) {
      for (const r of cRelationships) relationships.push({ from: r.from, to: r.to, type: 'include' });
    }
  }

  // ---- C# ----
  const csFiles = extFiles(['.cs']);
  if (csFiles.length) {
    const csproj = fileNames.find((n) => /\.csproj$/i.test(n));
    const sln = fileNames.find((n) => /\.sln$/i.test(n));
    if (csproj) roles.push({ name: csproj, path: path.join(root, csproj), role: 'C# 项目' });
    if (sln) roles.push({ name: sln, path: path.join(root, sln), role: 'C# 解决方案' });
    const csMeta = {};
    for (const name of csFiles) csMeta[name] = { name, path: path.join(root, name), text: readFileSafe(name, 10000) };
    let csMain = null;
    for (const name of csFiles) {
      if (/static\s+(?:async\s+)?(?:Task\s+)?Main\s*\(/i.test(csMeta[name].text)) { csMain = name; break; }
    }
    const csRoles = [];
    for (const name of csFiles) {
      let role;
      if (csMain && name === csMain) role = 'C# 主程序（入口）';
      else if (/\[Test\]|\[Fact\]|\[Theory\]|xunit|nunit/i.test(csMeta[name].text) || /test/i.test(name)) role = 'C# 测试';
      else role = 'C# 类';
      csRoles.push({ name, path: csMeta[name].path, role, _isMain: csMain === name });
    }
    csRoles.sort((a, b) => {
      if (a._isMain && !b._isMain) return -1;
      if (!a._isMain && b._isMain) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const r of csRoles) { delete r._isMain; roles.push(r); }

    const allText = csFiles.slice(0, 20).map((n) => csMeta[n].text).join('\n');
    let kind = 'C# 程序';
    if (/using\s+UnityEngine/i.test(allText)) kind = 'Unity C#';
    else if (/AspNetCore|CreateBuilder|ASP\.NET/i.test(allText)) kind = 'ASP.NET';
    langs.push({ name: 'C#', kind, mainPath: path.join(root, (csMain || csFiles[0])) });
  }

  // ---- Ruby ----
  const rbFiles = extFiles(['.rb']);
  if (rbFiles.length) {
    if (has('Gemfile')) roles.push({ name: 'Gemfile', path: path.join(root, 'Gemfile'), role: 'Ruby 依赖' });
    const allText = rbFiles.slice(0, 10).map((n) => readFileSafe(n, 6000)).join('\n');
    let kind = 'Ruby 脚本';
    if (/rails|ActionController|ActiveRecord/i.test(allText)) kind = 'Ruby on Rails';
    else if (/sinatra/i.test(allText)) kind = 'Sinatra';
    langs.push({ name: 'Ruby', kind, mainPath: path.join(root, rbFiles[0]) });
  }

  // ---- PHP ----
  const phpFiles = extFiles(['.php']);
  if (phpFiles.length) {
    if (has('composer.json')) roles.push({ name: 'composer.json', path: path.join(root, 'composer.json'), role: 'PHP 依赖' });
    const allText = phpFiles.slice(0, 10).map((n) => readFileSafe(n, 6000)).join('\n');
    let kind = 'PHP 程序';
    if (/laravel|Illuminate\\/i.test(allText)) kind = 'Laravel';
    else if (/symfony/i.test(allText)) kind = 'Symfony';
    langs.push({ name: 'PHP', kind, mainPath: path.join(root, phpFiles[0]) });
  }

  // ---- Swift ----
  const swiftFiles = extFiles(['.swift']);
  if (swiftFiles.length) {
    if (has('Package.swift')) roles.push({ name: 'Package.swift', path: path.join(root, 'Package.swift'), role: 'Swift 包定义' });
    const swiftMeta = {};
    for (const name of swiftFiles) swiftMeta[name] = { name, path: path.join(root, name), text: readFileSafe(name, 6000) };
    let swiftMain = null;
    for (const name of swiftFiles) {
      if (/@main|func\s+main\s*\(/.test(swiftMeta[name].text)) { swiftMain = name; break; }
    }
    const swiftRoles = [];
    for (const name of swiftFiles) {
      let role;
      if (swiftMain && name === swiftMain) role = 'Swift 主程序（入口）';
      else if (/test/i.test(name)) role = 'Swift 测试';
      else role = 'Swift 源文件';
      swiftRoles.push({ name, path: swiftMeta[name].path, role, _isMain: swiftMain === name });
    }
    swiftRoles.sort((a, b) => {
      if (a._isMain && !b._isMain) return -1;
      if (!a._isMain && b._isMain) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const r of swiftRoles) { delete r._isMain; roles.push(r); }

    const allText = swiftFiles.slice(0, 10).map((n) => swiftMeta[n].text).join('\n');
    let kind = 'Swift 程序';
    if (/import SwiftUI/i.test(allText)) kind = 'SwiftUI';
    else if (/import UIKit/i.test(allText)) kind = 'iOS (UIKit)';
    langs.push({ name: 'Swift', kind, mainPath: path.join(root, (swiftMain || swiftFiles[0])) });
  }

  // ---- 可执行文件 / 构建产物 ----
  const exeExts = new Set(['.exe', '.bat', '.cmd', '.ps1', '.com', '.msi', '.sh', '.bin', '.out', '.run']);
  const isExecutableByExt = (n) => exeExts.has(path.extname(n).toLowerCase());
  const isExecutableByMode = (n) => {
    try {
      const st = fs.statSync(path.join(root, n));
      // POSIX 可执行位；Windows 上扩展名已覆盖主要可执行文件，这里作为兜底
      return (st.mode & 0o111) !== 0 && !st.isDirectory();
    } catch (_) { return false; }
  };
  const executableFiles = fileNames.filter((n) => isExecutableByExt(n) || isExecutableByMode(n));
  if (executableFiles.length) {
    // 对 C/C++ 项目，若存在与主程序同名的 exe，把主程序入口指向可执行文件
    const cCppLang = langs.find((l) => l.name === 'C/C++');
    if (cCppLang) {
      const base = path.basename(cCppLang.mainPath, path.extname(cCppLang.mainPath));
      const matchingExe = executableFiles.find((n) => path.basename(n, path.extname(n)).toLowerCase() === base.toLowerCase());
      if (matchingExe) cCppLang.mainPath = path.join(root, matchingExe);
    }
    for (const name of executableFiles) {
      const ext = path.extname(name).toLowerCase();
      let role = '可执行文件 / 构建产物';
      if (ext === '.exe') role = 'Windows 可执行程序（构建产物）';
      else if (ext === '.bat' || ext === '.cmd') role = 'Windows 批处理脚本';
      else if (ext === '.ps1') role = 'PowerShell 脚本';
      else if (ext === '.sh') role = 'Shell 脚本';
      else if (ext === '.msi') role = 'Windows 安装包';
      else if (ext === '.bin' || ext === '.out' || ext === '.run') role = '二进制可执行文件 / 构建产物';
      else if (ext === '') role = '可执行文件（无扩展名）';
      // 若文件名与某个已知源码文件同名，补充说明
      const base = path.basename(name, ext || undefined);
      const relatedSrc = fileNames.find((n) => n !== name && path.basename(n, path.extname(n)).toLowerCase() === base.toLowerCase());
      if (relatedSrc) role += '（由 ' + relatedSrc + ' 编译/生成）';
      roles.push({ name, path: path.join(root, name), role });
    }
  }

  // ---- Dart / Flutter ----
  const dartFiles = extFiles(['.dart']);
  if (dartFiles.length) {
    if (has('pubspec.yaml')) roles.push({ name: 'pubspec.yaml', path: path.join(root, 'pubspec.yaml'), role: 'Dart/Flutter 配置' });
    const allText = dartFiles.slice(0, 10).map((n) => readFileSafe(n, 6000)).join('\n');
    let kind = 'Dart 程序';
    if (/flutter|material\.dart/i.test(allText)) kind = 'Flutter';
    langs.push({ name: 'Dart', kind, mainPath: path.join(root, dartFiles[0]) });
  }

  // ---- R（数据分析） ----
  const rFiles = extFiles(['.r', '.R']);
  if (rFiles.length) langs.push({ name: 'R', kind: 'R 数据分析', mainPath: path.join(root, rFiles[0]) });

  // ---- Bash / Shell（仅当它可能是项目语言之一时计入） ----
  const shFiles = fileNames.filter((n) => /\.sh$/i.test(n));
  if (shFiles.length && (langs.length === 0 || shFiles.length >= 3)) {
    langs.push({ name: 'Bash', kind: 'Shell 脚本', mainPath: path.join(root, shFiles[0]) });
  }

  // ---- 通用配置 / 构建文件 ----
  const configKeys = [
    'vite.config', 'webpack.config', 'tsconfig.json', 'next.config', 'rollup.config',
    'babel.config', 'jest.config', 'tailwind.config', 'dockerfile', 'docker-compose',
    '.eslintrc', 'CMakeLists.txt', 'Makefile', 'Dockerfile', 'pubspec.yaml'
  ];
  for (const e of entries) {
    const n = e.name.toLowerCase();
    if (configKeys.some((k) => n === k || n.startsWith(k)) && !roles.some((r) => r.name === e.name)) {
      roles.push({ name: e.name, path: path.join(root, e.name), role: '构建 / 配置' });
    }
  }
  const src = entries.find((e) => e.isDirectory() && /^(src|lib|app|source|packages|cmd|internal)$/i.test(e.name));
  if (src) roles.push({ name: src.name + '/', path: path.join(root, src.name), role: '源码目录' });

  // ---- 其他文件类型（低优先级兜底） ----
  // 把尚未被各语言扫描识别的文件按扩展名分类，加入 roles（靠后展示）
  const trackedNames = new Set(roles.map((r) => r.name));
  const otherFiles = [];
  for (const name of fileNames) {
    if (trackedNames.has(name)) continue;
    const [type, roleText] = classifyFile(name);
    if (type === 'other') continue; // 完全未知类型不显示，避免太杂
    otherFiles.push({ name, path: path.join(root, name), role: roleText, _type: type });
  }
  // 按类型分组排序
  otherFiles.sort((a, b) => {
    const oa = TYPE_ORDER[a._type] || 99;
    const ob = TYPE_ORDER[b._type] || 99;
    if (oa !== ob) return oa - ob;
    return a.name.localeCompare(b.name);
  });
  for (const r of otherFiles) {
    delete r._type;
    roles.push(r);
  }

  // ---- 汇总 framework 文案（支持多语言混搭） ----
  let framework;
  if (!langs.length) {
    framework = roles.length ? '通用 / 非代码项目' : '未识别';
  } else if (langs.length === 1) {
    framework = langs[0].name + ' · ' + langs[0].kind;
  } else {
    framework = langs.map((l) => l.name).join(' + ') + '（多语言）';
  }

  return {
    framework,
    languages: langs.map((l) => ({ name: l.name, kind: l.kind, mainPath: l.mainPath })),
    roles,
    relationships
  };
}

/**
 * 把扫描结果渲染成给 agent 看的纯文本概览（含多语言拆分指导）。
 * @param {{framework:string,languages:Array,roles:Array}} data
 * @param {object} [opts]
 * @param {boolean} [opts.actionable=true] 是否在末尾追加「如何拆分写入多文件」的可操作指令。
 * @param {number}  [opts.maxRoles=0] 角色列表最多展示几条（0 表示全部）；超出部分折叠为「…等 N 个」。
 */
function projectOverviewText(data, opts) {
  const actionable = opts && opts.actionable !== false;
  const maxRoles = (opts && opts.maxRoles) || 0;
  const fw = data.framework && data.framework !== '未识别' ? ('检测到的技术栈：' + data.framework) : '（未识别到具体技术栈，可能需要在扫描后进一步确认）';
  const lines = [
    '下面是当前工作区的项目概览，请据此开展工作：',
    '',
    '【' + fw + '】',
    ''
  ];
  const roles = data.roles || [];
  if (roles.length) {
    lines.push('已识别的关键文件与角色：');
    const shown = maxRoles > 0 ? roles.slice(0, maxRoles) : roles;
    for (const r of shown) lines.push('- ' + r.name + '：' + r.role);
    if (maxRoles > 0 && roles.length > maxRoles) {
      lines.push('- …等 ' + roles.length + ' 个文件/目录');
    }
  } else {
    lines.push('（未发现关键文件，可能是一个未初始化或空的工作区）');
  }
  lines.push('');

  if (data.relationships && data.relationships.length) {
    lines.push('检测到的文件依赖关系：');
    for (const rel of data.relationships) lines.push('- ' + rel.from + ' → ' + rel.to + '（' + (rel.type || 'import') + '）');
    lines.push('');
  }

  if (data.languages && data.languages.length > 1) {
    lines.push('⚠️ 这是一个多语言混搭项目，请遵守：');
    lines.push('1. 不同语言的代码必须放在各自独立的文件/目录里，不要混在一个文件；');
    lines.push('2. 新增或重写代码时，按「一个清晰职责 = 一个文件」拆分，先预估每个模块需要写到几个文件、各自路径，再逐个用 write_file 创建；');
    lines.push('3. 跨语言调用（如 Python 调用 Go 服务、JS 调用本地二进制）要明确接口边界与通信方式（参数 / 返回 / 协议）。');
    lines.push('');
  }

  if (actionable) {
    lines.push('工作准则：');
    lines.push('- 先理解每个文件的作用，再动手；涉及多文件改动时，注意它们之间的依赖与调用关系，改动后保持整体协调。');
    lines.push('- 生成 / 重构代码时，主动拆分为多个文件，不要堆在单文件；每个文件只负责一块清晰的功能。');
    lines.push('- 可用 read_file / list_dir / search_text 进一步核实每个文件的具体内容；改动后用 diagnostics 验证。');
  }
  return lines.join('\n');
}

/**
 * 构建工作区文件树（类似文件管理器），用于环境面板的「项目」标签页。
 * 返回 { root, nodes }，其中 nodes 是顶层节点数组。
 * 每个节点：{ name, path, type:'file'|'dir', children?, fileType?, role?, size? }
 * maxDepth: 最大递归深度（默认 2，避免大仓库卡死）
 * skip: 跳过的目录名集合
 */
function buildFileTree(root, maxDepth = 2, skip = new Set(['node_modules', '.git', '.vscode', '__pycache__', '.vs', 'out', 'dist', 'build'])) {
  function walk(dir, depth) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
    const nodes = [];
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env') continue;
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const children = depth < maxDepth ? walk(full, depth + 1) : [];
        nodes.push({ name: e.name, path: full, type: 'dir', children });
      } else {
        const [fileType, role] = classifyFile(e.name);
        let size = 0;
        try { size = fs.statSync(full).size; } catch (_) {}
        nodes.push({ name: e.name, path: full, type: 'file', fileType, role, size });
      }
    }
    // 目录在前，文件按类型分组再按文件名排序
    const dirNodes = nodes.filter((n) => n.type === 'dir').sort((a, b) => a.name.localeCompare(b.name));
    const fileNodes = nodes.filter((n) => n.type === 'file');
    fileNodes.sort((a, b) => {
      const oa = TYPE_ORDER[a.fileType] || 99;
      const ob = TYPE_ORDER[b.fileType] || 99;
      if (oa !== ob) return oa - ob;
      return a.name.localeCompare(b.name);
    });
    return dirNodes.concat(fileNodes);
  }
  return { root, nodes: walk(root, 1) };
}

/**
 * L1 极速层用的精简文件树文本：只输出「目录 / 文件」层级路径，不带角色/大小/骨架。
 * 目标是 ≤ 约 1.5K token、随会话常驻可缓存，比完整的「项目概览 + 代码骨架」轻得多，
 * 让「你好」这类轻问只走这一层就能命中前缀缓存、秒回。
 * @param {string} root 项目根目录
 * @param {number} [maxDepth=2] 递归深度
 * @param {number} [maxEntries=120] 最多输出多少条（防止超大仓库撑爆 L1）
 * @param {Set<string>} [skip] 跳过的目录名
 */
function renderFileTreeText(root, maxDepth = 2, maxEntries = 120, skip) {
  const SKIP = skip || new Set(['node_modules', '.git', '.vscode', '__pycache__', '.vs', '.venv', 'venv', 'out', 'dist', 'build', 'target', '.next', 'coverage', 'vendor']);
  const lines = [];
  let count = 0;
  let truncated = false;

  function walk(dir, depth, prefix) {
    if (depth > maxDepth || truncated) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    const dirs = [];
    const files = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (SKIP.has(e.name)) continue;
      (e.isDirectory() ? dirs : files).push(e.name);
    }
    dirs.sort((a, b) => a.localeCompare(b));
    files.sort((a, b) => a.localeCompare(b));
    for (const name of dirs) {
      if (count >= maxEntries) { truncated = true; return; }
      lines.push(prefix + '📁 ' + name + '/');
      count++;
      walk(path.join(dir, name), depth + 1, prefix + '  ');
    }
    for (const name of files) {
      if (count >= maxEntries) { truncated = true; return; }
      lines.push(prefix + '📄 ' + name);
      count++;
    }
  }

  walk(root, 1, '');
  if (truncated) lines.push('…（文件树已截断，用 list_dir / read_file 按需查看）');
  return lines.join('\n');
}

/* ---------- 代码骨架（零依赖 AST） ---------- */

/**
 * 用正则从源码里抽取类 / 函数 / 方法签名，形成 L1 级骨架。
 * 不保证 100% 准确，但零依赖、速度快、token 省。
 */
function astSkeleton(filePath, text) {
  const ext = path.extname(filePath).toLowerCase();
  const lines = (text || '').split('\n');
  const out = [];
  const add = (type, line, name) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    out.push(`${type} ${name || trimmed.split(/[\s(:]/)[1] || ''}: ${trimmed.slice(0, 160)}`);
  };

  if (['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'].includes(ext)) {
    const re = /^(\s*)(?:export\s+|default\s+|async\s+)*(?:class\s+(\w+)|function\s*\*?\s*(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function|\(?.*\)?\s*=>)|(\w+)\s*\([^)]*\)\s*\{)/;
    for (const line of lines) {
      const m = line.match(re);
      if (m) {
        const type = m[2] ? 'class' : 'function';
        const name = m[2] || m[3] || m[4] || m[5] || '';
        add(type, line, name);
      }
    }
  } else if (ext === '.py') {
    const re = /^(\s*)(?:class\s+(\w+)|def\s+(\w+)\s*\()/;
    for (const line of lines) {
      const m = line.match(re);
      if (m) add(m[2] ? 'class' : 'function', line, m[2] || m[3]);
    }
  } else if (ext === '.go') {
    const re = /^(\s*)(?:func\s+(?:\([^)]+\)\s*)?(\w+)|type\s+(\w+)\s+struct|type\s+(\w+)\s+interface)/;
    for (const line of lines) {
      const m = line.match(re);
      if (m) add(m[3] ? 'type' : 'function', line, m[2] || m[3] || m[4]);
    }
  } else if (ext === '.rs') {
    const re = /^(\s*)(?:fn\s+(\w+)|struct\s+(\w+)|impl\s+(?:\w+\s+for\s+)?(\w+)|trait\s+(\w+)|enum\s+(\w+))/;
    for (const line of lines) {
      const m = line.match(re);
      if (m) add(m[3] || m[5] || m[6] ? 'type' : 'function', line, m[2] || m[3] || m[4] || m[5] || m[6]);
    }
  } else if (['.java', '.kt'].includes(ext)) {
    const re = /^(\s*)(?:public\s+|private\s+|protected\s+|static\s+|final\s+)*(?:class|interface|enum|record)\s+(\w+)|(?:public\s+|private\s+|protected\s+|static\s+|final\s+)*([\w<>,\[\]\s]+)\s+(\w+)\s*\(/;
    for (const line of lines) {
      const m = line.match(re);
      if (m) add(m[2] ? 'class' : 'function', line, m[2] || m[4]);
    }
  } else if (['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp'].includes(ext)) {
    const re = /^(\s*)(?:class\s+(\w+)|(?:[\w:*&<>\[\]\s]+)\s+(\w+)\s*\([^)]*\)\s*(?:const\s*)?\{?)/;
    for (const line of lines) {
      const m = line.match(re);
      if (m && !line.trim().startsWith('#')) add(m[2] ? 'class' : 'function', line, m[2] || m[3]);
    }
  }
  return out.slice(0, 80).join('\n');
}

/* ---------- 项目扫描缓存与代码图谱 ---------- */

const scanCache = new Map();
const SCAN_CACHE_MAX = 20; // 最多缓存 20 个项目扫描结果，LRU 淘汰
const SKELETON_MAX_FILE_SIZE = 200 * 1024;

function cachePathFor(root) {
  const hash = require('crypto').createHash('md5').update(root).digest('hex').slice(0, 12);
  return path.join(require('os').homedir(), '.fox-ai', 'cache', `project-${hash}.json`);
}

function safeReadJson(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function safeWriteJson(p, data) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function signatureOfDir(root) {
  let newest = 0;
  let bytes = 0;
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      try {
        const st = fs.statSync(path.join(root, e.name));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        bytes += st.size;
      } catch (_) {}
    }
  } catch (_) {}
  return `${newest}:${bytes}`;
}

/**
 * 检测项目并缓存结果（内存 + 磁盘）。
 * 当工作区根目录下文件最近修改时间/总字节未变时直接返回缓存，避免每轮重扫。
 */
function detectProjectCached(root) {
  if (!root) return detectProject(root);
  let cacheEnabled = true;
  try {
    cacheEnabled = require('vscode').workspace.getConfiguration('foxAi').get('projectScan.cacheEnabled', true);
  } catch (_) {}
  if (!cacheEnabled) return detectProject(root);
  const sig = signatureOfDir(root);
  const mem = scanCache.get(root);
  if (mem && mem.signature === sig) return mem.data;

  const diskPath = cachePathFor(root);
  const disk = safeReadJson(diskPath, null);
  if (disk && disk.signature === sig && disk.data) {
    scanCache.set(root, { signature: sig, data: disk.data });
    return disk.data;
  }

  const data = detectProject(root);
  if (scanCache.size >= SCAN_CACHE_MAX) {
    const first = scanCache.keys().next().value;
    scanCache.delete(first);
  }
  scanCache.set(root, { signature: sig, data });
  safeWriteJson(diskPath, { signature: sig, data, builtAt: Date.now() });
  return data;
}

/**
 * 为工作区里的代码文件批量生成 L1 骨架摘要。
 * 只扫描根目录下常见源码目录及顶层文件，跳过 node_modules/.git/构建产物。
 */
function buildSkeletonMap(root) {
  const codeExts = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.cs']);
  const skip = new Set(['node_modules', '.git', '.vscode', '__pycache__', '.venv', 'venv', 'out', 'dist', 'build', 'target', '.next']);
  const map = {};

  function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env') continue;
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (codeExts.has(path.extname(e.name).toLowerCase())) {
        try {
          const st = fs.statSync(full);
          if (st.size > SKELETON_MAX_FILE_SIZE) continue;
          const text = fs.readFileSync(full, 'utf8');
          const sk = astSkeleton(full, text);
          if (sk) {
            map[path.relative(root, full).split(path.sep).join('/')] = sk;
          }
        } catch (_) {}
      }
    }
  }
  walk(root);
  return map;
}

/**
 * 查询代码图谱。
 * @param {object} proj detectProject 的返回结果
 * @param {string} op 'who-calls' | 'depends-on' | 'imports'
 * @param {string} target 目标文件名
 * @returns {string}
 */
function queryGraph(proj, op, target) {
  if (!proj || !proj.relationships || !proj.relationships.length) return '（未检测到文件依赖关系）';
  const rels = proj.relationships;
  const base = path.basename(target);
  const matches = (n) => n === target || n === base || path.basename(n) === base;

  if (op === 'who-calls' || op === 'imports') {
    const callers = rels.filter((r) => matches(r.to)).map((r) => r.from);
    if (!callers.length) return `（没有文件显示导入/包含 ${target}）`;
    return `导入/包含 ${target} 的文件：\n` + callers.map((f) => `- ${f}`).join('\n');
  }
  if (op === 'depends-on') {
    const deps = rels.filter((r) => matches(r.from)).map((r) => r.to);
    if (!deps.length) return `（${target} 没有检测到本地依赖）`;
    return `${target} 依赖的本地文件：\n` + deps.map((f) => `- ${f}`).join('\n');
  }
  return '未知图谱查询类型：' + op;
}

/* ---------- 供行内补全与 agent 共用的项目上下文 ---------- */

const skeletonCache = new Map();
const projectCtxCache = new Map();
const PROJECT_ROOT_MARKERS = [
  '.git',
  'package.json',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'CMakeLists.txt',
  'Makefile',
  'pom.xml',
  'build.gradle',
  'gradlew'
];

/** 根据单个文件路径向上查找项目根目录。 */
function findProjectRoot(filePath) {
  if (!filePath) return null;
  let dir = path.dirname(filePath);
  const home = os.homedir();
  const rootDir = path.parse(dir).root;
  while (dir && dir !== home && dir !== rootDir) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

/** 列出当前文件同目录下的其它文件（相对根目录路径），用于行内补全上下文。 */
function listNeighborFiles(dir, currentFile, root, max = 12) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const rels = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const full = path.join(dir, e.name);
      if (full === currentFile) continue;
      rels.push(path.relative(root, full).split(path.sep).join('/'));
    }
    return rels.slice(0, max);
  } catch (_) {
    return [];
  }
}

/** 带缓存的 buildSkeletonMap，按根目录最近修改签名失效。 */
function buildSkeletonMapCached(root) {
  if (!root) return {};
  const sig = signatureOfDir(root);
  const mem = skeletonCache.get(root);
  if (mem && mem.signature === sig) return mem.map;
  const map = buildSkeletonMap(root);
  if (skeletonCache.size > 30) {
    const first = skeletonCache.keys().next().value;
    skeletonCache.delete(first);
  }
  skeletonCache.set(root, { signature: sig, map });
  return map;
}

/** 为行内补全生成精简骨架摘要，当前文件优先。 */
function renderSkeletonForInline(map, relCurrent, maxFiles = 8) {
  const keys = Object.keys(map);
  if (!keys.length) return '';
  const lines = [];
  const used = new Set();
  if (relCurrent && map[relCurrent]) {
    lines.push(`📄 ${relCurrent}\n${map[relCurrent]}`);
    used.add(relCurrent);
  }
  const rest = keys.filter((k) => !used.has(k)).sort().slice(0, maxFiles - used.size);
  for (const f of rest) lines.push(`📄 ${f}\n${map[f]}`);
  if (!lines.length) return '';
  return '代码骨架（当前文件优先）：\n' + lines.join('\n\n');
}

/**
 * 渲染供 LLM 使用的项目上下文文本。
 * agent 与行内补全共用此函数，保证两者看到一致的项目概览。
 *
 * @param {string} root 项目根目录
 * @param {string|null} currentFile 当前编辑文件绝对路径
 * @param {object} [opts]
 * @param {number} [opts.maxChars=1200] 返回文本最大字符数
 * @param {boolean} [opts.actionable=true] 是否追加可操作指令
 * @param {number} [opts.maxRoles=12] 项目角色最多展示条数（0 表示全部）
 * @param {boolean} [opts.includeSkeleton=true] 是否注入代码骨架
 * @param {number} [opts.skeletonMaxFiles=8] 骨架最多展示几个文件
 * @param {boolean} [opts.includeNeighbors=true] 是否列出同目录文件
 */
function renderProjectContext(root, currentFile, opts = {}) {
  if (!root) return '';
  const maxChars = opts.maxChars || 1200;
  const actionable = opts.actionable !== false;
  const maxRoles = (opts && opts.maxRoles) || 12;
  const includeSkeleton = opts.includeSkeleton !== false;
  const skeletonMaxFiles = opts.skeletonMaxFiles || 8;
  const includeNeighbors = opts.includeNeighbors !== false;

  const sig = signatureOfDir(root);
  const cacheKey = `${root}|${currentFile || ''}|${maxChars}|${actionable ? 1 : 0}|${maxRoles}|${includeSkeleton ? 1 : 0}|${skeletonMaxFiles}|${includeNeighbors ? 1 : 0}`;
  const mem = projectCtxCache.get(cacheKey);
  if (mem && mem.sig === sig) return mem.text;

  const relCurrent = currentFile ? path.relative(root, currentFile).split(path.sep).join('/') : '';
  const proj = detectProjectCached(root);
  if (!proj.roles.length && !proj.languages.length) return '';

  const parts = [];
  parts.push(`项目根目录：${root}`);
  if (relCurrent) parts.push(`当前文件：${relCurrent}`);

  const overview = projectOverviewText(proj, { actionable, maxRoles });
  if (overview) parts.push(overview);

  if (includeNeighbors && currentFile) {
    const dir = path.dirname(currentFile);
    const neighbors = listNeighborFiles(dir, currentFile, root, 12);
    if (neighbors.length) {
      parts.push(`同目录其它文件：\n${neighbors.map((n) => `- ${n}`).join('\n')}`);
    }
  }

  if (includeSkeleton) {
    const map = buildSkeletonMapCached(root);
    const sk = renderSkeletonForInline(map, relCurrent, skeletonMaxFiles);
    if (sk) parts.push(sk);
  }

  let text = parts.join('\n\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…';

  if (projectCtxCache.size > 30) {
    const first = projectCtxCache.keys().next().value;
    projectCtxCache.delete(first);
  }
  projectCtxCache.set(cacheKey, { sig, text });
  return text;
}

module.exports = {
  detectProject, projectOverviewText, buildFileTree, classifyFile,
  detectProjectCached, buildSkeletonMap, buildSkeletonMapCached,
  astSkeleton, queryGraph, findProjectRoot, renderProjectContext, renderFileTreeText
};
