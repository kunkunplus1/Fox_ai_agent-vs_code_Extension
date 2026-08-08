'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');
const config = require('./src/config');
const { ChatViewProvider } = require('./src/chatView');
const { SessionTreeProvider } = require('./src/sessionTree');
const { createInlineProvider } = require('./src/inline');
const { listModels, requestJson } = require('./src/client');
const ws = require('./src/tools/workspace');
const term = require('./src/tools/terminal');
const undo = require('./src/undo');
const { SessionManager } = require('./src/sessions');
const { openEnvPanel } = require('./src/envView');
const extBridge = require('./src/extensionBridge');
const runtimes = require('./src/runtimes');
const knowledgeOrganizer = require('./src/knowledgeOrganizer');
const { MemoryStore, defaultPath } = require('./src/memory');
const storageMgr = require('./src/storageManager');
const { FileNavProvider } = require('./src/fileNav');
const { optimizeMemory } = require('./src/memoryOptimize');
const { cleanupFoxAi } = require('./src/cleanup');
const stealthFetchSetup = require('./src/tools/stealthFetchSetup');
const { tw } = require('./src/i18n');

let chatProvider = null;
let statusItem = null;

/**
 * 找到能用于执行 node 脚本的 node 可执行文件。
 * 注意：VS Code 扩展宿主里 process.execPath 是 Code.exe / Electron，
 * 不能直接当 node 用；必须找到真正的 node，否则脚本会被当成 Electron 启动而报错。
 */
function resolveNodeBin() {
  // 1) 优先用 PATH 里的 node
  try {
    cp.execFileSync('node', ['-v'], { stdio: 'ignore' });
    return 'node';
  } catch (_) { /* 不在 PATH */ }

  // 2) 常见安装位置（Windows）
  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs', 'node.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'node.exe'),
    process.env.NVM_HOME && path.join(process.env.NVM_HOME, 'node.exe'),
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe'
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // 3) 兜底：仍尝试 PATH 的 node（比误用 Code.exe 强）
  return 'node';
}

/**
 * 跨平台杀进程树：用于「中途取消」时长耗时子进程（如 MCP 安装里的 npm/npx）。
 * Windows 必须用 taskkill /T /F 连带子进程一起杀，否则 node 被杀后 npm 仍残留。
 */
