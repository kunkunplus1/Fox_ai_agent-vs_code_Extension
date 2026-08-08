'use strict';

/**
 * 轻量 disposable 收集袋。
 *
 * 把多个 { dispose() } 一次性清理，用于 webview / panel 的
 * onDidReceiveMessage / onDidDispose 等监听器——这些 API 返回的是
 * vscode.Disposable，但 fox-ai 此前把它们直接丢弃，导致面板反复
 * 创建/销毁时 VS Code 主进程累加 EventListener，长时间运行内存只涨不跌。
 *
 * 用法：
 *   const bag = new DisposableBag();
 *   bag.add(panel.webview.onDidReceiveMessage(handler));
 *   bag.add(panel.onDidDispose(() => bag.dispose()));
 *   // 之后 bag.dispose() 即可释放全部监听器
 */
class DisposableBag {
  constructor() {
    this._items = [];
    this._disposed = false;
  }

  /** 加入一个 disposable；若袋已释放，则立即释放它 */
  add(d) {
    if (d && typeof d.dispose === 'function') {
      if (this._disposed) {
        try { d.dispose(); } catch (_) { /* 忽略释放细节 */ }
      } else {
        this._items.push(d);
      }
    }
    return d;
  }

  /** 是否已释放 */
  get disposed() {
    return this._disposed;
  }

  /** 释放全部收集到的 disposable（可重复调用，幂等） */
  dispose() {
    this._disposed = true;
    const items = this._items.splice(0);
    for (const d of items) {
      try { d.dispose(); } catch (_) { /* 忽略单个释放失败 */ }
    }
  }

  /** 清空（同 dispose） */
  clear() {
    this.dispose();
  }
}

module.exports = DisposableBag;
