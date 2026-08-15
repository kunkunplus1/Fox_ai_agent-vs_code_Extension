# 狐狸 AI 智能体 · 使用说明书

> **制作人**：Cyunkun(kunkunplus1)
>
> **版本**：1.1.9
> **适用平台**：Visual Studio Code 及其兼容衍生版本（Cursor、Trae 等 API 兼容环境亦可）
> **开源协议**：GNU General Public License v3.0（GPL-3.0）

---

## 一、关于本软件

狐狸 AI 智能体（以下简称“本扩展”）是一款运行于 Visual Studio Code 的本地智能体扩展。其核心定位为：在开发者的工作区内，以智能体（Agent）模式自主完成读文件、修改代码、执行命令、查看运行报错等工程任务，并在全流程中提供暂停、继续、取消等过程控制能力。

本扩展支持以下两类模型接入方式：

1. **本地推理引擎**：llama.cpp、Ollama、LM Studio 等本地化部署的推理服务。
2. **云端 API 服务**：DeepSeek、智谱 GLM、通义千问、Kimi、硅基流动、OpenRouter 等国内合规 API 服务，以及 OpenAI 兼容接口、Anthropic Claude 等海外模型。

本说明书面向最终使用者，说明如何安装、配置并正确使用本扩展的各项功能。有关实现细节与历史变更，请以源代码与发布说明为准。

> **🦊 1.1.9 更新**：本版在既有能力基础上，重点做了「省 Token」与「DeepSeek 前缀缓存命中」两方面工程优化，并新增任务成果展示。
>
> - **省 Token**：精简系统提示词（工作准则 / 多模态指南 / 编码铁律）；MCP 自写指南改为仅在开启 `foxAi.mcp.enabled` 时注入；精简工具 schema 描述；`foxAi.agent.maxToolOutput` 默认降为 4000；项目上下文注入预算下调。
> - **DeepSeek 前缀缓存命中**：DeepSeek 的原生 `tools` 字段不参与前缀缓存，导致工具 schema 每轮原价计费、命中率封顶在约 85%。现默认对 DeepSeek 走 **text 协议**（工具写进 system、可缓存），长任务命中率可达约 98%；缓存预热补上最小 user 消息以稳定落缓存；状态栏显示「本轮命中 · 会话累计命中率」。可设 `foxAi.agent.toolProtocol=native` 覆盖回原生 function calling。
> - **任务产物与报告**：任务完成后展示「📦 本次任务产物」卡片（改动文件 + 增删行数，点击打开文件），并支持一键「📄 导出报告（Markdown）」。
> - **行内补全加强**：修复光标在最后一行时补全静默失效；新增上下文字符上限 `foxAi.inlineCompletion.maxContextChars`（默认 6000）与缩进感知，停止符收紧。
> - **其它修复**：`edit_file` 删除行范围不再残留空行、diff 预览 CRLF 归一化、`read_file` 提示修正等。

> **历史版本（1.0.0 → 1.1.23）已陆续补齐**：子代理 / 并行 Agent / 后台异步 Agent、Checkpoint 回滚、生命周期 Hooks、全仓库向量 RAG、结构化长期记忆、多厂商原生联网、知识库向量检索、引用角标可点化、深度思考、文生图、行内补全、沙盒自测、失败切换、本地弱模型适配等，详见第六节各小节。前缀缓存相关的历次迭代（稳定块前移、易变附录烤回源、只读工具去重、缓存预热等）统一收敛为上述「DeepSeek 前缀缓存命中」方案。

---

## 二、许可证

本扩展以 **GNU General Public License v3.0（GPL-3.0）** 发布，为自由软件（free software）。您享有运行、研究、分发与修改本软件的自由；在分发或修改本软件时，须遵守 GPL-3.0 中关于保持开源、提供对应源代码等条款。

> 本扩展**仅在 GitHub 发布**，未上架任何插件平台（如 VS Code Marketplace、Open VSX 等扩展商店）。请从 GitHub 官方仓库获取版本，避免通过第三方渠道下载被篡改的安装包。

许可证完整文本见仓库根目录 `LICENSE` 文件，亦可访问 <https://www.gnu.org/licenses/gpl-3.0.html> 查阅官方版本。

---

## 三、安装与激活

1. 获取扩展包 `fox-ai-1.1.9.vsix`（由源码经 `vsce package` 打包生成，或自发布渠道取得；实际文件名以你下载的版本为准）。
2. 在 Visual Studio Code 中打开扩展视图（侧边栏方块图标，或 `Ctrl+Shift+X`）。
3. 点击扩展视图右上角的 `…`（更多操作），选择 **“从 VSIX 安装”**。
4. 在文件选择对话框中定位并选中 `fox-ai-1.1.9.vsix`。
5. 安装完成后按提示 **重新加载（Reload）** 窗口以激活扩展。

> 说明：本扩展采用纯 Node.js 内置模块实现，无需额外下载运行时依赖，安装包体积小、部署轻便。活动栏使用狐狸图标（`media/fox.svg`），扩展详情页使用新头像图标（`media/fox-icon.png`）。

---

## 四、初始配置（模型接入）

首次使用前，需在设置中配置模型连接。打开 **设置 → 扩展 → 狐狸 AI**，或使用命令面板（`Ctrl+Shift+P`）执行 **“首选项：打开用户设置”** 后搜索 `foxAi`。

必须配置项：

| 配置项 | 说明 |
| --- | --- |
| `foxAi.provider` | 服务商标识（如 `deepseek`、`openai`、`anthropic` 等，或自定义）。 |
| `foxAi.baseUrl` | API 接入地址（端点）。本地引擎填写其 HTTP 地址。 |
| `foxAi.model` | 使用的模型名称。 |
| `foxAi.apiKey` | API 密钥。本地引擎若无需密钥可留空。 |

常用可选项（建议按需调整）：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `foxAi.maxTokens` | `2048` | 单条回复的最大长度。**撰写长教程、长文档时建议调大**（如 4096 或更高），否则回复可能因达到上限被截断。 |
| `foxAi.temperature` | 由扩展默认 | 采样温度，控制输出随机性。 |
| `foxAi.maxHistory` | — | 携带至模型的对话历史条数。 |
| `foxAi.agent.maxContinues` | `3` | 单条回复因长度限制被截断时，自动“继续”重调的最大次数；`0` 表示关闭自动继续。 |

配置示例（用户设置 `settings.json`）：

```json
{
  "foxAi.provider": "deepseek",
  "foxAi.baseUrl": "https://api.deepseek.com/v1",
  "foxAi.model": "deepseek-chat",
  "foxAi.apiKey": "your-api-key-here",
  "foxAi.maxTokens": 4096
}
```

---

## 五、快速上手

1. 打开目标项目文件夹作为工作区。
2. 使用命令面板执行 **“狐狸 AI：打开对话面板”**，或在活动栏点击 **狐狸 AI** 图标后从“会话”树新建/打开会话。
3. 在编辑器区域弹出的对话面板中输入任务，例如：“为当前模块补充单元测试”。
4. 智能体将按“思考 → 调用工具 → 观察结果 → 再次思考”的循环自主推进，过程中您可随时 **暂停 / 继续 / 取消**。
5. 任务完成后，结果（代码改动、命令输出、结论等）会在对话面板中汇总呈现。

> 对话面板默认在编辑器区域以可拖拽、可并排的 Webview 形式打开，而非左侧侧边栏；左侧活动栏仅保留“会话”树，便于切换与续跑历史会话。

---

## 六、功能使用说明

本章按使用场景组织，说明各项功能“如何操作”。

