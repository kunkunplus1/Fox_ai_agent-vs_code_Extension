'use strict';
// 1.1.31 裸 JSON 工具参数剥离回归测试（治「糊成一团」新形态：模型在正文里直接输出
// {"path":...,"start_line":...} / {"command":...} 无 <foxtool> 外壳的裸参数对象）。
// 覆盖：剥裸 path/command/编辑 JSON；不误伤示例输出 JSON（{"ok":true}）与正常正文；
// stripToolBlocks 的 keep=false/true 两路径都剥；自定义符号 [[tool:]] 与 XML 块保持原有剥离。

const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return { workspace: { getConfiguration: () => ({ get: () => undefined }) }, window: {}, commands: {}, Event: class {} };
  }
  return origLoad.apply(this, arguments);
};
const { stripToolBlocks, stripBareToolArgs } = require('../src/textParser.js');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 FAIL: ' + name); }
}

function hasBareJsonLeak(text) {
  return /\{\s*"(?:path|command|query|glob|content|old_text|new_text|start_line|end_line|max_results|timeout|pattern|file|text|args|model|input|question|answer|src|dst|name|message|url|body|options)"\s*:/.test(text);
}

// ---- stripBareToolArgs 直接单测 ----
{
  const cases = [
    ['裸 path（带引号键）', 'A{"path":"parse.js","start_line":225,"end_line":285}B', 'AB'],
    ['裸 command', 'A{"command":"node parse.js 2>&1|Out-String"}B', 'AB'],
    ['编辑 JSON（old_text/new_text）', 'A{"path":"parse.js","old_text":"x","new_text":"y"}B', 'AB'],
    ['示例输出 JSON 不误伤', 'A{"ok":true,"count":300}B', 'A{"ok":true,"count":300}B'],
    ['普通对象（非参数键）不误伤', 'A{"title":"速查页","total":300}B', 'A{"title":"速查页","total":300}B'],
    ['正常正文不误伤', '\u201c我检查一下当前render逻辑，确认搜索时无匹配章节是否隐藏\u201d', '\u201c我检查一下当前render逻辑，确认搜索时无匹配章节是否隐藏\u201d'],
    ['无 JSON 原样', '纯正文没有对象', '纯正文没有对象'],
    ['未闭合截断剥到结尾', 'A{"path":"parse.js","start_line":225', 'A']
  ];
  for (const [name, input, expected] of cases) {
    const got = stripBareToolArgs(input);
    ok('stripBareToolArgs: ' + name, got === expected);
  }
}

// ---- stripToolBlocks 两路径整合 ----
{
  const samples = [
    ['裸 JSON 嵌正文', '正文A{"path":"parse.js","start_line":225}正文B', false, true],
    ['裸 command 嵌正文', '正文{"command":"node parse.js"}正文', false, true],
    ['XML 工具块 原有剥离仍生效', '正文A<foxtool name="read_file">{"path":"x.js"}</foxtool>正文B', false, true],
    ['自定义符号 原有剥离仍生效', '正文A[[tool:read_file]]{"path":"x.js"}[[/tool]]正文B', false, true],
    ['示例输出 JSON 不误伤', '示例输出：{"ok":true,"count":300}', false, false],
    ['混合块+裸 JSON', '正文A<foxtool name="read_file">{"path":"x.js"}</foxtool>正文B{"path":"parse.js"}正文C', false, true]
  ];
  for (const [name, input, keep, expectClean] of samples) {
    for (const keepFlag of [false, true]) {
      const out = stripToolBlocks(input, keepFlag);
      const hasXmlTag = /<(fox:?tool|fox-tool|tool)[\s\S]/.test(out);
      const hasCustomTag = /\[\[tool:|\[\[\/tool\]\]/.test(out);
      const leak = hasBareJsonLeak(out);
      if (expectClean) {
        ok(name + ' (keep=' + keepFlag + '): 无裸 JSON/工具标签残留', !leak && !hasXmlTag && !hasCustomTag);
      } else {
        ok(name + ' (keep=' + keepFlag + '): 不误伤示例输出', leak === false);
      }
    }
  }
}

console.log('\ntext-bare-args.test: ' + passed + ' 通过, ' + failed + ' 失败');
process.exit(failed ? 1 : 0);