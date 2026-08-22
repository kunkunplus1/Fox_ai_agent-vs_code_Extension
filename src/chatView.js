'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const config = require('./config');
const router = require('./router');
const { AgentSession } = require('./agent');
const i18n = require('./i18n');
const harness = require('./harness');
const ws = require('./tools/workspace');
const terminal = require('./tools/terminal');
const undo = require('./undo');
const { SessionManager } = require('./sessions');
const { PlanTaskStore } = require('./planTasks');
const caps = require('./capabilities');
const storageMgr = require('./storageManager');
const mcp = require('./tools/mcp');
const DisposableBag = require('./disposableBag');

const outputChannel = vscode.window.createOutputChannel('狐狸 AI');
let logLineCount = 0;
const LOG_LINE_LIMIT = 800;
function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  logLineCount++;
  // 输出通道不会自动清理，长会话中日志无限增长会占 VS Code 主进程内存
  if (logLineCount >= LOG_LINE_LIMIT) {
    outputChannel.clear();
    logLineCount = 0;
    outputChannel.appendLine('[fox-ai] 日志已达上限，已清理');
  }
}

// 会话 transcript 压缩：按「轮次」保留，保证每轮都有一个 user 锚点，
// 避免长会话里一条超长回答的 delta 把开头的 user/assistantStart 挤出窗口，
// 导致重载 / 删除其他会话后 restore 重放时 delta 找不到气泡而被静默丢弃（对话栏变空）。
const TRANSCRIPT_HARD_LIMIT = 800; // 总条数硬上限，防止无限增长
const TRANSCRIPT_TURN_LIMIT = 50; // 至少保留最近 N 轮（每轮以一个 user 消息起头）
function compactTranscript(list) {
  if (!Array.isArray(list) || list.length === 0) return list;
  let out = list;
  if (out.length > TRANSCRIPT_HARD_LIMIT) {
    out = out.slice(out.length - TRANSCRIPT_HARD_LIMIT);
  }
  // user 消息是每轮对话的锚点，按它定位轮起点
  const starts = [];
  out.forEach((m, i) => { if (m && m.type === 'user') starts.push(i); });
  if (starts.length > TRANSCRIPT_TURN_LIMIT) {
    out = out.slice(starts[starts.length - TRANSCRIPT_TURN_LIMIT]);
  }
  return out;
}

function nonceStr() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

function summarizeArgs(name, args) {
  if (!args || typeof args !== 'object') return '';
  const clone = {};
  for (const k of Object.keys(args)) {
    let v = args[k];
    if (typeof v === 'string' && v.length > 300) v = v.slice(0, 300) + `…（共 ${v.length} 字）`;
    clone[k] = v;
  }
  if (name === 'run_command') return String(args.command || '');
  try {
    return JSON.stringify(clone, null, 2);
  } catch (_) {
    return String(args);
  }
}

function isEmptyMessageContent(content) {
  if (!content) return true;
  if (typeof content === 'string') return !content.trim();
  if (Array.isArray(content)) {
    return content.every((c) => {
      if (c.type === 'text') return !String(c.text || '').trim();
      return false;
    });
  }
  return false;
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  }
  return '';
}

class ChatViewProvider {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    // Harness：任务状态机（长期记忆，持久化到文件，避免 globalState 容量限制）
    const taskDir = context.globalStorageUri.fsPath;
    this.taskManager = new harness.TaskManager({ dir: taskDir });
    this.view = null;
    /** 主侧边栏 webview 的监听器收集袋；dispose 时一并释放，避免主进程累加 EventListener */
    this._disposables = new DisposableBag();
    /** 对话历史（OpenAI 消息格式，含 tool 消息） */
    this.messages = [];
    /** @type {AgentSession|null} */
    this.session = null;
    this.seq = 0;
    this.bubbleId = null;
    this.alwaysAllow = new Set();
    /** @type {Map<string, Function>} */
    this.approvalResolvers = new Map();
    /** @type {Map<string, {path:string, before:string, after:string}>} */
    this.previews = new Map();
    this.transcript = []; // 供面板重新可见时恢复
    this.attachments = []; // 当前输入框待发送的附件
    /** 上一轮“真实”用户输入（非切换指令），用于「换agent」时复述原问题重交智能体 */
    this._lastUserTurn = null;
    /** 主任务尚未 idle 时收到的审查卡片，暂存到 session 结束后再弹出 */
    this._pendingReviewCard = null;
    /** 用户点击「按审查意见修正」时若 session 正忙，把 prompt 暂存到 idle 后自动执行 */
    this._pendingApplyReview = null;
    /** 规划待确认时保留的 session 引用（此时主任务未真正结束） */
    this._planPendingSession = null;
    this.sessionManager = new SessionManager(context);
    this._sessionChangeListener = null;
    /** 项目任务清单 */
    this.planTasks = new PlanTaskStore(context.globalStorageUri.fsPath, {
      context,
      customDir: vscode.workspace.getConfiguration('foxAi').get('planTasks.storagePath', ''),
      onChange: () => {
        this._pushPlanTasks();
        // 同步刷新「环境与插件」面板的「任务」标签页——任务管理器现在合并 taskManager + planTasks 两个数据源，
        // planTasks 变化时（用户/模型新建/标记任务）必须让任务列表实时反映，否则面板卡在「（没有任务）」。
        try { const { notifyTaskListChanged } = require('./envView'); notifyTaskListChanged(this); } catch (_) {}
      }
    });
    /** 额外的可移动对话面板（WebviewPanel） */
    this.panels = new Set();
    /** 独立工作链页面 webview 集合，由 workchainView.js 注册/注销 */
    this._workchainWebviews = new Set();
    /** 上次上下文用量数据，关闭插件后再打开可恢复显示 */
    this.lastContextUsage = context.globalState.get('lastContextUsage') || null;

    // 面板模式不会触发 resolveWebviewView，需要主动确保有会话
    this._ensureSession();

