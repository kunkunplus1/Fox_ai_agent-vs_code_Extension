'use strict';

/**
 * 冲突感知（Conflict Watch）：记录 agent 读过的文件快照（mtime/size），
 * 在写之前检测“文件自上次读取后是否被外部（通常是用户本人）改过”，若改过则暂停让人工裁决。
 *
 * 设计原则（用户硬约束）：
 *  - 零 vscode 依赖：纯 Node 模块，单测友好。
 *  - 懒加载：仅在 foxAi.conflictWatch.enabled 时由 agent.js require（默认开启，但完全被动）。
 *  - 不常驻监听：不使用 fs.watch / 任何 watcher；只在“读”和“写前”各比对一次 stat，开销可忽略。
 *  - 有界缓存：path -> 快照，Map 上限 + 淘汰最早项（近似 LRU），不随项目规模无限增长。
 *  - 用完即弃：只存 mtime/size 两个整数，不存文件内容。
 *
 * 与既有底座的关系：agent 在 read_file 后 recordRead、在 edit_file/write_file 前 check、
 * 写入成功后 noteWrite 刷新快照；本模块只做“快照存取 + 比较”，不碰文件系统。
 */

const MAX_CACHE = 512;
const _snap = new Map(); // path -> { mtime, size }

/** 有界淘汰：超过上限时删最早写入项（Map 保持插入顺序即近似 LRU）。 */
function _set(key, val) {
  if (_snap.size >= MAX_CACHE && _snap.size > 0) {
    const fk = _snap.keys().next().value;
    if (fk !== undefined) _snap.delete(fk);
  }
  _snap.set(key, val);
}

/** 记录“agent 刚读过”的文件状态。 */
function recordRead(path, mtime, size) {
  if (!path) return;
  _set(path, { mtime, size });
}

/** 记录“agent 刚写入成功”的文件状态（刷新快照，避免把自己的写入当成外部修改）。 */
function noteWrite(path, mtime, size) {
  if (!path) return;
  _set(path, { mtime, size });
}

/**
 * 写前比对：当前状态相对快照是否发生过“外部修改”。
 * @param {string} path
 * @param {number} mtime 当前 mtime（毫秒）
 * @param {number} size 当前 size（字节）
 * @returns {{conflict:boolean, snapshot?:{mtime,size}, current?:{mtime,size}}}
 */
function check(path, mtime, size) {
  if (!path) return { conflict: false };
  const s = _snap.get(path);
  if (!s) return { conflict: false }; // 没读过就不比对，避免误报
  // mtime 更新，或同 mtime 但大小变化（粗粒度文件系统下兜底）→ 视为外部改过
  if (mtime > s.mtime || (mtime === s.mtime && size !== s.size)) {
    return { conflict: true, snapshot: { mtime: s.mtime, size: s.size }, current: { mtime, size } };
  }
  return { conflict: false };
}

/**
 * 是否“读过/写过”该文件（存在快照即视为 agent 看过最新状态）。
 * 用于「未读禁止写」硬门控：写已存在文件前，若从未读过则要求先 read_file，
 * 从代码层强制「先了解再动手」，避免模型凭空臆测直接覆盖造成屎山。
 * @param {string} path
 */
function hasRead(path) {
  return !!path && _snap.has(path);
}

function invalidate() { _snap.clear(); }
function cacheSize() { return _snap.size; }

module.exports = { recordRead, noteWrite, check, hasRead, invalidate, cacheSize, MAX_CACHE };