### 6.1 智能体对话与工作流

智能体并非简单问答工具，而是会自主循环调用工具完成任务。您只需用自然语言描述目标，例如：

- “读取 `src/agent.js`，解释主循环如何处理工具调用。”
- “把 `utils.js` 里的 `formatDate` 改为使用 `Intl.DateTimeFormat`。”
- “运行 `npm test` 并把失败用例修掉。”

过程中，深度思考过程以可折叠卡片展示，并标注计划、读取、执行、思考等分步状态，可随时展开查看。复杂任务会自动拆分为清单，逐项标记状态（待办 / 进行中 / 已完成）。

任务完成后，对话里会汇总一张「📦 本次任务产物」卡片：列出本次创建 / 修改 / 删除的文件（含增删行数），点击文件名可直接在编辑器打开；卡片底部还提供「📄 导出报告（Markdown）」按钮，一键把任务标题、改动清单与 Token 用量整理成 Markdown 报告打开，可另存归档。

### 6.2 文件操作（读 / 写 / 编辑 / 删除）

智能体可列目录、按 glob 定位文件、全文检索、按行号精确读取，并支持工作区相对路径与绝对路径。

- **写入 / 编辑**：智能体会先读取真实内容，再做精确片段替换；变更前提供差异预览（diff）。`edit_file` 支持 `start_line`/`end_line` 与字符级 `start_char`/`end_char` 限定范围，小改动无需重写整个文件。
- **删除**：删除文件时先移至回收站（而非永久删除），可在撤销中恢复。
- **工作区外文件**：修改或删除工作区外的文件时，系统会强制进行三重确认，防止误触系统或个人文件。
- **换行符**：`write_file`/`edit_file` 自动保留文件原有 `CRLF` 或 `LF`，不会把 Windows 仓库的换行全改为 LF 而导致满屏 `^M`。

### 6.3 撤销与重做

- **撤销**：一键回滚 AI 上一次文件改动（新建 / 编辑 / 删除均可撤销，删除档优先进入回收站）。命令：**“狐狸 AI：撤销上次编辑”**。
- **重做**：撤销操作后可恢复被撤销的内容——新建文件将重新生成、编辑恢复为新内容、被删文件再次删除。命令：**“狐狸 AI：重做上次撤销的编辑”**。

### 6.4 执行命令与读取终端

智能体可在可见的集成终端中执行命令，并实时将输出回传至模型，适用于依赖安装、构建、测试运行等场景。您也可要求智能体读取您自有终端中的输出，满足“查看终端报错”类诉求（目标终端需为当前活动终端）。

过程控制命令：**“狐狸 AI：暂停”** / **“取消”** / **“继续”**。取消会立即中断模型输出，并向正在运行的命令发送中断信号（Ctrl+C）。

### 6.5 规划确认模式（Plan-and-Execute）

多步骤任务默认会先列出完整计划并提交计划卡片，您点击 **“确认执行”** 后智能体才正式执行；执行中如需调整计划，必须先说明原因并再次确认。此模式可在设置 `foxAi.planAndExecute.enabled` 中关闭（关闭后退回“边思考边执行”模式）。

### 6.6 自动代码审查

每完成一轮代码写操作，智能体会自动调用只读的审查子代理对本次改动执行审查，并将意见以审查卡片展示于对话中。审查子代理仅读取、不修改、不执行命令。可在设置 `foxAi.review.enabled` 中关闭。

审查体验经过多轮优化，兼顾“快”与“准”：
- **不阻塞主回答**：审查在后台异步运行，您无需等待即可看到智能体的主结论，审查卡片稍后弹出。
- **限时注入**：主控输出前会限时（默认 8 秒，可在 `foxAi.review.injectTimeout` 调整，0 表示完全异步）等待审查结果；审查快时结论会纳入主控回答，慢时先给答案、卡片后补。
- **一键修正**：审查卡片底部有「按审查意见修正」按钮，点击后自动把审查意见作为新任务启动修正；若主任务仍在忙会自动排队、结束后应用，不再提示“还在忙”。
- **基于真实改动**：审查子代理读取文件真实前后状态生成 diff，不会被模型给出的错误编辑参数误导，避免“明明改了却说没改”的循环。

### 6.7 长期记忆（跨会话）

智能体具备跨会话长期记忆能力，用于保留用户偏好与项目约定。

- **查看/编辑**：命令 **“狐狸 AI：打开记忆文件”**（首次使用会生成空文件）。
- **存储位置**：`globalStorage/fox-ai/memory/memory.json`。
- **机制**：记忆内容作为【长期记忆】段落注入系统提示词，使智能体在多次对话间保持一致。

### 6.8 用户自建技能

允许智能体自主编写可复用工作流，并与扩展自带技能完全隔离。

- **存储路径**：`%APPDATA%/Code/User/globalStorage/fox-ai/user-skills/<name>/SKILL.md`（可附带 `run.js`）。
- **创建**：通过对话让智能体编写新技能（创建时自动执行 `node --check` 做语法校验）。
- **使用**：使用技能前需经人工确认（强制走审批流程，不会被自动批准跳过）。
- **管理**：命令 **“狐狸 AI：打开用户技能目录”** 在资源管理器中打开对应目录。

### 6.9 知识库整理与检索

- **整理**：命令 **“狐狸 AI：整理知识库”**，将散落的资料归纳为结构化节点，便于后续检索与注入。
- **检索**：默认启用 BM25 相关度检索（中文按二元组切分），按 Top-K 取回相关内容；可设置 `foxAi.knowledgeBase.topK`（默认 10）调整召回量。
- **向量语义检索（独立开关）**：在「环境面板 → 知识库 → 向量模型（语义检索）」分区可开启向量召回。**它与「AI 整理」完全独立**——只配整理模型时检索与旧版一致（纯 BM25）；同时配了向量模型时，向量先做语义召回（前置）、AI 整理继续产出笔记（在后），并可勾选「与 BM25 混合排序（RRF）」融合两种召回。支持的向量服务：Ollama（原生 `/api/embed`）、阿里百炼 `text-embedding-v4`（OpenAI 兼容端点）、智谱 GLM、硅基流动、OpenAI、Gemini/Mistral/OpenRouter 兼容端点、LM Studio、llama.cpp server；DeepSeek / Kimi / Claude 暂无官方 embedding 接口，可在 `custom` 下自配兼容端点。向量密钥存于独立的 SecretStorage 键，不与整理 AI、主对话互相覆盖。任意失败都会自动回退到 BM25，不影响知识库可用性。
- **存储位置**：知识库目录与整理结果可在设置 `foxAi.knowledgeBase.*` 中配置；向量缓存位于工作区 `.fox-ai/kb-vec.json`。

### 6.10 MCP 连接器（接入远程工具）

MCP（Model Context Protocol）连接器使智能体能够调用外部工具服务器，如网页抓取、浏览器自动化等。

- **总开关**：`foxAi.mcp.enabled`。
- **通用接入**：可在设置 `foxAi.mcp.servers` 中按标准 MCP（stdio）格式添加任意服务器，亦可在 🦊 MCP 面板中通过 UI 添加/编辑。
- **内置目录**：内置 Time / Fetch / Git 等纯 Node 实现服务器，无需下载依赖，安装即落盘并热注册。
- **Playwright 快捷开关**：`foxAi.mcp.playwright.enabled`，用于后台读取网页与可访问性树。
- **优先级**：`foxAi.mcp.priority` 可设为 `local-first` 或 `remote-first`，决定同名工具优先使用本地还是远程实现。
- **VS Code 原生 MCP**：扩展面板会只读展示 VS Code 自身 `mcp.json` 配置的服务器（标记为“VS Code 管理”），不会误改其配置。

