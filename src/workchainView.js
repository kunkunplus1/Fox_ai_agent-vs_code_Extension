'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const i18n = require('./i18n');
const DisposableBag = require('./disposableBag');

let _panel = null;

function nonceStr() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

function renderHtml(context, webview) {
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
  const htmlPath = path.join(context.extensionPath, 'media', 'workchain.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const nonce = nonceStr();
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'workchain.css'));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chat.js'));
  const i18nUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'i18n.js'));
  const katexCssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'vendor', 'katex', 'katex.min.css'));
  const katexJsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'vendor', 'katex', 'katex.min.js'));
  const katexHead = '<link rel="stylesheet" nonce="' + nonce + '" href="' + katexCssUri.toString() + '" />';
  const katexScript = '<script nonce="' + nonce + '" src="' + katexJsUri.toString() + '"></script>';
  const locale = i18n.currentLocale();
  const isZh = locale.toLowerCase().indexOf('zh') === 0;
  let i18nMap = {};
  if (!isZh) {
    try {
      i18nMap = JSON.parse(fs.readFileSync(path.join(context.extensionPath, 'l10n', 'webview.en.json'), 'utf8'));
    } catch (_) {
      i18nMap = {};
    }
  }
  const i18nScript =
    '<script nonce="' + nonce + '">window.__FOX_LOCALE__=' + JSON.stringify(locale) +
    ';window.__FOX_I18N__=' + JSON.stringify(i18nMap) + ';</script>';
  return html
    .replace('</head>', katexHead + i18nScript + katexScript + '</head>')
    .replace(/\$\{i18nUri\}/g, i18nUri.toString())
    .replace(/\$\{cspSource\}/g, webview.cspSource)
    .replace(/\$\{nonce\}/g, nonce)
    .replace(/\$\{styleUri\}/g, styleUri.toString())
    .replace(/\$\{scriptUri\}/g, scriptUri.toString());
}

function openWorkchainPanel(context, chatProvider) {
  if (_panel) {
    try {
      _panel.reveal();
    } catch (e) {
      // 面板已被销毁但单例未及时清空（极端时序），丢弃后重建，避免对 disposed webview 调 reveal 抛错
      _panel = null;
    }
    if (_panel) return;
  }
  const panel = vscode.window.createWebviewPanel(
    'foxAi.workchain', '狐狸 AI · 工作链', vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  _panel = panel;
  panel.webview.html = renderHtml(context, panel.webview);

  // 把本 webview 加入 chatProvider 的广播列表，实时接收 thinking/tool/step 消息
  if (chatProvider && chatProvider.addWorkchainWebview) {
    chatProvider.addWorkchainWebview(panel.webview);
  }

  const bag = new DisposableBag();
  panel._bag = bag;
  bag.add(panel.webview.onDidReceiveMessage(async (msg) => {
    // 工作链页面不需要用户输入，只处理不需要后端的本地交互；
    // 如需停止当前任务，透传给 chatProvider。
    if (!msg) return;
    try {
      if (msg.type === 'stop' && chatProvider) chatProvider.stop();
      else if (msg.type === 'pause' && chatProvider && chatProvider.session) chatProvider.session.pause();
      else if (msg.type === 'resume' && chatProvider && chatProvider.session) chatProvider.session.resume();
    } catch (e) {
      // ignore
    }
  }));
  bag.add(panel.onDidDispose(() => {
    if (chatProvider && chatProvider.removeWorkchainWebview) {
      chatProvider.removeWorkchainWebview(panel.webview);
    }
    _panel = null;
    bag.dispose();
  }));

  // 面板刚打开时同步一次当前会话的工作链历史（transcript 里的 thinking/tool 消息）
  try {
    if (chatProvider && chatProvider.transcript && chatProvider.transcript.length) {
      panel.webview.postMessage({ type: 'clear' });
      panel.webview.postMessage({ type: 'restore', items: chatProvider.transcript });
    }
  } catch (_) {}
}

module.exports = { openWorkchainPanel };
