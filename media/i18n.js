(function () {
  'use strict';

  // 由后端（chatView.js 的 _renderFor）在 <head> 中注入：
  //   window.__FOX_LOCALE__  -> 当前 VS Code 显示语言，如 'en' / 'zh-cn'
  //   window.__FOX_I18N__     -> 中文原文 -> 英文 的映射对象（中文环境不注入，保持空）
  window.__FOX_LOCALE__ = window.__FOX_LOCALE__ || 'zh-cn';
  window.__FOX_I18N__ = window.__FOX_I18N__ || {};

  /**
   * 取本地化字符串。
   * 设计原则：所有用户可见文案以「中文」作为代码内嵌默认值（fallback），
   * 英文等其它语言通过 window.__FOX_I18N__ 覆盖。这样中文用户永远不会因
   * 语言包缺失而看到空白或乱码，且无需任何第三方运行时依赖。
   *
   * @param {string} s 中文原文（同时作为 key 与中文 fallback）
   * @param {...string} args 占位符 {0} {1} ... 的替换值
   * @returns {string}
   */
  window.t = function (s) {
    if (typeof s !== 'string') return s;
    var loc = (window.__FOX_LOCALE__ || '').toLowerCase();
    var map = window.__FOX_I18N__ || {};
    var out = (loc.indexOf('zh') === 0)
      ? s
      : (Object.prototype.hasOwnProperty.call(map, s) ? map[s] : s);
    var args = Array.prototype.slice.call(arguments, 1);
    if (args.length) {
      out = out.replace(/\{(\d+)\}/g, function (_m, i) {
        var idx = Number(i);
        return idx < args.length ? args[idx] : ('{' + i + '}');
      });
    }
    return out;
  };
})();