    // VS Code 即将保存状态 / 扩展被停用时，同步把当前会话存盘
    // 旧版本 VS Code 没有 onWillSaveState，先判断存在再加订阅
    if (typeof vscode.workspace.onWillSaveState === 'function') {
      context.subscriptions.push(
        vscode.workspace.onWillSaveState((e) => {
          if (e && typeof e.waitUntil === 'function') {
            e.waitUntil(Promise.resolve(this._saveCurrentSession()));
          } else {
            this._saveCurrentSession();
          }
        })
      );
    }
  }

  /**
   * 释放本 provider 持有的全部资源（扩展停用、或面板彻底关闭时调用）。
   * 重点：清理侧边栏 webview 监听器袋，避免主进程 EventListener 残留。
   * 可移动面板的监听器由各面板自己的 bag 在 onDidDispose 里释放，这里兜底再清一遍。
   */
  dispose() {
    try { if (this._disposables) this._disposables.dispose(); } catch (_) {}
    for (const panel of Array.from(this.panels || [])) {
      try { if (panel && panel._bag) panel._bag.dispose(); } catch (_) {}
    }
    this.view = null;
    this.panels = new Set();
  }

  _pushPlanTasks() {
    this.post({ type: 'planTasks', items: this.planTasks.list() });
  }

  /**
   * 确保有当前会话；没有就新建一个（不抢焦点）。
   *
   * 关键修复：`_restoreCurrentSession()` 只在 `resolveWebviewView` 里被调用，
   * 也就是**只有侧边栏视图被展开过**才会把存档读进内存。如果用户习惯用编辑器区域的
   * 可移动面板对话，reload 之后侧边栏没展开 → 存档从未载入 → `this.transcript` 是空数组
   * → `_syncTo()` / `ready` 分支的 `if (this.transcript.length)` 全部落空 → 面板一片空白，
   * 表现就是「重载窗口不显示之前的对话内容」。这里补上内存态的兜底载入。
   */
  _ensureSession() {
    if (!this.sessionManager.currentId()) {
      this.newChat(false);
      return;
    }
    // 已有当前会话但内存里还是空的（面板模式 / 侧边栏没展开过）→ 从存档补载
    if (!this.transcript.length && !this.messages.length) {
      try {
        const current = this.sessionManager.current();
        if (current && ((current.transcript && current.transcript.length) || (current.messages && current.messages.length))) {
          this._applySession(current);
        }
      } catch (e) {
        log('ensureSession restore failed:', (e && e.message) || String(e));
      }
    }
  }

  /** @param {vscode.WebviewView} webviewView */
  resolveWebviewView(webviewView) {
    this.view = webviewView;
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    webview.html = this.render(webview);

    this._disposables.add(webview.onDidReceiveMessage(async (msg) => {
      try {
        await this.onMessage(msg || {});
      } catch (e) {
        log('onMessage error:', e && e.stack);
        this.post({ type: 'error', text: (e && e.message) || String(e) });
      }
    }));

    this._disposables.add(webviewView.onDidDispose(() => {
      this.stop();
      // 释放侧边栏 webview 相关监听器，避免反复开关累加 EventListener
      if (this._disposables) this._disposables.dispose();
      this.view = null;
    }));

    // 加载当前会话
    this._restoreCurrentSession();
  }

  async _restoreCurrentSession() {
    const current = this.sessionManager.current();
    if (current) {
      this._applySession(current);
    } else {
      // 没有会话就创建一个
      this.newChat(false);
    }
  }

  _applySession(session) {
    this.messages = session.messages || [];
    this.transcript = resolveTranscriptImages(session.transcript || []);
    // 存档时剥掉了 base64，切回会话时按原路径补读回来（文件还在就还能继续发）
    this.attachments = (session.attachments || [])
      .map((a) => {
        if (a.base64 || !a.path || !fs.existsSync(a.path)) return a;
        try {
          const buf = fs.readFileSync(a.path);
          return Object.assign({}, a, { base64: buf.toString('base64'), size: buf.length });
        } catch (_) {
          return a;
        }
      })
      .filter((a) => a.base64);
    // 恢复时不要把 seq 归零，否则新消息 ID（u1/a1...）会和 transcript 里重放的历史消息 ID 重复，
    // 前端 live[] 可能指向错误的泡泡，导致「本次内容写进上次回答」。
    let maxSeq = 0;
    for (const t of (session.transcript || [])) {
      if (t && t.id) {
        const m = String(t.id).match(/^[a-z]+(\d+)$/);
        if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
      }
    }
    this.seq = maxSeq;
    this.bubbleId = null;
    this.previews.clear();
    this.alwaysAllow.clear();
    this.post({ type: 'clear' });
    if (this.transcript.length) this.post({ type: 'restore', items: this.transcript });
    if (this.attachments.length) this.post({ type: 'attachments', items: this.attachments });
    // 恢复规划状态（新会话存档无此字段 → 自动重置为 null/false，避免脏状态跨会话残留）
    this._planTaskId = session._planTaskId || null;
    this._planned = !!session._planned;
    this._planPending = !!session._planPending;
    this.pushStatus('idle');
  }

  async onMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this.pushStatus();
        if (this.transcript.length) this.post({ type: 'restore', items: this.transcript });
        if (this.attachments.length) this.post({ type: 'attachments', items: this.attachments });
        if (this.lastContextUsage) this.post({ type: 'contextUsage', ...this.lastContextUsage });
        this._pushPlanTasks();
        break;
      case 'send':
        await this.ask(msg.text, { attachments: msg.attachments });
        break;
      case 'pause':
        if (this.session) this.session.pause();
        break;
      case 'resume':
        if (this.session) this.session.resume();
        break;
      case 'stop':
        this.stop();
        break;
      case 'clear':
        this.newChat();
        break;
      case 'approval': {
        const cb = this.approvalResolvers.get(msg.id);
        if (cb) {
          this.approvalResolvers.delete(msg.id);
          cb(msg.decision);
        }
        break;
      }
      case 'showDiff': {
        const p = this.previews.get(msg.id);
        if (p) {
          if (this.fileNav) this.fileNav.addFile(p.path, { op: 'diff' });
          await ws.showDiff(p.path, p.before, p.after, `${p.path}（狐狸 AI 的改动预览）`);
        }
        break;
      }
      case 'openFile':
        if (msg.path) {
          if (this.fileNav) this.fileNav.addFile(msg.path, { op: '打开' });
          try {
            await ws.openFile({ path: msg.path, line: msg.line });
          } catch (e) {
            vscode.window.showWarningMessage(i18n.tw('打不开文件：{0}', e.message));
          }
        }
        break;
      case 'undo':
        await undo.undoLast();
        this.pushStatus();
        break;
      case 'redo':
        await undo.redoLast();
        this.pushStatus();
        break;
      case 'insertCode':
        await insertIntoEditor(msg.code);
        break;
      case 'openExternal': {
        // 引用角标 / 正文外链：只放行 http(s)，用系统默认浏览器打开
        const raw = String(msg.url || '').trim();
        if (!/^https?:\/\//i.test(raw)) break;
        try {
          await vscode.env.openExternal(vscode.Uri.parse(raw));
        } catch (e) {
          vscode.window.showWarningMessage(i18n.tw('打不开链接：{0}', e && e.message ? e.message : String(e)));
        }
        break;
      }
      case 'openLocal': {
        // 本地知识库来源角标：在系统文件资源管理器中定位该文件
        const raw = String(msg.path || '').trim();
        if (!raw) break;
        const uri = vscode.Uri.file(raw);
        let exists = false;
        try {
          await vscode.workspace.fs.stat(uri);
          exists = true;
        } catch (_) {
          exists = false;
        }
        log('openLocal', raw, 'exists=', exists);
        if (!exists) {
          vscode.window.showWarningMessage(i18n.tw('文件不存在：{0}', raw));
          break;
        }
        // 优先用 revealFileInOS：直接打开系统资源管理器并选中文件，对任意路径（含工作区外）都有效。
        // revealInExplorer 仅在 VS Code 侧边栏资源管理器里定位“工作区内”的文件；KB 文件位于 ~/.fox-ai/ 等工作区外，
        // 对它静默无反应（不报错也不弹窗），所以不能作为首选。
        try {
          await vscode.commands.executeCommand('revealFileInOS', uri);
        } catch (e) {
          log('revealFileInOS failed, fallback to revealInExplorer', e && e.message ? e.message : String(e));
          try {
            await vscode.commands.executeCommand('revealInExplorer', uri);
          } catch (e2) {
            vscode.window.showWarningMessage(i18n.tw('无法定位文件：{0}', e2 && e2.message ? e2.message : String(e2)));
          }
        }
        break;
      }
      case 'copy':
        await vscode.env.clipboard.writeText(msg.code || '');
        vscode.window.setStatusBarMessage(i18n.tw('$(check) 已复制'), 1500);
        break;
      case 'saveImage': {
        if (msg.src) await this._saveGeneratedImage(msg.src, msg.name);
        break;
      }
      case 'applyReview': {
        if (!msg.text) break;
        const prompt = '【代码审查意见】\n' + msg.text + '\n\n请检查本次改动是否需要修正；若需要，请直接执行修正并给出最终回答。';
        // 若主任务还在跑（含 plan-pending 暂停），先把审查修正请求排队；等 session 真正 idle 后自动执行。
        if (this.session || this._planPendingSession) {
          this._pendingApplyReview = { text: prompt, showText: i18n.tw('按审查意见修正'), id: msg.id };
          this.post({ type: 'reviewApplied', id: msg.id, state: 'queued', text: i18n.tw('主任务尚未结束，已排队，结束后将自动应用审查意见。') });
          break;
        }
        await this.ask(prompt, { showText: i18n.tw('按审查意见修正') });
        this.post({ type: 'reviewApplied', id: msg.id, state: 'applied' });
        break;
      }
      case 'newFile': {
        const doc = await vscode.workspace.openTextDocument({ content: msg.code || '', language: msg.lang || 'plaintext' });
        await vscode.window.showTextDocument(doc, { preview: false });
        break;
      }
      case 'pickProvider':
        vscode.commands.executeCommand('foxAi.selectProvider');
        break;
      case 'pickModel':
        vscode.commands.executeCommand('foxAi.selectModel');
        break;
      case 'pickApiMode': {
        const cur = config.conf().get('apiMode', 'chat');
        const pid = config.currentProviderId();
        const meta = config.providerMeta(pid);
        if (meta && meta.transport === 'anthropic') {
          vscode.window.showInformationMessage(
            '当前服务商「' + (meta.label || pid) + '」走原生 Messages API，仅支持 Chat 模式，无需切换 Responses。'
          );
          this.pushStatus();
          break;
        }
        const pick = await vscode.window.showQuickPick(
          [
            { label: 'Chat（默认）', description: 'OpenAI 兼容 /chat/completions，所有服务商通用', value: 'chat' },
            { label: 'Responses', description: 'OpenAI Responses API /v1/responses，原生函数调用与推理增量（需服务商支持）', value: 'responses' }
          ],
          { title: '选择 API 协议', placeHolder: '当前：' + (cur === 'responses' ? 'Responses' : 'Chat') }
        );
        if (pick && pick.value !== cur) {
          await config.conf().update('apiMode', pick.value, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(i18n.tw('狐狸 AI 已切换为 {0}（下一轮对话生效）', pick.value === 'responses' ? 'Responses API' : 'Chat 协议'));
        }
        this.pushStatus();
        break;
      }
      case 'toggleAgent': {
        const cfg = config.conf();
        const now = cfg.get('agent.enabled', true);
        await cfg.update('agent.enabled', !now, vscode.ConfigurationTarget.Global);
        this.pushStatus();
        break;
      }
      // 深度思考：芯片单击 = 开关；右键/长按（前端发 pick:true）= 选强度
      case 'toggleDeepThinking': {
        const c = config.conf();
        const now = c.get('deepThinking.enabled', false);
        const effort = c.get('deepThinking.effort', 'medium');

        if (msg && msg.pick) {
          const pick = await vscode.window.showQuickPick(
            [
              { label: '关闭深度思考', description: '模型直接作答，最快最省 token', value: 'off' },
              { label: 'low · 浅思考', description: '少量推理，速度优先', value: 'low' },
              { label: 'medium · 均衡（推荐）', description: '默认强度，兼顾质量与速度', value: 'medium' },
              { label: 'high · 深思考', description: '充分推理，慢且更贵，适合难题', value: 'high' }
            ],
            { title: '深度思考模式', placeHolder: '当前：' + (now ? effort : '关闭') }
          );
          if (!pick) { this.pushStatus(); break; }
          if (pick.value === 'off') {
            await c.update('deepThinking.enabled', false, vscode.ConfigurationTarget.Global);
          } else {
            await c.update('deepThinking.effort', pick.value, vscode.ConfigurationTarget.Global);
            await c.update('deepThinking.enabled', true, vscode.ConfigurationTarget.Global);
          }
        } else {
          await c.update('deepThinking.enabled', !now, vscode.ConfigurationTarget.Global);
        }

        // 让改动对「正在跑的会话」也即时生效
        const nowOn = config.conf().get('deepThinking.enabled', false);
        const nowEffort = config.conf().get('deepThinking.effort', 'medium');
        if (this.session && this.session.cfg) {
          this.session.cfg.deepThinking = Object.assign({}, this.session.cfg.deepThinking, {
            enabled: nowOn,
            effort: nowEffort
          });
        }
        this.pushStatus();
        this.post({
          type: 'notice',
          text: nowOn
            ? '已开启深度思考（' + nowEffort + '）：模型会先推理再作答，耗时与 token 都会增加。'
            : '已关闭深度思考：模型直接作答。'
        });
        break;
      }
      case 'setApprove': {
        await config.conf().update('agent.autoApprove', msg.value, vscode.ConfigurationTarget.Global);
        this.pushStatus();
        break;
      }
      case 'openSettings':
        vscode.commands.executeCommand('workbench.action.openSettings', 'foxAi');
        break;
      case 'setContextWindow': {
        // 即时保存上下文窗口上限，使占比显示与自动压缩（知识库-2）可用
        const cfg = vscode.workspace.getConfiguration('foxAi');
        await cfg.update('contextWindow', Number(msg.value) || 0, vscode.ConfigurationTarget.Global);
        break;
      }
      case 'addAttachments':
        await this.addAttachments();
        break;
      case 'readTerminal':
        await this.readTerminalAndAsk();
        break;
      case 'planTaskToggle':
        if (msg.id) {
          this.planTasks.nextStatus(msg.id);
        }
        break;
      case 'planTaskRemove':
        if (msg.id) {
          const item = this.planTasks.list().find((x) => x.id === msg.id);
          const label = item ? item.subject : '这条任务';
          const ok = await vscode.window.showWarningMessage(i18n.tw('确定删除任务「{0}」吗？', label), { modal: true }, '删除');
          if (ok === '删除') {
            this.planTasks.remove(msg.id);
            this.post({ type: 'planTasks', items: this.planTasks.list() });
            vscode.window.showInformationMessage(i18n.tw('已删除任务：{0}', label));
          }
        }
        break;
      case 'planTaskClearCompleted': {
        const items = this.planTasks.list();
        const completed = items.filter((x) => x.status === 'completed');
        if (!completed.length) {
          vscode.window.showInformationMessage(i18n.tw('没有已完成的任务可清理'));
          // 即使没有清理，也发一次列表刷新，让前端按钮恢复可用状态
          this.post({ type: 'planTasks', items: this.planTasks.list() });
          break;
        }
        const ok = await vscode.window.showWarningMessage(
          i18n.tw('确定清理 {0} 条已完成的任务吗？此操作不可恢复。', completed.length),
          { modal: true },
          i18n.tw('清理')
        );
        if (ok === i18n.tw('清理')) {
          const removed = this.planTasks.clearCompleted();
          this.post({ type: 'planTasks', items: this.planTasks.list() });
          if (removed) {
            vscode.window.showInformationMessage(i18n.tw('已清理 {0} 条完成任务', removed));
          }
        } else {
          // 用户点取消/关闭弹窗，也需要恢复前端按钮状态
          this.post({ type: 'planTasks', items: this.planTasks.list() });
        }
        break;
      }
      case 'planApprove': {
        const session = this._planPendingSession;
        if (!session) break;
        this._planPendingSession = null;
        this.session = session;
        this.pushStatus('running');
        try {
          const r = await session.approvePlan();
          if (r && r.reason === 'plan-pending') {
            // 执行中又修订了计划：再次进入待确认
            this._planPendingSession = session;
            this.session = null;
            this.pushStatus('idle');
            break;
          }
        } catch (err) {
          this.endBubble();
          const msg = (err && err.message) || String(err);
          this.post({ type: 'error', text: msg });
          vscode.window.showErrorMessage(i18n.tw('狐狸 AI 请求失败：{0}', msg));
        } finally {
          if (!this._planPendingSession) {
            this.session = null;
            this._saveCurrentSession();
            this.pushStatus('idle');
          }
        }
        break;
      }
      case 'openPlanTasks': {
        const file = require('./planTasks').defaultPath(this.context.globalStorageUri.fsPath);
        try {
          const dir = path.dirname(file);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ version: 1, items: [] }, null, 2), 'utf8');
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (e) {
          vscode.window.showErrorMessage(i18n.tw('打开任务清单失败：{0}', e.message));
        }
        break;
      }
      case 'manageStorage': {
        try {
          await storageMgr.manageStorage(this.context);
        } catch (e) {
          log('manageStorage error:', e && e.stack);
          vscode.window.showErrorMessage(i18n.tw('管理存储位置失败：{0}', (e && e.message) || String(e)));
        }
        break;
      }
      case 'removeAttachment':
        this.attachments = this.attachments.filter((a) => a.id !== msg.id);
        this.post({ type: 'attachments', items: this.attachments });
        this._saveCurrentSession();
        break;
      case 'requestMcpTools': {
        try {
          await mcp.refreshMcpTools();
          const policy = mcp.getPolicy();
          const tools = mcp.getCachedTools().map((t) => ({
            serverId: t.connectorId,
            toolName: t.remoteName,
            description: t.description || '',
            kind: t.kind || 'read'
          }));
          this.post({ type: 'mcpTools', tools, policy });
        } catch (e) {
          this.post({ type: 'mcpTools', tools: [], error: '加载 MCP 工具失败：' + ((e && e.message) || String(e)) });
        }
        break;
      }
      default:
        break;
    }
  }

  render(webview) {
    return this._renderFor(webview);
  }

  addWorkchainWebview(webview) {
    if (webview) this._workchainWebviews.add(webview);
  }

  removeWorkchainWebview(webview) {
    if (webview) this._workchainWebviews.delete(webview);
  }

  post(msg) {
    const targets = [];
    if (this.view) targets.push(this.view.webview);
    for (const panel of this.panels) {
      if (panel && panel.webview) targets.push(panel.webview);
    }
    for (const wv of this._workchainWebviews) {
      if (wv) targets.push(wv);
    }
    for (const webview of targets) {
      try {
        const p = webview.postMessage(msg);
        if (p && typeof p.then === 'function') p.then(() => {}, () => {});
      } catch (_) {}
    }
    // 落盘白名单：assistant（RAG 直答的一次性回答）与 reasoning（全量思考）都要落盘，否则重载/切换会话后
    // 这些内容会丢失（回答气泡消失、思考折叠区变空）。reasoning 的 stream:true 增量不落盘，避免 transcript 膨胀；
    // 轮末全量 reasoning（无 stream 标记）才落盘，供恢复「已思考」内容。
    const PERSIST = ['user', 'assistantStart', 'delta', 'assistantEnd', 'image', 'tool', 'toolUpdate', 'step', 'notice', 'error', 'assistant'];
    if (msg && (PERSIST.includes(msg.type) || (msg.type === 'reasoning' && !msg.stream))) {
      this.transcript.push(msg);
      // 按轮次压缩，保留每轮锚点（详见 compactTranscript），避免长会话丢锚点导致恢复后对话栏为空
      this.transcript = compactTranscript(this.transcript);
    }
  }

  pushStatus(state) {
    const id = config.currentProviderId();
    const cfg = config.conf();
    const model = config.modelName(id);
    // executeCommand 返回 thenable，不接住 rejection 会变成 VS Code 的「出现未知错误」
    Promise.resolve(vscode.commands.executeCommand('setContext', 'foxAi.running', !!this.session)).then(
      () => {},
      () => {}
    );
    this.post({
      type: 'status',
      provider: config.providerMeta(id).label,
      model,
      apiMode: cfg.get('apiMode', 'chat'),
      deepThinking: cfg.get('deepThinking.enabled', false),
      thinkEffort: cfg.get('deepThinking.effort', 'medium'),
      vision: caps.supportsVision(model, cfg.get('visionMode', 'auto'), config.visionLists()),
      agent: cfg.get('agent.enabled', true),
      approve: cfg.get('agent.autoApprove', 'read'),
      state: state || (this.session ? 'running' : 'idle'),
      undoCount: undo.size(),
      redoCount: undo.redoSize(),
      sessionTitle: (this.sessionManager.current() || {}).title || '新会话'
    });
    const finalState = state || (this.session ? 'running' : 'idle');
    if (finalState === 'idle' && this._lastThinkingId) {
      this.post({ type: 'step', id: this._lastThinkingId, status: 'ok' });
      this._lastThinkingId = null;
    }
  }

  async show() {
    // 优先在可移动的编辑器标签页中打开 / 激活，而不是侧边栏
    const existing = Array.from(this.panels).find((p) => p && !p._disposed);
    if (existing) {
      existing.reveal(vscode.ViewColumn.Active, true);
    } else {
      this.openInPanel();
    }
  }

  /**
   * 在可自由拖动的编辑器标签页中打开对话窗口。
   * 该面板与侧边栏共享同一份会话状态，可拖到任意视图组、独立浮动。
   */
  openInPanel() {
    this._ensureSession();
    const existing = Array.from(this.panels).find((p) => p && !p._disposed);
    if (existing) { existing.reveal(vscode.ViewColumn.Active); return; }

    const panel = vscode.window.createWebviewPanel(
      'foxAi.chatPanel',
      '狐狸 AI 对话',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
      }
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'fox.svg'),
      dark: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'fox.svg')
    };
    // 限制可移动面板数量上限，避免同时开太多会话导致内存暴涨
    const MAX_PANELS = 3;
    while (this.panels.size >= MAX_PANELS) {
      const oldest = this.panels.values().next().value;
      if (!oldest) break;
      try {
        this.panels.delete(oldest); // 先移出集合，使 size 即时下降，避免 dispose 异步前再次进入循环
        oldest.dispose();
      } catch (_) {}
    }
    this.panels.add(panel);

    panel.webview.html = this._renderFor(panel.webview);
    this._syncTo(panel.webview);

    // 每个可移动面板自带一个 disposable 袋，dispose 时彻底释放其监听器
    const bag = new DisposableBag();
    panel._bag = bag;
    bag.add(panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        await this.onMessage(msg || {});
      } catch (e) {
        log('panel onMessage error:', e && e.stack);
        this.post({ type: 'error', text: (e && e.message) || String(e) });
      }
    }));

    bag.add(panel.onDidDispose(() => {
      panel._disposed = true;
      // 释放面板监听器，避免反复开关累加 EventListener
      bag.dispose();
      panel._bag = null;
      this.panels.delete(panel);
    }));
  }

  _renderFor(webview) {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const htmlPath = path.join(this.context.extensionPath, 'media', 'chat.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const nonce = nonceStr();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chat.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chat.js'));
    const i18nUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'i18n.js'));
    // 数学公式渲染：本地 vendor 的 KaTeX（离线可用），在 chat.js 之前加载，保证 window.katex 可用
    const katexCssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'vendor', 'katex', 'katex.min.css'));
    const katexJsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'vendor', 'katex', 'katex.min.js'));
    const katexHead = '<link rel="stylesheet" nonce="' + nonce + '" href="' + katexCssUri.toString() + '" />';
    const katexScript = '<script nonce="' + nonce + '" src="' + katexJsUri.toString() + '"></script>';
    // 跟随系统语言：仅非中文环境注入「中文 -> 英文」映射；中文环境不注入，直接展示原文（零回退风险）
    const locale = i18n.currentLocale();
    const isZh = locale.toLowerCase().indexOf('zh') === 0;
    let i18nMap = {};
    if (!isZh) {
      try {
        i18nMap = JSON.parse(fs.readFileSync(path.join(this.context.extensionPath, 'l10n', 'webview.en.json'), 'utf8'));
      } catch (_) {
        i18nMap = {};
      }
    }
    const i18nScript =
      '<script nonce="' + nonce + '">window.__FOX_LOCALE__=' + JSON.stringify(locale) +
      ';window.__FOX_I18N__=' + JSON.stringify(i18nMap) + ';</script>';
    // 数学公式渲染：本地 KaTeX（vendor/katex，离线可用）。CSS 与 JS 都注入 head，
    // 在 chat.js 之前加载，保证 window.katex 可用；注意 KaTeX 脚本是独立 <script> 标签，
    // 绝不能拼进 ${scriptUri} 的 src 属性里（否则会破坏 HTML、导致 chat.js 完全不加载、按钮全失效）。
    return html
      .replace('</head>', katexHead + i18nScript + katexScript + '</head>')
      .replace(/\$\{i18nUri\}/g, i18nUri.toString())
      .replace(/\$\{cspSource\}/g, webview.cspSource)
      .replace(/\$\{nonce\}/g, nonce)
      .replace(/\$\{styleUri\}/g, styleUri.toString())
      .replace(/\$\{scriptUri\}/g, scriptUri.toString());
  }

  _syncTo(webview) {
    try {
      webview.postMessage({ type: 'clear' });
      if (this.transcript.length) webview.postMessage({ type: 'restore', items: this.transcript });
      if (this.attachments.length) webview.postMessage({ type: 'attachments', items: this.attachments });
      if (this.lastContextUsage) webview.postMessage({ type: 'contextUsage', ...this.lastContextUsage });
      this.pushStatus();
      this._pushPlanTasks();
    } catch (_) {}
  }

  newChat(focus = true) {
    this.stop();
    const s = this.sessionManager.create({ title: '新会话', messages: [], transcript: [] });
    this._applySession(s);
    if (focus) this.show();
  }

  switchSession(id) {
    this.stop();
    const s = this.sessionManager.switchTo(id);
    if (s) {
      this._applySession(s);
      this.show();
      return true;
    }
    return false;
  }

  deleteSession(id) {
    const currentId = this.sessionManager.currentId();
    this.sessionManager.delete(id);
    if (currentId === id) {
      const s = this.sessionManager.current();
      this._applySession(s || { messages: [], transcript: [], attachments: [] });
    }
  }

  renameSession(id, title) {
    this.sessionManager.rename(id, title);
  }

  _saveCurrentSession() {
    const currentId = this.sessionManager.currentId();
    if (!currentId) return;
    // 标题仍是默认「新会话」时传空字符串，让 sessions.save 里的 makeTitle 兜底用首条用户消息
    // 自动生成标题；否则会话列表里所有会话永远都叫「新会话」。
    const curTitle = (this.sessionManager.current() || {}).title;
    const title = (curTitle && curTitle !== '新会话') ? curTitle : '';
    try {
      this.sessionManager.save({
        id: currentId,
        title,
        // 存档时把 base64 剥掉：一张图 1~2MB，直接写进会话 JSON 会让文件迅速膨胀
        messages: stripHeavyMessages(this.messages),
        transcript: stripHeavyTranscript(this.transcript),
        attachments: this.attachments.map((a) => Object.assign({}, a, { base64: '' })),
        // 随会话持久化规划状态，resume / 切换会话后可恢复，避免 planner 重跑建重复任务
        planTaskId: this._planTaskId || null,
        planned: !!this._planned,
        planPending: !!this._planPending
      });
    } catch (e) {
      log('save session failed:', (e && e.message) || String(e));
    }
  }

  stop() {
    if (this.session) {
      this.session.cancel();
    }
    // 释放 diff 预览占用的大字符串
    this.previews.clear();
  }

  isBusy() {
    return !!this.session;
  }

  postNotice(text) {
    this.post({ type: 'notice', text });
  }

  async prefill(text) {
    await this.show();
    this.post({ type: 'prefill', text });
  }

  endBubble() {
    if (this.bubbleId) {
      this.post({ type: 'assistantEnd', id: this.bubbleId });
      this.bubbleId = null;
    }
  }

  ensureBubble() {
    if (!this.bubbleId) {
      this.bubbleId = 'a' + ++this.seq;
      this.post({ type: 'assistantStart', id: this.bubbleId });
    }
    return this.bubbleId;
  }

  async addAttachments() {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: '添加附件'
    });
    if (!uris || !uris.length) return;
    const maxMB = Math.max(0.1, config.conf().get('attachment.maxSizeMB', 6));
    for (const uri of uris) {
      const data = await readFileAsBase64(uri.fsPath);
      if (!data) continue;
      const name = path.basename(uri.fsPath);
      if (data.size > maxMB * 1024 * 1024) {
        vscode.window.showWarningMessage(
          `附件「${name}」有 ${formatBytes(data.size)}，超过上限 ${maxMB}MB，已跳过。图片建议先压缩（或调大 foxAi.attachment.maxSizeMB）。`
        );
        continue;
      }
      const ext = path.extname(name).toLowerCase();
      const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext);
      this.attachments.push({
        id: 'att-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        name,
        path: uri.fsPath,
        mime: data.mime,
        base64: data.base64,
        isImage,
        size: data.size
      });
    }
    this.post({ type: 'attachments', items: this.attachments });
    this._saveCurrentSession();
  }

  /** 读取当前活动终端内容并作为用户消息发给 agent（用于交互式技能/游戏） */
  async readTerminalAndAsk() {
    if (this.session) {
      vscode.window.showWarningMessage(i18n.tw('狐狸 AI 还在忙，先停止它再读取终端哦～'));
      return;
    }
    this.post({ type: 'notice', text: '正在读取终端内容…' });
    try {
      const output = await terminal.readActiveTerminal({ lines: 120 });
      const clean = String(output || '').trim();
      if (!clean || clean.includes('当前没有打开的终端') || clean.includes('没能读到终端内容') || clean.includes('暂无命令记录')) {
        vscode.window.showWarningMessage(i18n.tw('终端里好像还没有内容，先在终端输入点东西再试～'));
        return;
      }
      await this.ask('[终端最新输出]\n' + clean, { showText: '📟 读取终端' });
    } catch (e) {
      vscode.window.showErrorMessage(i18n.tw('读取终端失败：{0}', (e && e.message) || String(e)));
    }
  }

  /**
   * 发起一次任务
   * @param {string} text
   * @param {{hidden?:string, showText?:string, attachments?:Array}} [opts]
   */
  async ask(text, opts) {
    this._ensureSession();
    const options = opts || {};
    const sendText = options.hidden || text;
    const visible = options.showText || text;
    // 用户主动发送的消息一定带 attachments 字段；不带时不应回退到可能过期的 this.attachments
    const atts = Array.isArray(options.attachments)
      ? options.attachments
      : (this.attachments || []);
    if (isEmptyMessageContent(sendText) && !atts.length) return;

    // 拦截 /mcp 斜杠命令：显式调用某个 MCP 服务器工具，不经过模型自动决策
    if (typeof sendText === 'string' && /^\s*\/mcp(\s|$)/i.test(sendText)) {
      await this._handleMcpSlash(sendText);
      return;
    }

    // 拦截自定义 Slash Commands：`/review src/a.js` -> 展开 .fox-ai/commands/review.md 模板后再发给模型。
    // 懒加载：只有输入确实以 `/单词` 开头时才 require 模块并扫目录，普通聊天零开销。
    if (typeof sendText === 'string' && !options._slashExpanded && /^\s*\/[a-zA-Z0-9]/.test(sendText)) {
      const expanded = this._expandSlashCommand(sendText);
      if (expanded && expanded.ok) {
        // 展开后的完整 prompt 作为隐藏消息发给模型，聊天区仍显示用户敲的那句 `/xxx ...`
        // _slashExpanded 防止模板正文本身以 / 开头时无限递归展开
        return this.ask(visible, Object.assign({}, options, {
          hidden: expanded.text,
          showText: visible,
          _slashExpanded: true
        }));
      }
      if (expanded && expanded.notFound) {
        this.post({
          type: 'notice',
          text: expanded.available && expanded.available.length
            ? `没有自定义命令 /${expanded.name}。当前可用：${expanded.available.map((n) => '/' + n).join('、')}（命令目录：狐狸 AI: 打开命令模板目录）`
            : `没有自定义命令 /${expanded.name}。可执行「狐狸 AI: 打开命令模板目录」新建一个 ${expanded.name}.md 模板。`
        });
        return;
      }
    }

    // 若用户消息里显式引用了 MCP 工具命名空间，但 MCP 未启用或未注入模型，给出操作提示
    if (typeof sendText === 'string' && /mcp__\w+/i.test(sendText)) {
      const policy = mcp.getPolicy();
      if (!policy.enabled) {
        this.post({
          type: 'notice',
          text: i18n.tw('你消息里提到了 MCP 工具，但 MCP 总开关尚未开启。请打开左侧「🌐 MCP」面板，勾选「启用」后再让狐狸 AI 调用。')
        });
      } else if (!policy.autoInject) {
        this.post({
          type: 'notice',
          text: i18n.tw('你消息里提到了 MCP 工具，但 foxAi.mcp.autoInject 当前为 false，狐狸 AI 看不到 MCP 工具。请在设置里把 foxAi.mcp.autoInject 设为 true（或左侧 MCP 面板勾选「自动注入模型」）后再试。')
        });
      }
    }

    // 立即清空输入框附件，防止异步配置解析期间重入或残留
    this.attachments = [];
    this.post({ type: 'attachments', items: [] });

    await this.show();

    if (this.session) {
      vscode.window.showWarningMessage(i18n.tw('狐狸 AI 还在忙上一件事，先暂停或停止它吧～'));
      return;
    }

    log('ask start:', visible.slice(0, 80), 'attachments=', atts.length);
    let cfg;
    try {
      cfg = await config.resolve(this.context);
    } catch (err) {
      const msg = '读取配置失败：' + ((err && err.message) || String(err));
      log(msg);
      this.post({ type: 'error', text: msg });
      vscode.window.showErrorMessage(msg);
      return;
    }

    log('config resolved:', cfg.providerId, cfg.baseUrl, 'model=', cfg.model, 'key=', cfg.apiKey ? '已设' : '未设');

    if (!cfg.baseUrl) {
      const msg = i18n.tw('还没配置接口地址，请在设置里填 foxAi.baseUrl');
      this.post({ type: 'error', text: msg });
      vscode.window.showErrorMessage(msg);
      return;
    }
    if (!cfg.meta.local && !cfg.apiKey) {
      const msg = i18n.tw('{0} 需要 API Key。命令面板运行「狐狸 AI: 设置 API Key」即可。', cfg.meta.label);
      this.post({ type: 'error', text: msg });
      vscode.window.showErrorMessage(msg);
      return;
    }

    // 模型不支持读图时，图片一律降级成文字说明——
    // 否则 DeepSeek 这类服务端会直接 400：unknown variant `image_url`
    const visionMode = config.conf().get('visionMode', 'auto');
    const canSeeImagesNative = caps.supportsVision(cfg.model, visionMode, config.visionLists());
    // 任务2「多模态识图中转」：即使主模型不支持读图，只要 foxAi.vision.enabled 且已配模型，
    // 仍要把真实图片发给 agent，由 agent 内部用第二个 vision 模型转文字——绝不能在这里提前降级成文件名，
    // 否则 image_url 被吃掉、_hasImages 为假、中转静默失效。
    const visionRelayOn = !!(cfg.visionConfig && cfg.visionConfig.enabled && cfg.visionConfig.model);
    const canSeeImages = canSeeImagesNative || visionRelayOn;
    const imageCount = atts.filter((a) => a.isImage).length;
    if (imageCount && !canSeeImagesNative) {
      if (visionRelayOn) {
        this.post({
          type: 'notice',
          text: `「${cfg.model}」本身不支持读图，但这 ${imageCount} 张图片会先交给第二个多模态模型「${cfg.visionConfig.model}」转成文字描述，再交给主模型推理（原图不会直接发给主模型）。`
        });
      } else {
        this.post({
          type: 'notice',
          text: `「${cfg.model}」被判定为纯文本模型，这 ${imageCount} 张图片会以文件名形式发送。\n如果它其实能读图，把模型名加进设置 foxAi.visionModels 即可（或把 foxAi.vision 设为 on 强制发送）。`
        });
      }
    }

    // 「换agent / 切换智能体」语义升级：复述上一轮真实用户问题（含其图片附件），
    // 重新交给智能体处理，而不是把「换agent」三个字当成用户输入提交给模型
    // ——否则模型会误以为用户要“切换模型”，答非所问（多模态识图也因此失效）。
    const SWITCH_AGENT_RE = /(换\s*agent|切换\s*(到\s*)?agent|用\s*agent|换\s*智能体|切换\s*(到\s*)?智能体|用\s*智能体|force\s*agent)/i;
    let effectiveText = sendText;
    let effectiveAtts = atts;
    if (SWITCH_AGENT_RE.test(sendText)) {
      if (this._lastUserTurn && this._lastUserTurn.text && !SWITCH_AGENT_RE.test(this._lastUserTurn.text)) {
        effectiveText = this._lastUserTurn.text;
        effectiveAtts = (this._lastUserTurn.attachments && this._lastUserTurn.attachments.length)
          ? this._lastUserTurn.attachments
          : atts;
        const { appendLog } = require('./log');
        appendLog('router', '[force-agent] 复述上一轮用户问题重交智能体：' + String(effectiveText).slice(0, 80));
        this.post({ type: 'replaceLastAssistant' });
        this.post({
          type: 'notice',
          text: '〔已切换智能体〕正在用智能体重新处理你刚才的问题'
            + (effectiveAtts.length ? '（含 ' + effectiveAtts.length + ' 张图片）' : '') + '：' + effectiveText
        });
      } else {
        const { appendLog } = require('./log');
        appendLog('router', '[force-agent] 无上一轮真实用户问题，按字面提交');
      }
    }

    // 构建用户消息内容（文本 + 附件）
    const userContent = buildUserContent(effectiveText, effectiveAtts, canSeeImages);
    const visibleText = buildUserContent(visible, effectiveAtts, canSeeImages);

    this.post({ type: 'user', id: 'u' + ++this.seq, text: extractTextFromContent(visibleText), attachments: effectiveAtts });
    this.messages.push({ role: 'user', content: userContent });
    // 仅在“本次不是切换指令”时才更新上一轮缓冲，避免把「换agent」写进缓冲造成死循环
    if (!SWITCH_AGENT_RE.test(sendText)) {
      this._lastUserTurn = { text: effectiveText, attachments: effectiveAtts };
    }

    // 前置路由门控：简单文本查询直走 RAG，不进智能体主循环（省 Token）。
    // 带图片的输入一律跳过 RAG 直答、直接走智能体——让多模态识图中转生效，
    // 否则 RAG 会把图片当成知识库查询、给出无关的文档式回答（识图因此“失效”）。
    if (cfg.routing && cfg.routing.gateEnabled && !SWITCH_AGENT_RE.test(sendText) && imageCount === 0) {
      const { appendLog } = require('./log');
      const route = router.shouldRoute(sendText, cfg);
      if (route) {
        appendLog('router', '[gate] query=' + String(sendText).slice(0, 80) + ' RAG直答命中');
        this.post({ type: 'notice', text: '〔路由：RAG 直答〕命中知识库，已跳过智能体主循环。' });
        try {
          const answer = await router.answerWithRag(route.query, route.ctx, cfg);
          if (answer) {
            this.messages.push({ role: 'assistant', content: answer });
            this.post({ type: 'assistant', text: answer });
            this.post({ type: 'ragHint' });
            this._saveCurrentSession();
            return;
          } else {
            appendLog('router', '[empty] RAG 无结果，回退主循环');
            this.post({ type: 'notice', text: '〔路由：RAG 直答〕知识库检索到了资料，但模型没有生成回答，已回退到智能体主循环。' });
          }
        } catch (e) {
          const errText = e && e.message ? e.message : String(e);
          appendLog('router', '[fallback] RAG 失败，回退主循环 err=' + errText);
          this.post({ type: 'notice', text: '〔路由：RAG 直答〕生成回答失败：' + errText.split('\n')[0] + '，已回退到智能体主循环。' });
          // 路由失败，回退到正常智能体主循环
        }
      } else {
        appendLog('router', '[skip] query 未命门控，走主循环');
      }
    }

    this._saveCurrentSession();

    await this._launch();
  }

  /**
   * 把对话里生成的图片保存到本地磁盘。
   * 支持两种来源：data URI（生图工具直接回传的 base64）与远程 URL（生图模型返回的图片链接）。
   * 通过 VS Code 原生「另存为」对话框让用户选择路径/文件名，写入后提示并在资源管理器打开。
   * @param {string} src 图片 data URI 或 http(s) URL
   * @param {string} [name] 文件名提示（取图片 alt）
   */
  async _saveGeneratedImage(src, name) {
    const { URL } = require('url');
    try {
      // 1) 解析图片字节与扩展名
      let buf;
      let ext;
      if (typeof src === 'string' && src.startsWith('data:')) {
        const mm = /^data:([^;]+);base64,(.*)$/.exec(src);
        if (!mm) {
          vscode.window.showErrorMessage(i18n.tw('图片格式无法识别，保存失败。'));
          return;
        }
        const mime = mm[1].toLowerCase();
        ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' })[mime] || 'png';
        buf = Buffer.from(mm[2], 'base64');
      } else if (typeof src === 'string' && /^https?:\/\//i.test(src)) {
        const fetched = await this._downloadImageBytes(src);
        if (!fetched) {
          vscode.window.showErrorMessage(i18n.tw('图片下载失败，无法保存。'));
          return;
        }
        buf = fetched.buf;
        ext = fetched.ext || 'png';
      } else {
        vscode.window.showErrorMessage(i18n.tw('不支持的图片来源，无法保存。'));
        return;
      }
      if (!buf || !buf.length) {
        vscode.window.showErrorMessage(i18n.tw('图片内容为空，保存失败。'));
        return;
      }

      // 2) 默认文件名与目录（优先当前工作区，否则用户主目录）
      const safe = String(name || 'fox-ai-image')
        .replace(/[\/\\:*?"<>|]+/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 40) || 'fox-ai-image';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const fileName = safe + '_' + stamp + '.' + ext;
      const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
      const baseDir = folders[0] || (process.env.USERPROFILE || process.env.HOME || '.');
      const defaultUri = vscode.Uri.file(path.join(baseDir, fileName));

      const picked = await vscode.window.showSaveDialog({
        defaultUri,
        saveLabel: i18n.tw('保存图片'),
        filters: { '图片': [ext], '所有文件': ['*'] }
      });
      if (!picked) return; // 用户取消

      await vscode.workspace.fs.writeFile(picked, new Uint8Array(buf));
      const open = i18n.tw('在资源管理器中打开');
      const act = await vscode.window.showInformationMessage(
        i18n.tw('已保存图片：{0}', picked.fsPath), open
      );
      if (act === open) {
        vscode.commands.executeCommand('revealFileInOS', picked);
      }
    } catch (e) {
      vscode.window.showErrorMessage(i18n.tw('保存图片失败：{0}', (e && e.message) || String(e)));
    }
  }

  /** 下载远程图片字节，自动跟随重定向（最多 5 跳）。失败返回 null。 */
  _downloadImageBytes(urlStr) {
    return new Promise((resolve) => {
      const tryGet = (uStr, redirects) => {
        let u;
        try { u = new URL(uStr); } catch (_) { return resolve(null); }
        const lib = u.protocol === 'http:' ? http : https;
        const req = lib.get(u, { timeout: 30000 }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
            res.resume();
            return tryGet(new URL(res.headers.location, u).toString(), redirects + 1);
          }
          if (res.statusCode !== 200) { res.resume(); return resolve(null); }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            const ct = (res.headers['content-type'] || '').toLowerCase();
            const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' })[ct] || 'png';
            resolve({ buf, ext });
          });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
      };
      tryGet(urlStr, 0);
    });
  }

  /**
   * 归一化 MCP 工具 schema。不同 SDK/服务器可能把 schema 放在
   * parameters / inputSchema / schema 等不同字段里。
   */
  _normalizeMcpSchema(parameters) {
    if (!parameters) return { type: 'object', properties: {} };
    if (parameters.properties || Array.isArray(parameters.required)) return parameters;
    return parameters.inputSchema || parameters.schema || parameters;
  }

  /**
   * 根据 schema 生成一个示例参数对象，用于提示用户正确的 JSON 格式。
   */
  _buildMcpParamExample(parameters) {
    const schema = this._normalizeMcpSchema(parameters);
    const props = schema.properties || {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const ex = {};
    for (const key of required) {
      const p = props[key] || {};
      const t = p.type;
      if (t === 'number' || t === 'integer') ex[key] = 1;
      else if (t === 'boolean') ex[key] = true;
      else if (t === 'array') ex[key] = [];
      else if (t === 'object') ex[key] = {};
      else ex[key] = '...';
    }
    if (!required.length) {
      const first = Object.keys(props)[0];
      if (first) ex[first] = '...';
    }
    return ex;
  }

  /**
   * 把用户输入的纯文本参数适配成 MCP 工具所需的 JSON 参数。
   * 策略：
   *   1) 文本本身是合法 JSON -> 直接解析；
   *   2) 存在 "key:value" 模式 -> 解析成对象；
   *   3) 工具 schema 只有一个 required 字符串属性 -> 作为该字段值；
   *   4) 工具 schema 只有一个字符串属性 -> 作为该字段值；
   *   5) 无法 confident 映射 -> 返回 null（调用方应提示用户用 JSON）。
   *
   * 注意：不再兜底成 { input: 文本 }，因为很多 MCP 工具根本没有 input 字段，
   * 兜底会导致服务器报一堆字段 undefined/NaN 的迷惑错误。
   */
  _coerceMcpArgs(argStr, parameters) {
    const trimmed = String(argStr || '').trim();
    if (!trimmed) return {};
    // 1) JSON
    try { return JSON.parse(trimmed); } catch (_) {}
    // 2) key:value 模式
    const lines = trimmed.split(/[\n;]+/).map((l) => l.trim()).filter(Boolean);
    const kv = {};
    let hasKv = false;
    for (const line of lines) {
      const m = line.match(/^([^:=]+)[:=](.*)$/);
      if (m) { hasKv = true; kv[m[1].trim()] = m[2].trim(); }
    }
    if (hasKv) return kv;
    // 3)(4) 根据 schema 找单一字符串属性
    const schema = this._normalizeMcpSchema(parameters);
    const props = schema.properties || {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const stringKeys = Object.keys(props).filter((k) => {
      const t = props[k] && props[k].type;
      return t === 'string' || !t;
    });
    if (required.length === 1 && stringKeys.includes(required[0])) {
      return { [required[0]]: trimmed };
    }
    // 只有一个字符串属性、且没有其它 required 字段时，才放心把纯文本映射给它；
    // 否则其他 required 字段缺失会导致服务器报 undefined/NaN，不如直接提示 JSON。
    if (stringKeys.length === 1 && required.length <= 1) {
      return { [stringKeys[0]]: trimmed };
    }
    // 5) 无法 confident 映射：返回 null，由 _handleMcpSlash 提示正确格式
    return null;
  }

  /**
   * 展开自定义 Slash Command 模板（.fox-ai/commands/<name>.md）。
   * 懒加载模块 + 目录 mtime 缓存，命中不了就返回 notFound 让上层提示，绝不抛错打断发送。
   * @returns {{ok:true,text:string}|{notFound:true,name:string,available:string[]}|null}
   */
  _expandSlashCommand(raw) {
    try {
      const slash = require('./slashCommands');
      const parsed = slash.parseInput(raw);
      if (!parsed) return null;
      // /mcp 已被上面单独处理；这里排除掉内置前缀，避免误判
      if (/^mcp$/i.test(parsed.name)) return null;
      const dirs = this._commandDirs();
      const r = slash.renderCommand(parsed.name, parsed.args, dirs);
      if (r.ok) return { ok: true, text: r.text };
      return { notFound: true, name: parsed.name, available: r.available || [] };
    } catch (_) {
      return null;
    }
  }

  /** 命令模板目录：工作区优先，其次用户级 */
  _commandDirs() {
    const slash = require('./slashCommands');
    const dirs = [];
    try {
      const folders = vscode.workspace.workspaceFolders;
      if (folders && folders.length) dirs.push(slash.workspaceCommandsDir(folders[0].uri.fsPath));
    } catch (_) {}
    try {
      const base = vscode.workspace.getConfiguration('foxAi').get('slashCommands.storagePath', '');
      dirs.push(slash.userCommandsDir(base || undefined));
    } catch (_) {
      dirs.push(slash.userCommandsDir());
    }
    return dirs.filter(Boolean);
  }

  /**
   * 处理 /mcp 斜杠命令：显式调用某个 MCP 服务器工具，绕过模型自动决策。
   * 用法：
   *   /mcp <serverId>.<toolName> [JSON参数或普通文本]
   *   /mcp <serverId> <toolName> [JSON参数或普通文本]
   *   /mcp <serverId>            -> 列出该服务器可用工具
   *   /mcp                       -> 列出所有已连接服务器
   */
  async _handleMcpSlash(raw) {
    const parsed = mcp.parseMcpCommand(raw);
    if (parsed.error) {
      this.post({ type: 'error', text: parsed.error });
      return;
    }

    // 帮助：列出服务器 / 工具
    if (parsed.help) {
      await mcp.refreshMcpTools();
      const tools = mcp.getCachedTools();
      const servers = [...new Set(tools.map((t) => t.connectorId))];
      if (!servers.length) {
        this.post({
          type: 'notice',
          text: '还没有任何已连接的 MCP 服务器。请先在「🌐 MCP」标签页启用服务器并确认连接成功，再使用 /mcp 调用。'
        });
        return;
      }
      if (parsed.serverId) {
        const list = tools.filter((t) => t.connectorId === parsed.serverId).map((t) => `· ${t.remoteName}（${t.kind}）`);
        if (!list.length) {
          this.post({ type: 'error', text: `未找到 MCP 服务器「${parsed.serverId}」或它尚未连接。已连接：${servers.join('、')}` });
          return;
        }
        this.post({ type: 'notice', text: `MCP 服务器「${parsed.serverId}」可用工具：\n${list.join('\n')}` });
      } else {
        const lines = servers.map((s) => {
          const n = tools.filter((t) => t.connectorId === s).length;
          return `· ${s}（${n} 个工具）`;
        });
        this.post({
          type: 'notice',
          text: '可用 MCP 服务器：\n' + lines.join('\n') +
            '\n\n用法：/mcp <服务器> <工具> [JSON参数或普通文本]\n例：/mcp playwright navigate {"url":"https://example.com"}\n例：/mcp sequentialthinking sequentialthinking 帮我想一个方案'
        });
      }
      return;
    }

    // 调用工具
    await mcp.refreshMcpTools();
    const tools = mcp.getCachedTools();
    const tool =
      tools.find((t) => t.connectorId === parsed.serverId && t.remoteName === parsed.toolName) ||
      tools.find((t) => t.name === `mcp__${parsed.serverId}__${parsed.toolName}`);
    if (!tool) {
      const avail = tools.filter((t) => t.connectorId === parsed.serverId).map((t) => t.remoteName);
      if (avail.length) {
        this.post({ type: 'error', text: `服务器「${parsed.serverId}」没有工具「${parsed.toolName}」。可用：${avail.join('、')}` });
      } else {
        const connected = [...new Set(tools.map((t) => t.connectorId))];
        this.post({
          type: 'error',
          text: `未找到 MCP 服务器「${parsed.serverId}」或它尚未连接。已连接：${connected.join('、') || '（无）'}`
        });
      }
      return;
    }

    // 参数适配：JSON 优先；非 JSON 纯文本时根据工具 schema 自动匹配到单一字符串参数
    let args = parsed.args || {};
    if (parsed.args === null && parsed.argStr) {
      args = this._coerceMcpArgs(parsed.argStr, tool.parameters);
    }
    if (args === null) {
      const example = this._buildMcpParamExample(tool.parameters);
      const exampleJson = JSON.stringify(example);
      this.post({
        type: 'error',
        text: `「${parsed.serverId}.${parsed.toolName}」需要结构化参数，无法把纯文本直接映射到该工具的 schema。\n\n请使用 JSON 格式调用，例如：\n/mcp ${parsed.serverId}.${parsed.toolName} ${exampleJson}\n\n该工具的 schema 要求：${JSON.stringify(this._normalizeMcpSchema(tool.parameters).required || [])}`
      });
      return;
    }

    // 展示命令与调用结果
    this.post({ type: 'user', id: 'u' + ++this.seq, text: raw });
    const bid = 'mcp' + ++this.seq;
    this.post({ type: 'assistantStart', id: bid });
    this.post({ type: 'delta', id: bid, text: `⏳ 正在调用 MCP 工具 ${parsed.serverId}/${parsed.toolName} …\n` });
    let result;
    try {
      result = await mcp.executeRemote(tool, args);
    } catch (e) {
      this.post({ type: 'delta', id: bid, text: '调用失败：' + ((e && e.message) || String(e)) });
      this.post({ type: 'assistantEnd', id: bid });
      return;
    }
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    this.post({ type: 'delta', id: bid, text });
    this.post({ type: 'assistantEnd', id: bid });

    // 记录到会话历史，便于后续对话引用
    this.messages.push({ role: 'user', content: raw });
    this.messages.push({ role: 'assistant', content: text });
    this._saveCurrentSession();
  }

  /** 创建并启动一个 AgentSession（ask 与 resumeTaskById 共用） */
  async _launch(resumeTaskId) {
    if (this.session) {
      vscode.window.showWarningMessage(i18n.tw('狐狸 AI 还在忙上一件事，先暂停或停止它吧～'));
      return;
    }

    let cfg;
    try {
      cfg = await config.resolve(this.context);
    } catch (err) {
      const msg = '读取配置失败：' + ((err && err.message) || String(err));
      log(msg);
      this.post({ type: 'error', text: msg });
      vscode.window.showErrorMessage(msg);
      return;
    }

    if (!cfg.baseUrl) {
      const msg = i18n.tw('还没配置接口地址，请在设置里填 foxAi.baseUrl');
      this.post({ type: 'error', text: msg });
      vscode.window.showErrorMessage(msg);
      return;
    }
    if (!cfg.meta.local && !cfg.apiKey) {
      const msg = i18n.tw('{0} 需要 API Key。命令面板运行「狐狸 AI: 设置 API Key」即可。', cfg.meta.label);
      this.post({ type: 'error', text: msg });
      vscode.window.showErrorMessage(msg);
      return;
    }

    // 跨 session 保持状态（防止"继续"后全新 session 丢失关键记忆）
    const prev = this.session;
    const prevReadFileHistory = (prev && prev._readFileHistory) ? prev._readFileHistory.slice() : [];
    const prevForceText = prev ? prev._forceText : false;
    // 1.1.18：computeOfficialSearch 已改为「仅当次请求时效性」触发，不再永久粘连，
    // 因此无需把旧会话的官方搜索标记传给新 session，避免旧 bug 的遗留状态继续污染新对话。
    const prevScVerified = prev && prev._scVerified ? new Set(prev._scVerified) : null;
    // 规划状态跨「继续」/resume 保持：优先取上一个 session，否则取 chatView 镜像（resume 时已从存档恢复）
    const prevPlanTaskId = (prev && prev._planTaskId) || this._planTaskId || null;
    const prevPlanned = !!(prev && prev._planned) || !!this._planned;
    const prevPlanPending = !!(prev && prev._planPending) || !!this._planPending;

    const session = new AgentSession({
      context: this.context,
      cfg,
      messages: this.messages,
      alwaysAllow: this.alwaysAllow,
      ui: this.buildUi(),
      harness: { taskManager: this.taskManager, policy: new harness.PolicyEngine(cfg) },
      planTasks: this.planTasks,
      sessionId: this.sessionManager.currentId(),
      resumeTaskId
    });
    if (prevReadFileHistory.length) session._readFileHistory = prevReadFileHistory;
    if (prevForceText) session._forceText = true;
    if (prevScVerified) session._scVerified = prevScVerified;
    if (prevPlanTaskId) session._planTaskId = prevPlanTaskId;
    if (prevPlanned) session._planned = true;
    if (prevPlanPending) session._planPending = true;
    // ★ 前缀缓存关键：稳定块 / 易变块缓存跨「继续」/下次提问保持。
    // AgentSession 每次提问都新建（实例属性会被构造函数重置），但稳定块（技能/结构/规则/人格/记忆）
    // 与易变块缓存（RAG/主题记忆指纹）必须跨提问冻结，否则 system 前缀每次提问都重算 → 每次提问全 miss。
    // 复刻 prev 的 _stableBlock 与 _dynCache，保证同一会话内 system 前缀字节稳定、RAG 不重复注入。
    if (prev && prev._stableBlock !== undefined) session._stableBlock = prev._stableBlock;
    if (prev && prev._dynCache) session._dynCache = prev._dynCache;
    this.session = session;
    this.pushStatus('running');
    // 自动化桥：把当前会话的后台 agent 入口注册给 extension 的调度/触发回调复用
    try { require('./automationsBridge').setRunner((spec) => session.runBackgroundAgent(spec)); } catch (_) {}

    try {
      log('session.run start', 'resume=', !!resumeTaskId);
      const result = await session.run();
      log('session.run end:', result);
      if (result && result.reason === 'plan-pending') {
        // 规划待确认：保留 session 引用，释放 this.session 以允许用户发消息修改计划
        this._planPendingSession = session;
        this.session = null;
        this.pushStatus('idle');
        return;
      }
    } catch (err) {
      this.endBubble();
      if (err && err.isQuota) {
        // 额度/余额耗尽：agent 已 emit 友好提示并中止了审查子代理；记忆由 finally 的 _saveCurrentSession 兜底保留
        vscode.window.showWarningMessage(i18n.tw('模型额度/余额不足，已自动停止并保留本次对话。请充值后重试。'));
      } else {
        const msg = (err && err.message) || String(err);
        log('session.run error:', msg, '\nstack:', err && err.stack);
        this.post({ type: 'error', text: msg });
        vscode.window.showErrorMessage(i18n.tw('狐狸 AI 请求失败：{0}', msg));
      }
    } finally {
      if (this.session === session) {
        this.session = null;
      }
      // 镜像规划状态回 chatView，随会话存档持久化（供 resume / 下次「继续」恢复，防止 planner 重跑建重复任务）
      this._planTaskId = session._planTaskId || this._planTaskId || null;
      this._planned = !!(session._planned || this._planned);
      this._planPending = !!(session._planPending || this._planPending);
      if (!this._planPendingSession) {
        for (const [id, cb] of this.approvalResolvers) {
          cb('reject-cancel');
          this.approvalResolvers.delete(id);
        }
        this._saveCurrentSession();
        this.pushStatus('idle');
        // session 真正 idle 后：补发被抑制的审查卡片，并自动执行排队的审查修正
        if (this._pendingReviewCard) {
          const card = this._pendingReviewCard;
          this._pendingReviewCard = null;
          this.post({ type: 'review', files: card.files, text: card.text, id: card.id });
        }
        if (this._pendingArtifact) {
          const a = this._pendingArtifact;
          this._pendingArtifact = null;
          this.post(Object.assign({ type: 'artifact' }, a));
        }
        if (this._pendingApplyReview) {
          const pending = this._pendingApplyReview;
          this._pendingApplyReview = null;
          this.ask(pending.text, { showText: pending.showText }).catch(() => {});
        }
      }
    }
  }

  /**
   * 热恢复续跑：从断点继续执行一个未完成的任务。
   * 优先切回该任务关联的对话会话；若当前存储区找不到，会去默认目录/历史 storagePath 查找并导入；
   * 实在找不到就在当前会话续跑，并更新任务关联的 sessionId。
   * @param {string} taskId
   */
  async resumeTaskById(taskId) {
    const { appendLog } = require('./log');
    if (this.session) {
      vscode.window.showWarningMessage(i18n.tw('狐狸 AI 还在忙上一件事，先暂停或停止它吧～'));
      return;
    }
    const tm = this.taskManager;
    const task = await tm.getTask(taskId);
    if (!task) {
      vscode.window.showErrorMessage(i18n.tw('找不到该任务记录，无法续跑。'));
      return;
    }
    appendLog('checkpoint', '[resume-start] taskId=' + taskId + ' state=' + task.state + ' taskSession=' + (task.sessionId || '无') + ' currentSession=' + this.sessionManager.currentId());
    if (task.state === harness.TASK_STATES.RUNNING) {
      vscode.window.showWarningMessage(i18n.tw('该任务正在运行中，无需续跑～'));
      return;
    }
    if (!task.sessionId) {
      vscode.window.showWarningMessage(
        '该任务未关联对话会话（可能是旧版本记录），无法自动定位上下文。请回到原对话里输入「继续」让它接着做。'
      );
      return;
    }
    // 切回关联的会话，恢复历史上下文
    if (task.sessionId !== this.sessionManager.currentId()) {
      let s = this.sessionManager.load(task.sessionId);
      if (!s) {
        // 当前存储区没有，去默认目录/历史 storagePath 找并导入
        s = this.sessionManager.recoverSession(task.sessionId);
      }
      if (s) {
        this.sessionManager.switchTo(s.id);
        this._applySession(s);
      } else {
        // 实在找不到原会话，就在当前会话续跑，并更新任务关联
        this._ensureSession();
        await this.taskManager.updateTask(task.id, { sessionId: this.sessionManager.currentId() });
      }
    }
    // 追加续跑提示，让模型从断点处继续，而不是重做已完成的步骤
    const hint =
      '[续跑] 上次的任务尚未完成/被中断，请基于已有的对话进度与当前文件、环境状态，' +
      '从断点处继续完成，不要重复已经做过的步骤；全部完成后简要总结你做了什么。';
    this.post({ type: 'user', id: 'u' + ++this.seq, text: hint });
    this.messages.push({ role: 'user', content: hint });
    this._saveCurrentSession();
    appendLog('checkpoint', '[resume-launch] taskId=' + taskId);
    await this._launch(taskId);
  }

  buildUi() {
    const self = this;
    return {
      assistantStart: ({ channel, msg_id }) => {
        if (channel === 'final') this.bubbleId = msg_id;
        this.post({ type: 'assistantStart', channel, msg_id });
      },
      text: ({ text, channel, msg_id }) => {
        this.post({ type: 'delta', channel, msg_id: msg_id || this.bubbleId, text });
      },
      reasoning: ({ text, channel, msg_id, stream }) => {
        this.post({ type: 'reasoning', channel, msg_id: msg_id || this.bubbleId, text, stream: !!stream });
      },
      image: ({ src, alt, channel, msg_id }) => {
        this.post({ type: 'image', channel, msg_id: msg_id || this.bubbleId, src, alt });
      },
      assistantEnd: ({ channel, msg_id, done }) => {
        this.post({ type: 'assistantEnd', channel, msg_id: msg_id || this.bubbleId, done });
        if (channel === 'final' || !channel) this.bubbleId = null;
      },
      // 运行中检查点：agent 每完成一步 emit 一次，chatView debounce 落盘，
      // 保证长任务中途重载窗口也能恢复最近进度（Bug④ 兜底）
      checkpoint: () => {
        if (!self._autosaveTimer) {
          self._autosaveTimer = setTimeout(() => {
            self._autosaveTimer = null;
            try { self._saveCurrentSession(); } catch (_) {}
          }, 4000);
        }
      },
      toolPending: () => {
        // 模型开始吐工具调用，先收尾当前文本气泡
        this.endBubble();
      },
      toolStart: ({ id, name, kind, title, args, preview }) => {
        this.endBubble();
        // 步骤时间线：工具调用前先收尾仍在运行的「思考」步骤，避免工具步骤里残留 ⏳
        if (self._lastThinkingId) {
          self.post({ type: 'step', id: self._lastThinkingId, status: 'ok' });
          self._lastThinkingId = null;
        }
        // 记录开始时间，工具结束时计算耗时（结构化工作链元数据之一）
        self._toolTimes = self._toolTimes || new Map();
        self._toolTimes.set(id, Date.now());
        // 结构化工作链：工具调用本身就是一条时间线节点（不再额外发一条冗余 step），
        // 携带 tool_name/parameters/timestamp 等元数据，供前端折叠详情渲染
        this.post({
          type: 'tool',
          id,
          name,
          kind,
          title,
          argsText: summarizeArgs(name, args),
          preview: preview
            ? { path: preview.path, existed: preview.existed, stat: preview.stat, text: preview.text }
            : null,
          tool_name: name,
          parameters: args,
          summary: title,
          group: 'tool',
          stepType: 'tool_call',
          timestamp: Date.now(),
          status: 'running'
        });
        if (preview && preview.before !== undefined) {
          this.previews.set(id, { path: preview.path, before: preview.before, after: preview.after });
        }
        // 记录 agent 碰过的文件，方便在「文件」导航树里一键跳转
        if (this.fileNav && args && args.path && typeof name === 'string' && name.endsWith('_file')) {
          this.fileNav.addFile(args.path, { op: name });
        }
      },
      toolStream: ({ id, text }) => this.post({ type: 'toolStream', id, text }),
      toolEnd: ({ id, ok, output, rejected }) => {
        const dur = self._toolTimes ? (Date.now() - (self._toolTimes.get(id) || Date.now())) : 0;
        if (self._toolTimes) self._toolTimes.delete(id);
        const status = rejected ? 'rejected' : ok ? 'ok' : 'error';
        self.post({
          type: 'toolUpdate',
          id,
          status,
          output: String(output || '').slice(0, 4000),
          duration: dur
        });
        self.pushStatus();
      },
      requestApproval: (req, cb) => {
        this.post({ type: 'approval', id: req.id, name: req.name, kind: req.kind, title: req.title });
        this.post({ type: 'step', id: 'ap-' + req.id, kind: 'approval', title: i18n.tw('等待审批：{0}', req.title || req.name), status: 'running', group: 'warn', stepType: 'approval', timestamp: Date.now() });
        // 包装回调：用户决策后同步刷新 step 状态，避免「已允许」后步骤列表仍显示 running
        const wrappedCb = (decision) => {
          const status = decision === 'reject' || decision === 'reject-cancel' ? 'error' : 'ok';
          this.post({ type: 'step', id: 'ap-' + req.id, kind: 'approval', title: i18n.tw(decision === 'reject' ? '已拒绝：{0}' : '已允许：{0}', req.title || req.name), status });
          cb(decision);
        };
        this.approvalResolvers.set(req.id, wrappedCb);
      },
      step: ({ id, kind, title, detail, status }) => {
        self._stepSeq = self._stepSeq || 0;
        // 完成/出错到达时，先收尾仍在运行的「思考」步骤，避免时间线末尾残留 ⏳
        if ((kind === 'done' || kind === 'error') && self._lastThinkingId) {
          self.post({ type: 'step', id: self._lastThinkingId, status: 'ok' });
          self._lastThinkingId = null;
        }
        // 按类型归类（思考链归类用）：工具/思考/错误/警告/系统状态各自成组，避免一堆「完成」
        const grp = kind === 'error' ? 'error' : (kind === 'approval' || kind === 'warn' || kind === 'notice') ? 'warn' : kind === 'system_status' ? 'info' : 'llm';
        const stepType = kind === 'done' ? 'done' : kind === 'error' ? 'error' : kind === 'approval' ? 'approval' : kind === 'system_status' ? 'system_status' : 'llm';
        self.post({ type: 'step', id: id || ('s' + (++self._stepSeq)), kind: kind || 'info', title: title || '', detail: detail || '', status: status || 'running', group: grp, stepType, timestamp: Date.now() });
      },
      state: ({ state, thinkingMsgId }) => {
        this.pushStatus(state);
        if (state === 'thinking') {
          this._stepSeq = self._stepSeq || 0;
          if (this._lastThinkingId) {
            this.post({ type: 'step', id: self._lastThinkingId, status: 'ok' });
          }
          const sid = thinkingMsgId || ('st' + (++self._stepSeq));
          this._lastThinkingId = sid;
          this.post({ type: 'step', id: sid, kind: 'llm', title: i18n.tw('调用模型'), status: 'running', group: 'reason', stepType: 'llm', timestamp: Date.now() });
        }
      },
      notice: ({ text }) => this.post({ type: 'notice', text }),
      // 原生联网（DeepSeek/OpenAI Responses 的 web_search_call）的搜索结果 URL，
      // 透传给前端 harvest，补全引用角标成可点击链接。
      searchSources: ({ text }) => { if (text) this.post({ type: 'searchSources', text }); },
      // 本地知识库检索命中的来源文件（label + 绝对路径），透传给前端用于角标定位。
      kbSources: ({ sources }) => { if (Array.isArray(sources) && sources.length) this.post({ type: 'kbSources', sources }); },
      cacheStats: (data) => { this.post({ type: 'cacheStats', ...data }); },
      cacheUnsupported: (data) => { this.post({ type: 'cacheUnsupported', ...data }); },
      contextUsage: (data) => {
        this.lastContextUsage = data;
        try { this.context.globalState.update('lastContextUsage', data); } catch (_) {}
        this.post({ type: 'contextUsage', ...data });
      },
      finalText: () => {
        // 已合并到 assistantEnd，保留空回调兼容旧版 agent 事件
      },
      planPending: ({ plan, revised }) => {
        self.post({ type: 'planPending', plan: plan || [], revised: !!revised });
      },
      plan: ({ steps }) => {
        self.post({ type: 'plan', steps: steps || [] });
      },
      review: ({ files, text, id }) => {
        // 若主任务还在跑（或处于 plan-pending 暂停），先把卡片暂存，等 session 真正 idle 再弹出。
        // 避免用户在主任务未结束时看到卡片、点了「应用」却提示「还在忙」。
        if (self.session || self._planPendingSession) {
          self._pendingReviewCard = { files: files || [], text: text || '', id: id || null };
          return;
        }
        self.post({ type: 'review', files: files || [], text: text || '', id: id || null });
      },
      artifact: (payload) => {
        // 产物卡片：任务完成瞬间 session 可能仍被引用，先暂存、idle 后统一弹出，与审查卡片一致
        self._pendingArtifact = payload || {};
        if (!self.session && !self._planPendingSession) {
          const a = self._pendingArtifact;
          self._pendingArtifact = null;
          self.post(Object.assign({ type: 'artifact' }, a));
        }
      }
    };
  }
}

async function readFileAsBase64(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    return { base64: buf.toString('base64'), mime, size: buf.length };
  } catch (e) {
    vscode.window.showWarningMessage(i18n.tw('读取附件失败：{0}', e.message));
    return null;
  }
}

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.html': 'text/html',
  '.css': 'text/css',
  '.pdf': 'application/pdf',
  '.py': 'text/x-python',
  '.csv': 'text/csv'
};

