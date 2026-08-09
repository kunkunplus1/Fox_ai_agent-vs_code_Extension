'use strict';

/**
 * 自动化运行桥：解耦「调度/触发」与「实际执行」。
 * chatView 在会话创建时把当前会话的 runBackgroundAgent 注册进来；
 * extension 的自动化触发回调通过 getRunner() 拿到它来真正跑任务。
 * 纯模块、零依赖、无循环引用（extension 与 chatView 都只依赖本模块）。
 */

let _runner = null;

function setRunner(fn) {
  _runner = (typeof fn === 'function') ? fn : null;
}

function getRunner() {
  return _runner;
}

function clearRunner(fn) {
  if (_runner === fn) _runner = null;
}

module.exports = { setRunner, getRunner, clearRunner };