### 6.11 上下文用量面板与自动压缩

- **用量面板**：开启 `foxAi.showContextUsage` 后，面板显示当前上下文 token 数与占比；填写 `foxAi.contextWindow`（如 128000）后才会显示百分比。
- **距离压缩指示**：面板在用量下方额外显示「自动压缩」进度——直接给出**距离触发压缩还差多少百分比 / 多少 token**，以及「已达阈值、下次对话后压缩」或「已达阈值但无可压缩对话（固定开销主导）」等状态，避免只看总占用百分比产生“快满要清空”的误解。
- **自动压缩**：当历史接近窗口上限（阈值 `foxAi.knowledgeBase.autoSummarize.threshold`，默认 0.9）时，自动对较早内容做增量摘要，保留最近 `keepRecent`（默认 6）条，以节省 token。
- **会话隔离**：同一 session 的历次压缩会追加到**同一个** `<sessionId>-summary.md` 文件，不会一次压缩产生一个新文件；检索时只读当前 session 的摘要，其他 session 完全隔离。
- **跨会话授权**：如果用户明确要求“回忆/参考其他会话”，agent 会调用 `allow_session_access` 工具弹窗请求授权；授权后该会话摘要才进入当前对话的 RAG 检索范围。

### 6.12 行内补全（对标 Copilot 的 Tab 补全）

默认开启的灰色幽灵文本行内补全，对标 GitHub Copilot 的实时补全体验：边打字边给出建议，按 `Tab` 接受、`Esc` 拒绝。仅对本地文件（`file` / `untitled`）触发，并与对话 AI 共用项目上下文，避免“牛头不对马嘴”。

- `foxAi.inlineCompletion.enabled`：总开关（**默认 true**，开箱即用；命令“狐狸 AI：切换行内补全”可一键开关）。
- `foxAi.inlineCompletion.provider`：**专用补全模型供应商**（含本地 llama.cpp / Ollama / LM Studio 及 DeepSeek / 智谱 / 通义 / Kimi / SiliconFlow / OpenRouter / 自定义）。**默认空 = 跟随主对话模型**。
- `foxAi.inlineCompletion.baseUrl`：补全专用 API 基础地址。留空则使用所选供应商默认值，或继承主对话模型。
- `foxAi.inlineCompletion.apiKey`：补全专用 API Key。留空则继承主对话模型 Key；本地供应商无需填写。
- `foxAi.inlineCompletion.model`：**专用补全模型 ID**（对标 Copilot 的独立轻量补全引擎）。留空则使用供应商默认模型或继承主对话模型；建议填一个低延迟模型专门做补全，避免拖慢/烧主模型。
- `foxAi.inlineCompletion.maxTokens`：单次补全最大 token（**默认 256**，支持补全整段函数等多行块）。
- `foxAi.inlineCompletion.maxFileLines`：超过此行数的大文件跳过补全（**默认 8000**，超大文件限流以省 token，对标 Copilot 行为）。
- `foxAi.inlineCompletion.debounce` / `.contextLines`：触发防抖（默认 350ms）与上下文行数（默认 60）。
- `foxAi.inlineCompletion.suffixLines` / `.fimStrategy`：光标后取多少行作为后缀（**默认 30**），以及是否使用 Fill-in-the-Middle 格式（**默认 auto**）。代码段中间书写时，suffix 能帮模型知道后文结构，避免补全与后文冲突；`auto` 会根据模型名自动选 `diffusion` / `codellama` / `deepseek` / `starcoder` 等 FIM token 格式。
- `foxAi.inlineCompletion.fimEndpoint`：**专用 FIM 端点开关（默认 false）**。开启后行内补全改走 DeepSeek Beta 的 `/completions` 端点（`prompt`/`suffix` 原生参数），需把本补全的 `baseUrl` 设为 `https://api.deepseek.com/beta` 且模型支持 FIM（如 `deepseek-coder` / `deepseek-v4-pro`）；此模式下 `fimStrategy` 失效。关闭时走原来的 chat/completions + FIM token 方式，向后兼容。
- `foxAi.inlineCompletion.useProjectContext` / `.projectContextChars`：是否结合项目上下文（默认 true）/ 上下文最大字符数（默认 1000）。
- `foxAi.inlineCompletion.maxContextChars`：补全前后文（不含项目上下文）的最大字符数（**默认 6000**），超出时前文优先保留、后文裁剪，控制每次补全的 token 消耗。

> 提示：每次按键都会向模型发一次请求，若主模型较慢或按量计费，强烈建议把 `provider` + `model` 指向一个快模型（如 `qwen2.5-coder`、`deepseek-chat` 等）；不需要时可关闭 `enabled`。

### 6.13 项目概览与文件导航

大项目中文件多、调用关系复杂，提供两套能力以便掌控项目结构：

- **文件导航树**（活动栏“文件”视图）：分“本次会话涉及”（AI 读/写/打开过的文件，按时间倒序并标注操作类型与行号）与“工作区文件”（可展开文件树，自动跳过 `node_modules`/`.git`/`out`）。点击即跳转至对应行。
- **项目概览 / 地图**：命令 **“狐狸 AI：生成项目概览”**，自动扫描工作区并识别 `README`、入口、配置、源码目录，推断技术栈（多语言混搭亦支持），并可一键“让 AI 梳理项目”。

### 6.14 环境管理器 / 端口 / 调试控制台

环境管理器（“环境”标签页）汇总展示当前环境信息，包括转发端口（`get_ports`）与调试控制台输出（`get_debug_console`），便于智能体在需要时读取运行期信息。命令：**“狐狸 AI：打开环境管理器”**。

### 6.15 多模态识图中转

当主模型不支持图片理解、而对话中包含图片时，可开启多模态识图中转：由独立的视觉模型先将图片转述为文字描述，再交给主模型处理。相关设置位于 `foxAi.vision.*`（enabled / provider / baseUrl / apiKey / model / apiMode）。

> 带图片的输入会跳过知识库直答、直接走智能体，确保识图中转生效；如需让 AI 生成图片，见 6.17。

### 6.16 输出截断自动继续

当模型单条回复因达到 `max_tokens` 上限而被截断（`finish_reason` 为 `length` 或 `incomplete`）时，扩展会在同一对话气泡内自动插入“继续输出剩余内容”的指令并重调模型，默认最多 `foxAi.agent.maxContinues`（默认 3）次。达到上限后，面板会提示“如需继续请手动发送「继续」”。

> 若长回答频繁被截断，优先调大 `foxAi.maxTokens`，而非依赖自动继续。可在日志 `~/.fox-ai/logs/agent.log` 中查看 `[auto-continue]` 记录。

### 6.17 文生图（generate_image）

智能体可调用独立的生图模型生成图片（插画、海报、图标、概念图等）。生图是独立于主控模型的**第二个模型通道**，需单独配置后才生效：

- **开启与配置**：设置 `foxAi.imageGen.enabled` 为 `true`，并填写 `provider` / `baseUrl` / `apiKey` / `model`（如通义万相兼容端点）。未配置时，AI 会提示“生图通道未开启”而非静默失败。
- **如何触发**：用自然语言描述即可，例如“画一棵大树”“生成一张活动海报”。生图工具已设为常驻，AI 会主动调用而非用 SVG/代码替代（除非您明确要矢量图）。
- **保存与持久化**：生成的图片在对话中展示，每张图右下角有「保存」按钮，可一键另存到本地磁盘；会话中的图片会以轻量引用存档，关闭窗口再打开也能原样恢复，不再丢失。
- **结果可信**：生图结果只从约定的图片字段提取，若模型返回错误页/无关内容会明确提示“未返回可识别图片”，而不会把页面里的无关图静默渲染成“生成结果”。

