'use strict';

/**
 * MCP 服务器连接安全校验
 * ----------------------------------------------------------------------------
 * 防止通过 MCP 配置造成：任意命令执行、SSRF（访问内网/云元数据）、敏感环境变量泄露。
 * 全部为纯函数，便于单测；在 src/tools/mcpServers.js 注册前调用。
 */

// 默认放行的启动命令（仅允许「包管理器/解释器」，不允许任意二进制直接执行）
const DEFAULT_ALLOWED_COMMANDS = [
  'npx', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'node', 'uvx',
  'python', 'python3', 'pipx', 'docker', 'podman'
];

// 命令/参数里禁止出现的 shell 元字符（防止命令注入）。
// 注意：路径分隔符 \ 与 / 不算元字符——否则 Windows 绝对路径命令
// （如 C:\Program Files\...\node.exe）和替换后的 ${workspaceFolder} 路径会被误判为注入而拒绝。
const SHELL_META = /[;&|`$()<>{}!#\n\r]/;

// 命中即视为敏感的环境变量名（连接远程服务器前会被剥离，除非显式 allow）
const SENSITIVE_ENV = /(token|secret|password|passwd|pwd|api[_-]?key|private[_-]?key|access[_-]?key|aws|gcp|azure|session|auth|cookie|credential)/i;

/**
 * 校验单个 MCP 服务器定义是否安全可启动。
 * @param {Object} def { id, transport, command, args, url, headers, env, enabled, flat }
 * @param {Object} [policy] { allowedCommands?:string[], allowPrivateUrls?:boolean }
 * @returns {{ ok:boolean, errors:string[], warnings:string[] }}
 */
function validateServerDef(def, policy = {}) {
  const errors = [];
  const warnings = [];
  if (!def || !def.id) errors.push('缺少 id');

  const allowed = (policy.allowedCommands && policy.allowedCommands.length)
    ? policy.allowedCommands
    : DEFAULT_ALLOWED_COMMANDS;

  const transport = def.transport || 'stdio';

  if (transport === 'sse') {
    const u = validateSseUrl(def.url, policy);
    if (!u.ok) errors.push(u.error);
  } else {
    // stdio：校验启动命令
    const cmd = def.command || 'npx';
    const base = String(cmd).trim().split(/[\s/\\]+/).pop().replace(/\.(exe|cmd|bat|ps1|sh|com)$/i, '');
    if (SHELL_META.test(cmd)) {
      errors.push('启动命令包含非法字符，可能存在命令注入风险');
    } else if (!allowed.includes(base)) {
      errors.push(
        `启动命令「${cmd}」不在白名单（${allowed.join(', ')}）。` +
        '如需使用请在 foxAi.mcp.allowedCommands 中显式添加。'
      );
    }
    // 参数里禁止出现 shell 元字符
    const args = Array.isArray(def.args) ? def.args : [];
    for (const a of args) {
      if (typeof a === 'string' && SHELL_META.test(a)) {
        errors.push('启动参数包含非法字符，可能存在命令注入风险');
        break;
      }
    }
  }

  // 环境变量敏感信息过滤（只记录是否会被剥离，不直接改 def）
  const env = def.env || {};
  const stripped = Object.keys(env).filter((k) => SENSITIVE_ENV.test(k));
  if (stripped.length) warnings.push('以下环境变量将被剥离后传入（避免泄露）：' + stripped.join(', '));

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 校验 SSE/HTTP 地址，防止 SSRF（访问内网 / 云元数据）。
 * @param {string} url
 * @param {Object} [policy] { allowPrivateUrls?:boolean }
 * @returns {{ ok:boolean, error?:string }}
 */
function validateSseUrl(url, policy = {}) {
  if (!url || typeof url !== 'string') return { ok: false, error: 'sse 传输缺少 url' };
  let parsed;
  try { parsed = new URL(url); } catch (_) { return { ok: false, error: 'url 格式非法：' + url }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: '只允许 http/https 协议，拒绝：' + parsed.protocol };
  }
  if (policy.allowPrivateUrls) return { ok: true };

  const host = parsed.hostname.toLowerCase();
  if (isPrivateHost(host)) {
    return {
      ok: false,
      error: `拒绝连接到内网/本地地址「${host}」（SSRF 防护）。如需连接请在 foxAi.mcp.allowPrivateUrls 中显式开启。`
    };
  }
  return { ok: true };
}

/** 判断主机是否为私有/本地/链路本地地址（SSRF 防护用） */
function isPrivateHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return true;
  // IPv6
  if (host === '::1' || host.startsWith('fe80::') || host.startsWith('fc') || host.startsWith('fd')) return true;
  // IPv4 字面量
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地/云元数据
    if (a === 0) return true;
  }
  return false;
}

/**
 * 过滤敏感环境变量，返回新的 env 对象（不修改入参）。
 * @param {Object} env
 * @param {string[]} [allow] 显式允许保留的变量名
 */
function filterEnv(env, allow = []) {
  const out = {};
  const allowSet = new Set(allow.map((x) => String(x).toLowerCase()));
  for (const [k, v] of Object.entries(env || {})) {
    if (SENSITIVE_ENV.test(k) && !allowSet.has(k.toLowerCase())) continue; // 剥离敏感项
    out[k] = v;
  }
  return out;
}

module.exports = {
  DEFAULT_ALLOWED_COMMANDS,
  SHELL_META,
  SENSITIVE_ENV,
  validateServerDef,
  validateSseUrl,
  isPrivateHost,
  filterEnv
};
