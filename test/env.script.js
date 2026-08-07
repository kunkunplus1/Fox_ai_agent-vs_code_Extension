
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
  }
  function bindTabs() {
    const tabs = document.getElementById('tabs');
    if (!tabs) return;
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

  function bindForms() {
    document.getElementById('refresh-audit').onclick = () => post({ type: 'loadAudit' });
    document.getElementById('refresh-tasks').onclick = () => post({ type: 'loadTasks' });
    document.getElementById('show-done').onchange = () => { if (window.__taskData) renderTasks(window.__taskData); };

    document.getElementById('pick-root').onclick = () => post({ type: 'pickRoot' });
    document.getElementById('root').onchange = (e) => post({ type: 'setRoot', value: e.target.value });
    document.getElementById('mirror').onchange = (e) => post({ type: 'setMirror', value: e.target.value });
    document.getElementById('elevation').onchange = (e) => post({ type: 'setElevation', value: e.target.value });
    document.getElementById('silent').onchange = (e) => post({ type: 'setSilent', value: e.target.checked });

    document.getElementById('kb-pick-source').onclick = () => post({ type: 'pickKbSource' });
    document.getElementById('kb-pick-output').onclick = () => post({ type: 'pickKbOutput' });
    document.getElementById('kb-organize').onclick = () => {
      document.getElementById('kb-log').textContent = '';
      post({ type: 'organize', config: collectKbForm() });
    };
    document.getElementById('kb-rebuild').onclick = () => post({ type: 'rebuildKb' });

    document.querySelectorAll('.install-btn').forEach(b => b.onclick = () => {
      const card = b.closest('.card');
      const id = card.dataset.rt;
      const ver = card.querySelector('.ver-input').value.trim();
      const status = card.querySelector('.status');
      b.disabled = true; status.textContent = '准备中…';
      post({ type: 'install', id, version: ver });
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
      model: document.getElementById('kb-model').value
    };
  }

  const STATE_LABEL = { queued: '排队中', running: '运行中', paused: '已暂停', 'awaiting-approval': '等待确认', completed: '已完成', failed: '失败', cancelled: '已取消' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function fmtTime(iso) { try { const d = new Date(iso); return d.toLocaleString(); } catch (_) { return iso || ''; } }
  function renderTasks(tasks) {
    window.__taskData = tasks;
    const showDone = document.getElementById('show-done').checked;
    const list = showDone ? tasks : tasks.filter((t) => !['completed', 'cancelled'].includes(t.state));
    const box = document.getElementById('task-list');
    if (!list.length) { box.innerHTML = '<span class="hint">（没有任务）</span>'; return; }
    box.innerHTML = list.map((t) => {
      const n = (t.steps || []).length;
      return '<div class="task-item" data-id="' + t.id + '" style="padding:6px 8px;border:1px solid var(--vscode-panel-border);border-radius:6px;margin-bottom:6px;cursor:pointer;">'
        + '<span style="font-weight:600">[' + (STATE_LABEL[t.state] || t.state) + ']</span> '
        + esc(t.title) + ' <span class="hint">· ' + esc(t.type) + ' · ' + n + ' 步 · ' + fmtTime(t.updatedAt) + '</span></div>';
    }).join('');
    box.querySelectorAll('.task-item').forEach((el) => (el.onclick = () => {
      const t = tasks.find((x) => x.id === el.dataset.id);
      if (t) renderTaskDetail(t);
    }));
  }
  function renderTaskDetail(t) {
    const box = document.getElementById('task-detail');
    const steps = (t.steps || []).map((s, i) => {
      const tag = s.kind || '-';
      const st = s.ok === false ? '✗' : (s.ok === true ? '✓' : '·');
      const extra = s.reason ? ' — <span style="color:var(--vscode-errorForeground,#f85149)">' + esc(s.reason) + '</span>'
        : s.error ? ' — ' + esc(s.error) : (s.verify ? ' — 验证：' + esc(s.verify).slice(0, 80) : '');
      const txt = s.text ? esc(s.text).slice(0, 120) : (s.name ? esc(s.name) : '');
      return (i + 1) + '. [' + st + ' ' + tag + '] ' + txt + extra;
    }).join('
');
    let actions = '';
    const resumable = ['failed', 'paused', 'queued', 'awaiting-approval'].includes(t.state);
    if (t.state === 'running') {
      actions += '<button class="task-cancel" data-id="' + t.id + '">停止任务</button> ';
    } else {
      if (resumable) actions += '<button class="task-resume" data-id="' + t.id + '">续跑任务</button> ';
      actions += '<button class="task-delete" data-id="' + t.id + '">删除记录</button>';
    }
    box.innerHTML = '<div style="margin-bottom:6px"><b>' + esc(t.title) + '</b> <span class="hint">(' + (STATE_LABEL[t.state] || t.state) + ')</span></div>'
      + '<div class="hint">类型：' + esc(t.type) + ' · 创建：' + fmtTime(t.createdAt) + (t.finishedAt ? ' · 结束：' + fmtTime(t.finishedAt) : '') + '</div>'
      + '<pre style="white-space:pre-wrap;max-height:300px;overflow:auto;background:rgba(128,128,128,.08);padding:8px;border-radius:6px;font-size:12px;margin-top:6px;">' + (steps || '（无步骤）') + '</pre>'
      + '<div style="margin-top:8px">' + actions + '</div>';
    box.querySelectorAll('.task-cancel').forEach((b) => (b.onclick = () => post({ type: 'cancelTask', id: b.dataset.id })));
    box.querySelectorAll('.task-resume').forEach((b) => (b.onclick = () => post({ type: 'resumeTask', id: b.dataset.id })));
    box.querySelectorAll('.task-delete').forEach((b) => (b.onclick = () => post({ type: 'deleteTask', id: b.dataset.id })));
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'init') {
      if (m.root) document.getElementById('root').value = m.root;
      if (m.mirror) document.getElementById('mirror').value = m.mirror;
      if (m.elevation) document.getElementById('elevation').value = m.elevation;
      if (m.silent !== undefined) document.getElementById('silent').checked = m.silent;
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
        const box = document.getElementById('ext-list');
        if (!m.extensions.length) { box.innerHTML = '<span class="hint">未发现其它扩展</span>'; return; }
        box.innerHTML = m.extensions.map(e => {
          const cmds = e.commands.map(c => '<label style="display:flex;align-items:center;gap:6px"><input type="checkbox" data-cmd="'+c.command+'" '+(c.allowed?'checked':'')+'/> <span>'+c.title+' <code>'+c.command+'</code></span> <button class="call-cmd" data-cmd="'+c.command+'">调用</button></label>').join('');
          return '<div class="ext"><b>'+e.displayName+'</b> <span class="hint">'+e.id+'</span><div class="cmds">'+cmds+'</div></div>';
        }).join('');
        box.querySelectorAll('input[data-cmd]').forEach(cb => cb.onchange = () => post({ type: 'toggleCmd', command: cb.dataset.cmd, on: cb.checked }));
        box.querySelectorAll('button.call-cmd').forEach(b => b.onclick = () => {
          document.getElementById('ext-log').textContent = '调用中：' + b.dataset.cmd + ' …';
          document.getElementById('ext-log').style.color = '';
          post({ type: 'callCmd', command: b.dataset.cmd });
        });
      } else if (m.type === 'extResult') {
        const log = document.getElementById('ext-log');
        if (m.ok) {
          log.style.color = 'var(--vscode-charts-green, #3fb950)';
          log.textContent = '✅ 调用成功：' + m.command + (m.result !== undefined && m.result !== null ? '
返回：' + String(m.result).slice(0, 300) : '');
        } else {
          log.style.color = 'var(--vscode-errorForeground, #f85149)';
          log.textContent = '❌ 调用失败：' + m.command + (m.error ? '
' + m.error : '');
        }
      } else if (m.type === 'kbInit') {
        document.getElementById('kb-enabled').checked = !!m.enabled;
        document.getElementById('kb-source').value = m.source || '';
        document.getElementById('kb-output').value = m.output || '';
        document.getElementById('kb-provider').value = m.provider || 'llamacpp';
        document.getElementById('kb-baseurl').value = m.baseurl || '';
        document.getElementById('kb-model').value = m.model || '';
        document.getElementById('kb-stat').textContent = m.stat || '';
        document.getElementById('kb-log').textContent = m.defaultOutput ? ('默认输出目录：' + m.defaultOutput + '
') : '';
      } else if (m.type === 'kbLog') {
        const box = document.getElementById('kb-log');
        box.textContent += (box.textContent && !box.textContent.endsWith('
') ? '
' : '') + m.text;
        box.scrollTop = box.scrollHeight;
      } else if (m.type === 'kbStat') {
        document.getElementById('kb-stat').textContent = m.text || '';
      } else if (m.type === 'audit') {
        document.getElementById('audit-log').textContent = m.text || '（暂无日志）';
      } else if (m.type === 'taskList') {
        renderTasks(m.tasks || []);
      } else if (m.type === 'switchTab') {
        switchTab(m.tab, false);
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