> 若生图内容偶尔跑题（模型本身画歪了，而非抓错图），属生图模型质量问题，本层已兜住“抓错图”这类故障；可更换生图模型或优化描述。

### 6.18 深度思考模式（主控模型开关）

主控模型可以**一键开启「先推理、再作答」**。对话面板顶部新增 **🧠 思考** 芯片：

- **左键单击** —— 开 / 关深度思考。
- **右键单击** —— 弹出强度选择：关闭 / `low`（浅思考，快） / `medium`（均衡，推荐） / `high`（充分推理，慢且贵）。
- 芯片实时显示当前状态（`🧠 思考: 关` / `🧠 思考: medium`），切换后**当前会话立即生效**，无需重开窗口。

扩展会按您当前的服务商与协议，自动翻译成对应厂商的思考参数，您无需关心差异：

| 服务商 / 协议 | 实际下发的参数 |
| --- | --- |
| OpenAI（o 系 / gpt-5）、Gemini 2.5+、grok-3-mini、中转站同类模型 | `reasoning_effort: low\|medium\|high` |
| Responses 协议（OpenAI / DeepSeek v4） | `reasoning: { effort }`（官方 OpenAI 额外带思考摘要） |
| Claude（原生 Messages API 或中转站 claude 模型） | `thinking: { type: "enabled", budget_tokens }`，并自动把 `temperature` 置 1、抬高 `max_tokens` |
| 通义千问 Qwen3（DashScope / 硅基流动） | `enable_thinking: true` + `thinking_budget` |
| 智谱 GLM-4.5 系 | `thinking: { type: "enabled" }` |
| OpenRouter | `reasoning: { effort }` 或 `reasoning: { max_tokens }` |
| 无原生开关的模型（deepseek-chat、gpt-4o、本地 Ollama 等） | 用系统提示词兜底，要求模型分步推理后再作答 |

配套细节：

- **关闭也真的关闭**：Qwen3、GLM 这类「默认就思考」的模型，关闭开关时会主动下发 `enable_thinking: false` / `thinking.disabled`，不是放任不管。
- **非流式自动规避**：DashScope 规定非流式调用不得开启思考，扩展检测到非流式时会自动改走提示词兜底，不会因此报错。
- **参数不被接受时自动兜底**：若服务端回「不认识 reasoning_effort / enable_thinking」，扩展会去掉思考参数重试一次并提示您，不会让一个可选参数打死整轮对话。
- **思考内容展示**：模型返回的思考过程仍以可折叠的「深度思考」卡片展示，多轮对话中会正确回传。

> 深度思考会显著增加响应时长与 token 消耗，日常问答建议保持关闭，遇到疑难 bug、架构设计、复杂推理时再临时开启。

### 6.19 执行步骤时间线

智能体执行任务时，对话区顶部会浮现一条**竖向执行步骤时间线**，按真实发生顺序点亮：

- 🧠 调用模型 → 🔍 读取 → ✏️ 修改 → 🖥️ 执行命令 → ⏳ 等待审批 → ✅ 完成，运行中节点呼吸闪烁。
- 点击任意步骤可展开查看详情（如工具参数、输出摘要）。
- 关闭窗口再打开，时间线会从会话记录中自动恢复。

### 6.20 子代理 / 并行 Agent / Agent Teams

复杂任务可拆分给多个**子代理（Subagent）并行**执行，主代理负责调度与结果聚合：

- **角色分工**：内置 `coder`（写代码）/ `tester`（测试验证）/ `explorer`（只读调研）/ `researcher`（资料检索）等角色，也可自定义角色提示词。
- **工具 `spawn_subagent`**：主代理在需要时派生一个或多个子代理并行干活，互不阻塞，结果回传主对话。
- **典型场景**：大规模重构（拆模块并行改）、跨模块调研、批量修复 + 自动测试、长链路任务分治。
- 并行度、单步上限、工具调用上限、超时等可在「子代理与并行」设置组调整（见第七节）。

### 6.21 后台 / 异步 Agent

不阻塞当前对话的**后台智能体**：提交任务后立即返回，任务在后台独立运行，进度通过通知回流，您可以继续聊别的。

- **安全隔离**：在 git 仓库内自动开**独立 worktree + 独立分支**干活，**绝不碰您的主工作区文件**；非 git 仓库（或无提交）自动降级为**只读调研**。
- **可选产出 PR**：提交时带 `create_pr`，任务完成后推送分支并用 `gh` 创建 Pull Request（无 `gh` 时给出手动推送指引）。
- **治理护栏**：并发上限（默认 2，硬上限 4）、任务超时（默认 15 分钟，硬上限 1 小时）、队列上限（12）、历史保留（默认 60 条）均在「后台任务」设置组可调。
- **查看与管理**：工具 `background_jobs`（action: list/get/cancel/clear）或命令面板 **「狐狸 AI：查看后台任务」** 可视化列表（查看详情 / 打开补丁 / 取消 / 删除记录）。

### 6.22 Checkpoint 回滚

智能体在关键步骤自动打**检查点（快照）**，出错或想换思路时可一键回滚到任意历史节点：

- 命令面板 **「狐狸 AI：回滚到检查点」** → 选择检查点 → 确认即回滚。
- 设置组「检查点与回滚」：`foxAi.checkpoints.enabled` / `foxAi.checkpoints.maxSnapshots`。

### 6.23 生命周期 Hooks

在智能体运行的**生命周期节点**挂载自定义脚本，实现自动化与治理：

- **钩子时机**：`preToolUse` / `postToolUse`（工具调用前后）、会话开始 / 结束等。
- **用途**：自动格式化、安全拦截危险命令、入参/出参审计、自动打标签、外部系统联动等。
- 命令面板 **「狐狸 AI：打开 Hooks 配置」** 直接编辑（首次打开写入含示例的模板）；设置 `foxAi.hooks.enabled` 总开关。

### 6.24 全仓库向量 RAG 索引

对**整个代码仓库**建立语义索引，支持自然语言代码检索，跨大代码库也能精准定位：

- **工具 `search_codebase`**：用语义检索找到相关代码（不知道叫什么名字、刚进陌生项目时优先用）。
- **工具 `index_codebase`**：手动增量或强制重建索引；索引按文件修改时间增量更新，自动跳过未变更文件、清理已删除文件。
- 设置组「代码库语义索引」：`foxAi.rag.extensions`（纳入索引的扩展名）/ `foxAi.rag.maxFiles` / `foxAi.rag.autoRebuildHours`（自动重建间隔）。
- 命令面板 **「狐狸 AI：重建代码索引」** 可强制全量重建并带进度。

### 6.25 结构化长期记忆（主题化）

长期记忆按**主题文件**组织，可手动编辑、跨会话持久、按相关性自动注入：

- **主题分类**：项目约定 / 用户偏好 / 踩坑教训 / 架构决策 / 操作流程 / 领域知识等。
- **工具 `save_memory`**（支持 `topic` 参数自动归类）、`get_memory`（按主题或相关性取回）。
- 命令面板 **「狐狸 AI：打开主题记忆」** 浏览记忆目录。
- 设置组「结构化长期记忆」：`foxAi.memory.topics.enabled` / `.budget`（单主题预算）/ `.autoHarvest`（自动收割）。

---

### 6.26 项目规则自动读取（Project Rules）

