'use strict';

/**
 * 本地弱模型辅助模式（1.1.17）共用逻辑。
 * 纯函数 + 常量，不依赖 vscode / agent，便于离线测试。
 *
 * 涵盖：
 *  - TEXT_TOOL_GRAMMAR：通用 GBNF 约束解码语法，让本地模型只能输出
 *    「自然语言」或「<foxtool name="..">{合法 JSON}</foxtool>」，从源头消灭缺引号/缺括号。
 *  - validateToolArgs：按工具 JSON Schema 做轻量校验（类型/必填/枚举），供闭环自愈使用。
 *  - buildAnchor：为弱模型构造「核心任务锚点」，重复在系统提示词头尾，防注意力漂移。
 */

/**
 * 通用 GBNF 语法（llama.cpp / LM Studio 等支持 grammar 的服务端可直接用）。
 *
 * 设计要点：
 *  - root 允许「自由文本」或「工具块」任意交替，但实际使用中本地弱模型在工具轮只输出工具块、
 *    在回答轮只输出文本（提示词已要求「不要混用」），因此两种结构不冲突。
 *  - freechar 允许绝大多数字符，仅把 `<foxtool` + 空格 这一前缀留给 toolcall 规则，
 *    从而让「<foxtool name=...>」必然进入工具结构（JSON 被强制为合法），
 *    而普通的 `<`（如 "a < b"）仍可作为文本正常出现。
 *  - toolcall 内部的 json 用标准 JSON 子语法约束，确保参数一定是合法 JSON。
 */
const TEXT_TOOL_GRAMMAR = [
  'root ::= ( freechar | toolcall )*',
  'freechar ::= [^<] | "<" [^f] | "<f" [^o] | "<fo" [^x] | "<fox" [^t] | "<foxt" [^o] | "<foxo" [^o] | "<foxto" [^o] | "<foxtoo" [^l] | "<foxtool" [^ ]',
  'toolcall ::= "<foxtool name=\\"" toolname "\\">" json "</foxtool>"',
  'toolname ::= [a-zA-Z_][a-zA-Z0-9_]*',
  'json ::= value',
  'value ::= object | array | string | number | "true" | "false" | "null"',
  'object ::= "{" ws ( string ws ":" ws value ( ws "," ws string ws ":" ws value )* )? ws "}"',
  'array ::= "[" ws ( value ( ws "," ws value )* )? ws "]"',
  'string ::= "\\"" ( [^"\\\\] | "\\\\" ( ["\\\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] ) )* "\\""',
  'number ::= "-"? ( "0" | [1-9] [0-9]* ) ( "." [0-9]+ )? ( [eE] [+-]? [0-9]+ )?',
  'ws ::= [ \\t\\n\\r]*'
].join('\n');

/**
 * 按工具的 JSON Schema 做轻量校验（不引入 ajv，覆盖本地弱模型最常见的错误）。
 * @param {object} tool 工具定义（含 parameters.properties / required）
 * @param {any} args 解析出的参数对象
 * @returns {{ok:boolean, errors:string[]}}
 */
function validateToolArgs(tool, args) {
  const errors = [];
  const params = (tool && tool.parameters) || {};
  const props = params.properties || {};
  const required = Array.isArray(params.required) ? params.required : [];
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { ok: false, errors: ['参数必须是 JSON 对象 { }，不能是数组或空值'] };
  }
  for (const k of required) {
    const v = args[k];
    if (v === undefined || v === null || v === '') {
      errors.push(`缺少必填参数 "${k}"`);
    }
  }
  for (const k of Object.keys(args)) {
    if (!(k in props)) {
      errors.push(`存在未定义的参数 "${k}"（该工具没有这个参数）`);
      continue;
    }
    const p = props[k];
    const val = args[k];
    const t = p.type;
    if (t === 'boolean' && typeof val !== 'boolean') {
      errors.push(`参数 "${k}" 应为 true 或 false`);
    } else if ((t === 'integer' || t === 'number') && typeof val !== 'number') {
      errors.push(`参数 "${k}" 应为数字`);
    } else if (t === 'string' && typeof val !== 'string') {
      errors.push(`参数 "${k}" 应为字符串`);
    } else if (Array.isArray(p.enum) && p.enum.length && !p.enum.includes(val)) {
      errors.push(`参数 "${k}" 只能取：${p.enum.join(' / ')}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 为弱模型构造「核心任务锚点」文本（重复在系统提示词头尾，防注意力漂移）。
 * @param {string} queryText 用户最近一次提问
 * @returns {string} 不含多余换行的单行锚点（已截断）
 */
function buildAnchor(queryText) {
  const q = String(queryText || '').replace(/\s+/g, ' ').trim();
  if (!q) return '';
  const maxLen = 200;
  const head = q.length > maxLen ? q.slice(0, maxLen - 1) + '…' : q;
  return head;
}

module.exports = {
  TEXT_TOOL_GRAMMAR,
  validateToolArgs,
  buildAnchor
};
