'use strict';
/**
 * fox-atoms —— 原子组件库行为（锁定交互逻辑，禁止手搓等价组件）。
 * 与 fox-atoms.css 成对引入。调用 initFoxAtoms() 注册自定义元素（幂等）。
 */
(function (global) {
  'use strict';
  function fireClose(el) {
    if (typeof el.onclose === 'function') {
      try { el.onclose(); } catch (_) {}
    }
    el.dispatchEvent(new CustomEvent('close'));
    el.removeAttribute('visible');
    el.removeAttribute('open');
  }

  // ---- fox-button ----
  if (!global.customElements.get('fox-button')) {
    global.customElements.define('fox-button', class extends global.HTMLElement {
      connectedCallback() {
        if (!this.getAttribute('role')) this.setAttribute('role', 'button');
        this.style.display = this.style.display || 'inline-block';
      }
    });
  }

  // ---- fox-modal ----
  if (!global.customElements.get('fox-modal')) {
    global.customElements.define('fox-modal', class extends global.HTMLElement {
      connectedCallback() {
        if (this._wired) return;
        this._wired = true;
        const kids = Array.from(this.childNodes);
        this.innerHTML = `
          <div class="fox-modal-panel" part="panel">
            <div class="fox-modal-head"><span class="fox-modal-title"></span><button class="fox-modal-close" aria-label="关闭">×</button></div>
            <div class="fox-modal-body"></div>
          </div>`;
        this.querySelector('.fox-modal-title').textContent = this.getAttribute('title') || '';
        const body = this.querySelector('.fox-modal-body');
        kids.forEach((k) => body.appendChild(k));
        this.addEventListener('click', (e) => {
          if (e.target === this || e.target.classList.contains('fox-modal-close')) fireClose(this);
        });
        this._onKey = (e) => { if (e.key === 'Escape' && this.hasAttribute('visible')) fireClose(this); };
        global.addEventListener('keydown', this._onKey);
      }
      disconnectedCallback() { if (this._onKey) global.removeEventListener('keydown', this._onKey); }
    });
  }

  // ---- fox-tooltip ----
  if (!global.customElements.get('fox-tooltip')) {
    global.customElements.define('fox-tooltip', class extends global.HTMLElement {
      connectedCallback() {
        if (this._wired) return;
        this._wired = true;
        const tip = document.createElement('span');
        tip.className = 'fox-tip';
        tip.textContent = this.getAttribute('text') || '';
        this.appendChild(tip);
      }
    });
  }

  // ---- fox-toast ----
  if (!global.customElements.get('fox-toast')) {
    global.customElements.define('fox-toast', class extends global.HTMLElement {
      show(msg, type) {
        if (type) this.setAttribute('type', type);
        this.textContent = msg || '';
        this.classList.add('show');
        const dur = parseInt(this.getAttribute('duration'), 10) || 2600;
        clearTimeout(this._t);
        this._t = setTimeout(() => this.classList.remove('show'), dur);
      }
    });
  }

  // ---- fox-tabs / fox-tab ----
  if (!global.customElements.get('fox-tab')) {
    global.customElements.define('fox-tab', class extends global.HTMLElement {});
  }
  if (!global.customElements.get('fox-tabs')) {
    global.customElements.define('fox-tabs', class extends global.HTMLElement {
      connectedCallback() {
        if (this._wired) return;
        this._wired = true;
        const tabs = Array.from(this.querySelectorAll('fox-tab'));
        const bar = document.createElement('div');
        bar.className = 'fox-tabs-bar';
        tabs.forEach((tab, i) => {
          const btn = document.createElement('button');
          btn.textContent = tab.getAttribute('name') || ('Tab ' + (i + 1));
          btn.addEventListener('click', () => this._select(i));
          bar.appendChild(btn);
          if (i === 0) { tab.classList.add('active'); btn.classList.add('active'); }
        });
        this.insertBefore(bar, this.firstChild);
      }
      _select(idx) {
        const tabs = Array.from(this.querySelectorAll('fox-tab'));
        const btns = this.querySelectorAll('.fox-tabs-bar button');
        tabs.forEach((t, i) => t.classList.toggle('active', i === idx));
        btns.forEach((b, i) => b.classList.toggle('active', i === idx));
      }
    });
  }

  // ---- fox-sidebar ----
  if (!global.customElements.get('fox-sidebar')) {
    global.customElements.define('fox-sidebar', class extends global.HTMLElement {
      connectedCallback() {
        if (this._wired) return;
        this._wired = true;
        const mask = document.createElement('div');
        mask.className = 'fox-sidebar-mask';
        mask.addEventListener('click', () => fireClose(this));
        this.parentNode && this.parentNode.insertBefore(mask, this.nextSibling);
        this._onKey = (e) => { if (e.key === 'Escape' && this.hasAttribute('open')) fireClose(this); };
        global.addEventListener('keydown', this._onKey);
      }
      disconnectedCallback() { if (this._onKey) global.removeEventListener('keydown', this._onKey); }
    });
  }

  global.initFoxAtoms = function () { /* 自定义元素在 define 时已注册，本函数仅为语义化入口 */ };
})(typeof window !== 'undefined' ? window : this);