开启后，扩展会在每次对话开始时自动读取**项目根目录的约定文件**（如 `CLAUDE.md` / `AGENTS.md` / `.fox-ai/rules` 等），注入到系统提示词，让智能体遵循项目既有规范。

- 设置组「项目规则」：`foxAi.projectRules.enabled`（默认开）/ `foxAi.projectRules.budget`（token 预算，0=不限制，超出按重要性截断以控上下文体积）。
- 关掉可省 token；大型仓库建议保留以统一风格。

### 6.27 智能体模式（Architect / Ask / Debug）

对标 Roo Code 的多模式人格：同一套智能体按模式改变**工具范围、可写路径与系统提示词**，并支持**每模式独立模型**。

- 切换命令：**「狐狸 AI：切换智能体模式」**（或设置 `foxAi.modes.current`）。
- 四种内置模式：
  - **编码 code**（默认）：全权限读写、跑命令、改 bug。
  - **架构 architect**：只做方案与设计，只允许写 Markdown/文档类文件（`editGlobs`），不改代码、不跑命令。
  - **问答 ask**：纯只读答疑，绝不改动任何东西。
  - **排错 debug**：先取证再动手，可读可改可跑命令，只做最小修复。
- 每模式独立模型：`foxAi.modes.models`（如 `{"architect":"claude-opus","ask":"deepseek-chat"}`，留空用主模型）。
- 覆盖定义：`foxAi.modes.overrides`（放开/收紧某模式文件限制或更换模型）。

### 6.28 自定义 Slash Commands

支持把常用工作流写成模板，在对话输入 `/<名字>` 即可调用，模板里用 `$ARGUMENTS` 占位。

- 项目级优先：`<workspace>/.fox-ai/commands/<名字>.md`；用户级：`~/.fox-ai/commands/<名字>.md`（可在设置 `foxAi.slashCommands.storagePath` 改）。
- 打开命令：**「狐狸 AI：打开命令模板目录」** 会自动创建示例 `review.md`。

### 6.29 Auto Mode（自动门控）

开启后，对**写/改/删/执行类动作**先用一次轻量 LLM 分类做 **allow / deny / ask** 门控，减少人工审批负担。

- 设置组「Auto Mode」：`foxAi.autoMode.enabled` / `foxAi.autoMode.allow`（白名单，命中即放行、零 LLM 开销）/ `foxAi.autoMode.deny`（黑名单，命中即拒绝）。
- 规则快路径（allow/deny 名单命中）不调用 LLM；其余情况由 LLM 判定。关闭则恢复默认人工审批。

### 6.30 Best-of-N 多模型对比

一次提问并发跑 N 个候选模型，由**评委**挑出最优回答，适合对关键任务做交叉验证。

- 工具：`best_of_n`（参数 `prompt`、`candidates`、`judge`、`temperature`）。
- 设置组「Best-of-N」：`foxAi.bestOfN.enabled` / `foxAi.bestOfN.judge`（`length`=按内容长度，`llm`=用主模型当评委更准但多一次调用，`first`=取第一个）/ `foxAi.bestOfN.candidates`（N 个 `{provider,model,baseUrl,apiKey}`，anthropic 类加 `transport:"anthropic"`）/ `foxAi.bestOfN.temperature`。
- 纯 Node、有界并发、有界缓存（命中缓存直接返回），默认关、按需懒加载。

### 6.31 冲突感知（Conflict Watch）

人类在智能体读取文件后**又改了该文件**时，智能体写前会检测到冲突并**暂停写操作转人工裁决**，避免覆盖人工改动。

- 设置：`foxAi.conflictWatch.enabled`（默认开，被动生效）。
- 机制：读文件时记 mtime/size 快照；写前比对，若被外部改动则暂停；agent 自己写入后刷新快照，不会误报。有界缓存，不常驻监听。

### 6.32 本地自动化（Automations · 纯本地）

纯本地定时/事件触发，把重复任务交给**后台 agent 异步执行**，不依赖云端、无需关机常驻。

- 两种触发：
  - **定时**：cron 表达式（`0 18 * * *`）或 interval（毫秒）。
  - **本地 webhook**：GitHub / Slack 等作为来源，向本机端口 POST 触发（只收指令、绝不回传任何内部资料，符合红线）。
- 设置组「本地自动化」：`foxAi.automations.enabled` / `foxAi.automations.storagePath`（默认 `~/.fox-ai/automations.json`）/ `foxAi.automations.webhookPort`（0=不开启）/ `foxAi.automations.webhookSecret`。
- 管理命令：**「狐狸 AI：管理自动化」** 创建/打开示例（含 `daily-summary` 与 `hourly-ping`）。

### 6.33 Headless / CI 集成

把狐狸 AI 当成一个**无状态的非流式调用**嵌入 CI / 脚本 / 命令行，输出到 stdout，退出码表成败。

- **根目录脚本**：`node foxai --prompt "..." -P deepseek`（或管道 `echo "..." | node foxai`）。支持 `--base-url`/`--api-key`/`--model`/`--transport`/`--api-mode`/`--system`/`--json`/`--verbose`/`--file` 等参数，凭据亦可用环境变量 `FOXAI_*` 注入（优先级：显式参数 > 环境变量 > 预设默认值）。
- **流式输出**：加 `-S` / `--stream`，文本逐块写到 stdout、reasoning 写到 stderr（CI 里像真人打字一样实时滚）；`--json` 时仍等结束再输出完整 JSON。
- **多轮对话（两种形态）**：
  - `--session <file>`：跨调用持久化。首次 `node foxai -p "记住我叫小明" --session chat.json -P llamacpp` 会把历史写入 `chat.json`；之后再 `node foxai -p "我刚说我叫什么？" --session chat.json -P llamacpp` 会自动带上前文。
  - `--turns <file>`：一次性批量多轮。`file` 可为 JSON 数组 `["问题1","问题2"]`，或 `{ "messages": [...种子历史], "turns": ["问题1","问题2"] }`；每个 turn 也支持 `{ "role": "user"|"assistant", "content": "..." }`。
  - 多轮模式下聊天状态只落盘到 `session`/`turns` 文件，进程本身**无常驻、无内存累积**，符合「用完即弃」约束。
- **编辑器内命令**：**「狐狸 AI：运行 Headless 调用」**（`foxAi.runHeadless`，需在设置开启 `foxAi.headless.enabled`），用当前主对话模型做一次调用，结果落到输出面板。
- 纯 Node、零 vscode 依赖，复用主对话的 client/anthropic 协议层；无缓存、无常驻监听、用完即弃，内存占用恒定。

### 6.34 统一视觉风格（1.1.4）

- **聊天面板**：`media/chat.css` 已升级为高级感主题，含统一圆角、accent 渐变辉光、毛玻璃顶栏/输入区、精致代码块与思考链卡片，动效仅走 `transform`/`opacity`（GPU 友好）。
- **环境与插件面板**：`media/env.css` 从 `src/envView.js` 内联样式抽出，复用同一套设计 token（圆角、卡片阴影、渐变按钮、细滚动条），标签页改用 pill 胶囊样式，运行环境/插件/任务/文件树/MCP 等模块统一卡片化。
- **左侧活动栏与树视图**：活动栏图标换用 `media/fox.svg`；会话树的分组带 `calendar`/`history`/`calendar-week`/`archive` 图标，当前会话用狐狸 SVG 图标，描述改为相对时间（"3 分钟前"）；文件导航树的分组带主题色图标，文件按操作类型着色。
- 所有颜色仍基于 VS Code 主题变量（`--vscode-*`），深浅主题自适应；不引入外部字体，保持轻量。

