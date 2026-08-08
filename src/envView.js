'use strict';

/*
 * src/envView.js — 环境与插件管理面板（Webview）
 *
 * 两个标签页：
 *   环境：列出可安装的运行时、已装状态、自定义安装根目录 / 镜像 / 提权模式，触发安装并显示进度。
 *   插件：列出已装扩展及其命令，勾选跨插件调用白名单。
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const runtimes = require('./runtimes');
const bridge = require('./extensionBridge');
const kbOrg = require('./knowledgeOrganizer');
const kb = require('./knowledgeBase');
const harness = require('./harness');
const { tw } = require('./i18n');
const foxConfig = require('./config');
const projectScan = require('./projectScan');
const mcp = require('./tools/mcp');
const mcpServers = require('./tools/mcpServers');
const mcpSetup = require('./tools/mcpSetup');
const mcpSecurity = require('./tools/mcpSecurity');
const mcpCatalog = require('./mcpCatalog');
const DisposableBag = require('./disposableBag');
const mcpAuthor = require('./tools/mcpAuthor'); // 用户自写 MCP 的磁盘目录清理

let _panel = null;
let _initialTab = 'env';

function nonceStr() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

function getHtml(context, webview) {
  const nonce = nonceStr();
  const csp = (webview && webview.cspSource) ? webview.cspSource : '';
  const rt = runtimes.listRuntimes();
  const rtRows = rt.map((r) => `
    <div class="card" data-rt="${r.id}">
      <div class="rt-head"><b>${r.name}</b><span class="ver">默认 ${r.defaultVersion}</span></div>
      <div class="rt-actions">
        <input class="ver-input" placeholder="版本（留空用默认）" value="${r.defaultVersion}"/>
        <button class="install-btn">安装</button>
        <span class="status"></span>
      </div>
    </div>`).join('');
  const os = require('os');
  const modulesPath = vscode.workspace.getConfiguration('foxAi').get('mcp.modulesPath') || path.join(os.homedir(), '.fox-ai', 'mcp-modules');
  function escAttr(v){ return String(v).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
  const envUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'env.js')).toString(); // foxAiMcpModulesPathInjected


  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} https: data:; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<meta name="foxai-mcp-modules" content="${escAttr(modulesPath)}" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
  h2 { font-size: 14px; margin: 6px 0 10px; }
  .tabs { display: flex; gap: 4px; margin-bottom: 12px; position: relative; z-index: 1; }
  .tab { padding: 5px 12px; cursor: pointer; border: 1px solid var(--vscode-panel-border); border-radius: 6px; pointer-events: auto; user-select: none; outline: none; }
  .tab:hover { background: var(--vscode-list-hoverBackground); }
  .tab:focus { border-color: var(--vscode-focusBorder); }
  .tab.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .pane { display: none; }
  .pane.active { display: block; }
  .row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  .row label { width: 110px; opacity: .85; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px; margin-bottom: 8px; }
  .rt-head { display: flex; justify-content: space-between; }
  .ver { opacity: .6; font-size: 12px; }
  .rt-actions { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  input, select { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 4px 6px; }
  .ver-input { width: 180px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: 0; border-radius: 4px; padding: 5px 12px; cursor: pointer; pointer-events: auto; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:active { transform: translateY(1px); }
  button.pick-btn { padding: 5px 16px; min-width: 60px; font-weight: 500; }
  .status { font-size: 12px; opacity: .8; }
  .ext { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 8px 10px; margin-bottom: 6px; }
  .ext .cmds { margin-top: 6px; font-size: 12px; opacity: .85; }
  .ext-group { margin-bottom: 14px; }
  .ext-group-title { font-size: 13px; font-weight: 600; margin: 8px 0 6px; padding-bottom: 4px; border-bottom: 1px solid var(--vscode-panel-border); }
  .hint { opacity: .6; font-size: 12px; margin: 6px 0; }
  code { background: rgba(128,128,128,.15); padding: 1px 4px; border-radius: 3px; }
  .danger { color: var(--vscode-errorForeground); }
  .mcp-field { margin-bottom: 4px; }
  #mcp-editor { box-shadow: 0 4px 12px rgba(0,0,0,.15); }
  .field-help { margin: -2px 0 8px 118px; font-size: 12px; opacity: .7; line-height: 1.45; }
  .preset-row { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0 14px; align-items: center; }
  .preset-btn { padding: 3px 10px; font-size: 12px; }
  .file-tree { user-select: none; }
  .file-tree .tree-node { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 4px; cursor: pointer; }
  .file-tree .tree-node:hover { background: var(--vscode-list-hoverBackground); }
  .file-tree .tree-node.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .file-tree .tree-toggle { width: 14px; text-align: center; font-size: 10px; opacity: .7; }
  .file-tree .tree-checkbox { margin: 0; }
  .file-tree .tree-icon { width: 16px; text-align: center; }
  .file-tree .tree-children { padding-left: 18px; }
  .file-tree .tree-role { opacity: .7; font-size: 11px; margin-left: 6px; }
  .file-tree .tree-size { opacity: .5; font-size: 11px; margin-left: auto; }
  .task-wrap { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-bottom: 6px; overflow: hidden; }
  .task-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; cursor: pointer; user-select: none; }
  .task-item:hover { background: var(--vscode-list-hoverBackground); }
  .task-item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .task-item .task-toggle { width: 14px; text-align: center; font-size: 10px; opacity: .7; }
  .task-item .task-state { font-weight: 600; min-width: 56px; }
  .task-item .task-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .task-item .task-meta { opacity: .6; font-size: 11px; white-space: nowrap; }
  .task-actions-row { display: none; gap: 6px; margin-left: auto; }
  .task-item:hover .task-actions-row { display: flex; }
  .task-detail { border-top: 1px solid var(--vscode-panel-border); padding: 8px; font-size: 12px; background: rgba(128,128,128,.05); }
  .task-detail pre { white-space: pre-wrap; max-height: 240px; overflow: auto; background: rgba(128,128,128,.08); padding: 8px; border-radius: 6px; margin: 6px 0; }
  .task-detail .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .task-detail button { font-size: 12px; padding: 4px 10px; }
</style>
</head>
<body>
  <div class="tabs" id="tabs">
    <div class="tab active" data-tab="env" tabindex="0" role="button" aria-pressed="true">🐾 运行环境</div>
    <div class="tab" data-tab="ext" tabindex="0" role="button" aria-pressed="false">🔌 插件联动</div>
    <div class="tab" data-tab="audit" tabindex="0" role="button" aria-pressed="false">📜 审计日志</div>
    <div class="tab" data-tab="kb" tabindex="0" role="button" aria-pressed="false">📚 知识库</div>
    <div class="tab" data-tab="tasks" tabindex="0" role="button" aria-pressed="false">📋 任务</div>
    <div class="tab" data-tab="project" tabindex="0" role="button" aria-pressed="false">🗺️ 项目</div>
    <div class="tab" data-tab="mcp" tabindex="0" role="button" aria-pressed="false">🌐 MCP</div>
  </div>

  <div class="pane active" id="env">
    <h2>运行环境管理</h2>
    <div class="row">
      <label>安装根目录</label>
      <input id="root" style="flex:1;min-width:220px" placeholder="C:\\Users\\asis\\.fox-ai\\runtimes"/>
      <button id="pick-root">选择目录</button>
    </div>
    <div class="row">
      <label>优先镜像</label>
      <select id="mirror">
        <option value="auto">自动（官方优先，失败用镜像）</option>
        <option value="tsinghua">清华镜像优先</option>
        <option value="official">仅官方源</option>
      </select>
    </div>
    <div class="row">
      <label>管理员提权</label>
      <select id="elevation">
        <option value="always">每次都弹 UAC 确认</option>
        <option value="session">该会话内不再询问</option>
      </select>
    </div>
    <p class="hint danger">⚠️ 所有下载仅允许来自内置官方源白名单，安装/改 PATH 前会弹窗确认，全程写入审计日志。</p>
    <div id="rt-list">${rtRows}</div>
    <div class="card" style="margin-top:14px;">
      <div class="rt-head"><b>🧰 工具箱</b></div>
      <p class="hint">类似 PCL2 百宝箱：释放内存、清理狐狸 AI 自身产生的缓存与数据。</p>
      <div class="row">
        <button id="optimize-memory">内存优化</button>
        <button id="cleanup-foxai">清理狐狸 AI 垃圾</button>
      </div>
    </div>
  </div>

  <div class="pane" id="ext">
    <h2>插件联动（跨扩展调用）</h2>
    <p class="hint danger">⚠️ 默认禁止一切跨插件调用。勾选命令将其加入白名单后，狐狸 AI 才能调用它；调用前仍会弹确认。</p>
    <div class="row" style="position:sticky;top:0;background:var(--vscode-editor-background);z-index:10;padding:6px 0;border-bottom:1px solid var(--vscode-panel-border);margin-bottom:8px;">
      <label><input type="checkbox" id="silent"/> 白名单命令免二次确认</label>
      <input id="ext-search" type="text" placeholder="搜索扩展或命令…" autocomplete="off" style="flex:1;min-width:180px;margin-left:12px;"/>
    </div>
    <div id="ext-list"><span class="hint">加载中…</span></div>
    <div id="ext-log" style="margin-top:10px;min-height:24px;font-size:13px;white-space:pre-wrap;"></div>
  </div>

  <div class="pane" id="audit">
    <h2>审计日志</h2>
    <p class="hint">记录本插件所有的环境下载 / 安装 / PATH 修改与跨插件调用，便于事后复盘。</p>
    <div class="row">
      <button id="refresh-audit">刷新</button>
    </div>
    <pre id="audit-log" style="white-space:pre-wrap;max-height:420px;overflow:auto;background:rgba(128,128,128,.08);padding:8px;border-radius:6px;font-size:12px;">（点击刷新读取）</pre>
  </div>

  <div class="pane" id="kb">
    <h2>本地知识库（AI 整理）</h2>
    <p class="hint danger">⚠️ 开启整理后，agent 读到的将是「AI 整理后」的笔记，原文不会进入上下文。建议用本地 AI（llama.cpp / Ollama）整理，数据不出本机；选云端会把源文件内容发到其服务器。</p>
    <label><input type="checkbox" id="kb-enabled"/> 开启 AI 整理（开启后知识库 RAG 只检索整理后目录）</label>
    <div class="row">
      <label>源目录（原文）</label>
      <input id="kb-source" style="flex:1;min-width:200px" placeholder="要整理的文档目录，多个用逗号分隔"/>
      <button type="button" class="pick-btn" id="kb-pick-source">选择</button>
    </div>
    <div class="row">
      <label>输出目录</label>
      <input id="kb-output" style="flex:1;min-width:200px" placeholder="C:/Users/asis/.fox-ai/knowledge（agent 读取这里）"/>
      <button type="button" class="pick-btn" id="kb-pick-output">选择</button>
    </div>
    <div class="row">
      <label>整理 AI</label>
      <select id="kb-provider">
        <option value="llamacpp">llama.cpp（本地·推荐）</option>
        <option value="ollama">Ollama（本地）</option>
        <option value="lmstudio">LM Studio（本地）</option>
        <option value="deepseek">DeepSeek（云端）</option>
        <option value="zhipu">智谱 GLM（云端）</option>
        <option value="dashscope">通义千问（云端）</option>
        <option value="moonshot">Kimi（云端）</option>
        <option value="siliconflow">硅基流动（云端）</option>
        <option value="openrouter">OpenRouter（云端）</option>
        <option value="custom">自定义</option>
      </select>
    </div>
    <div class="row">
      <label>Base URL</label>
      <input id="kb-baseurl" style="flex:1" placeholder="留空用服务商默认"/>
    </div>
    <div class="row">
      <label>模型名</label>
      <input id="kb-model" style="flex:1" placeholder="留空用服务商默认（建议长上下文模型）"/>
    </div>
    <div class="row">
      <label>API Key</label>
      <input id="kb-key" type="password" style="flex:1" placeholder="选云端模型时填写；本地模型留空。会写入该服务商独立的 SecretStorage"/>
    </div>
    <div class="row">
      <button id="kb-organize">开始整理</button>
      <button id="kb-rebuild">重建索引</button>
      <span id="kb-stat" class="hint"></span>
    </div>
    <pre id="kb-log" style="white-space:pre-wrap;max-height:260px;overflow:auto;background:rgba(128,128,128,.08);padding:8px;border-radius:6px;font-size:12px;margin-top:8px;"></pre>
    <hr style="margin:14px 0;border:none;border-top:1px solid rgba(128,128,128,.25)"/>
    <h3>自动压缩（知识库-2）</h3>
    <p class="hint">上下文用量超过阈值时，自动把较早的对话用上方「整理 AI」压缩成摘要，写入独立的「知识库-2」目录；agent 之后通过本地知识库检索继续衔接，上下文立即变小。依赖 foxAi.contextWindow 已正确设置。</p>
    <label><input type="checkbox" id="kb-auto-enabled"/> 开启上下文超限自动压缩</label>
    <div class="row">
      <label>触发阈值（占窗口）</label>
      <input id="kb-auto-threshold" type="number" min="0.1" max="1" step="0.05" style="width:90px" placeholder="0.9"/>
    </div>
    <div class="row">
      <label>保留最近条数</label>
      <input id="kb-auto-keep" type="number" min="2" max="40" step="1" style="width:90px" placeholder="6"/>
    </div>
    <div class="row">
      <label>知识库-2 目录</label>
      <input id="kb-auto-dir" style="flex:1;min-width:200px" placeholder="C:/Users/asis/.fox-ai/knowledge-2（agent 检索这里）"/>
    </div>
  </div>

  <div class="pane" id="tasks">
    <h2>任务管理器（Harness 长期记忆）</h2>
    <p class="hint">每次对话 / 智能体任务都会记录状态与步骤，崩溃后也可在此查看遗留任务。点击任务展开详情与操作按钮；失败 / 暂停 / 排队的任务可点「续跑任务」从断点继续。</p>
    <div class="row">
      <button id="refresh-tasks">刷新</button>
      <button id="clear-done-tasks">清空已完成</button>
      <label style="margin-left:12px;"><input type="checkbox" id="show-done"/> 显示已完成</label>
    </div>
    <div id="task-list" style="margin-top:8px;"><span class="hint">加载中…</span></div>
  </div>

  <div class="pane" id="project">
    <h2>项目概览 / 地图</h2>
    <p class="hint">自动识别关键文档、程序入口、配置文件、AI 模型等；像文件管理器一样展开目录并勾选文件，再点「发给 AI」让狐狸 AI 读取。</p>
    <div class="row">
      <button id="refresh-project">刷新</button>
      <button id="ask-project">让 AI 梳理项目</button>
      <button id="ask-selected">将选中文件发给 AI</button>
      <span id="project-selection" class="hint">已选 0 个文件</span>
    </div>
    <div class="row">
      <label>展开深度</label>
      <select id="project-depth">
        <option value="1">1 层</option>
        <option value="2" selected>2 层</option>
        <option value="3">3 层</option>
      </select>
      <label style="margin-left:8px;"><input type="checkbox" id="project-code-only"/> 只看源码</label>
    </div>
    <div id="project-info" class="hint"></div>
    <div id="project-list"><span class="hint">加载中…</span></div>
  </div>

  <div class="pane" id="mcp">
    <h2>MCP 服务器管理</h2>
    <p class="hint">MCP（Model Context Protocol）让狐狸 AI 能调用外部服务器提供的工具。每个服务器的工具会以 <code>mcp__&lt;id&gt;__&lt;工具名&gt;</code> 的命名形式进入智能体，不会与本地 CLI 工具冲突。</p>
    <div class="row">
      <label style="width:auto">总开关</label>
      <input type="checkbox" id="mcp-enabled"/>
      <span id="mcp-status" class="hint"></span>
    </div>
    <p class="hint danger">⚠️ 启动服务器会拉起外部进程 / 建立网络连接。已启用命令白名单、内网访问限制与敏感环境变量过滤；新增服务器前会做安全检查，危险配置会被拒绝。</p>
    <div class="row">
      <button id="refresh-mcp">刷新状态</button>
      <button id="add-mcp">+ 添加服务器</button>
      <button id="setup-mcp-deps">检查并安装依赖</button>
      <button id="import-vscode-mcp">导入 VS Code 配置</button>
    </div>

    <div id="mcp-editor" style="display:none;margin:12px 0;border:1px solid var(--vscode-panel-border);border-radius:8px;padding:10px;background:var(--vscode-editor-background);">
      <h3 id="mcp-editor-title">添加服务器</h3>
      <p class="hint">先选一个快速预设，或按下方说明手动填写。保存后会立即做一次安全检查。</p>
      <div class="preset-row">
        <span class="hint" style="margin:0;align-self:center">快速预设：</span>
        <button class="preset-btn" data-preset="filesystem">📁 文件系统（读取本地目录）</button>
        <button class="preset-btn" data-preset="playwright">🌐 Playwright（浏览器自动化）</button>
        <button class="preset-btn" data-preset="clear">清空</button>
      </div>

      <div class="mcp-field">
        <div class="row"><label>id</label><input id="mcp-id" style="flex:1" placeholder="filesystem"/></div>
        <div class="field-help">唯一英文标识，建议小写无空格。<strong>效果</strong>：该服务器的工具在对话里以 <code>mcp__id__工具名</code> 出现，例如 <code>mcp__filesystem__list_directory</code>。</div>
      </div>

      <div class="mcp-field">
        <div class="row"><label>传输</label>
          <select id="mcp-transport">
            <option value="stdio">stdio（启动本地进程）</option>
            <option value="sse">sse（连接远程 HTTP 服务）</option>
          </select>
        </div>
        <div class="field-help"><strong>stdio</strong>：在本地启动一个命令行进程来提供 MCP 服务，最常见；<strong>sse</strong>：连接一个已经运行中的 HTTP/SSE 服务。</div>
      </div>

      <div id="mcp-stdio-fields">
        <div class="mcp-field">
          <div class="row"><label>命令</label><input id="mcp-command" value="npx" style="flex:1"/></div>
          <div class="field-help">启动服务器的可执行文件。新手直接用 <code>npx</code> 即可，它会自动下载并执行 npm 包。必须是白名单内的命令（npx / node / python 等）。</div>
        </div>
        <div class="mcp-field">
          <div class="row"><label>参数</label><input id="mcp-args" placeholder="-y @modelcontextprotocol/server-filesystem C:/path/to/folder" style="flex:1"/></div>
          <div class="field-help">传给命令的参数，按空格分隔。上例会启动官方文件系统 MCP，并把指定目录暴露给 AI。<strong>把 C:/path/to/folder 换成你想让 AI 读取的真实路径</strong>。</div>
        </div>
      </div>

      <div id="mcp-sse-fields" style="display:none">
        <div class="mcp-field">
          <div class="row"><label>URL</label><input id="mcp-url" placeholder="http://localhost:8000/sse" style="flex:1"/></div>
          <div class="field-help">远程 MCP 服务器的 SSE 端点地址。出于安全，默认禁止连接内网 / localhost，如需本地服务请在设置开启 <code>foxAi.mcp.allowPrivateUrls</code>。</div>
        </div>
        <div class="mcp-field">
          <div class="row"><label>Headers</label><input id="mcp-headers" placeholder='{"Authorization":"Bearer xxx"}' style="flex:1"/></div>
          <div class="field-help">可选 JSON。用于鉴权，如 Bearer Token。没有则留空。</div>
        </div>
      </div>

      <div class="mcp-field">
        <div class="row"><label>环境变量</label><input id="mcp-env" placeholder='{"OPENAI_API_KEY":"sk-xxx"}' style="flex:1"/></div>
        <div class="field-help">可选 JSON，会传给服务器子进程。默认会过滤掉含 token / secret / password 等敏感变量；如需放行，请在 <code>foxAi.mcp.allowedEnv</code> 里加白名单。</div>
      </div>

      <div class="row" style="align-items:flex-start">
        <label style="width:auto"><input type="checkbox" id="mcp-enabled-item"/> 启用</label>
        <label style="width:auto;margin-left:12px"><input type="checkbox" id="mcp-flat"/> 扁平暴露</label>
      </div>
      <div class="field-help" style="margin-left:0"><strong>启用</strong>：保存后立即尝试启动该服务器。<strong>扁平暴露</strong>：关闭时工具以 <code>mcp__id__name</code> 隔离；开启时以原名暴露，若与本地工具同名则按 <code>foxAi.mcp.priority</code> 裁决。</div>

      <div class="row">
        <button id="mcp-save">保存</button>
        <button id="mcp-cancel-edit">取消</button>
        <span id="mcp-editor-msg" class="hint"></span>
      </div>
    </div>

    <div id="mcp-list"><span class="hint">加载中…</span></div>

    <div id="mcp-catalog-section" style="margin-top:16px;border-top:1px solid var(--vscode-panel-border);padding-top:12px;">
      <h3 style="margin:0 0 4px">📦 内置服务器目录（一键下载并接入）</h3>
      <p class="hint">点击「安装并使用」会自动下载依赖并接入；也可先「导入 VS Code 配置」复用你已在 VS Code 里配好的服务器（含 type:http / sse / stdio）。</p>
      <div id="mcp-catalog"><span class="hint">加载中…</span></div>
    </div>
  </div>

<script nonce="${nonce}" src="${envUri}"></script>
</body>
</html>`;
}

async function writeOrganize(cfg, patch) {
  if ('enabled' in patch) await cfg.update('knowledgeBase.organize.enabled', !!patch.enabled, vscode.ConfigurationTarget.Global);
  if (Array.isArray(patch.sourcePaths)) await cfg.update('knowledgeBase.organize.sourcePaths', patch.sourcePaths, vscode.ConfigurationTarget.Global);
  if ('outputDir' in patch) await cfg.update('knowledgeBase.organize.outputDir', patch.outputDir || '', vscode.ConfigurationTarget.Global);
  if ('provider' in patch) await cfg.update('knowledgeBase.organize.provider', patch.provider || 'llamacpp', vscode.ConfigurationTarget.Global);
  if ('baseUrl' in patch) await cfg.update('knowledgeBase.organize.baseUrl', patch.baseUrl || '', vscode.ConfigurationTarget.Global);
  if ('model' in patch) await cfg.update('knowledgeBase.organize.model', patch.model || '', vscode.ConfigurationTarget.Global);
  if ('prompt' in patch) await cfg.update('knowledgeBase.organize.prompt', patch.prompt || '', vscode.ConfigurationTarget.Global);
  if ('autoEnabled' in patch) await cfg.update('knowledgeBase.autoSummarize.enabled', !!patch.autoEnabled, vscode.ConfigurationTarget.Global);
  if ('autoThreshold' in patch) await cfg.update('knowledgeBase.autoSummarize.threshold', Number(patch.autoThreshold) || 0.9, vscode.ConfigurationTarget.Global);
  if ('autoKeep' in patch) await cfg.update('knowledgeBase.autoSummarize.keepRecent', Number(patch.autoKeep) || 6, vscode.ConfigurationTarget.Global);
  if ('autoDir' in patch) await cfg.update('knowledgeBase.autoSummarize.dir', patch.autoDir || '', vscode.ConfigurationTarget.Global);
}

/**
 * 扫描工作区，识别关键文档 / 程序入口 / 配置 / 源码目录，并尽量推断技术栈。
 * 实际识别逻辑在 src/projectScan.js（vscode 无关，便于 agent 复用）。
 * 返回 { framework, languages, roles:[{name,path,role}] }，供「项目」标签页展示与「让 AI 梳理」使用。
 */