function killTree(child) {
  if (!child || child.pid == null) return;
  if (process.platform === 'win32') {
    try {
      cp.spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    } catch (_) {}
  } else {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
}

/** 默认 MCP 依赖本地安装目录（与 setup-mcp.js / mcpSetup.js 保持一致） */
function defaultModulesPath() {
  return path.join(os.homedir(), '.fox-ai', 'mcp-modules');
}

/**
 * 用国内镜像把 npm 包安装到本地目录（默认 ~/.fox-ai/mcp-modules），
 * 并在通知栏流式显示输出、支持中途取消。失败抛错（中途取消时抛 '已取消'）。
 * 本地安装可避免用户机器上多 Node 环境导致的全局路径混乱。
 */
function installNpmLocal(pkg, title, modulesPath) {
  const target = modulesPath || defaultModulesPath();
  return vscode.window.withProgress(
    { title: (title || ('安装 ' + pkg)) + '…（可点取消）', location: vscode.ProgressLocation.Notification, cancellable: true },
    (progress, token) => new Promise((resolve, reject) => {
      fs.mkdirSync(target, { recursive: true });
      const pkgFile = path.join(target, 'package.json');
      if (!fs.existsSync(pkgFile)) {
        fs.writeFileSync(pkgFile, JSON.stringify({ name: 'fox-ai-mcp-modules', version: '1.0.0', private: true }, null, 2));
      }
      const child = cp.spawn(
        'npm', ['install', '--no-audit', '--no-fund', pkg],
        { shell: true, windowsHide: true, cwd: target, env: Object.assign({}, process.env, { npm_config_registry: 'https://registry.npmmirror.com' }) }
      );
      let cancelled = false;
      if (token) token.onCancellationRequested(() => { cancelled = true; killTree(child); });
      const { StringDecoder } = require('string_decoder');
      const decoder = new StringDecoder('utf8');
      let buf = '';
      const ANSI = /\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07|\x1b\[[0-9;]*[A-Za-z]/g;
      const cleanLine = (s) => s.replace(ANSI, '').split('\r').pop().trim();
      const onData = (chunk) => {
        buf += decoder.write(chunk);
        const nl = buf.lastIndexOf('\n');
        const head = nl >= 0 ? buf.slice(0, nl) : '';
        const tail = nl >= 0 ? buf.slice(nl + 1) : buf;
        if (head) for (const raw of head.split('\n')) { const l = cleanLine(raw); if (l) progress.report({ message: l.slice(0, 200) }); }
        const live = cleanLine(tail);
        if (live) progress.report({ message: live.slice(0, 200) });
        buf = tail;
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', reject);
      child.on('close', (code) => {
        if (cancelled) return reject(new Error('已取消'));
        return code === 0 ? resolve() : reject(new Error('npm install 退出码 ' + code));
      });
    })
  );
}

function activate(context) {
  ws.registerDiffProvider(context);

  chatProvider = new ChatViewProvider(context);
  // 扩展停用时统一释放 provider 持有的监听器（侧边栏 webview / 可移动面板）
  context.subscriptions.push({ dispose: () => { try { chatProvider.dispose(); } catch (_) {} } });
  // 对话窗口现在以可移动编辑器标签页（WebviewPanel）形式存在，不再占用侧边栏

  /* ---------------- 会话侧边栏 ---------------- */
  const sessionTree = new SessionTreeProvider(chatProvider.sessionManager, chatProvider);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('foxAi.sessions', sessionTree)
  );
  // 当会话变化时刷新树；注册后再主动刷新一次，避免视图在 provider 就绪前已可见导致空白
  // 返回值（Disposable）必须收进 subscriptions，否则每次 activate 都会追加一个残留监听器
  context.subscriptions.push(
    chatProvider.sessionManager.onChange(() => sessionTree.refresh())
  );
  sessionTree.refresh();

  /* ---------------- 文件导航树（栏目表点击跳转） ---------------- */
  const fileNav = new FileNavProvider();
  chatProvider.fileNav = fileNav;
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('foxAi.files', fileNav)
  );

  /* ---------------- 状态栏 ---------------- */
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'foxAi.openChat';
  context.subscriptions.push(statusItem);
  updateStatusBar();
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('foxAi')) {
          if (e.affectsConfiguration('foxAi.runtimes.elevation')) runtimes.resetElevationCache();
          updateStatusBar();
        if (chatProvider) {
          // 配置变化时立即取消当前正在运行的请求，避免旧 provider/model 的请求继续占用导致“热切换卡顿”
          if (chatProvider.isBusy()) {
            chatProvider.stop();
            chatProvider.postNotice && chatProvider.postNotice('模型/服务配置已变更，当前请求已取消；下次发送将使用新配置。');
          }
          chatProvider.pushStatus();
        }
      }
    })
  );

  /* ---------------- 行内补全 ---------------- */
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      createInlineProvider(context)
    )
  );

  /* ---------------- MCP 连接器（实验） ----------------
     启动时若开启 foxAi.mcp.enabled 且有已注册连接器，则拉取远程工具；
     配置变更时重新拉取。当前骨架未内置任何连接器，故默认无副作用。 */
  const mcp = require('./src/tools/mcp');
  const refreshMcp = () => { try { mcp.refreshMcpTools(); } catch (_) {} };
  refreshMcp();
  const mcpServers = require('./src/tools/mcpServers');
  const mcpSetup = require('./src/tools/mcpSetup');
  const mcpCatalog = require('./src/mcpCatalog');
  const mcpAuthor = require('./src/tools/mcpAuthor');

  // 依据配置注册所有 MCP 服务器（含 foxAi.mcp.servers 与 Playwright 快捷开关）
  const registerConfiguredServers = async () => {
    try {
      // 用超时包裹，防止启动卡死（例如 npx 下载耗时）
      const withTimeout = (p, ms) =>
        Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('连接超时')), ms))]);
      await withTimeout(mcpSetup.applyConfiguredServers(), 15000);
    } catch (e) {
      // 未安装依赖或连接失败：仅记录，不影响其余功能
      console.warn('[狐狸 AI] MCP 服务器注册未全部完成：', e && e.message);
    }
  };
  registerConfiguredServers();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('foxAi.mcp')) {
        refreshMcp();
        registerConfiguredServers();
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('foxAi.listMcpConnectors', () => {
      const list = mcp.getConnectors();
      if (!list.length) {
        vscode.window.showInformationMessage(tw('[狐狸 AI] 当前没有已注册的 MCP 连接器（Playwright 需开启 foxAi.mcp.enabled 与 foxAi.mcp.playwright.enabled）。'));
        return;
      }
      const lines = list.map((c) => `${c.id} [${c.transport}] status=${c.status}${c.error ? ' err=' + c.error : ''} tools=${c.toolCount}`).join('\n');
      vscode.window.showInformationMessage(tw('[狐狸 AI] MCP 连接器：\n{0}', lines));
    })
  );

  /* ---------------- Quick Fix：用 AI 修问题 ---------------- */
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { pattern: '**' },
      {
        provideCodeActions(document, range, ctx) {
          const diags = (ctx.diagnostics || []).filter(
            (d) => d.severity <= vscode.DiagnosticSeverity.Warning
          );
          if (!diags.length) return;
          const action = new vscode.CodeAction(
            '🦊 让狐狸 AI 修复这个问题',
            vscode.CodeActionKind.QuickFix
          );
          action.command = {
            command: 'foxAi.fixDiagnostic',
            title: '修复',
            arguments: [document.uri, range, diags.map((d) => ({
              message: d.message,
              line: d.range.start.line + 1,
              source: d.source || '',
              code: d.code && typeof d.code === 'object' ? d.code.value : d.code
            }))]
          };
          return [action];
        }
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    )
  );

  /* ---------------- 命令 ---------------- */
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // 一键检查 / 安装 MCP 实验功能依赖（@modelcontextprotocol/sdk + @playwright/mcp + 浏览器）
  reg('foxAi.setupMcpDeps', async () => {
    const script = path.join(context.extensionPath, 'scripts', 'setup-mcp.js');
    const nodeBin = resolveNodeBin();
    // 默认装到用户主目录下独立目录（清晰、不被扩展更新清掉）；用户可在设置里自定义
    const DEFAULT_MCP_MODULES = path.join(os.homedir(), '.fox-ai', 'mcp-modules');
    const cfg = vscode.workspace.getConfiguration('foxAi');
    let modulesPath = cfg.get('mcp.modulesPath') || '';
    let autoWrotePath = false;
    if (!modulesPath) {
      modulesPath = DEFAULT_MCP_MODULES; // 未设置时用默认干净目录，安装后自动写回设置
    }
    try {
      // 检查：用 spawnSync，依赖缺失时脚本会返回非 0（exit 2），属正常「待安装」状态，
      // 不能当作异常抛出——要读取 stdout 把报告展示给用户。
      const checkArgs = [script, '--check', '--prefix', modulesPath];
      const r = cp.spawnSync(nodeBin, checkArgs, { encoding: 'utf8', timeout: 30000 });
      if (r.error) throw r.error; // 例如 node 找不到
      const report = (r.stdout || '') + (r.stderr || '');
      const choice = await vscode.window.showInformationMessage(
        report + '\n是否现在自动安装缺失的依赖？（需要联网与 npm）',
        { modal: true }, '安装', '稍后手动'
      );
      if (choice === '安装') {
        await vscode.window.withProgress(
          { title: '安装 MCP 依赖…（含百分比，可点取消）', location: vscode.ProgressLocation.Notification, cancellable: true },
          (progress, token) => new Promise((resolve, reject) => {
            const installArgs = [script, '--install', '--prefix', modulesPath];
            // 用异步 spawn，避免浏览器下载（可能数分钟）期间冻结 VS Code 界面
            // windowsHide:true 防止在 VS Code 扩展宿主里弹出 node/cmd 黑窗
            // 用 pipe 捕获 npm/npx 真实输出，实时喂到进度条消息，让用户看到下载进度
            const child = cp.spawn(nodeBin, installArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            let cancelled = false;
            if (token) {
              token.onCancellationRequested(() => {
                cancelled = true;
                killTree(child); // 连带杀掉 npm/npx 子进程
              });
            }
            const { StringDecoder } = require('string_decoder');
            const decoder = new StringDecoder('utf8');
            let buf = '';
            const ANSI = /\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07|\x1b\[[0-9;]*[A-Za-z]/g;
            // 把 ANSI 转义清掉，并取一行中「最后一次 \r 之后」的内容
            // （Playwright 下载百分比用同一行 \r 覆盖刷新，必须这样取才能拿到实时百分比）
            const cleanLine = (s) => s.replace(ANSI, '').split('\r').pop().trim();
            const onData = (chunk) => {
              buf += decoder.write(chunk);
              const nl = buf.lastIndexOf('\n');
              const head = nl >= 0 ? buf.slice(0, nl) : '';
              const tail = nl >= 0 ? buf.slice(nl + 1) : buf;
              // 已换行的完整行：作为阶段信息（如「[3/3]…」「Chromium downloaded to …」）
              if (head) {
                for (const raw of head.split('\n')) {
                  const line = cleanLine(raw);
                  if (line) progress.report({ message: line.slice(0, 220) });
                }
              }
              // 当前未完成行：含实时下载百分比（如「Downloading Chromium … 45%」），提取百分比显示
              const live = cleanLine(tail);
              if (live) {
                const m = live.match(/(\d{1,3})\s*%/);
                progress.report({ message: (m ? m[0] + '  ' : '') + live.slice(0, 200) });
              }
              buf = tail;
            };
            child.stdout.on('data', onData);
            child.stderr.on('data', onData);
            child.on('error', reject);
            child.on('close', (code) => {
              if (cancelled) return reject(new Error('已取消'));
              return code === 0 ? resolve() : reject(new Error('安装进程退出码 ' + code));
            });
          })
        );
        // 安装成功后自动把 modulesPath 写进全局设置，扩展即可加载 SDK，无需手动设置
        try {
          await cfg.update('mcp.modulesPath', modulesPath, vscode.ConfigurationTarget.Global);
          autoWrotePath = true;
        } catch (_) {}
        vscode.window.showInformationMessage(
          '[狐狸 AI] MCP 依赖安装完成。' +
          (autoWrotePath ? `已自动将 foxAi.mcp.modulesPath 设为 ${modulesPath}。` : '') +
          '可在设置里开启 foxAi.mcp.enabled 并配置服务器。'
        );
      }
    } catch (e) {
      vscode.window.showErrorMessage(tw('[狐狸 AI] MCP 依赖检查/安装失败：{0}', e && e.message));
    }
  });

  // 百宝箱：内存优化、清理狐狸 AI 垃圾
  reg('foxAi.optimizeMemory', async () => {
    try {
      const result = await optimizeMemory();
      return result;
    }
    catch (e) {
      const m = e && e.message;
      if (m === '已取消') {
        vscode.window.showInformationMessage(tw('[狐狸 AI] 已取消内存优化。'));
        throw e;
      }
      vscode.window.showErrorMessage(tw('[狐狸 AI] 内存优化失败：{0}', m));
      throw e;
    }
  });
  reg('foxAi.cleanupFoxAi', async () => {
    try { await cleanupFoxAi(context); }
    catch (e) {
      const m = e && e.message;
      if (m === '已取消') vscode.window.showInformationMessage(tw('[狐狸 AI] 已取消清理。'));
      else vscode.window.showErrorMessage(tw('[狐狸 AI] 清理失败：{0}', m));
    }
  });

  // 导入 VS Code 已配置的 MCP 服务器（.vscode/mcp.json + 用户 mcp.json）
  reg('foxAi.importVSCodeMcp', async () => {
    try {
      const discovered = mcpSetup.discoverVSCodeServers();
      if (!discovered.length) {
        vscode.window.showInformationMessage(tw('[狐狸 AI] 没有在 VS Code 配置（.vscode/mcp.json / 用户 mcp.json）中发现任何 MCP 服务器。'));
        return;
      }
      const cfg = vscode.workspace.getConfiguration('foxAi');
      const existing = (cfg.get('mcp.servers', []) || []).slice();
      const merged = existing.slice();
      let added = 0;
      for (const d of discovered) {
        if (!merged.some((s) => s.id === d.id)) { merged.push(d); added++; }
      }
      if (added) {
        await cfg.update('mcp.servers', merged, vscode.ConfigurationTarget.Global);
        if (!cfg.get('mcp.enabled', false)) await cfg.update('mcp.enabled', true, vscode.ConfigurationTarget.Global);
      }
      await mcpSetup.applyConfiguredServers();
      vscode.window.showInformationMessage(
        `[狐狸 AI] 已从 VS Code 配置导入 ${added} 个（共 ${merged.length} 个）MCP 服务器，并已尝试接入。可在「🌐 MCP」面板查看状态。`
      );
    } catch (e) {
      vscode.window.showErrorMessage(tw('[狐狸 AI] 导入 VS Code MCP 失败：{0}', e.message));
    }
  });

  // 从内置目录一键下载并接入某个 MCP 服务器
  reg('foxAi.installCatalogServer', async (id) => {
    const entry = mcpCatalog.find(id);
    if (!entry) { vscode.window.showErrorMessage(tw('[狐狸 AI] 未找到目录项：{0}', id)); return; }
    try {
      // 收集需要的环境变量（如 GitHub / Brave 的 token），用户可中途取消
      const env = {};
      if (entry.needsEnv && entry.needsEnv.length) {
        for (const ne of entry.needsEnv) {
          const val = await vscode.window.showInputBox({ prompt: ne.label, password: !!ne.secret, ignoreFocusOut: true });
          if (val === undefined) { vscode.window.showInformationMessage(tw('[狐狸 AI] 已取消安装。')); return; }
          env[ne.key] = val;
        }
      }

      const cfg = vscode.workspace.getConfiguration('foxAi');
      const modulesPath = cfg.get('mcp.modulesPath') || defaultModulesPath();
      const wsFolder = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0])
        ? vscode.workspace.workspaceFolders[0].uri.fsPath : '';

      // 内置服务器：用 fox-ai 自写 MCP 能力生成纯 Node 脚本，无需下载。
      if (entry.install && entry.install.type === 'builtin') {
        const source = mcpAuthor.buildBuiltinServer(entry.id);
        if (!source) throw new Error('不支持的内置 MCP 服务器：' + entry.id);
        const spec = mcpAuthor.getBuiltinSpec(entry.id);
        const builtinEnv = wsFolder ? { FOX_AI_WORKSPACE_FOLDER: wsFolder } : undefined;
        const r = await mcpAuthor.registerUserServer({
          name: entry.id,
          description: spec.description,
          script: source,
          cfg,
          context,
          env: builtinEnv,
          trustedEnv: ['FOX_AI_WORKSPACE_FOLDER']
        });
        if (!r.ok) throw new Error(r.error);
        vscode.window.showInformationMessage(
          `[狐狸 AI] 已安装并接入内置 MCP 服务器：${entry.name}（${entry.id}）。其工具将以 mcp__${entry.id}__* 形式进入对话。`
        );
        return;
      }

      // 下载依赖到本地模块目录（与 SDK/Playwright 一致），失败不阻塞配置写入
      let installErr = null;
      // python 类型：自动配置 venv + 安装 curl_cffi（带百分比进度），再用 venv python 启动
      let pythonCommand = null;
      let pythonArgs = null;
      if (entry.install && entry.install.type === 'python') {
        const r = await stealthFetchSetup.installStealthFetch({ context });
        if (!r.ok) throw new Error(r.error || 'Python 环境配置失败');
        pythonCommand = r.venvPython;
        pythonArgs = [r.serverPy];
      } else if (entry.install && entry.install.type === 'npm') {
        try {
          await installNpmLocal(entry.install.pkg, '安装 ' + entry.name, modulesPath);
        } catch (e) {
          installErr = e && e.message;
          if (installErr === '已取消') {
            vscode.window.showInformationMessage(tw('[狐狸 AI] 已取消安装。'));
            return;
          }
          vscode.window.showWarningMessage(tw('[狐狸 AI] 下载依赖时出现问题，仍会继续写入配置：{0}', installErr));
        }
      }

      // 把 ${workspaceFolder} 替换为当前工作区根目录；优先用本地模块目录启动
      const args = pythonArgs || (entry.args || []).map((a) => String(a).replace(/\$\{workspaceFolder\}/g, wsFolder));
      // npx 包名会在 mcpServers.js 里根据 foxAi.mcp.modulesPath 解析成本地入口直接执行，
      // 这里保持 args 干净，避免 Windows 下 --prefix 参数被误当成包名。
      const def = { id: entry.id, transport: entry.transport || 'stdio', command: pythonCommand || entry.command || 'npx', args, enabled: true, source: 'catalog' };
      if (entry.url) def.url = entry.url;
      if (Object.keys(env).length) { def.env = env; def.trustedEnv = Object.keys(env); }
      if (entry.headers) def.headers = entry.headers;
      const servers = (cfg.get('mcp.servers', []) || []).slice();
      const i = servers.findIndex((s) => s.id === def.id);
      if (i >= 0) servers[i] = def; else servers.push(def);
      await cfg.update('mcp.servers', servers, vscode.ConfigurationTarget.Global);
      if (!cfg.get('mcp.enabled', false)) await cfg.update('mcp.enabled', true, vscode.ConfigurationTarget.Global);
      try { await mcpSetup.applyConfiguredServers(); } catch (e) { console.warn('[fox-ai] applyConfiguredServers failed:', e); }

      if (installErr) {
        vscode.window.showWarningMessage(
          `[狐狸 AI] 已添加 MCP 服务器：${entry.name}（${entry.id}），但依赖下载失败。请检查网络或点击面板「检查并安装依赖」重试。`
        );
      } else {
        vscode.window.showInformationMessage(
          `[狐狸 AI] 已安装并接入 MCP 服务器：${entry.name}（${entry.id}）。其工具将以 mcp__${entry.id}__* 形式进入对话。`
        );
      }
    } catch (e) {
      const m = e && e.message;
      if (m === '已取消') vscode.window.showInformationMessage(tw('[狐狸 AI] 已取消安装。'));
      else vscode.window.showErrorMessage(tw('[狐狸 AI] 安装 MCP 服务器失败：{0}', m));
    }
  });

  reg('foxAi.openChat', () => chatProvider.openInPanel());
  // 兼容旧命令：现在所有对话窗口默认就是可移动面板
  reg('foxAi.openChatInPanel', () => chatProvider.openInPanel());
  reg('foxAi.newChat', () => chatProvider.newChat());
  reg('foxAi.switchSession', (id) => chatProvider.switchSession(id));
  reg('foxAi.renameSession', async (item) => {
    const sid = item && item.id;
    if (!sid) return;
    const s = chatProvider.sessionManager.load(sid);
    const title = await vscode.window.showInputBox({
      prompt: '新会话名称',
      value: s ? s.title : '新会话'
    });
    if (title === undefined) return;
    chatProvider.renameSession(sid, title || '未命名');
    sessionTree.refresh();
  });
  reg('foxAi.deleteSession', async (item) => {
    const sid = item && item.id;
    if (!sid) return;
    const ok = await vscode.window.showWarningMessage(tw('确定删除这个会话吗？'), { modal: true }, tw('删除'));
    if (ok !== '删除') return;
    chatProvider.deleteSession(sid);
    sessionTree.refresh();
  });
  reg('foxAi.setSessionStorage', async () => {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: '选择会话存储目录'
    });
    if (!uris || !uris.length) return;
    const { moved } = await chatProvider.sessionManager.migrateStorage(uris[0].fsPath);
    vscode.window.showInformationMessage(tw('会话存储位置已更新{0}', moved ? tw('，已迁移 {0} 个会话', String(moved)) : ''));
    sessionTree.refresh();
  });
  reg('foxAi.rebuildKnowledgeBase', async () => {
    const kb = require('./src/knowledgeBase');
    kb.invalidate();
    if (!kb.isEnabled()) {
      vscode.window.showWarningMessage(tw('本地知识库还没开启，请先打开 foxAi.knowledgeBase.enabled 并配置 paths。'));
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '狐狸 AI：重建本地知识库索引…（可点取消）', cancellable: true },
      async (progress, token) => {
        if (token && token.isCancellationRequested) return;
        kb.retrieve('索引预热 warmup', 1);
      }
    );
    const s = kb.stats();
    vscode.window.showInformationMessage(tw('知识库索引已重建：{0} 个文件 / {1} 个片段', s.files, s.chunks));
  });
  reg('foxAi.organizeKnowledge', async () => {
    const kb = require('./src/knowledgeBase');
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '狐狸 AI：整理知识库（AI 提炼中）…（可点取消）', cancellable: true },
      async (progress, token) => {
        const ac = new AbortController();
        if (token) token.onCancellationRequested(() => ac.abort());
        let cur = '';
        const r = await knowledgeOrganizer.organize(context, {
          onLog: (m) => {
            if (m !== cur) { progress.report({ message: m }); cur = m; }
          },
          signal: ac.signal
        });
        kb.invalidate();
        if (token && token.isCancellationRequested) return;
        vscode.window.showInformationMessage(tw('知识库整理完成：成功 {0} / 失败 {1} / 跳过 {2}', r.ok, r.fail, r.skip));
      }
    ).then(() => {}, (e) => {
      if (e && (e.message === '已取消' || (e.name === 'Canceled' || e.name === 'AbortError'))) {
        vscode.window.showInformationMessage(tw('[狐狸 AI] 已取消知识库整理。'));
      } else {
        vscode.window.showErrorMessage(tw('整理失败：{0}', e && e.message));
      }
    });
  });
  reg('foxAi.pause', () => chatProvider.session && chatProvider.session.pause());
  reg('foxAi.resume', () => chatProvider.session && chatProvider.session.resume());
  reg('foxAi.stop', () => chatProvider.stop());
  reg('foxAi.undoLastEdit', () => {
    undo.undoLast();
    if (chatProvider && chatProvider.pushStatus) chatProvider.pushStatus();
  });
  reg('foxAi.redoLastEdit', () => {
    undo.redoLast();
    if (chatProvider && chatProvider.pushStatus) chatProvider.pushStatus();
  });

  reg('foxAi.toggleAgent', async () => {
    const cfg = config.conf();
    const now = cfg.get('agent.enabled', true);
    await cfg.update('agent.enabled', !now, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(tw('智能体模式已{0}', !now ? tw('开启') : tw('关闭')));
  });

  reg('foxAi.toggleInlineCompletion', async () => {
    const cfg = config.conf();
    const now = cfg.get('inlineCompletion.enabled', false);
    await cfg.update('inlineCompletion.enabled', !now, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(tw('行内补全已{0}', !now ? tw('开启') : tw('关闭')));
  });

  /* ---------------- 长期记忆 ---------------- */
  reg('foxAi.remember', async () => {
    const text = await vscode.window.showInputBox({
      prompt: '记一条长期记忆（用户偏好 / 项目约定 / 踩坑教训）',
      placeHolder: '例如：用户偏好用中文注释 / 这个项目用 pnpm 而不是 npm'
    });
    if (!text) return;
    const tags = await vscode.window.showInputBox({
      prompt: '标签（可选，逗号分隔，便于检索）',
      placeHolder: '偏好,前端'
    });
    const store = new MemoryStore(context.globalStorageUri.fsPath);
    const item = store.add({ text, tags });
    if (item) vscode.window.showInformationMessage(tw('已记住：{0}', item.text));
  });
  reg('foxAi.openMemory', async () => {
    const file = storageMgr.getPaths(context).memory;
    try {
      const fs = require('fs');
      const path = require('path');
      const dir = path.dirname(file);
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify({ version: 1, items: [] }, null, 2), 'utf8');
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (e) {
      vscode.window.showErrorMessage(tw('打开长期记忆文件失败：{0}', e.message));
    }
  });
  reg('foxAi.openUserSkills', async () => {
    const fs = require('fs');
    const dir = storageMgr.getPaths(context).skills;
    fs.mkdirSync(dir, { recursive: true });
    try {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
    } catch (_) {
      vscode.window.showInformationMessage(tw('用户技能目录：{0}', dir));
    }
  });

  reg('foxAi.openPlanTasks', async () => {
    const file = storageMgr.getPaths(context).planTasks;
    const fs = require('fs');
    const path = require('path');
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ version: 1, items: [] }, null, 2), 'utf8');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc, { preview: false });
  });

  /* ---------------- 存储位置管理 ---------------- */
  reg('foxAi.openSessionStorage', async () => {
    const dir = storageMgr.getPaths(context).sessions;
    require('fs').mkdirSync(dir, { recursive: true });
    await storageMgr.openInVscode(dir);
  });
  reg('foxAi.openMemoryStorage', async () => {
    const file = storageMgr.getPaths(context).memory;
    const fs = require('fs');
    const path = require('path');
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ version: 1, items: [] }, null, 2), 'utf8');
    await storageMgr.openInVscode(file);
  });
  reg('foxAi.setMemoryStorage', async () => storageMgr.migrateMemory(context));
  reg('foxAi.openUserSkillStorage', async () => {
    const dir = storageMgr.getPaths(context).skills;
    require('fs').mkdirSync(dir, { recursive: true });
    await storageMgr.openInVscode(dir);
  });
  reg('foxAi.setUserSkillStorage', async () => storageMgr.migrateSkills(context));
  reg('foxAi.openPlanTaskStorage', async () => {
    const file = storageMgr.getPaths(context).planTasks;
    const fs = require('fs');
    const path = require('path');
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ version: 1, items: [] }, null, 2), 'utf8');
    await storageMgr.openInVscode(file);
  });
  reg('foxAi.setPlanTaskStorage', async () => storageMgr.migratePlanTasks(context));
  reg('foxAi.manageStorage', async () => storageMgr.manageStorage(context));

  /* ---------------- 文件导航与项目概览 ---------------- */
  reg('foxAi.openFileAt', async (p, line, op) => {
    if (!p) return;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const ln = Math.max(0, (parseInt(line, 10) || 1) - 1);
      if (ln > 0 && ln < doc.lineCount) {
        const pos = new vscode.Position(ln, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    } catch (e) {
      vscode.window.showErrorMessage(tw('打开文件失败：{0}', e.message));
    }
  });
  reg('foxAi.openAnyFile', async () => {
    const files = fileNav.allWorkspaceFiles();
    if (!files.length) {
      vscode.window.showInformationMessage(tw('当前没有打开的工作区，无法跳转。'));
      return;
    }
    const picks = files.map((f) => ({
      label: path.basename(f),
      description: path.dirname(f),
      path: f
    }));
    const picked = await vscode.window.showQuickPick(picks, {
      placeHolder: '输入关键字跳转文件（支持路径匹配）',
      matchOnDescription: true
    });
    if (picked) vscode.commands.executeCommand('foxAi.openFileAt', picked.path, 0, '跳转');
  });
  reg('foxAi.projectOutline', async () => {
    openEnvPanel(context, chatProvider, 'project');
  });

  /* ---------------- 运行环境与插件管理 ---------------- */
  reg('foxAi.openEnvManager', () => openEnvPanel(context, chatProvider));
  reg('foxAi.openTaskManager', () => openEnvPanel(context, chatProvider, 'tasks'));
  reg('foxAi.callExtensionCommand', async () => {
    const items = extBridge.commandCatalog()
      .filter((c) => !c.builtin)
      .map((c) => ({ label: c.title + '  ·  ' + c.extension, detail: c.command, command: c.command }));
    if (!items.length) { vscode.window.showInformationMessage(tw('没有发现其它可调用扩展命令')); return; }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: '选择要调用的扩展命令（需加入白名单，或在弹窗里授权一次）'
    });
    if (!picked) return;
    try {
      await extBridge.callExtensionCommand(context, picked.command, [], {});
      vscode.window.showInformationMessage(tw('已调用：{0}', picked.command));
      } catch (e) {
        vscode.window.showErrorMessage(tw('调用失败：{0}', e.message));
    }
  });
  // 把自己的能力暴露给其它扩展在授权后调用
  extBridge.registerFoxApi(context, chatProvider);

  reg('foxAi.selectProvider', async () => {
    const items = Object.keys(config.PROVIDERS).map((id) => {
      const p = config.PROVIDERS[id];
      return {
        label: (p.local ? '$(vm) ' : '$(cloud) ') + p.label,
        description: p.detail || '',
        detail: p.baseUrl ? '默认地址：' + p.baseUrl : '需要自行填写 baseUrl',
        id
      };
    });
    const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择模型服务（本地优先，无需 Key）' });
    if (!picked) return;
    const cfg = config.conf();
    await cfg.update('provider', picked.id, vscode.ConfigurationTarget.Global);
    await cfg.update('baseUrl', '', vscode.ConfigurationTarget.Global);
    await cfg.update('model', '', vscode.ConfigurationTarget.Global);

    const meta = config.PROVIDERS[picked.id];
    if (!meta.local) {
      const key = await config.getApiKey(context, picked.id);
      if (!key) {
        const go = await vscode.window.showInformationMessage(
          `${meta.label} 需要 API Key`,
          '现在设置',
          meta.keyUrl ? '去申请' : undefined
        );
        if (go === '现在设置') await vscode.commands.executeCommand('foxAi.setApiKey');
        else if (go === '去申请' && meta.keyUrl) vscode.env.openExternal(vscode.Uri.parse(meta.keyUrl));
      }
    } else if (meta.docs) {
      vscode.window.setStatusBarMessage('$(info) ' + meta.docs, 8000);
    }
    updateStatusBar();
    chatProvider.pushStatus();
  });

  reg('foxAi.selectModel', async () => {
    const cfg = await config.resolve(context);
    const picked = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在拉取模型列表…' },
      async () => {
        try {
          const models = await listModels({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
          if (!models.length) return null;
          return vscode.window.showQuickPick(models, { placeHolder: '选择模型（当前：' + cfg.model + '）' });
        } catch (e) {
          const manual = await vscode.window.showInputBox({
            prompt: '拉取失败（' + String(e.message).split('\n')[0] + '），手动输入模型名',
            value: cfg.model
          });
          return manual;
        }
      }
    );
    if (picked) {
      await config.conf().update('model', picked, vscode.ConfigurationTarget.Global);
      updateStatusBar();
      chatProvider.pushStatus();
    }
  });

  reg('foxAi.setApiKey', async () => {
    const id = config.currentProviderId();
    const meta = config.providerMeta(id);
    if (meta.local) {
      vscode.window.showInformationMessage(tw('{0} 是本地服务，不需要 API Key～', meta.label));
      return;
    }
    const value = await vscode.window.showInputBox({
      prompt: `输入 ${meta.label} 的 API Key`,
      password: true,
      ignoreFocusOut: true,
      placeHolder: meta.keyUrl ? '申请地址：' + meta.keyUrl : ''
    });
    if (value === undefined) return;
    await config.setApiKey(context, id, value.trim());
    vscode.window.showInformationMessage(tw('API Key 已安全保存到系统密钥链 ✧'));
  });

  reg('foxAi.clearApiKey', async () => {
    const id = config.currentProviderId();
    await config.clearApiKey(context, id);
    vscode.window.showInformationMessage(tw('已清除 {0} 的 API Key', config.providerMeta(id).label));
  });

  reg('foxAi.testConnection', async () => {
    const cfg = await config.resolve(context);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `正在连接 ${cfg.meta.label}…` },
      async () => {
        try {
          const t0 = Date.now();
          const res = await requestJson(cfg.baseUrl + '/chat/completions', {
            method: 'POST',
            apiKey: cfg.apiKey,
            timeout: 30000,
            body: {
              model: cfg.model,
              messages: [{ role: 'user', content: '回复两个字：正常' }],
              max_tokens: 16,
              stream: false
            }
          });
          const reply =
            (res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content) || '';
          const usedModel = res.model || cfg.model;
          if (!String(reply).trim()) {
            const choice = await vscode.window.showWarningMessage(
              `连接成功但模型返回空内容。当前模型名：${usedModel}。可能是模型名不存在或该模型不支持 chat 接口。`,
              '去改模型名',
              '打开设置'
            );
            if (choice === '去改模型名') vscode.commands.executeCommand('foxAi.selectModel');
            else if (choice === '打开设置') vscode.commands.executeCommand('workbench.action.openSettings', 'foxAi');
            return;
          }
          vscode.window.showInformationMessage(
            `连接成功 (${Date.now() - t0}ms)｜模型 ${usedModel}｜回复：${String(reply).trim().slice(0, 30)}`
          );
        } catch (e) {
          const choice = await vscode.window.showErrorMessage(
            '连接失败：' + String(e.message).split('\n').slice(0, 2).join(' '),
            '打开设置'
          );
          if (choice === '打开设置') vscode.commands.executeCommand('workbench.action.openSettings', 'foxAi');
        }
      }
    );
  });

  /* ---------------- 代码相关动作 ---------------- */

  const codeAction = (instruction, needSelection) => async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage(tw('先打开一个文件吧～'));
      return;
    }
    const doc = editor.document;
    const sel = editor.selection;
    const rel = ws.relative(doc.uri);
    let snippet = '';
    let where = '';
    if (!sel.isEmpty) {
      snippet = doc.getText(sel);
      where = `${rel} 第 ${sel.start.line + 1}-${sel.end.line + 1} 行`;
    } else if (needSelection) {
      vscode.window.showWarningMessage(tw('先选中一段代码～'));
      return;
    } else {
      where = rel + '（整个文件）';
    }
    const hidden =
      `${instruction}\n\n目标：${where}` +
      (snippet ? `\n\n\`\`\`${doc.languageId}\n${snippet}\n\`\`\`` : '\n\n请自行用 read_file 读取该文件。');
    await chatProvider.ask(instruction, { hidden, showText: `${instruction}（${where}）` });
  };

  reg('foxAi.explainCode', codeAction('解释这段代码的作用与实现思路', false));
  reg('foxAi.refactorCode', codeAction('重构优化这段代码，直接改到文件里，并说明改了什么', true));
  reg('foxAi.addComments', codeAction('给这段代码补全必要的注释与文档字符串，直接写入文件', true));
  reg('foxAi.generateTests', codeAction('为这段代码生成单元测试，并按项目已有测试框架建好测试文件', true));
  reg('foxAi.fixCode', codeAction('检查这段代码有什么问题（先看 get_diagnostics），然后修好它', false));

  reg('foxAi.askAboutSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    let where = '';
    let snippet = '';
    if (editor && !editor.selection.isEmpty) {
      const doc = editor.document;
      snippet = doc.getText(editor.selection);
      where = `${ws.relative(doc.uri)} 第 ${editor.selection.start.line + 1}-${editor.selection.end.line + 1} 行`;
    }
    const question = await vscode.window.showInputBox({
      prompt: where ? `就「${where}」提问` : '想让狐狸 AI 做什么？',
      placeHolder: '例如：把这里改成异步写法 / 这个报错怎么修'
    });
    if (!question) return;
    const hidden = snippet
      ? `${question}\n\n相关代码（${where}）：\n\`\`\`\n${snippet}\n\`\`\``
      : question;
    await chatProvider.ask(question, { hidden });
  });

  reg('foxAi.fixDiagnostic', async (uri, range, diags) => {
    const list = (diags || []).map((d) => `第 ${d.line} 行 [${d.source || ''}${d.code ? ' ' + d.code : ''}] ${d.message}`);
    const rel = uri ? ws.relative(uri) : '当前文件';
    const hidden =
      `修复 ${rel} 里的这些问题：\n${list.join('\n')}\n\n` +
      '请先 read_file 看清上下文再用 edit_file 修改，改完用 get_diagnostics 确认。';
    await chatProvider.ask(`修复 ${rel} 的 ${list.length} 个问题`, { hidden });
  });

  /* ---------------- 终端相关 ---------------- */

  reg('foxAi.explainTerminalError', async () => {
    await chatProvider.ask('看一下终端里的报错，分析原因并修好它', {
      hidden:
        '请先调用 get_terminal_output 读取终端最近的输出，找出其中的报错信息，分析根因；' +
        '如果需要改代码，先 read_file 再 edit_file，改完可以用 run_command 重新验证。'
    });
  });

  reg('foxAi.fixProblems', async () => {
    await chatProvider.ask('修复工作区里的报错', {
      hidden:
        '请调用 get_diagnostics 读取当前工作区的所有错误，逐个定位文件并修复；' +
        '每改一个文件后重新检查诊断，直到错误清零，最后总结做了哪些修改。'
    });
  });

  reg('foxAi.runAndFix', async () => {
    const command = await vscode.window.showInputBox({
      prompt: '要执行并自动修复的命令',
      value: 'npm test',
      placeHolder: '例如 npm run build / pytest / go build ./...'
    });
    if (!command) return;
    await chatProvider.ask(`执行 ${command} 并修复出现的问题`, {
      hidden:
        `请用 run_command 执行 \`${command}\`，读取输出。若失败，分析报错、定位并修改代码，` +
        '然后重新执行该命令验证，最多重试 3 轮。全部通过后简要总结。'
    });
  });

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) => {
      if (t.name === term.TERMINAL_NAME) term.clearTerminalRef();
    })
  );
}

function updateStatusBar() {
  if (!statusItem) return;
  const id = config.currentProviderId();
  const meta = config.providerMeta(id);
  const agent = config.conf().get('agent.enabled', true);
  statusItem.text = `$(flame) ${meta.local ? '本地' : ''}${config.modelName(id)}${agent ? ' · 智能体' : ''}`;
  statusItem.tooltip = `狐狸 AI\n服务：${meta.label}\n模型：${config.modelName(id)}\n模式：${agent ? '智能体（可改文件/跑命令）' : '纯问答'}\n点击打开对话面板`;
  statusItem.show();
}

function deactivate() {
  if (chatProvider) { try { chatProvider.dispose(); } catch (_) {} }
}

module.exports = { activate, deactivate };