---

### 6.35 对话栏富文本渲染

对话气泡支持完整 Markdown 富文本，便于阅读代码与公式：

- **代码语法高亮**：代码块按语言（`language-xxx`）着色，语言识别失败自动降级为纯文本。
- **LaTeX 公式**：支持块级 `$$…$$` 与行内 `$…$`，由 KaTeX 渲染；含空格且无数学符号的货币片段（如 `$10 to $20`）不会被误判为公式。
- **外链图片缩略图**：`![alt](url)`、裸图链、base64 均渲染为缩略图；`javascript:` 等危险协议不生成链接，杜绝注入。
- **GFM 表格**：`| 表头 |---| … |` 渲染为带边框、隔行底色的表格，支持 `:--` / `:-:` / `--:` 对齐与单元格内联格式。

高亮与公式依赖本地 `media/vendor/`（highlight.js / KaTeX），**运行时无需联网**。

### 6.36 搜索引用角标与来源跳转

模型回答里引用的资料会以可点击角标呈现，点击用系统浏览器打开来源：

- **角标识别**：兼容中文来源标签（`（来源：xxx）`）、markdown 脚注 `[^n]`（含 OpenAI 双尖 `[^n^]`）与 `[n]`（仅当会话已有搜索编号索引时）；无对应来源时退化为不可点击的「来源 n」提示，不误导点击。
- **正文链接全部可点**：裸 `https://…` 自动变为可点击链接；外链统一走 `data-url` + 委托点击，校验 `http(s)` 后用系统默认浏览器打开（不在 webview 内导航，避免「点了没反应」）。
- **原生联网搜索也能拿到来源（多厂商统一适配）**：各主流厂商的**官方服务端联网搜索**都会被抽取真实网址并透传到角标、无需依赖本地 `web_search` 工具——① **Responses API 原生 `web_search`**：OpenAI / DeepSeek / 通义百炼（responses）在 `web_search_call` / `output[]` 与 **Chat Completions** 的 `delta.annotations` / `delta.citations` 两条路径都收割；② **Chat 标记式**：通义百炼 Chat（`enable_search` + `search_options.enable_source`，结果在 chunk 顶层 `search_info.search_results`）；③ **Chat 工具式**：智谱 GLM（`web_search` 原生工具，结果在工具消息 `search_results`）与 Kimi / Moonshot（`$web_search` 内置工具）；④ **Claude（Anthropic Messages）**：注入 server tool `web_search_20250305`，结果在 `web_search_tool_result` block + 文本 `citations[]`。所有厂商的真实 URL 都会汇入角标链接。
- **无链接角标用默认光标**，不再显示小问号。

### 6.37 沙盒代码自测

环境面板「🧪 沙盒」标签页可管理隔离运行环境，让智能体把生成的代码跑起来自测：

- **内置沙盒**（🔒 锁定，不可删）：Node.js / Python / Go / Rust / Java，开箱即用。
- **用户沙盒**（🧩 可增删）：把带 `manifest.json` 的文件夹丢进 `~/.fox-ai/sandboxes/`（或套用模板 C++ / Ruby / PHP / Bash / TS / C# / Lua / Perl）即可新增语言；新沙盒首次发现时先用 `canary` 示例实跑验证，通过才注册。
- **隔离语义**：默认进程级隔离（独立临时目录，不碰工作区）；需真隔离用 docker runner（`foxAi.sandbox.allowDocker`）。
- **工具 `run_in_sandbox`**：`action` 支持 `run`（跑代码）/ `list`（列出沙盒与状态）/ `reload`（重扫并重校验）；`sandbox` 用名称或语言模糊匹配。超时由 `foxAi.sandbox.timeout`（默认 30s）控制。
- **目录热感知**：面板打开时监听沙盒目录，手动增删文件夹自动刷新；内置沙盒受「防误删」保护，越权路径拒绝。

### 6.38 失败自动切换备用模型（Failover）

主模型挂掉 / 超时 / 限流时，可自动切到备用模型兜底：

- 设置 `foxAi.failover`：`enabled`（默认 false，关闭时零回归）、`triggers`（默认 `['timeout','connection','serverError']`，可选 `rateLimit` / `emptyResponse`）、`maxRetries`（默认 1）、`targets`（备用模型数组，每条可填本地或云端，`local: true` 表示本地不发送 API Key）。
- 行为：命中 triggers 才切换，参数错（400）不切；切换时去掉 grammar 约束避免卡死；全部失败才抛出。

### 6.39 本地 / 弱模型适配

- **协议自动选择**：`foxAi.agent.toolProtocol` 默认 `auto`，按厂商 / 模型名智能选原生 function calling 或 text 协议；本地 / 小模型走 text 协议并加固非严格 JSON 解析（单引号、未加引号键、尾部逗号等）。
- **弱模型辅助模式**：`foxAi.agent.localWeakModelMode`（`auto` / `on` / `off`）对小模型自动开启——约束解码（GBNF）、工具检索 Top-N 精简、闭环校验自我修正、上下文锚点，从根源减少格式错与选择困难。
- **grammar 探测**：`foxAi.agent.localConstrainedDecoding` 默认 `'auto'`，先探测服务端是否支持约束解码，支持才注入，不支持 / 挂起则跳过，绝不卡死。
- **本地无响应兜底**：本地模型返回空时自动以纯对话模式重试一次，保证出字。

---
## 七、设置项参考

以下为本扩展可调设置项（分组列出，便于查找）：

