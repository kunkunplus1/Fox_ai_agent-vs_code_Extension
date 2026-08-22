
(function() {
  'use strict';
  try {
    const vscode = acquireVsCodeApi();
    function post(msg){ vscode.postMessage(msg); }

    function init() {
      // 初始化设置
      post({ type: 'init' });
      bindTabs();
      bindForms();
      // 查询 WebAI2API 服务运行状态（用于重载窗口后恢复显示）
      post({ type: 'webai2apiServerStatus' });
    }

    function switchTab(tabName, notify) {
    const target = document.querySelector('.tab[data-tab="' + tabName + '"]');
    if (!target) return;
    document.querySelectorAll('.tab').forEach((x) => {
      x.classList.remove('active');
      x.setAttribute('aria-pressed', 'false');
    });
    document.querySelectorAll('.pane').forEach((x) => x.classList.remove('active'));
    target.classList.add('active');
    target.setAttribute('aria-pressed', 'true');
    const pane = document.getElementById(tabName);
    if (pane) pane.classList.add('active');
    if (notify === false) return;
    if (tabName === 'ext') post({ type: 'loadExt' });
    if (tabName === 'audit') post({ type: 'loadAudit' });
    if (tabName === 'kb') post({ type: 'loadKnowledge' });
    if (tabName === 'tasks') post({ type: 'loadTasks' });
    if (tabName === 'project') post({ type: 'loadProject' });
    if (tabName === 'mcp') post({ type: 'loadMcp' });
    if (tabName === 'sandbox') post({ type: 'loadSandbox' });
  }

  function renderExtList() {
    try {
      const box = document.getElementById('ext-list');
      if (!box) return;
      const exts = window._extData || [];
      if (!exts.length) { box.innerHTML = '<span class="hint">未发现其它扩展</span>'; return; }
      const searchEl = document.getElementById('ext-search');
      const q = (searchEl && searchEl.value || '').toLowerCase().trim();
      const enabledHtml = [];
      const disabledHtml = [];
      for (const e of exts) {
        const extName = String(e.displayName || '').toLowerCase();
        const extId = String(e.id || '').toLowerCase();
        const extMatch = !q || extName.includes(q) || extId.includes(q);
        const cmdItems = [];
        // 扩展内部：已勾选命令置顶
        const cmds = Array.isArray(e.commands) ? e.commands : [];
        const sortedCmds = [...cmds].sort((a, b) => {
          if (!!a.allowed === !!b.allowed) return 0;
          return a.allowed ? -1 : 1;
        });
        for (const c of sortedCmds) {
          const title = String(c.title || '').toLowerCase();
          const cmd = String(c.command || '').toLowerCase();
          const cmdMatch = !q || title.includes(q) || cmd.includes(q);
          if (q && !extMatch && !cmdMatch) continue;
          const cmdKey = esc(String(c.command || ''));
          const cmdTitle = esc(String(c.title || c.command || ''));
          cmdItems.push('<label style="display:flex;align-items:center;gap:6px;margin:3px 0;"><input type="checkbox" data-cmd="'+cmdKey+'" '+(c.allowed?'checked':'')+'/> <span>'+cmdTitle+' <code>'+cmdKey+'</code></span> <button class="call-cmd" data-cmd="'+cmdKey+'">调用</button></label>');
        }
        if (!cmdItems.length && q) continue;
        const hasEnabled = cmds.some((c) => c.allowed);
        const section = '<div class="ext" data-ext-id="'+esc(String(e.id || ''))+'"><b>'+esc(String(e.displayName || e.id || '未命名扩展'))+'</b> <span class="hint">'+esc(String(e.id || ''))+'</span><div class="cmds">'+cmdItems.join('')+'</div></div>';
        if (hasEnabled) enabledHtml.push(section); else disabledHtml.push(section);
      }
      let html = '';
      // 狐狸 AI 自身命令（早期版本可能已勾选，现在单独提示，避免用户找不到）
      const own = (window._ownCommands || []).filter((c) => {
        const t = String(c.title || '').toLowerCase();
        const cmd = String(c.command || '').toLowerCase();
        return !q || t.includes(q) || cmd.includes(q);
      });
      if (own.length) {
        html += '<div class="ext-group"><div class="ext-group-title" style="color:var(--vscode-charts-orange,#d29922)">🦊 狐狸 AI 自身命令（通常无需在此管理）</div>'
          + own.map((c) => {
            const cmdKey = esc(String(c.command || ''));
            const cmdTitle = esc(String(c.title || c.command || ''));
            return '<label style="display:flex;align-items:center;gap:6px;margin:3px 0;"><input type="checkbox" data-cmd="'+cmdKey+'" checked/> <span>'+cmdTitle+' <code>'+cmdKey+'</code></span> <button class="call-cmd" data-cmd="'+cmdKey+'">调用</button></label>';
          }).join('')
          + '</div>';
      }
      if (enabledHtml.length) {
        html += '<div class="ext-group"><div class="ext-group-title">✅ 已启用（白名单）</div>'+enabledHtml.join('')+'</div>';
      }
      if (disabledHtml.length) {
        html += '<div class="ext-group"><div class="ext-group-title" style="opacity:.7">⬜ 未启用</div>'+disabledHtml.join('')+'</div>';
      }
      if (!enabledHtml.length && !disabledHtml.length && !own.length) {
        html = '<span class="hint">没有匹配「'+esc(q)+'」的扩展或命令</span>';
      }
      box.innerHTML = html;
      box.querySelectorAll('input[data-cmd]').forEach(cb => cb.onchange = () => {
        const entry = exts.find((e) => Array.isArray(e.commands) && e.commands.some((c) => c.command === cb.dataset.cmd));
        if (entry) {
          const c = entry.commands.find((x) => x.command === cb.dataset.cmd);
          if (c) c.allowed = cb.checked;
        }
        // 狐狸 AI 自身命令：取消勾选时从本地列表移除，避免立即重新渲染又出现
        if (!cb.checked && window._ownCommands) {
          const idx = window._ownCommands.findIndex((c) => c.command === cb.dataset.cmd);
          if (idx >= 0) window._ownCommands.splice(idx, 1);
        }
        post({ type: 'toggleCmd', command: cb.dataset.cmd, on: cb.checked });
        renderExtList();
      });
      box.querySelectorAll('button.call-cmd').forEach(b => b.onclick = () => {
        const log = document.getElementById('ext-log');
        if (log) { log.textContent = '调用中：' + b.dataset.cmd + ' …'; log.style.color = ''; }
        post({ type: 'callCmd', command: b.dataset.cmd });
      });
    } catch (err) {
      const box = document.getElementById('ext-list');
      if (box) box.innerHTML = '<span class="hint danger">渲染扩展列表出错：' + esc(String(err && err.message || err)) + '</span>';
      console.error('[fox-ai env] renderExtList error', err);
    }
  }

  function onClick(id, fn) {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
    else console.warn('[fox-ai env] missing element #' + id + ' for onclick');
  }
  function onChange(id, fn) {
    const el = document.getElementById(id);
    if (el) el.onchange = fn;
    else console.warn('[fox-ai env] missing element #' + id + ' for onchange');
  }

  /* ---- WebAI2API 下载配置 UI ---- */
  function w2aEl(id) { return document.getElementById(id); }
  function w2aStage(text) { const el = w2aEl('webai2api-stage'); if (el) el.textContent = text; }
  function w2aLog(text, cls) {
    const el = w2aEl('webai2api-log');
    if (!el) return;
    if (el.style.display === 'none') el.style.display = '';
    const line = document.createElement('div');
    line.textContent = text;
    if (cls === 'danger') line.style.color = 'var(--vscode-errorForeground,#f85149)';
    else if (cls === 'ok') line.style.color = 'var(--vscode-charts-green,#3fb950)';
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
    while (el.children.length > 300) el.removeChild(el.firstChild);
  }
  function w2aToast(text) {
    // 1.1.45：短暂气泡提示（如 Token 已复制）
    try {
      let el = document.getElementById('webai2api-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'webai2api-toast';
        el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--vscode-editorWidget-background,#252526);color:var(--vscode-editorWidget-foreground,#ccc);border:1px solid var(--vscode-widget-border,#454545);padding:8px 16px;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.4);z-index:9999;max-width:80%;font-size:13px;transition:opacity .3s';
        document.body.appendChild(el);
      }
      el.textContent = text;
      el.style.opacity = '1';
      clearTimeout(el._t);
      el._t = setTimeout(() => { el.style.opacity = '0'; }, 3500);
    } catch (_) { /* 忽略 */ }
  }
  function w2aProgress(percent, indeterminate) {
    const wrap = w2aEl('webai2api-progress');
    const fill = w2aEl('webai2api-fill');
    const pct = w2aEl('webai2api-pct');
    if (wrap) wrap.style.display = '';
    if (fill) {
      if (indeterminate) {
        fill.classList.add('indeterminate');
        fill.style.width = '100%';
      } else {
        fill.classList.remove('indeterminate');
        fill.style.width = Math.max(0, Math.min(100, percent || 0)) + '%';
      }
    }
    if (pct) pct.textContent = indeterminate ? '进行中…' : ((percent || 0) + '%');
  }
  function w2aReset(running) {
    const setup = w2aEl('webai2api-setup');
    const stop = w2aEl('webai2api-stop');
    const fill = w2aEl('webai2api-fill');
    if (setup) setup.disabled = !!running;
    if (stop) stop.style.display = running ? '' : 'none';
    if (running) w2aProgress(0, false);
    else if (fill) { fill.classList.remove('indeterminate'); fill.style.width = '0%'; }
  }
  function w2aShowLog() {
    const el = w2aEl('webai2api-log');
    if (el) { el.style.display = ''; el.textContent = ''; }
  }
  function w2aServerStatus(running) {
    const status = w2aEl('webai2api-server-status');
    const start = w2aEl('webai2api-start-server');
    const stop = w2aEl('webai2api-stop-server');
    if (running === null || running === undefined) {
      if (status) { status.textContent = '启动中…'; status.style.color = ''; }
      if (start) start.disabled = true;
      if (stop) stop.style.display = 'none';
      return;
    }
    if (status) status.textContent = running ? '● 服务运行中 (localhost:3000)' : '○ 服务未运行';
    if (status) status.style.color = running ? 'var(--vscode-charts-green,#3fb950)' : '';
    if (start) start.disabled = !!running;
    if (stop) stop.style.display = running ? '' : 'none';
  }

  function bindTabs() {
    const tabs = document.getElementById('tabs');
    if (!tabs) { console.warn('[fox-ai env] tabs element missing'); return; }
    tabs.addEventListener('click', (e) => {
      const t = e.target.closest('.tab');
      if (!t) return;
      switchTab(t.dataset.tab);
    });
    tabs.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const t = e.target.closest('.tab');
      if (!t) return;
      e.preventDefault();
      switchTab(t.dataset.tab);
    });
  }

  function bindPick(id, msgType, inputId) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const input = inputId ? document.getElementById(inputId) : null;
      if (input) input.placeholder = '正在打开选择对话框…';
      post({ type: msgType });
    });
  }

  function bindForms() {
    onClick('refresh-audit', () => post({ type: 'loadAudit' }));
    onClick('refresh-tasks', () => post({ type: 'loadTasks' }));
    onClick('clear-done-tasks', () => post({ type: 'clearDoneTasks' }));
    onChange('show-done', () => { if (window.__taskData) renderTasks(window.__taskData); });

    onClick('refresh-project', () => post({ type: 'loadProject' }));
    onClick('ask-project', () => post({ type: 'askProjectOutline' }));

    /* ---- MCP 服务器管理 ---- */
    onClick('refresh-mcp', () => post({ type: 'loadMcp' }));
    onClick('add-mcp', () => openMcpEditor(null));
    onClick('setup-mcp-deps', () => post({ type: 'setupMcpDeps' }));
    onClick('import-vscode-mcp', () => post({ type: 'importVSCodeMcp' }));
    document.querySelectorAll('.preset-btn').forEach((btn) => {
      btn.onclick = () => applyMcpPreset(btn.dataset.preset);
    });
    onClick('mcp-cancel-edit', () => { const ed = document.getElementById('mcp-editor'); if (ed) ed.style.display = 'none'; });
    onChange('mcp-enabled', (e) => post({ type: 'setMcpEnabled', value: e.target.checked }));
    onChange('mcp-transport', (e) => {
      const stdio = e.target.value === 'stdio';
      const stdioFields = document.getElementById('mcp-stdio-fields');
      const sseFields = document.getElementById('mcp-sse-fields');
      if (stdioFields) stdioFields.style.display = stdio ? '' : 'none';
      if (sseFields) sseFields.style.display = stdio ? 'none' : '';
    });
    onClick('mcp-save', () => {
      const def = collectMcpForm();
      const msg = document.getElementById('mcp-editor-msg');
      if (!def.id) { if (msg) { msg.textContent = '请填写 id'; msg.className = 'hint danger'; } return; }
      if (msg) { msg.textContent = '保存中…'; msg.className = 'hint'; }
      post({ type: 'saveMcpServer', def });
    });
    onClick('ask-selected', () => {
      const paths = Array.from(window.__selectedFiles || []);
      if (!paths.length) return;
      post({ type: 'askSelectedFiles', paths });
    });
    onChange('project-depth', () => {
      const d = document.getElementById('project-depth');
      post({ type: 'loadProject', depth: parseInt(d ? d.value : '2', 10) || 2 });
    });
    onChange('project-code-only', () => renderProject(window.__projectData));

    onClick('pick-root', () => post({ type: 'pickRoot' }));
    onClick('optimize-memory', () => post({ type: 'optimizeMemory' }));
    onClick('cleanup-foxai', () => post({ type: 'cleanupFoxAi' }));

    /* ---- WebAI2API 下载与配置 ---- */
    onClick('webai2api-pick-dir', () => post({ type: 'pickWebAI2APIDir' }));
    onClick('webai2api-setup', () => {
      const dir = (document.getElementById('webai2api-dir').value || '').trim();
      if (!dir) { w2aLog('⚠️ 请先选择安装位置', 'danger'); return; }
      const mirrorVal = (document.getElementById('webai2api-mirror').value || '').trim();
      const proxyVal = (document.getElementById('webai2api-proxy').value || '').trim();
      w2aReset(true);
      w2aStage('准备中…');
      w2aShowLog();
      post({ type: 'setupWebAI2API', dir, mirror: mirrorVal, proxy: proxyVal });
    });
    onClick('webai2api-stop', () => post({ type: 'stopWebAI2API' }));
    onClick('webai2api-token', () => {
      const dir = (document.getElementById('webai2api-dir').value || '').trim();
      post({ type: 'requestWebAI2APIToken', dir });
    });
    onClick('webai2api-start-server', () => {
      const dir = (document.getElementById('webai2api-dir').value || '').trim();
      w2aServerStatus(null);
      w2aShowLog();
      w2aLog('正在启动服务…');
      post({ type: 'startWebAI2APIServer', dir });
    });
    onClick('webai2api-stop-server', () => {
      w2aLog('正在停止服务…');
      post({ type: 'stopWebAI2APIServer' });
    });
    onChange('webai2api-autostart', (e) => post({ type: 'setWebAI2APIAutoStart', value: e.target.checked }));
    onChange('webai2api-mirror', (e) => post({ type: 'setWebAI2APIMirror', value: e.target.value }));
    onChange('webai2api-proxy', (e) => post({ type: 'setWebAI2APIProxy', value: e.target.value }));
    onChange('root', (e) => post({ type: 'setRoot', value: e.target.value }));
    onChange('mirror', (e) => post({ type: 'setMirror', value: e.target.value }));
    onChange('elevation', (e) => post({ type: 'setElevation', value: e.target.value }));
    onChange('silent', (e) => post({ type: 'setSilent', value: e.target.checked }));
    const extSearch = document.getElementById('ext-search');
    if (extSearch) {
      let debounceTimer = null;
      const refresh = () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          renderExtList();
        }, 120);
      };
      extSearch.oninput = refresh;
      extSearch.onkeyup = refresh;
      extSearch.onchange = refresh;
    }

    bindPick('kb-pick-source', 'pickKbSource', 'kb-source');
    bindPick('kb-pick-output', 'pickKbOutput', 'kb-output');
    onChange('kb-key', (e) => {
      const provider = document.getElementById('kb-provider');
      post({ type: 'setKbKey', provider: provider ? provider.value : '', value: e.target.value });
    });
    onClick('kb-organize', () => {
      const log = document.getElementById('kb-log');
      if (log) log.textContent = '';
      post({ type: 'organize', config: collectKbForm() });
    });
    // 勾选框/输入即时保存，避免切页后丢失
    onChange('kb-enabled', saveKb);
    onChange('kb-source', saveKb);
    onChange('kb-output', saveKb);
    onChange('kb-provider', saveKb);
    onChange('kb-baseurl', saveKb);
    onChange('kb-model', saveKb);
    onChange('kb-auto-enabled', saveKb);
    onChange('kb-auto-threshold', saveKb);
    onChange('kb-auto-keep', saveKb);
    onChange('kb-auto-dir', saveKb);
    onClick('kb-rebuild', () => post({ type: 'rebuildKb' }));

    /* ---- 向量模型（语义检索）：与整理 AI 完全独立的一组控件 ---- */
    onChange('kb-vec-enabled', saveKb);
    onChange('kb-vec-provider', saveKb);
    onChange('kb-vec-baseurl', saveKb);
    onChange('kb-vec-model', saveKb);
    onChange('kb-vec-dim', saveKb);
    onChange('kb-vec-hybrid', saveKb);
    onChange('kb-vec-key', (e) => {
      const provider = document.getElementById('kb-vec-provider');
      post({ type: 'setKbKey', scope: 'embed', provider: provider ? provider.value : '', value: e.target.value });
    });
    onClick('kb-vec-build', () => {
      const st = document.getElementById('kb-vec-stat');
      if (st) st.textContent = '正在构建向量索引…';
      post({ type: 'buildVectors', config: collectKbForm() });
    });
    onClick('kb-vec-clear', () => {
      const st = document.getElementById('kb-vec-stat');
      if (st) st.textContent = '正在清空向量缓存…';
      post({ type: 'clearVectors' });
    });

    document.querySelectorAll('.install-btn').forEach(b => b.onclick = () => {
      const card = b.closest('.card');
      if (!card) return;
      const id = card.dataset.rt;
      const verInput = card.querySelector('.ver-input');
      const status = card.querySelector('.status');
      const ver = verInput ? verInput.value.trim() : '';
      b.disabled = true; if (status) status.textContent = '准备中…';
      post({ type: 'install', id, version: ver });
    });

    /* ---- 沙盒管理 ---- */
    onClick('sb-open-dir', () => post({ type: 'openSandboxDir' }));
    onClick('sb-reload', () => post({ type: 'reloadSandbox' }));
    const SB_TPL = {
      cpp: { language: 'cpp', ext: '.cpp', command: 'g++ -std=c++17 -O2 "{{file}}" -o "{{workdir}}/out" && "{{workdir}}/out"' },
      ruby: { language: 'ruby', ext: '.rb', command: 'ruby "{{file}}"' },
      php: { language: 'php', ext: '.php', command: 'php "{{file}}"' },
      bash: { language: 'bash', ext: '.sh', command: 'bash "{{file}}"' },
      typescript: { language: 'typescript', ext: '.ts', command: 'npx --yes ts-node "{{file}}"' },
      csharp: { language: 'csharp', ext: '.csx', command: 'dotnet script "{{file}}"' },
      lua: { language: 'lua', ext: '.lua', command: 'lua "{{file}}"' },
      perl: { language: 'perl', ext: '.pl', command: 'perl "{{file}}"' }
    };
    onClick('sb-template-fill', () => {
      const sel = document.getElementById('sb-template');
      const tpl = sel ? sel.value : '';
      if (tpl && SB_TPL[tpl]) {
        const g = SB_TPL[tpl];
        document.getElementById('sb-language').value = g.language;
        document.getElementById('sb-ext').value = g.ext;
        document.getElementById('sb-command').value = g.command;
      }
    });
    onClick('sb-save', () => {
      const name = (document.getElementById('sb-name').value || '').trim();
      const msgEl = document.getElementById('sb-msg');
      if (!name) { if (msgEl) { msgEl.textContent = '⚠️ 请填写名称'; msgEl.className = 'hint danger'; } return; }
      const cmdRaw = (document.getElementById('sb-command').value || '').trim();
      let command;
      try { command = cmdRaw.startsWith('[') ? JSON.parse(cmdRaw) : cmdRaw; } catch (_) { command = cmdRaw; }
      const spec = { name, language: (document.getElementById('sb-language').value || '').trim(), ext: (document.getElementById('sb-ext').value || '').trim() };
      if (cmdRaw) spec.run = { command };
      const canary = (document.getElementById('sb-canary').value || '').trim();
      spec.canary = canary ? { code: canary } : null;
      if (msgEl) { msgEl.textContent = '保存中…'; msgEl.className = 'hint'; }
      post({ type: 'saveSandbox', spec });
    });
  }

  // 知识库标签页交互
  function collectKbForm() {
    return {
      enabled: document.getElementById('kb-enabled').checked,
      source: document.getElementById('kb-source').value,
      output: document.getElementById('kb-output').value,
      provider: document.getElementById('kb-provider').value,
      baseurl: document.getElementById('kb-baseurl').value,
      model: document.getElementById('kb-model').value,
      apiKey: document.getElementById('kb-key').value,
      autoEnabled: document.getElementById('kb-auto-enabled').checked,
      autoThreshold: document.getElementById('kb-auto-threshold').value,
      autoKeep: document.getElementById('kb-auto-keep').value,
      autoDir: document.getElementById('kb-auto-dir').value,
      // 向量模型（语义检索）—— 与上面的整理 AI 互不影响
      vecEnabled: val('kb-vec-enabled', 'checked', false),
      vecProvider: val('kb-vec-provider', 'value', 'ollama'),
      vecBaseurl: val('kb-vec-baseurl', 'value', ''),
      vecModel: val('kb-vec-model', 'value', ''),
      vecDim: val('kb-vec-dim', 'value', ''),
      vecHybrid: val('kb-vec-hybrid', 'checked', true),
      vecApiKey: val('kb-vec-key', 'value', '')
    };
  }

  /** 安全读取控件（元素缺失时返回默认值，避免旧面板缓存导致整表崩掉） */
  function val(id, prop, def) {
    const el = document.getElementById(id);
    if (!el) return def;
    const v = el[prop];
    return v === undefined ? def : v;
  }

  /** 安全写入控件（元素缺失时静默跳过） */
  function setVal(id, prop, v) {
    const el = document.getElementById(id);
    if (el) el[prop] = v;
  }

  // 仅保存知识库/自动压缩设置（不触发整理），用于勾选框与输入即时落盘，
  // 避免「勾上自动压缩、切到别的页再回来发现没勾上」——之前只在点「开始整理」才写盘。
  function saveKb() {
    post({ type: 'setKnowledge', config: collectKbForm() });
  }

  const STATE_LABEL = { queued: '排队中', running: '运行中', paused: '已暂停', 'awaiting-approval': '等待确认', completed: '已完成', failed: '失败', cancelled: '已取消' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function fmtTime(iso) { try { const d = new Date(iso); return d.toLocaleString(); } catch (_) { return iso || ''; } }
  function renderTasks(tasks) {
    window.__taskData = tasks;
    window.__taskExpanded = window.__taskExpanded || null;
    const showDone = document.getElementById('show-done').checked;
    const list = showDone ? tasks : tasks.filter((t) => !['completed', 'cancelled'].includes(t.state));
    const box = document.getElementById('task-list');
    if (!list.length) { box.innerHTML = '<span class="hint">（没有任务）</span>'; return; }
    box.innerHTML = list.map((t) => {
      const n = typeof t.stepsCount === 'number' ? t.stepsCount : (t.steps || []).length;
      const expanded = window.__taskExpanded === t.id;
      return '<div class="task-wrap" data-id="' + t.id + '">'
        + '<div class="task-item' + (expanded ? ' active' : '') + '" data-id="' + t.id + '">'
        + '<span class="task-toggle">' + (expanded ? '▼' : '▶') + '</span>'
        + '<span class="task-state">[' + (STATE_LABEL[t.state] || t.state) + ']</span>'
        + '<span class="task-title" title="' + esc(t.title) + '">' + esc(t.title) + '</span>'
        + '<span class="task-meta">' + esc(t.type) + ' · ' + n + ' 步 · ' + fmtTime(t.updatedAt) + '</span>'
        + '<span class="task-actions-row">'
        + '<button class="task-row-resume" data-id="' + t.id + '" title="续跑" style="display:' + (['failed','paused','queued','awaiting-approval'].includes(t.state) ? 'inline-block' : 'none') + '">▶</button>'
        + '<button class="task-row-cancel" data-id="' + t.id + '" title="停止" style="display:' + (t.state === 'running' ? 'inline-block' : 'none') + '">⏹</button>'
        + '<button class="task-row-delete" data-id="' + t.id + '" title="删除">🗑</button>'
        + '</span>'
        + '</div>'
        + '<div class="task-detail" data-detail-for="' + t.id + '" style="display:' + (expanded ? 'block' : 'none') + ';">'
        + (expanded ? '<span class="hint">加载中…</span>' : '')
        + '</div>'
        + '</div>';
    }).join('');

    box.querySelectorAll('.task-item').forEach((el) => {
      el.onclick = (e) => {
        if (e.target.closest('.task-actions-row button')) return;
        const id = el.dataset.id;
        const was = window.__taskExpanded;
        window.__taskExpanded = was === id ? null : id;
        renderTasks(window.__taskData);
        if (window.__taskExpanded) post({ type: 'getTask', id: window.__taskExpanded });
      };
    });

    box.querySelectorAll('.task-row-resume').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); post({ type: 'resumeTask', id: b.dataset.id }); }));
    box.querySelectorAll('.task-row-cancel').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); post({ type: 'cancelTask', id: b.dataset.id }); }));
    box.querySelectorAll('.task-row-delete').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); post({ type: 'deleteTask', id: b.dataset.id }); }));

    // 若当前有展开项但还没拿到详情（如列表刷新后），补请求
    if (window.__taskExpanded) {
      const detail = document.querySelector('.task-detail[data-detail-for="' + window.__taskExpanded + '"]');
      if (detail && detail.textContent.trim() === '加载中…') post({ type: 'getTask', id: window.__taskExpanded });
    }
  }
  function renderTaskDetail(t) {
    const detail = document.querySelector('.task-detail[data-detail-for="' + t.id + '"]');
    if (!detail) return;
    const steps = (t.steps || []).map((s, i) => {
      const tag = s.kind || '-';
      const st = s.ok === false ? '✗' : (s.ok === true ? '✓' : '·');
      const extra = s.reason ? ' — <span style="color:var(--vscode-errorForeground,#f85149)">' + esc(s.reason) + '</span>'
        : s.error ? ' — ' + esc(s.error) : (s.verify ? ' — 验证：' + esc(s.verify).slice(0, 80) : '');
      const txt = s.text ? esc(s.text).slice(0, 120) : (s.name ? esc(s.name) : '');
      return (i + 1) + '. [' + st + ' ' + tag + '] ' + txt + extra;
    }).join('\\n');
    let actions = '';
    const resumable = ['failed', 'paused', 'queued', 'awaiting-approval'].includes(t.state);
    if (t.state === 'running') {
      actions += '<button class="task-cancel" data-id="' + t.id + '">停止任务</button> ';
    } else {
      if (resumable) actions += '<button class="task-resume" data-id="' + t.id + '">续跑任务</button> ';
      actions += '<button class="task-delete" data-id="' + t.id + '">删除记录</button>';
    }
    detail.innerHTML = '<div style="margin-bottom:6px"><b>' + esc(t.title) + '</b> <span class="hint">(' + (STATE_LABEL[t.state] || t.state) + ')</span></div>'
      + '<div class="hint">类型：' + esc(t.type) + ' · 创建：' + fmtTime(t.createdAt) + (t.finishedAt ? ' · 结束：' + fmtTime(t.finishedAt) : '') + '</div>'
      + '<pre>' + (steps || '（无步骤）') + '</pre>'
      + '<div class="actions">' + actions + '</div>';
    detail.querySelectorAll('.task-cancel').forEach((b) => (b.onclick = () => post({ type: 'cancelTask', id: b.dataset.id })));
    detail.querySelectorAll('.task-resume').forEach((b) => (b.onclick = () => post({ type: 'resumeTask', id: b.dataset.id })));
    detail.querySelectorAll('.task-delete').forEach((b) => (b.onclick = () => post({ type: 'deleteTask', id: b.dataset.id })));
  }

  function renderProject(data) {
    window.__projectData = data || {};
    const info = document.getElementById('project-info');
    const box = document.getElementById('project-list');
    if (!data || !data.roles || !data.roles.length) {
      if (info) info.textContent = (data && data.framework && data.framework !== '未识别') ? ('检测到的技术栈：' + data.framework) : '（未发现关键文件，或未打开工作区）';
      if (box) box.innerHTML = '<span class="hint">（未发现关键文件，或未打开工作区）</span>';
      return;
    }
    if (info) info.textContent = (data.framework && data.framework !== '未识别') ? ('检测到的技术栈：' + data.framework) : '（未识别到具体技术栈）';
    if (!box) return;
    const codeOnly = document.getElementById('project-code-only') && document.getElementById('project-code-only').checked;
    const selected = window.__selectedFiles || (window.__selectedFiles = new Set());

    function formatBytes(n) {
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
      return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
    }

    function iconFor(node) {
      if (node.type === 'dir') return '📁';
      const t = node.fileType;
      if (t === 'code') return '📄';
      if (t === 'config') return '⚙️';
      if (t === 'doc') return '📖';
      if (t === 'model') return '🧠';
      if (t === 'data') return '📊';
      if (t === 'log') return '📜';
      if (t === 'media') return '🎬';
      if (t === 'exec') return '⚡';
      if (t === 'archive') return '📦';
      return '📄';
    }

    function renderNode(node, level) {
      const isDir = node.type === 'dir';
      const expanded = node._expanded !== false; // 默认展开
      const checked = selected.has(node.path);
      const hidden = codeOnly && isDir ? false : (codeOnly && node.fileType !== 'code');
      const style = hidden ? 'display:none;' : '';
      const toggle = isDir ? ('<span class="tree-toggle">' + (expanded ? '▼' : '▶') + '</span>') : '<span class="tree-toggle"></span>';
      const checkbox = isDir ? '' : ('<input type="checkbox" class="tree-checkbox" data-path="' + esc(node.path) + '" ' + (checked ? 'checked' : '') + '/>');
      const size = !isDir && node.size ? ('<span class="tree-size">' + formatBytes(node.size) + '</span>') : '';
      const role = node.role ? ('<span class="tree-role">' + esc(node.role) + '</span>') : '';
      let html = '<div class="tree-node" data-path="' + esc(node.path) + '" data-type="' + node.type + '" style="padding-left:' + (level * 12) + 'px;' + style + '">'
        + toggle + checkbox
        + '<span class="tree-icon">' + iconFor(node) + '</span>'
        + '<span class="tree-name">' + esc(node.name) + '</span>'
        + role + size + '</div>';
      if (isDir && node.children && node.children.length) {
        html += '<div class="tree-children" style="' + (expanded ? '' : 'display:none;') + '">';
        for (const child of node.children) html += renderNode(child, level + 1);
        html += '</div>';
      }
      return html;
    }

    const tree = data.tree && data.tree.nodes ? data.tree.nodes : [];
    if (!tree.length) {
      box.innerHTML = '<span class="hint">（未发现文件）</span>';
      return;
    }
    box.innerHTML = '<div class="file-tree">' + tree.map((n) => renderNode(n, 0)).join('') + '</div>';

    // 绑定展开/折叠
    box.querySelectorAll('.tree-toggle').forEach((el) => {
      el.onclick = (e) => {
        e.stopPropagation();
        const nodeEl = el.closest('.tree-node');
        const children = nodeEl.nextElementSibling;
        if (!children || !children.classList.contains('tree-children')) return;
        const hidden = children.style.display === 'none';
        children.style.display = hidden ? '' : 'none';
        el.textContent = hidden ? '▼' : '▶';
      };
    });

    // 绑定复选框
    box.querySelectorAll('.tree-checkbox').forEach((cb) => {
      cb.onchange = (e) => {
        e.stopPropagation();
        if (cb.checked) selected.add(cb.dataset.path);
        else selected.delete(cb.dataset.path);
        updateSelectionLabel();
      };
    });

    // 绑定单击打开
    box.querySelectorAll('.tree-node').forEach((el) => {
      el.onclick = (e) => {
        if (e.target.closest('.tree-checkbox') || e.target.closest('.tree-toggle')) return;
        post({ type: 'openFileAt', path: el.dataset.path, line: 0 });
      };
    });

    updateSelectionLabel();
  }

  function updateSelectionLabel() {
    const count = (window.__selectedFiles || new Set()).size;
    const label = document.getElementById('project-selection');
    if (label) label.textContent = '已选 ' + count + ' 个文件';
  }

  function applyMcpPreset(name) {
    const idInput = document.getElementById('mcp-id');
    const transport = document.getElementById('mcp-transport');
    const command = document.getElementById('mcp-command');
    const args = document.getElementById('mcp-args');
    const url = document.getElementById('mcp-url');
    const headers = document.getElementById('mcp-headers');
    const env = document.getElementById('mcp-env');
    const enabledItem = document.getElementById('mcp-enabled-item');
    const flat = document.getElementById('mcp-flat');

    if (name === 'clear') {
      idInput.value = '';
      transport.value = 'stdio';
      command.value = 'npx';
      args.value = '';
      url.value = '';
      headers.value = '';
      env.value = '';
      enabledItem.checked = false;
      flat.checked = false;
      transport.onchange({ target: transport });
      return;
    }

    const presets = {
      filesystem: {
        id: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: '-y @modelcontextprotocol/server-filesystem C:/path/to/folder',
        help: '把 C:/path/to/folder 改成你想让 AI 读取的目录，例如 C:/Users/你的名字/Desktop'
      },
      playwright: (() => {
        // 优先使用 setup-mcp.js 安装到本地的 @playwright/mcp，避免全局 npm 路径混乱
        const _mpMeta = document.querySelector('meta[name="foxai-mcp-modules"]');
    const mp = (_mpMeta && _mpMeta.getAttribute('content')) || '';
        const local = mp && !mp.includes(' ');
        return {
          id: 'playwright',
          transport: 'stdio',
          command: 'npx',
          args: local ? ('--prefix ' + mp + ' -y @playwright/mcp') : '-y @playwright/mcp',
          help: '需先通过「检查并安装依赖」按钮安装 @playwright/mcp 与浏览器'
        };
      })()
    };
    const p = presets[name];
    if (!p) return;

    if (!idInput.disabled) idInput.value = p.id;
    transport.value = p.transport;
    command.value = p.command;
    args.value = p.args;
    url.value = '';
    headers.value = '';
    env.value = '';
    enabledItem.checked = true;
    flat.checked = false;
    transport.onchange({ target: transport });

    const msg = document.getElementById('mcp-editor-msg');
    msg.textContent = p.help || '';
    msg.className = 'hint';
  }

  function collectMcpForm() {
    const transport = document.getElementById('mcp-transport').value;
    const def = {
      id: document.getElementById('mcp-id').value.trim(),
      transport,
      enabled: document.getElementById('mcp-enabled-item').checked,
      flat: document.getElementById('mcp-flat').checked
    };
    if (transport === 'sse') {
      def.url = document.getElementById('mcp-url').value.trim();
      const h = document.getElementById('mcp-headers').value.trim();
      if (h) { try { def.headers = JSON.parse(h); } catch (_) { def._headersError = true; } }
    } else {
      def.command = document.getElementById('mcp-command').value.trim() || 'npx';
      const a = document.getElementById('mcp-args').value.trim();
      def.args = a ? a.split(/\s+/).filter(Boolean) : [];
    }
    const env = document.getElementById('mcp-env').value.trim();
    if (env) { try { def.env = JSON.parse(env); } catch (_) { def._envError = true; } }
    return def;
  }

  function openMcpEditor(def) {
    const editor = document.getElementById('mcp-editor');
    editor.style.display = 'block';
    editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('mcp-editor-title').textContent = def ? ('编辑服务器：' + def.id) : '添加服务器';
    document.getElementById('mcp-editor-msg').textContent = '';
    document.getElementById('mcp-editor-msg').className = 'hint';
    document.getElementById('mcp-id').value = def ? def.id : '';
    document.getElementById('mcp-id').disabled = !!def; // 编辑时 id 不可改
    const transport = (def && def.transport) || 'stdio';
    document.getElementById('mcp-transport').value = transport;
    document.getElementById('mcp-stdio-fields').style.display = transport === 'stdio' ? '' : 'none';
    document.getElementById('mcp-sse-fields').style.display = transport === 'stdio' ? 'none' : '';
    document.getElementById('mcp-command').value = (def && def.command) || 'npx';
    document.getElementById('mcp-args').value = (def && def.args) ? def.args.join(' ') : '';
    document.getElementById('mcp-url').value = (def && def.url) || '';
    document.getElementById('mcp-headers').value = (def && def.headers) ? JSON.stringify(def.headers) : '';
    document.getElementById('mcp-env').value = (def && def.env) ? JSON.stringify(def.env) : '';
    document.getElementById('mcp-enabled-item').checked = def ? (def.enabled !== false) : true;
    document.getElementById('mcp-flat').checked = def ? !!def.flat : false;
    window.__mcpEditingId = def ? def.id : null;
  }

  const STATUS_LABEL = { registered: '已注册', disabled: '已禁用', connecting: '连接中', connected: '已连接', error: '错误' };
  function renderMcp(data) {
    window.__mcpData = data;
    const enabled = !!(data && data.enabled);
    document.getElementById('mcp-enabled').checked = enabled;
    document.getElementById('mcp-status').textContent = enabled ? '（总开关已开）' : '（总开关关闭，服务器不会启动）';
    const err = data && data.error;
    if (err) {
      const status = document.getElementById('mcp-status');
      status.innerHTML = '<span class="danger">加载失败：' + esc(err) + '</span>';
    }
    const list = (data && data.servers) || [];
    const box = document.getElementById('mcp-list');
    if (!list.length) {
      box.innerHTML = '<span class="hint">（还没有配置任何 MCP 服务器）</span>';
    } else {
    box.innerHTML = list.map((s) => {
      if (s.vscodeManaged) {
        const summary = (s.transport === 'sse' || s.transport === 'http')
          ? ((s.transport === 'http' ? 'http · ' : 'sse · ') + esc(s.url || ''))
          : ('stdio · ' + esc(s.command || 'npx') + ' ' + (s.args || []).map(esc).join(' '));
        return '<div class="card" data-id="' + esc(s.id) + '">'
          + '<div class="rt-head"><b>' + esc(s.id) + '</b>'
          + '<span class="ver" style="color:var(--vscode-charts-green,#3fb950)">[VS Code 管理]</span></div>'
          + '<div class="hint">' + summary + '</div>'
          + '<div class="hint">由 VS Code 原生 MCP 主机管理，工具已在 VS Code「MCP」视图中可用。</div>'
          + '</div>';
      }
      const st = s.status || 'registered';
      const color = st === 'connected' ? 'var(--vscode-charts-green,#3fb950)' : (st === 'error' ? 'var(--vscode-errorForeground,#f85149)' : 'var(--vscode-descriptionForeground,#999)');
      const summary = (s.transport === 'sse' || s.transport === 'http')
        ? ((s.transport === 'http' ? 'http · ' : 'sse · ') + esc(s.url || ''))
        : ('stdio · ' + esc(s.command || 'npx') + ' ' + (s.args || []).map(esc).join(' '));
      const imp = (s.importedFromVSCode) ? '<span class="ver" style="color:var(--vscode-charts-green,#3fb950)">[来自 VS Code·已接入]</span>' : '';
      return '<div class="card" data-id="' + esc(s.id) + '">'
        + '<div class="rt-head"><b>' + esc(s.id) + '</b>'
        + '<span class="ver" style="color:' + color + '">[' + (STATUS_LABEL[st] || st) + ']</span>' + imp + '</div>'
        + '<div class="hint">' + summary + '</div>'
        + (s.error ? '<div class="hint danger">' + esc(s.error) + '</div>' : '')
        + '<div class="rt-actions" style="margin-top:6px">'
        + '<label style="width:auto"><input type="checkbox" class="mcp-toggle" data-id="' + esc(s.id) + '" ' + (s.enabled !== false ? 'checked' : '') + '/> 启用</label> '
        + '<button class="mcp-edit" data-id="' + esc(s.id) + '">编辑</button> '
        + '<button class="mcp-test" data-id="' + esc(s.id) + '">测试连接</button> '
        + '<button class="mcp-del" data-id="' + esc(s.id) + '">删除</button>'
        + '</div></div>';
    }).join('');

    box.querySelectorAll('.mcp-toggle').forEach((c) => (c.onchange = (e) => post({ type: 'toggleMcpServer', id: e.target.dataset.id, enabled: e.target.checked })));
    box.querySelectorAll('.mcp-edit').forEach((b) => (b.onclick = () => {
      const s = (window.__mcpData.servers || []).find((x) => x.id === b.dataset.id);
      openMcpEditor(s);
    }));
    box.querySelectorAll('.mcp-test').forEach((b) => (b.onclick = () => post({ type: 'testMcpServer', id: b.dataset.id })));
    box.querySelectorAll('.mcp-del').forEach((b) => (b.onclick = () => {
      post({ type: 'deleteMcpServer', id: b.dataset.id });
    }));
    }

    // 渲染内置服务器目录
    const catalog = (data && data.catalog) || [];
    const catBox = document.getElementById('mcp-catalog');
    if (catBox) {
      if (!catalog.length) {
        catBox.innerHTML = '<span class="hint">（目录为空）</span>';
      } else {
        catBox.innerHTML = catalog.map((c) => {
          const envHint = (c.needsEnv && c.needsEnv.length) ? ('<span class="hint">需要环境变量：' + c.needsEnv.map(esc).join('、') + '</span>') : '';
          return '<div class="card" data-cat="' + esc(c.id) + '">'
            + '<div class="rt-head"><b>' + esc(c.name) + '</b><span class="ver">' + esc(c.id) + '</span></div>'
            + '<div class="hint">' + esc(c.desc || '') + '</div>'
            + (c.note ? '<div class="hint">' + esc(c.note) + '</div>' : '')
            + envHint
            + '<div class="rt-actions" style="margin-top:6px">'
            + '<button class="cat-install" data-id="' + esc(c.id) + '">安装并使用</button>'
            + '</div></div>';
        }).join('');
        catBox.querySelectorAll('.cat-install').forEach((b) => (b.onclick = () => post({ type: 'installCatalogServer', id: b.dataset.id })));
      }
    }
  }

  function renderSandbox(data) {
    window.__sbData = data;
    if (!data) return;
    const dirEl = document.getElementById('sb-dir');
    if (dirEl && data.dir) dirEl.textContent = data.dir;

    const tpl = document.getElementById('sb-template');
    if (tpl) {
      const sel = tpl.value || '';
      tpl.innerHTML = '<option value="">— 空白 —</option>' + (data.templates || []).map((t) => '<option value="' + esc(t) + '">' + esc(t) + '</option>').join('');
      if ((data.templates || []).includes(sel)) tpl.value = sel;
    }

    const box = document.getElementById('sb-list');
    if (!box) return;
    const builtins = (data.builtins || []).map((s) => {
      const st = s.status === 'ready' ? '✅ 可用' : (s.status === 'invalid' ? '❌ 不可用' : '❓');
      return '<div class="card" data-name="' + esc(s.name) + '">'
        + '<div class="rt-head"><b>' + esc(s.name) + '</b> <span class="ver">[' + esc(s.language) + ']</span> <span class="ver" style="color:var(--vscode-charts-green,#3fb950)">[内置·锁定]</span></div>'
        + '<div class="hint">状态：' + st + (s.error ? ' — ' + esc(s.error) : '') + '</div>'
        + '<div class="rt-actions" style="margin-top:6px"><span class="hint">内置沙盒不可删除</span></div>'
        + '</div>';
    });
    const users = (data.user || []).map((s) => {
      const st = s.status === 'ready' ? '✅ 可用' : (s.status === 'invalid' ? '❌ 不可用' : '❓ 未校验');
      return '<div class="card" data-name="' + esc(s.name) + '">'
        + '<div class="rt-head"><b>' + esc(s.name) + '</b> <span class="ver">[' + esc(s.language) + ']</span> <span class="ver" style="color:var(--vscode-charts-orange,#d29922)">[用户]</span></div>'
        + '<div class="hint">状态：' + st + (s.error ? ' — ' + esc(s.error) : '') + '</div>'
        + '<div class="rt-actions" style="margin-top:6px">'
        + '<button class="sb-test" data-name="' + esc(s.name) + '">重测</button> '
        + '<button class="sb-del" data-name="' + esc(s.name) + '">删除</button>'
        + '</div></div>';
    });
    if (!builtins.length && !users.length) {
      box.innerHTML = '<span class="hint">（暂无沙盒）</span>';
    } else {
      box.innerHTML = (builtins.length ? '<h3 style="margin:8px 0 4px">🔒 内置沙盒</h3>' + builtins.join('') : '')
        + (users.length ? '<h3 style="margin:10px 0 4px">🧩 用户沙盒</h3>' + users.join('') : '<h3 style="margin:10px 0 4px">🧩 用户沙盒</h3><p class="hint">（暂无。点上方「套用模板」新建，或把带 manifest.json 的文件夹丢进沙盒目录即可出现在这里。）</p>');
    }
    box.querySelectorAll('.sb-test').forEach((b) => (b.onclick = () => {
      b.disabled = true; b.textContent = '重测中…';
      post({ type: 'testSandbox', name: b.dataset.name });
    }));
    box.querySelectorAll('.sb-del').forEach((b) => (b.onclick = () => {
      if (typeof confirm === 'function' && !confirm('确定删除用户沙盒「' + b.dataset.name + '」吗？此操作不可恢复。')) return;
      post({ type: 'deleteSandbox', name: b.dataset.name });
    }));
  }

  window.addEventListener('message', (ev) => {
    try {
    const m = ev.data;
    if (m.type === 'init') {
      if (m.root) document.getElementById('root').value = m.root;
      if (m.mirror) document.getElementById('mirror').value = m.mirror;
      if (m.elevation) document.getElementById('elevation').value = m.elevation;
      if (m.silent !== undefined) document.getElementById('silent').checked = m.silent;
      if (m.webai2apiDir) setVal('webai2api-dir', 'value', m.webai2apiDir);
      if (m.webai2apiMirror) setVal('webai2api-mirror', 'value', m.webai2apiMirror);
      if (m.webai2apiProxy) setVal('webai2api-proxy', 'value', m.webai2apiProxy);
      if (m.webai2apiAutoStart !== undefined) setVal('webai2api-autostart', 'checked', !!m.webai2apiAutoStart);
    } else if (m.type === 'installed') {
      const card = document.querySelector('.card[data-rt="'+m.id+'"]');
      if (card) { card.querySelector('.status').textContent = '✓ ' + (m.version||''); card.querySelector('.install-btn').disabled = false; }
    } else if (m.type === 'progress') {
      const card = document.querySelector('.card[data-rt="'+m.id+'"]');
      if (card) card.querySelector('.status').textContent = m.text;
    } else if (m.type === 'installError') {
      const card = document.querySelector('.card[data-rt="'+m.id+'"]');
      if (card) { card.querySelector('.status').textContent = '✗ ' + m.error; card.querySelector('.install-btn').disabled = false; }
      } else if (m.type === 'extList') {
        window._extData = m.extensions || [];
        window._ownCommands = m.ownCommands || [];
        if (m.error) {
          const box = document.getElementById('ext-list');
          if (box) box.innerHTML = '<span class="hint danger">加载扩展失败：' + esc(m.error) + '</span>';
          return;
        }
        renderExtList();
      } else if (m.type === 'extResult') {
        const log = document.getElementById('ext-log');
        if (m.ok) {
          log.style.color = 'var(--vscode-charts-green, #3fb950)';
          log.textContent = '✅ 调用成功：' + m.command + (m.result !== undefined && m.result !== null ? '\\n返回：' + String(m.result).slice(0, 300) : '');
        } else {
          log.style.color = 'var(--vscode-errorForeground, #f85149)';
          log.textContent = '❌ 调用失败：' + m.command + (m.error ? '\\n' + m.error : '');
        }
      } else if (m.type === 'kbInit') {
        document.getElementById('kb-enabled').checked = !!m.enabled;
        document.getElementById('kb-source').value = m.source || '';
        document.getElementById('kb-output').value = m.output || '';
        document.getElementById('kb-provider').value = m.provider || 'llamacpp';
        document.getElementById('kb-baseurl').value = m.baseurl || '';
        document.getElementById('kb-model').value = m.model || '';
        document.getElementById('kb-auto-enabled').checked = !!m.autoEnabled;
        document.getElementById('kb-auto-threshold').value = (m.autoThreshold != null) ? m.autoThreshold : '';
        document.getElementById('kb-auto-keep').value = (m.autoKeep != null) ? m.autoKeep : '';
        document.getElementById('kb-auto-dir').value = m.autoDir || '';
        document.getElementById('kb-stat').textContent = m.stat || '';
        setVal('kb-vec-enabled', 'checked', !!m.vecEnabled);
        setVal('kb-vec-provider', 'value', m.vecProvider || 'ollama');
        setVal('kb-vec-baseurl', 'value', m.vecBaseurl || '');
        setVal('kb-vec-model', 'value', m.vecModel || '');
        setVal('kb-vec-dim', 'value', m.vecDim != null ? m.vecDim : 0);
        setVal('kb-vec-hybrid', 'checked', m.vecHybrid !== false);
        setVal('kb-vec-stat', 'textContent', m.vecStat || '');
        document.getElementById('kb-log').textContent = m.defaultOutput ? ('默认输出目录：' + m.defaultOutput + '\n') : '';
        if (m.defaultAutoDir) document.getElementById('kb-log').textContent += '默认知识库-2 目录：' + m.defaultAutoDir + '\n';
      } else if (m.type === 'kbLog') {
        const box = document.getElementById('kb-log');
        box.textContent += (box.textContent && !box.textContent.endsWith('\\n') ? '\\n' : '') + m.text;
        box.scrollTop = box.scrollHeight;
      } else if (m.type === 'kbStat') {
        document.getElementById('kb-stat').textContent = m.text || '';
      } else if (m.type === 'kbVecStat') {
        setVal('kb-vec-stat', 'textContent', m.text || '');
      } else if (m.type === 'audit') {
        document.getElementById('audit-log').textContent = m.text || '（暂无日志）';
      } else if (m.type === 'taskList') {
        renderTasks(m.tasks || []);
      } else if (m.type === 'taskDetail') {
        renderTaskDetail(m.task);
      } else if (m.type === 'projectList') {
        renderProject(m.data);
      } else if (m.type === 'mcpList') {
        renderMcp(m);
      } else if (m.type === 'mcpEditorError') {
        const msg = document.getElementById('mcp-editor-msg');
        if (msg) { msg.textContent = m.message; msg.className = 'hint danger'; }
      } else if (m.type === 'mcpTestResult') {
        const box = document.getElementById('mcp-list');
        if (box) {
          const note = document.createElement('div');
          note.className = 'hint ' + (m.ok ? '' : 'danger');
          note.style.marginBottom = '6px';
          note.textContent = (m.ok ? '✓ ' : '✗ ') + '[' + m.id + '] ' + m.message;
          box.parentNode.insertBefore(note, box);
          setTimeout(() => { if (note.parentNode) note.parentNode.removeChild(note); }, 6000);
        }
      } else if (m.type === 'switchTab') {
        // 扩展端指定的初始标签页需要同时触发数据加载（否则目录/列表会永远停在「加载中…」）
        switchTab(m.tab, true);
      } else if (m.type === 'sandboxList') {
        renderSandbox(m);
      } else if (m.type === 'sandboxSaved') {
        const el = document.getElementById('sb-msg');
        if (el) { el.textContent = m.ok ? '✅ 已保存' : ('❌ ' + (m.error || '保存失败')); el.className = 'hint ' + (m.ok ? '' : 'danger'); }
      } else if (m.type === 'sandboxDeleted') {
        if (!m.ok) { const el = document.getElementById('sb-msg'); if (el) { el.textContent = '❌ ' + (m.error || '删除失败'); el.className = 'hint danger'; } }
      } else if (m.type === 'sandboxTestResult') {
        const box = document.getElementById('sb-list');
        if (box) {
          const note = document.createElement('div');
          note.className = 'hint ' + (m.ok ? '' : 'danger');
          note.style.marginBottom = '6px';
          let txt = (m.ok ? '✓ ' : '✗ ') + '重测「' + (m.name || '') + '」';
          if (m.builtin) txt += '：' + (m.note || '内置默认可用');
          else { txt += ' exit=' + m.exit; if (m.error) txt += ' 错误=' + m.error; if (m.stdout) txt += ' 输出=' + String(m.stdout).slice(0, 200); }
          note.textContent = txt;
          box.parentNode.insertBefore(note, box);
          setTimeout(() => { if (note.parentNode) note.parentNode.removeChild(note); }, 8000);
        }
      } else if (m.type === 'webai2apiDir') {
        setVal('webai2api-dir', 'value', m.dir || '');
      } else if (m.type === 'webai2apiStage') {
        w2aStage(m.text || '');
      } else if (m.type === 'webai2apiProgress') {
        w2aProgress(m.percent, !!m.indeterminate);
      } else if (m.type === 'webai2apiLog') {
        w2aLog(m.text || '');
      } else if (m.type === 'webai2apiDone') {
        w2aReset(false);
        w2aStage('✅ 配置完成');
        w2aProgress(100, false);
        const d = m.summary || {};
        w2aLog('WebAI2API 已配置在：' + (d.projectDir || ''), 'ok');
        w2aLog('鉴权密钥已自动填入狐狸 AI 的「WebAI2API」服务商（SecretStorage）。', 'ok');
        w2aLog('下一步：点下方「▶ 启动服务」，首次使用前先点一次「启动服务」后按提示运行 npm start -- -login 登录网页账号。');
      } else if (m.type === 'webai2apiCancelled') {
        w2aReset(false);
        w2aStage('⏹ 已停止');
        w2aLog('已中途停止（已下载内容保留，可再次点击「下载并配置」继续）。', 'danger');
      } else if (m.type === 'webai2apiError') {
        w2aReset(false);
        w2aStage('❌ 失败');
        w2aLog(m.error || '未知错误', 'danger');
      } else if (m.type === 'webai2apiServerStatus') {
        w2aServerStatus(!!m.running);
      } else if (m.type === 'webai2apiServerStarted') {
        w2aServerStatus(true);
        w2aLog('✅ 服务已启动 (pid ' + m.pid + ')，监听 http://localhost:3000', 'ok');
        w2aLog('首次使用需登录网页账号：点「停止服务」→ 在项目目录终端运行 npm start -- -login，登录后重新「启动服务」。');
      } else if (m.type === 'webai2apiServerStopped') {
        w2aServerStatus(false);
        w2aLog('服务已停止。');
      } else if (m.type === 'webai2apiTokenResult') {
        w2aLog(m.text || '', m.ok ? 'ok' : 'danger');
        if (m.ok) w2aToast(m.text || 'Token 已复制');
      } else if (m.type === 'webai2apiServerError') {
        w2aServerStatus(false);
        w2aLog(m.error || '未知错误', 'danger');
      }
    } catch (err) {
      console.error('[fox-ai env] message handler error', err);
      const log = document.getElementById('ext-log') || document.getElementById('kb-log') || document.getElementById('audit-log');
      if (log) log.textContent += '\n[渲染错误] ' + String(err && err.message || err);
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
} catch (e) {
  console.error('[fox-ai env] init error', e);
  if (typeof vscode !== 'undefined') {
    vscode.postMessage({ type: 'initError', error: String(e && e.message) });
  }
}
})();
