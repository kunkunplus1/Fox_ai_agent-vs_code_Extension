'use strict';

// 工具动态子集选择单元测试（纯函数，无需扩展宿主）
const { tokenize, selectSubsetNames, CORE_ALWAYS } = require('../src/tools/toolSelect');

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

const TOOLS = [
  { name: 'search_text', description: '全文搜索关键字或正则', parameters: { properties: { query: {}, glob: {}, scope: {} } } },
  { name: 'find_files', description: '按 glob 通配符查找文件路径', parameters: {} },
  { name: 'read_file', description: '读取文件内容', parameters: {} },
  { name: 'write_file', description: '创建新文件或整体覆盖', parameters: {} },
  { name: 'edit_file', description: '修改文件', parameters: {} },
  { name: 'run_command', description: '执行 shell 命令', parameters: {} },
  { name: 'list_dir', description: '列出目录', parameters: {} },
  { name: 'current_time', description: '获取当前时间', parameters: {} },
  { name: 'web_search', description: '联网搜索', parameters: {} },
  { name: 'get_diagnostics', description: '读取问题面板', parameters: {} },
  { name: 'get_terminal_output', description: '读取终端输出', parameters: {} },
  { name: 'save_memory', description: '保存长期记忆', parameters: {} },
  { name: 'create_plan_task', description: '创建任务清单', parameters: {} },
  { name: 'generate_image', description: '根据文字描述生成图片', parameters: {} },
  { name: 'security_audit', description: '代码安全自检', parameters: {} },
  { name: 'review_changes', description: '对比代码差异并深度思考', parameters: {} },
  { name: 'create_skill', description: '创建用户技能', parameters: {} },
  { name: 'use_skill', description: '激活用户技能', parameters: {} },
  { name: 'update_plan_task', description: '更新计划任务状态', parameters: {} },
  { name: 'list_plan_tasks', description: '列出计划任务', parameters: {} },
  { name: 'get_memory', description: '获取长期记忆', parameters: {} },
  { name: 'write_organize', description: '写入知识库', parameters: {} },
  { name: 'read_organize', description: '读取知识库', parameters: {} }
];
const ALL_NAMES = new Set(TOOLS.map((t) => t.name));

console.log('[toolSelect] 开始');

// 1) tokenize 基本能力
ok('英文词被切出', tokenize('Hello World').has('hello') && tokenize('Hello World').has('world'));
ok('中文 bigram', tokenize('搜索文件').has('搜索') && tokenize('搜索文件').has('文件'));
ok('空串返回空集', tokenize('').size === 0);
ok('undefined 安全', tokenize(undefined).size === 0);

// 2) 未开启 → null（注入全量）
ok('disabled -> null', selectSubsetNames(TOOLS, '搜索文件', { enabled: false }) === null);

// 3) 空 query → null（不推断）
ok('空 query -> null', selectSubsetNames(TOOLS, '', { enabled: true, topK: 3 }) === null);

// 4) 核心工具始终常驻
const r1 = selectSubsetNames(TOOLS, '帮我查一下天气', { enabled: true, topK: 3 });
ok('返回非 null', Array.isArray(r1));
for (const c of CORE_ALWAYS) ok('核心工具常驻: ' + c, r1.includes(c));

// 5) 相关工具被选中（生成图片）
const r2 = selectSubsetNames(TOOLS, '帮我生成一张生日海报图片', { enabled: true, topK: 3 });
ok('generate_image 因语义被选中', r2.includes('generate_image'));

// 6) topK 限制非核心数量（topK 有下限 3，避免注入过少工具）
const r3 = selectSubsetNames(TOOLS, '代码 安全 审查 任务 记忆 计划 图片 诊断 搜索 文件', { enabled: true, topK: 2 });
const effTopK = Math.max(3, 2);
const nonCore = r3.filter((n) => !CORE_ALWAYS.has(n));
ok('非核心数量不超过 topK(下限3)', nonCore.length <= effTopK);
ok('结果总长度 = 核心 + 选中', r3.length === CORE_ALWAYS.size + nonCore.length);

// 7) 用户白名单 alwaysInclude 强制注入
const r4 = selectSubsetNames(TOOLS, '今天天气怎样', { enabled: true, topK: 2, alwaysInclude: 'save_memory, create_plan_task' });
ok('alwaysInclude 生效: save_memory', r4.includes('save_memory'));
ok('alwaysInclude 生效: create_plan_task', r4.includes('create_plan_task'));

// 8) 子集一定是全量的子集（绝不引入不存在的工具）
const r5 = selectSubsetNames(TOOLS, '搜索文件中与安全自检有关的代码并审查', { enabled: true, topK: 5 });
ok('子集 ⊆ 全量', r5.every((n) => ALL_NAMES.has(n)));

console.log('\n[toolSelect] 通过 ' + pass + ' 项' + (fail ? '，失败 ' + fail + ' 项' : ''));
process.exit(fail ? 1 : 0);