| 分组 | 关键配置 |
| --- | --- |
| 连接 | `foxAi.provider` / `foxAi.baseUrl` / `foxAi.model` / `foxAi.apiKey` |
| 对话 | `foxAi.temperature` / `foxAi.maxTokens` / `foxAi.maxHistory` / `foxAi.streamFormat` / `foxAi.vision.*`（多模态识图中转） |
| 深度思考 | `foxAi.deepThinking.enabled`（总开关，默认 false） / `.effort`（low·medium·high，默认 medium） / `.budgetTokens`（Claude 思考预算，0=按强度自动） / `.promptFallback`（无原生开关时用提示词兜底，默认 true） |
| 生图 | `foxAi.imageGen.enabled` / `.provider` / `.baseUrl` / `.apiKey` / `.model`（独立生图通道，需单独开启） |
| 审查注入 | `foxAi.review.enabled` / `foxAi.review.injectTimeout`（主控限时等待审查的毫秒数，0 表示完全异步） |
| 上下文用量 | `foxAi.showContextUsage`（开关面板） / `foxAi.contextWindow`（模型窗口上限，填 0 则只显示 token 数） |
| 自动压缩 | `foxAi.knowledgeBase.autoSummarize.enabled` / `.threshold`（触发阈值，默认 0.75） / `.keepRecent`（保留最近条数，默认 6） / `.dir` |
| 存储位置 | `foxAi.sessions.storagePath` / `foxAi.memory.storagePath` / `foxAi.skills.storagePath` / `foxAi.planTasks.storagePath` |
| 智能体 | `foxAi.agent.enabled` / `foxAi.agent.maxSteps` / `foxAi.agent.maxContinues` / `foxAi.agent.autoApprove` / `foxAi.agent.blockedCommands` |
| 任务清单 | `foxAi.planTask.enabled` / `.provider` / `.baseUrl` / `.model` |
| 代码验证 | `foxAi.nodePath` / `foxAi.verify.enabled` / `.provider` / `.baseUrl` / `.model` |
| MCP | `foxAi.mcp.enabled`（总开关）/ `foxAi.mcp.priority`（local-first·remote-first）/ `foxAi.mcp.servers`（通用服务器列表）/ `foxAi.mcp.playwright.enabled` |
| 安全策略 | `foxAi.policy.mode` / `.blockedPaths` / `.blockedCommands` |
| 知识库检索 | `foxAi.knowledgeBase.bm25Enabled` / `.topK`（检索 Top-K，默认 10） |
| 项目扫描 | `foxAi.projectScan.cacheEnabled`（结果缓存，默认 true） |
| 行内补全 | `foxAi.inlineCompletion.enabled`（默认 true） / `.provider`（供应商，默认空=主模型） / `.baseUrl` / `.apiKey` / `.model`（专用模型，默认空=主模型） / `.maxTokens`（默认 256） / `.maxFileLines`（默认 8000） / `.maxContextChars`（默认 6000） / `.suffixLines`（后缀行数，默认 30） / `.fimStrategy`（FIM 格式，默认 auto） / `.fimEndpoint`（专用 /completions FIM 端点开关，默认 false） / `.useProjectContext`（默认 true） / `.projectContextChars`（默认 1000） / `.debounce` / `.contextLines` |
| 智能体（续） | `foxAi.agent.maxMessageBytes`（历史总字节硬上限，默认 1048576） / `.structuredOutput` / `.projectSkeleton`（L1 代码骨架，默认 true） |
| 失败切换 | `foxAi.failover.enabled` / `.triggers` / `.maxRetries` / `.targets` |
| 沙盒 | `foxAi.sandbox.enabled` / `.dir` / `.timeout` / `.allowDocker` |
| 本地/弱模型 | `foxAi.agent.toolProtocol`（auto·native·text） / `foxAi.agent.localWeakModelMode`（auto·on·off） / `foxAi.agent.localConstrainedDecoding`（auto·on·off） |
| 子代理与并行 | `foxAi.subagents.enabled` / `.concurrency`（并行度，默认 2） / `.maxSteps` / `.maxToolCalls` / `.timeoutMs` / `.autoApproveWrites` |
| 后台任务 | `foxAi.background.enabled` / `.maxConcurrent`（默认 2，硬上限 4） / `.timeoutMs`（默认 900000） / `.maxSteps` / `.maxToolCalls` / `.allowMainWorkspaceWrites` / `.keepWorktree` / `.maxHistory`（默认 60） / `.storagePath` |
| 检查点与回滚 | `foxAi.checkpoints.enabled` / `.maxSnapshots` |
| 生命周期钩子 | `foxAi.hooks.enabled` |
| 代码库语义索引 | `foxAi.rag.extensions` / `.maxFiles` / `.autoRebuildHours` |
| 结构化长期记忆 | `foxAi.memory.topics.enabled` / `.budget` / `.autoHarvest` |
| 项目规则 | `foxAi.projectRules.enabled` / `.budget`（token 预算，0=不限制） |
| 智能体模式 | `foxAi.modes.current`（code·architect·ask·debug）/ `foxAi.modes.overrides` / `foxAi.modes.models`（每模式独立模型） |
| 自定义命令 | `foxAi.slashCommands.storagePath`（用户级模板目录） |
| Auto Mode | `foxAi.autoMode.enabled` / `foxAi.autoMode.allow`（白名单）/ `foxAi.autoMode.deny`（黑名单） |
| Best-of-N | `foxAi.bestOfN.enabled` / `foxAi.bestOfN.judge`（length·llm·first）/ `foxAi.bestOfN.candidates` / `foxAi.bestOfN.temperature` |
| 冲突感知 | `foxAi.conflictWatch.enabled`（默认开，被动生效） |
| 本地自动化 | `foxAi.automations.enabled` / `foxAi.automations.storagePath` / `foxAi.automations.webhookPort` / `foxAi.automations.webhookSecret` |
| Headless / CI | `foxAi.headless.enabled` / `foxAi.headless.provider` / `foxAi.headless.baseUrl` / `foxAi.headless.apiKey` / `foxAi.headless.model` / `foxAi.headless.apiMode` / `foxAi.headless.transport` / `foxAi.headless.temperature` / `foxAi.headless.maxTokens` / `foxAi.headless.timeout` |

---

## 八、命令参考（Ctrl+Shift+P）

常用命令（名称以“狐狸 AI：”前缀）：

- `狐狸 AI：打开对话面板` —— 打开/聚焦对话面板。
- `狐狸 AI：打开记忆文件` —— 查看与编辑长期记忆。
- `狐狸 AI：打开用户技能目录` —— 打开用户自建技能目录。
- `狐狸 AI：打开任务清单` —— 查看与编辑项目任务清单。在对话面板顶部「📋 任务」清单里，也支持点击「清理已完成」一键清掉已完成的任务。
- `狐狸 AI：打开环境管理器` —— 查看环境与端口等信息。
- `狐狸 AI：打开知识库` / `狐狸 AI：整理知识库` —— 知识库浏览与整理。
- `狐狸 AI：让狐狸 AI 修复这个问题` —— 通过 Quick Fix 灯泡菜单触发，针对错误处请求修复。
- `狐狸 AI：暂停` / `取消` / `继续` —— 过程控制。
- `狐狸 AI：撤销上次编辑` / `狐狸 AI：重做上次撤销的编辑` —— 文件改动回滚与恢复。
- `狐狸 AI：查看后台任务` —— 可视化查看后台 Agent 任务列表（详情 / 打开补丁 / 取消 / 删除记录）。
- `狐狸 AI：回滚到检查点` —— 选择检查点并一键回滚到该历史节点。
- `狐狸 AI：重建代码索引` —— 强制全量重建全仓库语义索引（带进度）。
- `狐狸 AI：打开 Hooks 配置` —— 编辑生命周期钩子配置（首次写入含示例的模板）。
- `狐狸 AI：打开主题记忆` —— 浏览结构化长期记忆的主题目录。
- `狐狸 AI：切换智能体模式` —— 在 编码 / 架构 / 问答 / 排错 之间切换（对应 6.27）。
- `狐狸 AI：打开命令模板目录` —— 创建/打开 Slash Command 模板目录（对应 6.28）。
- `狐狸 AI：切换 Auto Mode` —— 开关自动门控（对应 6.29）。
- `狐狸 AI：管理自动化` —— 创建/打开本地自动化定义文件（对应 6.32）。
- `狐狸 AI：运行 Headless 调用` —— 用当前主对话模型做一次无状态调用（对应 6.33，需开启 `foxAi.headless.enabled`）。

---

## 九、智能体工具清单

智能体在完成任务时可调用的工具（部分）：

`read_file` `list_dir` `glob` `grep` `write_file` `edit_file` `delete_file` `run_command` `read_terminal` `get_diagnostics` `get_ports` `get_debug_console` `save_memory` `get_memory` `create_skill` `list_skills` `use_skill` `create_plan_task` `update_plan_task` `list_plan_tasks` `call_extension_command` `organize_knowledge` `query_code_graph` `review_changes` `security_audit` `generate_image` `search_codebase` `index_codebase` `spawn_subagent` `run_background_agent` `background_jobs` 等。

> 智能体工作准则要求：用户要求“读 / 看 / 打开 / 检查某文件”时，必须立即调用 `read_file` 读取真实内容，不凭记忆猜测或编造。

---

## 十、故障排查