function scanProject() {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) return { framework: '（未打开工作区）', languages: [], roles: [], tree: { root: '', nodes: [] } };
  const root = folder.uri.fsPath;
  const info = projectScan.detectProject(root);
  const tree = projectScan.buildFileTree(root, 2);
  return Object.assign({}, info, { tree });
}

function openEnvPanel(context, chatProvider, initialTab) {
  _initialTab = initialTab && initialTab !== 'env' ? initialTab : 'env';
  if (_panel) { _panel.reveal(); return; }
  const panel = vscode.window.createWebviewPanel(
    'foxAi.envManager', '狐狸 AI · 环境与插件', vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  _panel = panel;
  panel.webview.html = getHtml(context, panel.webview);

  // 面板监听器收进袋子，dispose 时一并释放，避免反复打开累加主进程 EventListener
  const bag = new DisposableBag();
  panel._bag = bag;
  bag.add(panel.webview.onDidReceiveMessage(async (msg) => {
    const cfg = vscode.workspace.getConfiguration('foxAi');

    async function refreshMcpPanel() {
      try {
        const mcpCfg = cfg.get('mcp', {}) || {};
        const autoImport = cfg.get('mcp.autoImportVSCode', true);
        const connectorsById = {};
        for (const c of mcp.getConnectors()) connectorsById[c.id] = c;
        // 自动导入 VS Code 原生 mcp.json 里的服务器到 foxAi（若开启），让它们以可管理条目
        // 出现（智能体也能调用）；已接入的不再显示只读卡片，避免重复。
        let foxServers = (mcpCfg.servers || []).slice();
        let vsServersRaw = [];
        const importedKeys = new Set();
        try {
          const sync = mcpSetup.syncVSCodeServers(cfg, { autoImport });
          foxServers = sync.servers;
          vsServersRaw = sync.vscode;
          for (const s of foxServers) {
            if (s && s.importedFromVSCode) importedKeys.add((s.sourceFile || '') + '#' + (s.sourceName || ''));
          }
        } catch (_) { /* 同步失败不影响展示 */ }
        const vscodeServers = [];
        try {
          for (const vs of vsServersRaw) {
            const key = (vs.sourceFile || '') + '#' + (vs.sourceName || '');
            if (importedKeys.has(key)) continue; // 已接入 foxAi，隐藏只读卡
            vscodeServers.push(Object.assign({}, vs, { vscodeManaged: true, status: 'vscode-managed' }));
          }
        } catch (_) { /* 发现失败不影响 fox-ai 自有服务器 */ }
        panel.webview.postMessage({
          type: 'mcpList',
          enabled: !!mcpCfg.enabled,
          autoImportVSCode: !!autoImport,
          catalog: mcpCatalog.list(),
          servers: foxServers.map((s) => {
            const conn = connectorsById[s.id];
            return Object.assign({}, s, conn ? { status: conn.status, error: conn.error } : {});
          }).concat(vscodeServers)
        });
      } catch (e) {
        console.error('[fox-ai env] refreshMcpPanel failed:', e);
        panel.webview.postMessage({ type: 'mcpList', enabled: false, catalog: [], servers: [], error: String(e.message) });
        vscode.window.showErrorMessage(tw('加载 MCP 服务器目录失败：{0}', e.message));
      }
    }

    try {
      if (msg.type === 'init') {
        panel.webview.postMessage({
          type: 'init',
          root: cfg.get('runtimes.installRoot', ''),
          mirror: cfg.get('runtimes.mirror', 'auto'),
          elevation: cfg.get('runtimes.elevation', 'always'),
          silent: cfg.get('bridge.silentAllowed', false)
        });
        if (_initialTab && _initialTab !== 'env') {
          panel.webview.postMessage({ type: 'switchTab', tab: _initialTab });
        }
      } else if (msg.type === 'initError') {
        vscode.window.showErrorMessage(tw('狐狸 AI 环境面板初始化失败：{0}', msg.error || '未知错误'));
      } else if (msg.type === 'pickRoot') {
        const uris = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false });
        if (uris && uris.length) {
          await cfg.update('runtimes.installRoot', uris[0].fsPath, vscode.ConfigurationTarget.Global);
          panel.webview.postMessage({ type: 'init', root: uris[0].fsPath });
        }
      } else if (msg.type === 'setRoot') {
        await cfg.update('runtimes.installRoot', msg.value, vscode.ConfigurationTarget.Global);
      } else if (msg.type === 'setMirror') {
        await cfg.update('runtimes.mirror', msg.value, vscode.ConfigurationTarget.Global);
      } else if (msg.type === 'setElevation') {
        await cfg.update('runtimes.elevation', msg.value, vscode.ConfigurationTarget.Global);
      } else if (msg.type === 'setSilent') {
        await cfg.update('bridge.silentAllowed', msg.value, vscode.ConfigurationTarget.Global);
      } else if (msg.type === 'install') {
        panel.webview.postMessage({ type: 'progress', id: msg.id, text: '下载中…' });
        try {
          const res = await runtimes.installRuntime(context, msg.id, {
            version: msg.version || undefined,
            installRoot: cfg.get('runtimes.installRoot', ''),
            onProgress: (p) => panel.webview.postMessage({ type: 'progress', id: msg.id, text: '下载 ' + p + '%' })
          });
          if (res && res.cancelled) panel.webview.postMessage({ type: 'installError', id: msg.id, error: '已取消' });
          else panel.webview.postMessage({ type: 'installed', id: msg.id, version: res && res.version });
        } catch (e) {
          panel.webview.postMessage({ type: 'installError', id: msg.id, error: String(e.message).split('\n')[0] });
        }
      } else if (msg.type === 'loadAudit') {
        const fs = require('fs');
        const p = require('path');
        const dir = context && context.logUri ? context.logUri.fsPath : require('os').tmpdir();
        const files = ['runtime-audit.log', 'bridge-audit.log'];
        let text = '';
        for (const f of files) {
          const fp = p.join(dir, f);
          text += `===== ${f} =====\n`;
          try { text += fs.readFileSync(fp, 'utf8'); } catch (_) { text += '（无记录）\n'; }
          text += '\n';
        }
        panel.webview.postMessage({ type: 'audit', text });
      } else if (msg.type === 'loadExt') {
        try {
          const all = bridge.listExtensions();
          const allowed = bridge.allowedCommands();
          // 第三方/内置扩展：继续排除 fox-ai 自身与内置扩展
          const exts = all.filter((e) => e.id !== 'foxai.fox-ai' && e.id !== 'fox-ai' && !e.isBuiltin);
          const out = exts.map((e) => ({
            id: e.id, displayName: e.displayName,
            commands: e.commands.map((c) => ({ command: c.command, title: c.title, allowed: allowed.includes(c.command) }))
          }));
          // 把狐狸 AI 自身命令单独列出（用户早期版本可能勾选过，现在找不到会困惑）
          const own = all.find((e) => e.id === 'foxai.fox-ai' || e.id === 'fox-ai');
          const ownCommands = own ? own.commands
            .filter((c) => allowed.includes(c.command))
            .map((c) => ({ command: c.command, title: c.title, allowed: true })) : [];
          panel.webview.postMessage({ type: 'extList', extensions: out, ownCommands });
        } catch (err) {
          panel.webview.postMessage({ type: 'extList', extensions: [], error: String(err && err.message || err) });
        }
      } else if (msg.type === 'toggleCmd') {
        const list = bridge.allowedCommands();
        const i = list.indexOf(msg.command);
        if (msg.on && i < 0) list.push(msg.command);
        if (!msg.on && i >= 0) list.splice(i, 1);
        await cfg.update('bridge.allowedCommands', list, vscode.ConfigurationTarget.Global);
      } else if (msg.type === 'callCmd') {
        try {
          const result = await bridge.callExtensionCommand(context, msg.command, msg.args, { skipConfirm: cfg.get('bridge.silentAllowed', false) });
          panel.webview.postMessage({ type: 'extResult', ok: true, command: msg.command, result });
        } catch (e) {
          panel.webview.postMessage({ type: 'extResult', ok: false, command: msg.command, error: String(e.message).split('\n')[0] });
        }
      } else if (msg.type === 'loadKnowledge') {
        const sub = cfg.get('knowledgeBase') || {};
        const org = sub.organize || {};
        const as = sub.autoSummarize || {};
        const s = kb.stats();
        panel.webview.postMessage({
          type: 'kbInit',
          enabled: !!org.enabled,
          source: (org.sourcePaths || []).join(','),
          output: org.outputDir || '',
          provider: org.provider || 'llamacpp',
          baseurl: org.baseUrl || '',
          model: org.model || '',
          defaultOutput: kbOrg.defaultOutputDir(org.outputDir),
          autoEnabled: !!as.enabled,
          autoThreshold: as.threshold != null ? as.threshold : 0.9,
          autoKeep: as.keepRecent != null ? as.keepRecent : 6,
          autoDir: as.dir || '',
          defaultAutoDir: kbOrg.defaultAutoSummaryDir(as.dir),
          stat: `当前索引：${s.files} 文件 / ${s.chunks} 片段`
        });
      } else if (msg.type === 'setKnowledge') {
        const c = msg.config || {};
        await writeOrganize(cfg, {
          enabled: !!c.enabled,
          sourcePaths: (c.source || '').split(',').map((x) => x.trim()).filter(Boolean),
          outputDir: (c.output || '').trim(),
          provider: c.provider || 'llamacpp',
          baseUrl: (c.baseurl || '').trim(),
          model: (c.model || '').trim(),
          autoEnabled: !!c.autoEnabled,
          autoThreshold: c.autoThreshold,
          autoKeep: c.autoKeep,
          autoDir: (c.autoDir || '').trim()
        });
      } else if (msg.type === 'organize') {
        if (msg.config) {
          const c = msg.config;
          await writeOrganize(cfg, {
            enabled: !!c.enabled,
            sourcePaths: (c.source || '').split(',').map((x) => x.trim()).filter(Boolean),
            outputDir: (c.output || '').trim(),
            provider: c.provider || 'llamacpp',
            baseUrl: (c.baseurl || '').trim(),
            model: (c.model || '').trim(),
            autoEnabled: !!c.autoEnabled,
            autoThreshold: c.autoThreshold,
            autoKeep: c.autoKeep,
            autoDir: (c.autoDir || '').trim()
          });
          if (c.apiKey && c.provider && !['llamacpp','ollama','lmstudio'].includes(c.provider)) {
            // 写入整理 AI 独立 secret 键，避免覆盖主控 agent 的 apiKey 槽
            await foxConfig.setOrganizeApiKey(context, c.provider, c.apiKey);
          }
        }
        kb.invalidate();
        try {
          const r = await kbOrg.organize(context, {
            onLog: (t) => panel.webview.postMessage({ type: 'kbLog', text: t })
          });
          kb.invalidate();
          const s = kb.stats();
          panel.webview.postMessage({ type: 'kbStat', text: `整理完成：成功 ${r.ok} / 失败 ${r.fail} / 跳过 ${r.skip}；索引 ${s.files} 文件` });
        } catch (e) {
          panel.webview.postMessage({ type: 'kbLog', text: '❌ 整理失败：' + String(e.message).split('\n')[0] });
        }
      } else if (msg.type === 'rebuildKb') {
        kb.invalidate();
        kb.retrieve('warmup', 1);
        const s = kb.stats();
        panel.webview.postMessage({ type: 'kbStat', text: `索引已重建：${s.files} 文件 / ${s.chunks} 片段` });
      } else if (msg.type === 'pickKbSource' || msg.type === 'pickKbOutput') {
        try {
          const isSource = msg.type === 'pickKbSource';
          const org = cfg.get('knowledgeBase.organize', {}) || {};
          const currentPaths = (org.sourcePaths || []);
          const currentOutput = (org.outputDir || '');
          const current = isSource
            ? (currentPaths.join(',') || '')
            : currentOutput;
          const defaultUri = current
            ? vscode.Uri.file(current.split(',')[0])
            : (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
              ? vscode.workspace.workspaceFolders[0].uri
              : vscode.Uri.file(require('os').homedir()));
          // 源目录改为单选、追加，避免 Windows 多选对话框按钮文案与行为异常
          const uris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: isSource ? '添加该文件夹到源目录' : '设为输出目录',
            title: isSource ? '选择要整理的一个源目录' : '选择知识库输出目录',
            defaultUri
          });
          if (uris && uris.length) {
            const picked = uris[0].fsPath;
            if (isSource) {
              if (currentPaths.includes(picked)) {
                vscode.window.showInformationMessage(tw('该目录已经在源目录列表里啦～'));
              } else {
                const next = currentPaths.concat(picked);
                await cfg.update('knowledgeBase.organize.sourcePaths', next, vscode.ConfigurationTarget.Global);
              }
            } else {
              await cfg.update('knowledgeBase.organize.outputDir', picked, vscode.ConfigurationTarget.Global);
            }
            panel.webview.postMessage({ type: 'loadKnowledge' });
          }
        } catch (e) {
          console.error('[fox-ai env] pickKb failed:', e);
          vscode.window.showErrorMessage(tw('选择目录失败：{0}', e.message));
        }
      } else if (msg.type === 'setKbKey') {
        await foxConfig.setApiKey(context, msg.provider, msg.value || '');
        panel.webview.postMessage({ type: 'kbStat', text: '已保存 ' + msg.provider + ' 的 API Key（本地 SecretStorage）' });
      } else if (msg.type === 'loadTasks') {
        const tm = chatProvider && chatProvider.taskManager;
        if (tm) panel.webview.postMessage({ type: 'taskList', tasks: await tm.listTasks() });
      } else if (msg.type === 'getTask') {
        const tm = chatProvider && chatProvider.taskManager;
        if (tm) {
          const task = await tm.getTask(msg.id);
          if (task) panel.webview.postMessage({ type: 'taskDetail', task });
        }
      } else if (msg.type === 'cancelTask') {
        const tm = chatProvider && chatProvider.taskManager;
        if (tm) { await tm.updateState(msg.id, harness.TASK_STATES.CANCELLED); panel.webview.postMessage({ type: 'taskList', tasks: await tm.listTasks() }); }
      } else if (msg.type === 'resumeTask') {
        try {
          if (chatProvider && typeof chatProvider.resumeTaskById === 'function') {
            await chatProvider.resumeTaskById(msg.id);
          }
        } catch (e) {
          vscode.window.showErrorMessage(tw('续跑失败：{0}', e.message));
        }
        const tm = chatProvider && chatProvider.taskManager;
        if (tm) panel.webview.postMessage({ type: 'taskList', tasks: await tm.listTasks() });
      } else if (msg.type === 'deleteTask') {
        const tm = chatProvider && chatProvider.taskManager;
        if (tm) {
          const task = await tm.getTask(msg.id);
          const label = (task && task.title) || '这条任务';
          const ok = await vscode.window.showWarningMessage(tw('确定删除任务「{0}」吗？此操作不可恢复。', label), { modal: true }, tw('删除'));
          if (ok === '删除') {
            await tm.deleteTask(msg.id);
            panel.webview.postMessage({ type: 'taskList', tasks: await tm.listTasks() });
            vscode.window.showInformationMessage(tw('已删除任务：{0}', label));
          }
        }
      } else if (msg.type === 'clearDoneTasks') {
        const tm = chatProvider && chatProvider.taskManager;
        if (tm) {
          const tasks = await tm.listTasks();
          const done = tasks.filter((t) => ['completed', 'cancelled'].includes(t.state));
          if (!done.length) {
            vscode.window.showInformationMessage(tw('没有已完成 / 已取消的任务可清理'));
          } else {
            const ok = await vscode.window.showWarningMessage(tw('确定清空 {0} 条已完成 / 已取消的任务吗？', done.length), { modal: true }, tw('清空'));
            if (ok === '清空') {
              for (const t of done) await tm.deleteTask(t.id);
              panel.webview.postMessage({ type: 'taskList', tasks: await tm.listTasks() });
              vscode.window.showInformationMessage(tw('已清空 {0} 条任务', done.length));
            }
          }
        }
      } else if (msg.type === 'loadMcp') {
        await refreshMcpPanel();
      } else if (msg.type === 'importVSCodeMcp') {
        try {
          await vscode.commands.executeCommand('foxAi.importVSCodeMcp');
        } catch (e) {
          vscode.window.showErrorMessage(tw('调用导入 VS Code MCP 命令失败：{0}', e.message));
        }
        await refreshMcpPanel();
      } else if (msg.type === 'installCatalogServer') {
        try {
          await vscode.commands.executeCommand('foxAi.installCatalogServer', msg.id);
        } catch (e) {
          vscode.window.showErrorMessage(tw('调用安装目录服务器命令失败：{0}', e.message));
        }
        await refreshMcpPanel();
      } else if (msg.type === 'setupMcpDeps') {
        try {
          await vscode.commands.executeCommand('foxAi.setupMcpDeps');
        } catch (e) {
          vscode.window.showErrorMessage(tw('调用 MCP 依赖安装命令失败：{0}', e.message));
        }
      } else if (msg.type === 'optimizeMemory') {
        try {
          await vscode.commands.executeCommand('foxAi.optimizeMemory');
        } catch (e) {
          vscode.window.showErrorMessage(tw('调用内存优化命令失败：{0}', e.message));
        }
      } else if (msg.type === 'cleanupFoxAi') {
        try {
          await vscode.commands.executeCommand('foxAi.cleanupFoxAi');
        } catch (e) {
          vscode.window.showErrorMessage(tw('调用清理命令失败：{0}', e.message));
        }
      } else if (msg.type === 'setMcpEnabled') {
        await cfg.update('mcp.enabled', !!msg.value, vscode.ConfigurationTarget.Global);
        try { await mcpSetup.applyConfiguredServers(); } catch (e) { console.warn('[fox-ai env] mcp apply failed', e); }
        await refreshMcpPanel();
      } else if (msg.type === 'toggleMcpServer') {
        const servers = (cfg.get('mcp.servers', []) || []).slice();
        const s = servers.find((x) => x.id === msg.id);
        if (s) { s.enabled = !!msg.enabled; await cfg.update('mcp.servers', servers, vscode.ConfigurationTarget.Global); }
        try { await mcpSetup.applyConfiguredServers(); } catch (e) { console.warn('[fox-ai env] mcp apply failed', e); }
        await refreshMcpPanel();
      } else if (msg.type === 'deleteMcpServer') {
        const servers = (cfg.get('mcp.servers', []) || []);
        const s = servers.find((x) => x.id === msg.id);
        const label = (s && s.id) || msg.id;
        const ok = await vscode.window.showWarningMessage(tw('确定删除 MCP 服务器「{0}」吗？此操作不可恢复。', label), { modal: true }, tw('删除'));
        if (ok === '删除') {
          const next = servers.filter((x) => x.id !== msg.id);
          await cfg.update('mcp.servers', next, vscode.ConfigurationTarget.Global);
          // 智能体自写的 MCP 还会把脚本写到磁盘 ~/.fox-ai/mcp-servers/<id>，
          // 若只删配置条目、不删目录，扩展重载时会通过自动发现重新加载（等于删不干净）。
          // 这里在重新应用前一并清理对应磁盘目录（仅限该根目录内，防越界）。
          try {
            const base = mcpAuthor.userMcpBaseDir();
            const dir = path.join(base, msg.id);
            if (dir !== base && dir.startsWith(base + path.sep) && fs.existsSync(dir)) {
              fs.rmSync(dir, { recursive: true, force: true });
            }
          } catch (e) { console.warn('[fox-ai env] 清理自写 MCP 目录失败', e); }
          // 若是从 VS Code 导入的，联动删除 VS Code mcp.json 里的对应条目（写回前自动备份为 .foxbak）
          if (s && s.importedFromVSCode) {
            try {
              const removed = mcpSetup.removeFromVSCodeMcpJson(s.sourceFile, s.sourceName);
              if (removed) console.log('[fox-ai env] 已联动删除 VS Code mcp.json 条目：' + (s.sourceName || s.id));
            } catch (e) { console.warn('[fox-ai env] 联动删除 VS Code 配置失败', e); }
          }
          try { await mcpSetup.applyConfiguredServers(); } catch (e) { console.warn('[fox-ai env] mcp apply failed', e); }
          await refreshMcpPanel();
        }
      } else if (msg.type === 'saveMcpServer') {
        const def = msg.def || {};
        if (def._headersError || def._envError) {
          panel.webview.postMessage({ type: 'mcpEditorError', message: 'Headers 或环境变量不是合法 JSON' });
          await refreshMcpPanel();
        }
        delete def._headersError; delete def._envError;
        // 用户在 UI 中明确添加的服务器，其声明的 env 视为已授权，标记可信（否则会被安全层剥离）
        if (def.env && typeof def.env === 'object' && Object.keys(def.env).length) def.trustedEnv = Object.keys(def.env);
        const servers = (cfg.get('mcp.servers', []) || []).slice();
        const i = servers.findIndex((x) => x.id === def.id);
        if (i >= 0) servers[i] = def; else servers.push(def);
        await cfg.update('mcp.servers', servers, vscode.ConfigurationTarget.Global);
        if (!cfg.get('mcp.enabled', false)) await cfg.update('mcp.enabled', true, vscode.ConfigurationTarget.Global);
        try { await mcpSetup.applyConfiguredServers(); } catch (e) { console.warn('[fox-ai env] mcp apply failed', e); }
        await refreshMcpPanel();
      } else if (msg.type === 'testMcpServer') {
        const servers = cfg.get('mcp.servers', []) || [];
        const def = servers.find((x) => x.id === msg.id);
        if (!def) {
          await refreshMcpPanel();
        } else {
          const policy = mcpSetup.buildPolicy(cfg);
          const verdict = mcpSecurity.validateServerDef(def, policy);
          if (!verdict.ok) {
            panel.webview.postMessage({ type: 'mcpTestResult', id: def.id, ok: false, message: '安全检查未通过：' + verdict.errors.join('；') });
          } else {
            try {
              const r = await mcpServers.registerGenericServer(def, { policy });
              if (r.ok) await mcp.refreshMcpTools();
              panel.webview.postMessage({
                type: 'mcpTestResult',
                id: def.id,
                ok: r.ok,
                message: r.ok ? ('连接成功（status=' + (r.status || 'connected') + (r.error ? '，' + r.error : '') + '）') : ('连接失败：' + (r.reason || r.error || '未知'))
              });
            } catch (e) {
              panel.webview.postMessage({ type: 'mcpTestResult', id: def.id, ok: false, message: '连接异常：' + e.message });
            }
          }
          await refreshMcpPanel();
        }
      } else if (msg.type === 'loadProject') {
        const depth = Math.max(1, Math.min(4, parseInt(msg.depth, 10) || 2));
        const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        let data;
        if (!folder) {
          data = { framework: '（未打开工作区）', languages: [], roles: [], tree: { root: '', nodes: [] } };
        } else {
          const root = folder.uri.fsPath;
          const info = projectScan.detectProject(root);
          const tree = projectScan.buildFileTree(root, depth);
          data = Object.assign({}, info, { tree });
        }
        panel.webview.postMessage({ type: 'projectList', data });
      } else if (msg.type === 'openFileAt') {
        try {
          await vscode.commands.executeCommand('foxAi.openFileAt', msg.path, msg.line || 0, '项目');
        } catch (e) {
          vscode.window.showErrorMessage(tw('打开文件失败：{0}', e.message));
        }
      } else if (msg.type === 'askProjectOutline') {
        const data = scanProject();
        const text = projectScan.projectOverviewText(data, { actionable: true });
        if (chatProvider && typeof chatProvider.ask === 'function') {
          chatProvider.ask(text, { showText: '🗺️ 梳理当前项目结构与文件作用' });
        }
      } else if (msg.type === 'askSelectedFiles') {
        const paths = Array.isArray(msg.paths) ? msg.paths : [];
        if (!paths.length || !chatProvider || typeof chatProvider.ask !== 'function') return;
        const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        const root = folder ? folder.uri.fsPath : '';
        const rels = paths.map((p) => root ? path.relative(root, p) : p);
        const text = '请读取并分析以下文件：\n' + rels.map((p) => '- ' + p.replace(/\\/g, '/')).join('\n');
        chatProvider.ask(text, { showText: '📂 读取选中的 ' + rels.length + ' 个文件' });
      }
    } catch (e) {
      vscode.window.showErrorMessage(tw('环境与插件面板出错：{0}', e.message));
    }
  }));

  panel.onDidDispose(() => {
    if (panel._bag) { try { panel._bag.dispose(); } catch (_) {} panel._bag = null; }
    _panel = null;
  });
}

module.exports = { openEnvPanel, scanProject };