function buildUserContent(text, attachments, canSeeImages = true) {
  if (!attachments || !attachments.length) return text;
  const parts = [];
  if (text && String(text).trim()) {
    parts.push({ type: 'text', text });
  }
  for (const a of attachments) {
    if (a.isImage && !canSeeImages) {
      parts.push({
        type: 'text',
        text: `[图片附件：${a.name}，${formatBytes(a.size)}（当前模型不支持读图，只能看到文件名）]`
      });
    } else if (a.isImage) {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${a.mime};base64,${a.base64}`, detail: 'auto' }
      });
    } else {
      // 非图片文件：文本类直接内联，二进制只给文件名和大小（PDF 塞 utf8 会变乱码）
      let fileText = null;
      if (a.mime.startsWith('text/') || a.mime === 'application/json') {
        try {
          fileText = Buffer.from(a.base64, 'base64').toString('utf8');
          if (fileText.length > 8000) fileText = fileText.slice(0, 8000) + '\n…（已截断）';
        } catch (_) {}
      }
      const binaryHint = !fileText && a.mime !== 'application/octet-stream' ? '，二进制文件内容未内联' : '';
      parts.push({
        type: 'text',
        text: `[附件：${a.name}，大小 ${formatBytes(a.size)}${binaryHint}${fileText ? '\n```\n' + fileText + '\n```' : ''}]`
      });
    }
  }
  // 全是文本时压回字符串，兼容对 content 数组比较挑剔的服务端
  if (parts.every((p) => p.type === 'text')) {
    return parts.map((p) => p.text).join('\n');
  }
  return parts;
}

/** 存档用：把消息里的 base64 图片换成占位，避免会话文件动辄几 MB */
function stripHeavyMessages(messages) {
  return (messages || []).map((m) => {
    let copy = m;
    if (Array.isArray(m.content) && m.content.some((c) => caps.isImagePart(c))) {
      copy = Object.assign({}, copy, {
        content: caps.degradeImageParts(m.content, '[图片附件（历史存档未保留原图）]')
      });
    }
    if (Array.isArray(m.images) && m.images.length) {
      copy = Object.assign({}, copy, {
        images: m.images.map((img) => Object.assign({}, img, { src: persistImage(img.src) }))
      });
    }
    return copy;
  });
}

/** 存档用：气泡记录里的附件只留元信息，过长文本截断 */
function stripHeavyTranscript(transcript) {
  const MAX_TRANSCRIPT_TEXT = 4000;
  return (transcript || []).map((t) => {
    if (!t) return t;
    const copy = Object.assign({}, t);
    if (copy.text && copy.text.length > MAX_TRANSCRIPT_TEXT) {
      copy.text = copy.text.slice(0, MAX_TRANSCRIPT_TEXT) + `…（共 ${t.text.length} 字）`;
    }
    if (copy.output && copy.output.length > MAX_TRANSCRIPT_TEXT) {
      copy.output = copy.output.slice(0, MAX_TRANSCRIPT_TEXT) + `…（共 ${t.output.length} 字）`;
    }
    if (Array.isArray(copy.attachments) && copy.attachments.length) {
      copy.attachments = copy.attachments.map((a) => Object.assign({}, a, { base64: '' }));
    }
    if (copy.type === 'image' && copy.src && copy.src.startsWith('data:')) {
      copy.src = persistImage(copy.src);
    }
    return copy;
  });
}

/** 生成图/截图落盘到用户级图片仓库（按内容 hash 去重），会话里只存轻量引用，重开时再还原 */
const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg'
};
const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml'
};
function sessionImagesDir() {
  const dir = path.join(os.homedir(), '.fox-ai', 'session-images');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}
function persistImage(src) {
  if (typeof src !== 'string' || !src.startsWith('data:')) return src;
  const mm = /^data:([^;]+);base64,(.*)$/.exec(src);
  if (!mm) return src;
  const mime = mm[1].toLowerCase();
  const ext = MIME_EXT[mime] || 'png';
  const buf = Buffer.from(mm[2], 'base64');
  if (!buf.length) return src;
  const fileName = crypto.createHash('md5').update(buf).digest('hex') + '.' + ext;
  const fp = path.join(sessionImagesDir(), fileName);
  try { if (!fs.existsSync(fp)) fs.writeFileSync(fp, buf); } catch (_) { return src; }
  return 'foximg:' + fileName;
}
function resolveImageRef(src) {
  if (typeof src !== 'string' || !src.startsWith('foximg:')) return src;
  const fileName = src.slice('foximg:'.length);
  if (!/^[a-f0-9]+\.[a-z]+$/i.test(fileName)) return null;
  const fp = path.join(sessionImagesDir(), fileName);
  try {
    const buf = fs.readFileSync(fp);
    const ext = path.extname(fileName).slice(1).toLowerCase();
    const mime = EXT_MIME[ext] || 'image/png';
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  } catch (_) { return null; }
}
function resolveTranscriptImages(items) {
  return (items || []).map((t) => {
    if (!t) return t;
    const c = Object.assign({}, t);
    if (c.type === 'image' && typeof c.src === 'string' && c.src.startsWith('foximg:')) {
      const r = resolveImageRef(c.src);
      if (r) c.src = r;
    }
    return c;
  });
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

async function insertIntoEditor(code) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    await vscode.env.clipboard.writeText(code || '');
    vscode.window.showWarningMessage(i18n.tw('没有活动编辑器，代码已复制到剪贴板'));
    return;
  }
  await editor.edit((b) => {
    if (editor.selection.isEmpty) b.insert(editor.selection.active, code);
    else b.replace(editor.selection, code);
  });
}

module.exports = { ChatViewProvider, readFileAsBase64, MIME_TYPES, buildUserContent };