| 现象 | 处理 |
| --- | --- |
| 扩展图标不显示 | 确认 `package.json` 的 `icon` 指向存在的 `media/fox.png` |
| AI 审查不生效 | 检查 `foxAi.verify.enabled` 是否为 `true`，且 provider / model 可达 |
| 终端读不到输出 | 确保目标终端是**当前活动终端**，或在技能期间点击“读取终端”按钮 |
| 记忆文件打不开 | 首次使用先执行 **狐狸 AI：打开记忆文件** 生成空文件 |
| 语法校验报错 | 检查 `foxAi.nodePath` 指向的 node 是否可用 |
| 上下文用量为 0 | 仅发送消息后才会统计；若始终为 0，检查 `foxAi.showContextUsage` 是否开启 |
| 上下文占比不显示 | 在设置中填写 `foxAi.contextWindow`（如 128000）后才会显示百分比 |
| 会话 / 历史消息不显示 | 扩展会同步保存当前会话 ID；重启后若丢失会自动恢复至最近会话。自定义存储路径建议使用绝对路径 |
| 报错 «Messages with role 'tool' must be a response to a preceding message with 'tool_calls'»（400） | 发送前已自动清洗历史中的“孤立工具消息”，正常情况下不再触发 |
| 让 AI“读某文件”它却反问 | 工作准则已要求必须立即 `read_file` 真实读取，遇此情况可明确强调“请先读取文件” |
| 续跑任务提示“关联的对话会话已丢失” | 已实现多层兜底：本存储区查找 → 默认/历史目录导入 → 在当前会话继续并更新 sessionId |
| 多步骤任务想先确认再执行 | 开启“规划确认模式”（`foxAi.planAndExecute.enabled`），会先提交计划卡片待您确认 |
| 扩展进程内存占用偏高 | 已内置多项治理；若仍偏高，可减少知识库超大文件、关闭非必要路径，或调小 `foxAi.agent.maxMessageBytes` |
| 知识库检索不到想要内容 | 可调大 `foxAi.knowledgeBase.topK`，或开启“知识库整理”使目录全量注入 |
| 让 AI 画图没反应 / 总提示“通道未开启” | 生图是独立通道，需在设置开启 `foxAi.imageGen.enabled` 并配置生图模型（provider/baseUrl/apiKey/model），详见 6.17 |
| 生成的图片不是我想要的（内容跑题） | 属生图模型质量问题；若返回完全不相关的图（如教程截图），多为模型返回异常，抓取逻辑已加固，可更换生图模型或优化描述 |
| 对话里的图片 / 生图重开窗口后消失 | 图片已做持久化存档（轻量引用），重开自动恢复；若仍丢失请检查存储路径 `foxAi.sessions.storagePath` |

---

## 十一、多语言（跟随系统语言）

本扩展界面**自动跟随 VS Code 的显示语言**，无需任何手动切换：

- **简体中文（默认）**：所有界面文案以中文作为内置默认值，中文环境下零回退风险。
- **English**：当 VS Code 显示语言为英文（或其它非中文语言）时，命令面板、设置项、聊天面板按钮/提示、以及运行时通知均自动切换为英文。

实现要点：
- 命令面板与设置项通过 VS Code 标准 `package.nls` 机制本地化（`package.nls.json` 为中文默认值，`package.nls.en.json` 为英文覆盖）。
- 聊天面板（Webview）通过内置轻量 `t()` 函数本地化，中文文案作代码内嵌默认值，英文走 `l10n/webview.en.json` 映射表；非中文环境才注入映射，避免任何第三方运行时依赖。
- 后端运行时通知（`vscode.window.show*Message`）通过 `src/i18n.js` 的 `tw()` 函数本地化，与前端共用同一张映射表。

> 说明：当前提供「简体中文 / English」双语。如需其它语言，复制 `l10n/webview.en.json` 为对应语言包并接入 `src/i18n.js` 的加载链即可，欢迎提交贡献。

---

## 十二、常见问题（FAQ）

**Q1：本扩展是免费的吗？**
是的。本扩展以 GPL-3.0 发布，为自由软件，您可自由运行、研究、分发与修改，但须遵守 GPL 关于保持开源与提供对应源代码的条款。

**Q2：可以使用本地模型吗？**
可以。在 `foxAi.baseUrl` 填写本地推理引擎（llama.cpp / Ollama / LM Studio 等）的 HTTP 地址，并按其要求填写 `model`；无需密钥时 `apiKey` 可留空。

**Q3：为什么长回答会中途停止？**
通常是 `foxAi.maxTokens` 偏小导致模型输出被截断。可先调大 `maxTokens`；扩展也会在截断时自动“继续”（详见 6.16）。

**Q4：如何保证 AI 不误删系统文件？**
工作区外的文件修改/删除会被强制三重确认；`rm -rf`、`git reset --hard` 等不可逆命令在自动批准关闭时须先征求同意。建议在设置 `foxAi.policy.blockedPaths` / `foxAi.policy.blockedCommands` 中进一步加固。

**Q5：会话数据保存在哪里？**
会话、记忆、技能、任务清单均有独立存储路径，可在设置的“存储位置”分组中查看与迁移（命令“狐狸 AI：打开 … 目录”可一键打开）。

**Q6：怎么让狐狸 AI 帮我画图？**
需在设置中开启生图通道：把 `foxAi.imageGen.enabled` 设为 `true`，并配置一个生图模型（provider / baseUrl / apiKey / model）。配置好后直接说“画一个 XX”即可，生成的图可一键保存到本地，且会话重开不丢失。详见 6.17。

---

## 附录：前缀缓存优化（Prompt Cache）

当输入总量很大（可达十万级 token）时，模型服务商的前缀缓存（Prompt Cache / KV Cache）能把「请求开头固定不变的那段」缓存下来，后续同前缀请求只计费 / 计算增量部分，大幅省 token 与延迟。fox-ai 做了一系列工程配合：

- **铁打前缀（System Prompt 绝对硬编码）**：系统提示词与工具定义在请求最前面且一成不变；知识库检索、长期记忆、技能、任务清单、项目规则、项目结构、时间、代码审查意见等每轮变动内容，统一收集后注入「最后一条用户消息」前面（请求尾部、仅追加），绝不回写 system，确保前缀缓存整段命中。
- **DeepSeek 专用适配（text 协议）**：DeepSeek 的原生 function calling 会把 `tools` 字段序列化在 messages 之后、不参与前缀缓存，导致工具 schema 每轮原价计费、命中率封顶在约 85%。因此扩展对 DeepSeek 默认走 **text 协议**，把工具定义写进 system（可缓存），长任务命中率可达约 98%；需要原生 function calling 时把 `foxAi.agent.toolProtocol` 设为 `native`。
- **工具集固化**：非 DeepSeek 云端模型始终发送全量工具定义，并按函数名排序固化序列化顺序，避免 `tools` 字段抖动破坏前缀。
- **缓存命中监控**：从各协议响应的 `usage` 中抽取缓存命中 token（OpenAI `prompt_tokens_details.cached_tokens`、DeepSeek `prompt_cache_hit_tokens`、Anthropic `cache_read_input_tokens`、Responses API `input_tokens_details.cached_tokens`），计算「本轮命中率」与「会话累计命中率」并通过 `cacheStats` 事件与状态栏上报；同时计算请求前缀（system+tools）的 SHA 指纹，一旦与本轮会话首次不一致即告警「前缀缓存将整段失效」，若上一轮有命中而本轮骤降为 0 亦告警。
- **缓存预热（可选）**：设置 `foxAi.cacheWarmup.enabled = true` 后，新会话首轮会先发一个只含 system+tools、`max_tokens` 极小的请求，把「铁打前缀」提前灌进服务商缓存，使随后的真实大体量请求直接命中。默认关闭，以免产生额外调用。

---

*本说明书随软件版本更新。如与界面实际行为存在差异，以当前安装版本为准。*
