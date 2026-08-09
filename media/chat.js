(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const messagesEl = $('messages');
  const stepItems = {};
  const inputEl = $('input');
  const btnSend = $('btnSend');
  const btnAttach = $('btnAttach');
  const attachmentsEl = $('attachments');
  const btnPause = $('btnPause');
  const btnResume = $('btnResume');
  const btnStop = $('btnStop');
  const btnUndo = $('btnUndo');
  const btnRedo = $('btnRedo');
  const btnReadTerminal = $('btnReadTerminal');
  const runBar = $('runBar');
  const runText = $('runText');
  const errorBar = $('errorBar');
  const errorText = $('errorText');
  const ragHintEl = $('ragHint');
  const providerChip = $('providerChip');
  const modelChip = $('modelChip');
  const apiModeChip = $('apiModeChip');
  const thinkChip = $('thinkChip');
  const agentChip = $('agentChip');
  const approveChip = $('approveChip');
  const btnPlanTasks = $('btnPlanTasks');
  const planPanel = $('planPanel');
  const planList = $('planList');
  const btnContextUsage = $('btnContextUsage');
  const contextPanel = $('contextPanel');
  const contextBody = $('contextBody');
  const btnStorage = $('btnStorage');

  const live = {};
  const toolCards = {};
  let rafPending = false;
  let busy = false;
  let attachments = [];

  const slashPopup = $('slashPopup');
  let slashCandidates = [];
  let slashIndex = -1;
  let slashTimer = null;
  let slashReqId = 0;
  let slashPending = false;
  let slashMcpPolicy = { enabled: false, autoInject: false };

  const APPROVE_LEVELS = ['off', 'read', 'edit', 'all'];
  const APPROVE_LABEL = { off: '每步确认', read: '读放行', edit: '读写放行', all: '全自动' };
  let approveLevel = 'read';

  /* ================= markdown ================= */

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function renderInline(s) {
    let out = escapeHtml(s);
    out = out.replace(/`([^`\n]+)`/g, (m, c) => '<code class="inline">' + c + '</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
    return out;
  }

  function renderMarkdown(src) {
    const blocks = [];
    let text = String(src == null ? '' : src);

    text = text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
      blocks.push({ lang: (lang || '').trim(), code: code.replace(/\n$/, '') });
      return '\u0000CB' + (blocks.length - 1) + '\u0000';
    });
    const open = text.lastIndexOf('```');
    if (open !== -1) {
      const rest = text.slice(open + 3);
      const nl = rest.indexOf('\n');
      const lang = (nl === -1 ? rest : rest.slice(0, nl)).trim();
      const code = nl === -1 ? '' : rest.slice(nl + 1);
      blocks.push({ lang, code });
      text = text.slice(0, open) + '\u0000CB' + (blocks.length - 1) + '\u0000';
    }

    const lines = text.split('\n');
    const html = [];
    let listType = null;
    let para = [];

    const flushPara = () => {
      if (para.length) {
        html.push('<p>' + renderInline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
        para = [];
      }
    };
    const closeList = () => {
      if (listType) { html.push(listType === 'ul' ? '</ul>' : '</ol>'); listType = null; }
    };

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      const ph = line.match(/^\u0000CB(\d+)\u0000$/);
      if (ph) { flushPara(); closeList(); html.push(codeBlockHtml(blocks[Number(ph[1])])); continue; }
      if (!line.trim()) { flushPara(); closeList(); continue; }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flushPara(); closeList(); html.push('<h' + h[1].length + '>' + renderInline(h[2]) + '</h' + h[1].length + '>'); continue; }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushPara(); closeList(); html.push('<hr>'); continue; }
      const q = line.match(/^>\s?(.*)$/);
      if (q) { flushPara(); closeList(); html.push('<blockquote>' + renderInline(q[1]) + '</blockquote>'); continue; }
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ul) {
        flushPara();
        if (listType !== 'ul') { closeList(); html.push('<ul>'); listType = 'ul'; }
        html.push('<li>' + renderInline(ul[1]) + '</li>');
        continue;
      }
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ol) {
        flushPara();
        if (listType !== 'ol') { closeList(); html.push('<ol>'); listType = 'ol'; }
        html.push('<li>' + renderInline(ol[1]) + '</li>');
        continue;
      }
      closeList();
      para.push(line);
    }
    flushPara(); closeList();
    return html.join('');
  }

  function codeBlockHtml(b) {
    if (!b) return '';
    return (
      '<div class="code-block"><div class="code-head">' +
      '<span class="lang">' + escapeHtml(b.lang || 'text') + '</span>' +
      '<button data-act="copy">' + t('复制') + '</button>' +
      '<button data-act="insert">' + t('插入') + '</button>' +
      '<button data-act="newfile">' + t('新文件') + '</button>' +
      '</div><pre><code>' + escapeHtml(b.code) + '</code></pre></div>'
    );
  }

  /* ================= DOM 辅助 ================= */

  function hideWelcome() {
    const w = $('welcome');
    if (w) w.remove();
  }

  function nearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 90;
  }

  function scrollDown(force) {
    if (force || nearBottom()) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addMessage(role, id) {
    hideWelcome();
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + role;
    wrap.dataset.id = id || '';
    const roleEl = document.createElement('div');
    roleEl.className = 'role';
    roleEl.textContent = role === 'user' ? t('你') : t('狐狸 AI');
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    wrap.appendChild(roleEl);
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    return { wrap, bubble };
  }

  function renderAttachments() {
    if (!attachmentsEl) return;
    if (!attachments.length) {
      attachmentsEl.innerHTML = '';
      attachmentsEl.classList.add('hidden');
      return;
    }
    attachmentsEl.classList.remove('hidden');
    attachmentsEl.innerHTML = attachments.map((a) =>
      '<span class="att-chip" data-id="' + escapeHtml(a.id) + '">' +
      (a.isImage ? '🖼 ' : '📄 ') +
      escapeHtml(a.name) +
      '<button data-act="remove" data-id="' + escapeHtml(a.id) + '">×</button>' +
      '</span>'
    ).join('');
  }

  function formatTokens(n) {
    if (n >= 10000) return (n / 1000).toFixed(1) + 'K';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  function renderContextUsage(data) {
    if (!contextBody) return;
    // 回填「上限」输入框（仅在不聚焦时，避免打断正在输入）
    const ctxInput = document.getElementById('contextWindowInput');
    if (ctxInput && data && document.activeElement !== ctxInput) {
      ctxInput.value = (data.contextWindow && data.contextWindow > 0) ? String(data.contextWindow) : '';
    }
    if (!data || !data.items || !data.items.length) {
      contextBody.innerHTML = '<div class="context-empty">' + t('发送消息后，这里会显示当前 prompt 的估算 token 分布。') + '</div>';
      return;
    }
    const total = data.totalMeasured || 0;
    const limit = data.contextWindow || 0;
    const pct = data.percentage || 0;
    const limitText = limit > 0 ? formatTokens(total) + ' / ' + formatTokens(limit) : formatTokens(total) + ' tokens';
    const head = limit > 0
      ? '<div class="context-summary">' +
          '<div class="context-percent">' + pct + '%</div>' +
          '<div class="context-bar"><div class="context-bar-fill" style="width:' + Math.min(100, pct) + '%"></div></div>' +
          '<div class="context-limit">' + t('已使用 ') + limitText + '</div>' +
        '</div>'
      : '<div class="context-summary">' +
          '<div class="context-limit">' + t('估算输入：') + limitText + '</div>' +
          '<div class="context-hint">' + t('在设置里填 foxAi.contextWindow 可显示占比') + '</div>' +
        '</div>';

    const palette = {
      system: 'var(--vscode-charts-blue, #3794ff)',
      tools: 'var(--vscode-charts-purple, #b180d7)',
      history: 'var(--vscode-charts-yellow, #d7ba7d)',
      memory: 'var(--vscode-charts-green, #3fb950)',
      skills: 'var(--vscode-charts-orange, #d18616)',
      planTasks: 'var(--vscode-charts-red, #f14c4c)',
      knowledge: 'var(--vscode-charts-cyan, #4ec9b0)'
    };

    const rows = data.items.map((it) => {
      const color = palette[it.key] || 'var(--vscode-charts-foreground, #999)';
      const rowPct = total > 0 ? Math.round((it.tokens / total) * 1000) / 10 : 0;
      return (
        '<div class="context-item">' +
          '<div class="context-item-top">' +
            '<span class="context-dot" style="background:' + color + '"></span>' +
            '<span class="context-label">' + escapeHtml(it.label) + '</span>' +
            '<span class="context-value">' + formatTokens(it.tokens) + ' tokens (' + rowPct + '%)</span>' +
          '</div>' +
          '<div class="context-item-bar"><div class="context-item-fill" style="width:' + Math.min(100, rowPct) + '%;background:' + color + '"></div></div>' +
        '</div>'
      );
    }).join('');

    // 「距离自动压缩」状态区：避免只显示总占用量误导用户
    let compressHtml = '';
    const cm = data.compressMeta;
    if (cm && cm.enabled && limit > 0) {
      const thrPct = Math.round(cm.threshold * 1000) / 10;
      const fillPct = thrPct > 0 ? Math.min(100, (pct / thrPct) * 100) : 0;
      if (pct >= thrPct) {
        if (cm.compressible >= 1) {
          compressHtml =
            '<div class="context-compress ready">' +
              '<div class="cc-title">🗜️ 自动压缩 · 阈值 ' + thrPct + '%</div>' +
              '<div class="context-compress-bar"><div class="context-compress-fill" style="width:100%"></div></div>' +
              '<div class="cc-status warn">已达阈值，下次对话后将自动压缩</div>' +
            '</div>';
        } else {
          compressHtml =
            '<div class="context-compress no-content">' +
              '<div class="cc-title">🗜️ 自动压缩 · 阈值 ' + thrPct + '%</div>' +
              '<div class="context-compress-bar"><div class="context-compress-fill" style="width:100%"></div></div>' +
              '<div class="cc-status muted">已达阈值，但可压缩对话不足（占用多为固定开销），暂不压缩</div>' +
            '</div>';
        }
      } else {
        const gapPct = Math.max(0, Math.round((thrPct - pct) * 10) / 10);
        const gapTokens = Math.max(0, Math.round((thrPct / 100) * limit - total));
        compressHtml =
          '<div class="context-compress">' +
            '<div class="cc-title">🗜️ 自动压缩 · 阈值 ' + thrPct + '%</div>' +
            '<div class="context-compress-bar"><div class="context-compress-fill" style="width:' + fillPct + '%"></div></div>' +
            '<div class="cc-status ok">距离自动压缩还需约 ' + gapPct + '%（约 +' + formatTokens(gapTokens) + ' tokens）</div>' +
          '</div>';
      }
    } else if (cm && cm.enabled && limit <= 0) {
      const toGo = Math.max(0, 6 - cm.compressible);
      compressHtml =
        '<div class="context-compress">' +
          '<div class="cc-title">🗜️ 自动压缩（按对话轮数）</div>' +
          (cm.compressible >= 6
            ? '<div class="cc-status warn">已达到轮数阈值，下次对话后压缩</div>'
            : '<div class="cc-status ok">还差约 ' + toGo + ' 条对话消息触发</div>') +
        '</div>';
    } else if (cm && !cm.enabled) {
      compressHtml =
        '<div class="context-compress off">' +
          '<div class="cc-title">🗜️ 自动压缩</div>' +
          '<div class="cc-status off">未开启（设置 foxAi.knowledgeBase.autoSummarize.enabled）</div>' +
        '</div>';
    }

    contextBody.innerHTML = head + compressHtml + '<div class="context-list">' + rows + '</div>';
  }

  function renderPlanTasks(items) {
    if (!planList) return;
    if (!items || !items.length) {
      planList.innerHTML = '<div class="plan-empty">' + t('暂无任务，让狐狸 AI 用 create_plan_task 拆分项目步骤吧～') + '</div>';
      return;
    }
    planList.innerHTML = items.map((it) => {
      const cls = 'plan-item ' + (it.status === 'completed' ? 'completed' : it.status === 'in_progress' ? 'in-progress' : 'pending');
      const icon = it.status === 'completed' ? '✓'
        : it.status === 'in_progress' ? '<span class="spinner"></span>'
        : '○';
      return (
        '<div class="' + cls + '" data-id="' + escapeHtml(it.id) + '">' +
          '<span class="plan-icon">' + icon + '</span>' +
          '<span class="plan-text">' +
            '<span class="plan-subject">' + escapeHtml(it.subject) + '</span>' +
            (it.description ? '<span class="plan-desc">' + escapeHtml(it.description) + '</span>' : '') +
          '</span>' +
          '<button class="plan-del" data-act="del" title="' + t('删除任务') + '" aria-label="' + t('删除任务') + '">🗑</button>' +
        '</div>'
      );
    }).join('');
  }

  function renderReasoning(text) {
    const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const rows = [];
    for (const line of lines) {
      const low = line.toLowerCase();
      let icon = '•';
      let cls = '';
      if (/编辑|edit|修改|改写|\+\d+\s+-\d+/.test(line)) { icon = '✏️'; cls = 'edit'; }
      else if (/读取|read|打开|查看|加载/.test(line)) { icon = '📖'; cls = 'read'; }
      else if (/运行|执行|run|test|check|同步|sync|syntax|校验|验证/.test(line)) { icon = '⚡'; cls = 'exec'; }
      else if (/思考|想|reasoning|consider|分析/.test(line)) { icon = '💭'; cls = 'think'; }
      rows.push(
        '<div class="reasoning-item ' + cls + '">' +
        '<span class="reasoning-icon">' + icon + '</span>' +
        '<span class="reasoning-text">' + escapeHtml(line) + '</span>' +
        '</div>'
      );
    }
    return rows.join('');
  }

  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const stick = nearBottom();
      for (const id of Object.keys(live)) {
        const m = live[id];
        if (!m.dirty) continue;
        m.dirty = false;
        m.bubble.innerHTML = m.raw ? renderMarkdown(m.raw) : '<span class="typing"></span>';
        if (m.images && m.images.length) {
          for (const img of m.images) {
            const wrapper = document.createElement('div');
            wrapper.className = 'generated-image';
            const el = document.createElement('img');
            el.src = img.src || '';
            el.alt = img.alt || t('模型生成图片');
            el.title = img.alt || t('模型生成图片');
            el.onerror = () => { el.style.display = 'none'; wrapper.textContent = '（图片加载失败）'; };
            wrapper.appendChild(el);
            const saveBtn = document.createElement('button');
            saveBtn.className = 'gen-image-save';
            saveBtn.textContent = t('保存');
            saveBtn.title = t('保存图片到本地');
            saveBtn.addEventListener('click', () => {
              vscode.postMessage({ type: 'saveImage', src: img.src, name: img.alt || 'generated-image' });
            });
            wrapper.appendChild(saveBtn);
            m.bubble.appendChild(wrapper);
          }
        }
        if (m.reasoning) {
          if (!m.reasonEl) {
            m.reasonEl = document.createElement('div');
            m.reasonEl.className = 'reasoning open';
            m.reasonEl.innerHTML =
              '<div class="reasoning-head">' +
                '<span class="reasoning-title">' + t('💭 深度思考') + '</span>' +
                '<span class="reasoning-caret">▾</span>' +
              '</div>' +
              '<div class="reasoning-body"></div>';
            m.reasonEl.querySelector('.reasoning-head').addEventListener('click', () => {
              m.reasonEl.classList.toggle('open');
            });
            m.bubble.parentElement.insertBefore(m.reasonEl, m.bubble);
          }
          const body = m.reasonEl.querySelector('.reasoning-body');
          body.innerHTML = renderReasoning(m.reasoning);
          body.scrollTop = body.scrollHeight;
        }
      }
      if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function renderDiff(text) {
    const lines = String(text || '').split('\n');
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      let cls = 'diff-line-ctx';
      let gutter = ' ';
      if (l.startsWith('+')) { cls = 'diff-line-add'; gutter = '+'; }
      else if (l.startsWith('-')) { cls = 'diff-line-del'; gutter = '-'; }
      const content = escapeHtml(l.slice(1));
      rows.push(
        '<div class="diff-row ' + cls + '">' +
        '<span class="diff-gutter">' + gutter + '</span>' +
        '<code class="diff-code">' + (content || '&nbsp;') + '</code>' +
        '</div>'
      );
    }
    return '<div class="diff-inline">' + rows.join('') + '</div>';
  }

  const KIND_ICON = { read: '📖', edit: '✏️', exec: '⚡' };
  const STATUS_ICON = { running: '⏳', ok: '✅', error: '❌', rejected: '🚫' };
  const STEP_ICON = { llm: '🧠', read: '🔍', write: '✏️', edit: '✏️', delete: '🗑️', exec: '🖥️', command: '🖥️', info: '•', review: '🔎', approval: '⏳', done: '✅', error: '❌' };

  function addToolCard(msg) {
    hideWelcome();
    const card = document.createElement('div');
    card.className = 'tool-card kind-' + (msg.kind || 'read') + ' status-running';
    card.dataset.id = msg.id;

    const stat = msg.preview && msg.preview.stat
      ? `+${msg.preview.stat.added} -${msg.preview.stat.removed}`
      : '';

    const isEdit = msg.kind === 'edit' || (msg.preview && msg.preview.text);
    card.dataset.hasPreview = isEdit ? '1' : '';

    card.innerHTML =
      '<div class="tool-head">' +
        '<span class="icon">' + (KIND_ICON[msg.kind] || '🔧') + '</span>' +
        '<span class="title"></span>' +
        '<span class="stat">' + escapeHtml(stat) + '</span>' +
        '<span class="state">⏳</span>' +
        '<span class="caret">▾</span>' +
      '</div>' +
      '<div class="tool-body">' +
        '<div class="args"></div>' +
        '<pre class="out"></pre>' +
      '</div>';

    card.querySelector('.title').textContent = msg.title || msg.name;
    const argsEl = card.querySelector('.args');
    if (msg.preview && msg.preview.text) {
      argsEl.innerHTML = renderDiff(msg.preview.text);
      card.classList.add('open');
    } else if (msg.argsText) {
      const pre = document.createElement('pre');
      pre.textContent = msg.argsText;
      argsEl.appendChild(pre);
      if (isEdit) card.classList.add('open');
    } else {
      argsEl.remove();
    }

    if (msg.preview) {
      const actions = document.createElement('div');
      actions.className = 'tool-actions';
      actions.innerHTML =
        '<button class="mini ghost" data-act="open">' + t('打开文件') + '</button>' +
        '<button class="mini" data-act="diff">' + t('🔍 在 Diff 视图中打开') + '</button>';
      actions.dataset.path = msg.preview.path || '';
      card.querySelector('.tool-body').appendChild(actions);
    }

    messagesEl.appendChild(card);
    toolCards[msg.id] = card;
    scrollDown();
    return card;
  }

  function updateToolCard(msg) {
    const card = toolCards[msg.id];
    if (!card) return;
    card.classList.remove('status-running');
    card.classList.add('status-' + msg.status);
    const state = card.querySelector('.state');
    if (state) state.textContent = STATUS_ICON[msg.status] || '';
    const out = card.querySelector('.out');
    if (out && msg.output) {
      out.textContent = msg.output;
      if (msg.status === 'error') card.classList.add('open');
    }
    // 写入/编辑类工具的改动预览默认保持展开，不用反复点
    if (card.dataset.hasPreview && msg.status === 'ok') {
      card.classList.add('open');
    }
    scrollDown();
  }

  function addStep(msg) {
    hideWelcome();
    let el = stepItems[msg.id];
    if (!el) {
      el = document.createElement('div');
      el.className = 'step-item';
      el.dataset.id = msg.id;
      el.innerHTML =
        '<div class="step-rail"></div>' +
        '<div class="step-icon"></div>' +
        '<div class="step-main">' +
          '<div class="step-row">' +
            '<span class="step-title"></span>' +
            '<span class="step-state"></span>' +
          '</div>' +
          '<div class="step-detail"></div>' +
        '</div>';
      el.querySelector('.step-title').addEventListener('click', () => el.classList.toggle('open'));
      messagesEl.appendChild(el);
      stepItems[msg.id] = el;
    }
    el.className = 'step-item kind-' + (msg.kind || 'info') + ' status-' + (msg.status || 'running') + (msg.detail ? ' has-detail' : '');
    el.querySelector('.step-icon').textContent = STEP_ICON[msg.kind] || '•';
    el.querySelector('.step-title').textContent = msg.title || '';
    const st = msg.status || 'running';
    el.querySelector('.step-state').textContent = st === 'ok' ? '✓' : st === 'error' ? '✗' : '⏳';
    if (msg.detail) el.querySelector('.step-detail').textContent = msg.detail;
    scrollDown();
    return el;
  }

  function appendToolStream(msg) {
    const card = toolCards[msg.id];
    if (!card) return;
    const out = card.querySelector('.out');
    if (!out) return;
    card.classList.add('open');
    out.textContent += msg.text;
    if (out.textContent.length > 20000) out.textContent = out.textContent.slice(-20000);
    out.scrollTop = out.scrollHeight;
    scrollDown();
  }

  function addApproval(msg) {
    hideWelcome();
    const box = document.createElement('div');
    box.className = 'approval';
    box.dataset.id = msg.id;
    const risky = msg.kind === 'exec' ? t('执行命令') : msg.kind === 'edit' ? t('修改文件') : t('读取');
    box.innerHTML =
      '<span class="q">' + t('要允许「{0}」吗？（{1}）', escapeHtml(msg.title || msg.name), risky) + '</span>' +
      '<button class="mini primary" data-d="approve">' + t('允许') + '</button>' +
      '<button class="mini" data-d="always">' + t('总是允许') + '</button>' +
      '<button class="mini danger" data-d="reject">' + t('拒绝') + '</button>';
    messagesEl.appendChild(box);
    scrollDown(true);
  }

  function addPlanPending(msg) {
    hideWelcome();
    const plan = msg.plan || [];
    const itemsHtml = plan.length
      ? plan.map((it) => {
          const icon = it.status === 'completed' ? '✓' : it.status === 'in_progress' ? '🔄' : '○';
          return '<li><span class="plan-icon">' + icon + '</span> ' +
            '<b>' + escapeHtml(it.subject) + '</b>' +
            (it.description ? ' — ' + escapeHtml(it.description) : '') + '</li>';
        }).join('')
      : '<li class="plan-empty">（计划为空，模型尚未用 create_plan_task 列出步骤）</li>';
    const box = document.createElement('div');
    box.className = 'plan-pending';
    box.innerHTML =
      '<div class="plan-pending-head">' +
        (msg.revised ? t('🔄 计划已修订，请再次确认') : t('📋 狐狸 AI 已提交执行计划，请确认')) +
      '</div>' +
      '<ol class="plan-pending-list">' + itemsHtml + '</ol>' +
      '<div class="plan-pending-actions">' +
        '<button class="mini primary" id="planConfirmBtn">' + t('✅ 确认执行') + '</button>' +
      '</div>' +
      '<div class="plan-pending-modify">' +
        '<textarea id="planModifyInput" rows="2" placeholder="' + t('想修改计划？在此输入意见，点「提交修改」让狐狸 AI 重新规划…') + '"></textarea>' +
        '<button class="mini" id="planModifyBtn">' + t('✏️ 提交修改') + '</button>' +
      '</div>';
    messagesEl.appendChild(box);
    scrollDown(true);
    box.querySelector('#planConfirmBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'planApprove' });
    });
    box.querySelector('#planModifyBtn').addEventListener('click', () => {
      const text = (box.querySelector('#planModifyInput').value || '').trim();
      const full = text ? '【修改计划】' + text : '请重新规划并再次提交计划以待确认。';
      vscode.postMessage({ type: 'send', text: full });
    });
  }

  function addPlan(msg) {
    const steps = msg.steps || [];
    if (!steps.length) return;
    hideWelcome();
    const itemsHtml = steps.map((s) => {
      const dep = (s.dependsOn && s.dependsOn.length) ? ' <span class="plan-dep">' + t('依赖：') + escapeHtml(s.dependsOn.join('、')) + '</span>' : '';
      const par = s.parallel ? ' <span class="plan-par">' + t('并行') + '</span>' : '';
      return '<li><b>' + escapeHtml(s.title) + '</b>' + dep + par + '</li>';
    }).join('');
    const box = document.createElement('div');
    box.className = 'plan-card';
    box.innerHTML =
      '<div class="plan-card-head">' + t('📋 执行计划（{0} 步）', steps.length) + '</div>' +
      '<ol class="plan-card-list">' + itemsHtml + '</ol>';
    messagesEl.appendChild(box);
    scrollDown(true);
  }

  function miniMarkdown(src) {
    return escapeHtml(src)
      .replace(/^### (.*)$/gm, '<h4>$1</h4>')
      .replace(/^## (.*)$/gm, '<h3>$1</h3>')
      .replace(/^\s*[-*] (.*)$/gm, '<span class="li">• $1</span>')
      .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
      .replace(/\n/g, '<br>');
  }

  function addReview(msg) {
    hideWelcome();
    const files = msg.files || [];
    const text = msg.text || '';
    const id = msg.id || '';
    const filesHtml = files.length
      ? '<div class="review-files">' + t('审查文件：') + files.map((f) => '<code>' + escapeHtml(f) + '</code>').join('、') + '</div>'
      : '';
    const box = document.createElement('div');
    box.className = 'review-card';
    if (id) box.dataset.reviewId = id;
    box.innerHTML =
      '<div class="review-head">' + t('🔍 代码审查意见（自动）') + '</div>' +
      filesHtml +
      '<div class="review-body">' + miniMarkdown(text) + '</div>' +
      '<div class="review-actions">' +
        '<button class="mini primary" data-act="apply-review">' + t('✅ 按审查意见修正') + '</button>' +
        '<span class="review-status"></span>' +
      '</div>';
    const applyBtn = box.querySelector('[data-act="apply-review"]');
    const statusEl = box.querySelector('.review-status');
    if (applyBtn) {
      applyBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'applyReview', text, id });
        applyBtn.disabled = true;
        applyBtn.textContent = t('修正中…');
        if (statusEl) statusEl.textContent = '';
      });
    }
    messagesEl.appendChild(box);
    scrollDown(true);
  }

  function updateReviewButton(msg) {
    const box = msg.id ? messagesEl.querySelector('.review-card[data-review-id="' + msg.id + '"]') : messagesEl.querySelector('.review-card:last-child');
    if (!box) return;
    const btn = box.querySelector('[data-act="apply-review"]');
    const statusEl = box.querySelector('.review-status');
    if (msg.state === 'queued') {
      if (btn) { btn.disabled = true; btn.textContent = t('排队中'); }
      if (statusEl) statusEl.textContent = msg.text || t('主任务结束后自动应用');
    } else if (msg.state === 'applied') {
      if (btn) { btn.disabled = true; btn.textContent = t('已应用'); }
      if (statusEl) statusEl.textContent = '';
    }
  }

  function addNotice(text) {
    hideWelcome();
    const el = document.createElement('div');
    el.className = 'notice';
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollDown();
  }

  // RAG 直答后，在输入栏上方提示用户可切换智能体模式
  function showRagHint() {
    if (!ragHintEl) return;
    ragHintEl.innerHTML = '';
    const body = document.createElement('span');
    body.className = 'rag-hint-body';
    const sentence = t('〔RAG 直答〕如果这条回答不准确或没解决你的问题，可再次输入「换agent」切换到智能体模式。');
    const kw = '换agent';
    const idx = sentence.indexOf(kw);
    if (idx >= 0) {
      const before = document.createElement('span');
      before.textContent = sentence.slice(0, idx);
      const kwEl = document.createElement('span');
      kwEl.className = 'rag-hint-kw';
      kwEl.textContent = kw;
      kwEl.title = t('点击自动填入并切换到智能体模式');
      kwEl.addEventListener('click', function () {
        inputEl.value = '换agent';
        autoGrow();
        inputEl.focus();
      });
      const after = document.createElement('span');
      after.textContent = sentence.slice(idx + kw.length);
      body.appendChild(before);
      body.appendChild(kwEl);
      body.appendChild(after);
    } else {
      body.textContent = sentence;
    }
    const close = document.createElement('button');
    close.className = 'rag-hint-close';
    close.textContent = '×';
    close.setAttribute('aria-label', t('关闭提示'));
    close.addEventListener('click', hideRagHint);
    ragHintEl.appendChild(body);
    ragHintEl.appendChild(close);
    ragHintEl.classList.remove('hidden');
    scrollDown();
  }

  function hideRagHint() {
    if (ragHintEl) ragHintEl.classList.add('hidden');
  }

  function showError(text) {
    errorText.textContent = text;
    errorBar.classList.remove('hidden');
  }

  /* ================= 交互 ================= */

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
  }

  function send() {
    const text = inputEl.value.trim();
    if ((!text && !attachments.length) || busy) return;
    hideRagHint();
    errorBar.classList.add('hidden');
    // 先把要发送的附件快照下来，再清空本地，避免连续快速操作时残留
    const toSend = attachments.slice();
    attachments = [];
    renderAttachments();
    vscode.postMessage({ type: 'send', text, attachments: toSend });
    inputEl.value = '';
    autoGrow();
  }

  btnSend.addEventListener('click', send);
  btnAttach.addEventListener('click', () => vscode.postMessage({ type: 'addAttachments' }));
  btnPause.addEventListener('click', () => vscode.postMessage({ type: 'pause' }));
  btnResume.addEventListener('click', () => vscode.postMessage({ type: 'resume' }));
  btnStop.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  btnUndo.addEventListener('click', () => vscode.postMessage({ type: 'undo' }));
  btnReadTerminal.addEventListener('click', () => vscode.postMessage({ type: 'readTerminal' }));
  $('btnSettings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
  providerChip.addEventListener('click', () => vscode.postMessage({ type: 'pickProvider' }));
  modelChip.addEventListener('click', () => vscode.postMessage({ type: 'pickModel' }));
  apiModeChip.addEventListener('click', () => vscode.postMessage({ type: 'pickApiMode' }));
  // 深度思考：左键一键开关，右键弹出强度选择（关闭 / low / medium / high）
  if (thinkChip) {
    thinkChip.addEventListener('click', () => vscode.postMessage({ type: 'toggleDeepThinking' }));
    thinkChip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'toggleDeepThinking', pick: true });
    });
  }
  agentChip.addEventListener('click', () => vscode.postMessage({ type: 'toggleAgent' }));
  approveChip.addEventListener('click', () => {
    const i = APPROVE_LEVELS.indexOf(approveLevel);
    const next = APPROVE_LEVELS[(i + 1) % APPROVE_LEVELS.length];
    vscode.postMessage({ type: 'setApprove', value: next });
  });
  $('errorClose').addEventListener('click', () => errorBar.classList.add('hidden'));

  btnPlanTasks.addEventListener('click', () => planPanel.classList.toggle('hidden'));
  $('btnPlanClose').addEventListener('click', () => planPanel.classList.add('hidden'));
  $('btnPlanOpenFile').addEventListener('click', () => vscode.postMessage({ type: 'openPlanTasks' }));
  planList.addEventListener('click', (e) => {
    const delBtn = e.target.closest('.plan-del');
    if (delBtn) {
      e.stopPropagation();
      const item = delBtn.closest('.plan-item');
      if (item) vscode.postMessage({ type: 'planTaskRemove', id: item.dataset.id });
      return;
    }
    const item = e.target.closest('.plan-item');
    if (!item) return;
    vscode.postMessage({ type: 'planTaskToggle', id: item.dataset.id });
  });

  btnContextUsage.addEventListener('click', () => contextPanel.classList.toggle('hidden'));
  $('btnContextClose').addEventListener('click', () => contextPanel.classList.add('hidden'));
  $('btnContextOpenSettings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
  const contextWindowInput = $('contextWindowInput');
  if (contextWindowInput) {
    contextWindowInput.addEventListener('change', () => {
      const v = parseInt(contextWindowInput.value, 10);
      vscode.postMessage({ type: 'setContextWindow', value: isNaN(v) || v <= 0 ? 0 : v });
    });
  }
  btnStorage.addEventListener('click', () => vscode.postMessage({ type: 'manageStorage' }));

  /* ================= /mcp 斜杠补全浮窗 ================= */

  function getSlashQuery() {
    const val = inputEl.value;
    const m = val.match(/^\/mcp\s*/i);
    if (!m) return null;
    return val.slice(m[0].length);
  }

  function closeSlashPopup() {
    slashPopup.classList.add('hidden');
    slashPopup.innerHTML = '';
    slashIndex = -1;
  }

  function applySlashItem(item) {
    // 改为让狐狸 AI 自动调用：插入自然语言请求，用户补全参数后发送即可
    const text = '请使用 mcp__' + item.serverId + '__' + item.toolName + ' 工具：';
    inputEl.value = text;
    autoGrow();
    inputEl.focus();
    // 光标放到末尾，方便用户补全参数
    inputEl.setSelectionRange(text.length, text.length);
    closeSlashPopup();
  }

  function renderSlashPopup(query) {
    const q = (query || '').trim().toLowerCase();
    const filtered = slashCandidates.filter((it) => {
      const hay = (it.serverId + ' ' + it.toolName + ' ' + (it.description || '')).toLowerCase();
      return !q || hay.includes(q);
    });

    const html = [];
    // 根据后端返回的 MCP 策略显示状态横幅
    if (!slashMcpPolicy.enabled) {
      html.push('<div class="slash-banner slash-banner-warn">' + t('MCP 总开关未开启：请打开左侧「🌐 MCP」面板，勾选「启用」') + '</div>');
    } else if (!slashMcpPolicy.autoInject) {
      html.push('<div class="slash-banner slash-banner-warn">' + t('MCP 已启用但未注入模型：请在设置开启 foxAi.mcp.autoInject，否则狐狸 AI 无法自动调用') + '</div>');
    } else {
      html.push('<div class="slash-banner">' + t('MCP 已启用并注入模型，选择工具即可让狐狸 AI 自动调用') + '</div>');
    }

    if (!filtered.length) {
      slashPopup.innerHTML = html.join('') + '<div class="slash-empty">' + t('没有匹配的 MCP 工具') + '</div>';
      slashPopup.classList.remove('hidden');
      slashIndex = -1;
      return;
    }

    html.push('<div class="slash-hint">' + t('↑↓ 选择，Enter 让狐狸 AI 调用，Esc 关闭') + '</div>');
    for (let i = 0; i < filtered.length; i++) {
      const it = filtered[i];
      const kind = it.kind === 'edit' ? 'write' : (it.kind || 'read');
      html.push(
        '<div class="slash-item' + (i === slashIndex ? ' active' : '') + '" data-idx="' + i + '">' +
        '<span class="icon">🔧</span>' +
        '<span class="label">' + escapeHtml(it.serverId + '.' + it.toolName) + '</span>' +
        '<span class="desc">' + escapeHtml(it.description || '') + '</span>' +
        '<span class="kind">' + escapeHtml(kind) + '</span>' +
        '</div>'
      );
    }
    slashPopup.innerHTML = html.join('');
    slashPopup.classList.remove('hidden');

    // 默认选中第一项
    if (slashIndex < 0) slashIndex = 0;
    if (slashIndex >= filtered.length) slashIndex = filtered.length - 1;
    updateSlashActive();
  }

  function updateSlashActive() {
    const items = slashPopup.querySelectorAll('.slash-item');
    items.forEach((el, i) => el.classList.toggle('active', i === slashIndex));
    const active = items[slashIndex];
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function requestMcpCandidates() {
    const myId = ++slashReqId;
    vscode.postMessage({ type: 'requestMcpTools' });
    slashPending = true;
    // 超时保护：500ms 还没返回就先显示等待提示
    slashTimer = setTimeout(() => {
      if (slashPending && slashReqId === myId) {
        slashPopup.innerHTML = '<div class="slash-empty">' + t('正在加载 MCP 工具…') + '</div>';
        slashPopup.classList.remove('hidden');
      }
    }, 80);
  }

  function onSlashInput() {
    const query = getSlashQuery();
    if (query === null) {
      closeSlashPopup();
      return;
    }
    if (!slashCandidates.length && !slashPending) {
      requestMcpCandidates();
    }
    renderSlashPopup(query);
  }

  slashPopup.addEventListener('click', (e) => {
    const item = e.target.closest('.slash-item');
    if (!item) return;
    const idx = Number(item.dataset.idx);
    const filtered = getFilteredSlashItems();
    const it = filtered[idx];
    if (it) applySlashItem(it);
  });

  function getFilteredSlashItems() {
    const query = getSlashQuery();
    const q = ((query === null ? '' : query) || '').trim().toLowerCase();
    return slashCandidates.filter((it) => {
      const hay = (it.serverId + ' ' + it.toolName + ' ' + (it.description || '')).toLowerCase();
      return !q || hay.includes(q);
    });
  }

  inputEl.addEventListener('input', () => {
    autoGrow();
    onSlashInput();
  });
  inputEl.addEventListener('keydown', (e) => {
    const open = !slashPopup.classList.contains('hidden');
    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const list = getFilteredSlashItems();
        slashIndex = (slashIndex + 1) % list.length;
        renderSlashPopup(getSlashQuery());
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const list = getFilteredSlashItems();
        slashIndex = (slashIndex - 1 + list.length) % list.length;
        renderSlashPopup(getSlashQuery());
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSlashPopup();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        const list = getFilteredSlashItems();
        const it = list[slashIndex];
        if (it) {
          e.preventDefault();
          applySlashItem(it);
          return;
        }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  inputEl.addEventListener('blur', () => {
    // 延迟关闭，给 click 事件留出时间
    setTimeout(() => closeSlashPopup(), 180);
  });

  attachmentsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act="remove"]');
    if (!btn) return;
    const id = btn.dataset.id;
    attachments = attachments.filter((a) => a.id !== id);
    renderAttachments();
    vscode.postMessage({ type: 'removeAttachment', id });
  });

  messagesEl.addEventListener('click', (e) => {
    const quick = e.target.closest('.quick-btn');
    if (quick) {
      inputEl.value = quick.dataset.q || '';
      autoGrow();
      send();
      return;
    }

    const approvalBtn = e.target.closest('.approval button');
    if (approvalBtn) {
      const box = approvalBtn.closest('.approval');
      const decision = approvalBtn.dataset.d;
      vscode.postMessage({ type: 'approval', id: box.dataset.id, decision });
      box.innerHTML =
        '<span class="q">' +
        (decision === 'reject' ? t('已拒绝这次操作') : decision === 'always' ? t('已允许，并记住该工具') : t('已允许')) +
        '</span>';
      return;
    }

    const head = e.target.closest('.tool-head');
    if (head) {
      head.parentElement.classList.toggle('open');
      return;
    }

    const toolBtn = e.target.closest('.tool-actions button');
    if (toolBtn) {
      const card = toolBtn.closest('.tool-card');
      const actions = toolBtn.closest('.tool-actions');
      if (toolBtn.dataset.act === 'diff') vscode.postMessage({ type: 'showDiff', id: card.dataset.id });
      else vscode.postMessage({ type: 'openFile', path: actions.dataset.path });
      return;
    }

    const btn = e.target.closest('.code-head button[data-act]');
    if (!btn) return;
    const block = btn.closest('.code-block');
    const code = block ? block.querySelector('code').textContent : '';
    const act = btn.dataset.act;
    if (act === 'copy') vscode.postMessage({ type: 'copy', code });
    else if (act === 'insert') vscode.postMessage({ type: 'insertCode', code });
    else if (act === 'newfile') vscode.postMessage({ type: 'newFile', code });
  });

  /* ================= 状态 ================= */

  const STATE_TEXT = {
    thinking: t('模型思考中…'),
    running: t('执行中…'),
    tool: t('正在调用工具…'),
    pausing: t('将在当前步骤结束后暂停…'),
    paused: t('已暂停，点「继续」接着干'),
    'awaiting-approval': t('等待你确认操作…'),
    cancelled: t('已取消')
  };

  function applyStatus(msg) {
    if (msg.provider) $('providerName').textContent = msg.provider;
    if (msg.model) $('modelName').textContent = msg.model;
    if (msg.apiMode) apiModeChip.textContent = t(msg.apiMode === 'responses' ? '协议: Responses' : '协议: Chat');

    if (thinkChip && msg.deepThinking !== undefined) {
      const on = !!msg.deepThinking;
      const eff = msg.thinkEffort || 'medium';
      thinkChip.textContent = on ? '🧠 ' + t('思考') + ': ' + eff : '🧠 ' + t('思考') + ': ' + t('关');
      thinkChip.classList.toggle('on', on);
      thinkChip.classList.toggle('off', !on);
      thinkChip.title = on
        ? t('深度思考已开启（强度 {0}）：模型先推理再作答。左键关闭，右键改强度', eff)
        : t('深度思考已关闭：模型直接作答。左键开启，右键选强度');
    }

    agentChip.textContent = msg.agent ? t('智能体') : t('纯问答');
    agentChip.classList.toggle('on', !!msg.agent);
    agentChip.classList.toggle('off', !msg.agent);

    if (msg.approve) {
      approveLevel = msg.approve;
      approveChip.textContent = t(APPROVE_LABEL[msg.approve] || msg.approve);
    }

    const state = msg.state || 'idle';
    busy = state !== 'idle' && state !== 'cancelled';
    providerChip.classList.toggle('busy', busy);
    runBar.classList.toggle('hidden', !busy);
    runBar.classList.toggle('paused', state === 'paused');
    runText.textContent = STATE_TEXT[state] || t('运行中…');
    btnPause.classList.toggle('hidden', state === 'paused' || state === 'pausing');
    btnResume.classList.toggle('hidden', state !== 'paused');
    btnSend.textContent = busy ? t('运行中…') : t('发送');
    btnSend.disabled = busy;
    btnAttach.disabled = busy;
    btnReadTerminal.disabled = busy;
    if (typeof msg.undoCount === 'number') {
      btnUndo.classList.toggle('hidden', msg.undoCount === 0);
      btnUndo.textContent = t('↩ 撤销改动 ({0})', msg.undoCount);
    }
    if (typeof msg.redoCount === 'number') {
      btnRedo.classList.toggle('hidden', msg.redoCount === 0);
      btnRedo.textContent = t('↪ 重做 ({0})', msg.redoCount);
    }
  }

  function handle(msg) {
    try {
      switch (msg.type) {
        case 'status':
          applyStatus(msg);
          break;
        case 'user': {
          const { bubble } = addMessage('user', msg.id);
          bubble.textContent = msg.text || '';
          if (msg.attachments && msg.attachments.length) {
            const att = document.createElement('div');
            att.className = 'user-attachments';
            att.innerHTML = msg.attachments.map((a) =>
              '<span class="att-chip">' + (a.isImage ? '🖼 ' : '📄 ') + escapeHtml(a.name) + '</span>'
            ).join('');
            bubble.appendChild(att);
          }
          scrollDown(true);
          break;
        }
        case 'assistantStart': {
          const { bubble } = addMessage('assistant', msg.id);
          live[msg.id] = { raw: '', reasoning: '', bubble, reasonEl: null, dirty: true };
          scheduleRender();
          break;
        }
        case 'delta': {
          const m = live[msg.id];
          if (!m) break;
          m.raw += msg.text;
          m.dirty = true;
          scheduleRender();
          break;
        }
        case 'reasoning': {
          const m = live[msg.id];
          if (!m) break;
          m.reasoning += msg.text;
          m.dirty = true;
          scheduleRender();
          break;
        }
        case 'image': {
          let m = live[msg.id];
          if (!m) {
            const { bubble } = addMessage('assistant', msg.id);
            m = { raw: '', reasoning: '', bubble, reasonEl: null, dirty: true, images: [] };
            live[msg.id] = m;
          }
          if (!m.images) m.images = [];
          m.images.push({ src: msg.src, alt: msg.alt || '模型生成图片' });
          m.dirty = true;
          scheduleRender();
          scrollDown(true);
          break;
        }
        case 'assistant': {
          const { bubble } = addMessage('assistant', msg.id);
          bubble.innerHTML = renderMarkdown(msg.text || '');
          scrollDown(true);
          break;
        }
        case 'assistantEnd': {
          const m = live[msg.id];
          if (m) {
            m.dirty = true;
            scheduleRender();
            if (m.reasonEl) m.reasonEl.classList.remove('open');
            if (!m.raw && !m.reasoning && m.bubble.parentElement) m.bubble.parentElement.remove();
            setTimeout(() => { delete live[msg.id]; }, 60);
          }
          break;
        }
        case 'finalText':
          // 文本已由 delta 实时显示，这里仅作兜底占位
          break;
        case 'attachments':
          attachments = msg.items || [];
          renderAttachments();
          break;
        case 'tool':
          addToolCard(msg);
          break;
        case 'step':
          addStep(msg);
          break;
        case 'toolStream':
          appendToolStream(msg);
          break;
        case 'toolUpdate':
          updateToolCard(msg);
          break;
        case 'approval':
          addApproval(msg);
          break;
        case 'notice':
          addNotice(msg.text);
          break;
        case 'ragHint':
          showRagHint();
          break;
        case 'error':
          showError(msg.text || '出错了');
          break;
        case 'clear':
          messagesEl.innerHTML = '';
          hideRagHint();
          for (const k of Object.keys(live)) delete live[k];
          for (const k of Object.keys(toolCards)) delete toolCards[k];
          for (const k of Object.keys(stepItems)) delete stepItems[k];
          attachments = [];
          renderAttachments();
          break;
        case 'prefill':
          inputEl.value = msg.text || '';
          autoGrow();
          inputEl.focus();
          break;
        case 'restore':
          messagesEl.innerHTML = '';
          for (const item of msg.items || []) handle(item);
          scrollDown(true);
          break;
        case 'planTasks':
          renderPlanTasks(msg.items);
          break;
        case 'planPending':
          addPlanPending(msg);
          break;
        case 'plan':
          addPlan(msg);
          break;
        case 'review':
          addReview(msg);
          break;
        case 'reviewApplied':
          updateReviewButton(msg);
          break;
        case 'contextUsage':
          renderContextUsage(msg);
          break;
        case 'mcpTools': {
          slashPending = false;
          if (slashTimer) { clearTimeout(slashTimer); slashTimer = null; }
          slashCandidates = Array.isArray(msg.tools) ? msg.tools : [];
          slashMcpPolicy = msg.policy || { enabled: false, autoInject: false };
          if (msg.error) {
            slashPopup.innerHTML = '<div class="slash-empty">' + escapeHtml(String(msg.error)) + '</div>';
            slashPopup.classList.remove('hidden');
            slashIndex = -1;
          } else {
            onSlashInput();
          }
          break;
        }
        default:
          break;
      }
    } catch (e) {
      console.error('[fox-ai] webview render error', e);
    }
  }

  function applyStaticI18n() {
    document.documentElement.lang = window.__FOX_LOCALE__ || 'zh-cn';
    document.title = t('狐狸 AI');
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
  }
  applyStaticI18n();

  window.addEventListener('message', (e) => handle(e.data || {}));
  vscode.postMessage({ type: 'ready' });
})();
