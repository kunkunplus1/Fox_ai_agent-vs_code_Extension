# 狐狸ai智能体（IDE原生跨界型agent）
-注：目前并未上架任何插件平台，只有GitHub仓库这一个获取方式
# 狐狸 AI 智能体 · 使用说明书

> **制作人**：Cyunkun(kunkunplus1)
>
> **版本**：0.8.85
> **适用平台**：Visual Studio Code 及其兼容衍生版本（Cursor、Trae 等 API 兼容环境亦可）
> **开源协议**：GNU General Public License v3.0（GPL-3.0）

---

## 一、关于本软件

狐狸 AI 智能体（以下简称“本扩展”）是一款运行于 Visual Studio Code 的本地智能体扩展。其核心定位为：在开发者的工作区内，以智能体（Agent）模式自主完成读文件、修改代码、执行命令、查看运行报错等工程任务，并在全流程中提供暂停、继续、取消等过程控制能力。

本扩展支持以下两类模型接入方式：

1. **本地推理引擎**：llama.cpp、Ollama、LM Studio 等本地化部署的推理服务。
2. **云端 API 服务**：DeepSeek、智谱 GLM、通义千问、Kimi、硅基流动、OpenRouter 等国内合规 API 服务，以及 OpenAI 兼容接口、Anthropic Claude 等海外模型。

本说明书面向最终使用者，说明如何安装、配置并正确使用本扩展的各项功能。有关实现细节与历史变更，请以源代码与发布说明为准。

---

## 二、许可证

本扩展以 **GNU General Public License v3.0（GPL-3.0）** 发布，为自由软件（free software）。您享有运行、研究、分发与修改本软件的自由；在分发或修改本软件时，须遵守 GPL-3.0 中关于保持开源、提供对应源代码等条款。

许可证完整文本见仓库根目录 `LICENSE` 文件，亦可访问 <https://www.gnu.org/licenses/gpl-3.0.html> 查阅官方版本。

---

## 三、安装与激活

1. 获取扩展包 `fox-ai-0.8.85.vsix`（由源码经 `vsce package` 打包生成，或自发布渠道取得）。
2. 在 Visual Studio Code 中打开扩展视图（侧边栏方块图标，或 `Ctrl+Shift+X`）。
3. 点击扩展视图右上角的 `…`（更多操作），选择 **“从 VSIX 安装”**。
4. 在文件选择对话框中定位并选中 `fox-ai-0.8.85.vsix`。
5. 安装完成后按提示 **重新加载（Reload）** 窗口以激活扩展。

> 说明：本扩展采用纯 Node.js 内置模块实现，无需额外下载运行时依赖，安装包体积小、部署轻便。活动栏与扩展详情页使用狐狸图标（`media/fox.png`）。

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
- **存储位置**：知识库目录与整理结果可在设置 `foxAi.knowledgeBase.*` 中配置。

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
- **自动压缩**：当历史接近窗口上限（阈值 `foxAi.knowledgeBase.autoSummarize.threshold`，默认 0.9）时，自动对较早内容做增量摘要，保留最近 `keepRecent`（默认 6）条，以节省 token。

### 6.12 行内补全（对标 Copilot 的 Tab 补全）

默认开启的灰色幽灵文本行内补全，对标 GitHub Copilot 的实时补全体验：边打字边给出建议，按 `Tab` 接受、`Esc` 拒绝。仅对本地文件（`file` / `untitled`）触发，并与对话 AI 共用项目上下文，避免“牛头不对马嘴”。

- `foxAi.inlineCompletion.enabled`：总开关（**默认 true**，开箱即用；命令“狐狸 AI：切换行内补全”可一键开关）。
- `foxAi.inlineCompletion.model`：**专用补全模型**（对标 Copilot 的独立轻量补全引擎）。留空则复用主对话模型；建议填一个低延迟模型专门做补全，避免拖慢/烧主模型。
- `foxAi.inlineCompletion.maxTokens`：单次补全最大 token（**默认 256**，支持补全整段函数等多行块）。
- `foxAi.inlineCompletion.maxFileLines`：超过此行数的大文件跳过补全（**默认 8000**，超大文件限流以省 token，对标 Copilot 行为）。
- `foxAi.inlineCompletion.debounce` / `.contextLines`：触发防抖（默认 350ms）与上下文行数（默认 60）。
- `foxAi.inlineCompletion.useProjectContext` / `.projectContextChars`：是否结合项目上下文（默认 true）/ 上下文最大字符数（默认 1000）。

> 提示：每次按键都会向模型发一次请求，若主模型较慢或按量计费，强烈建议配置 `inlineCompletion.model` 指向一个快模型；不需要时可关闭 `enabled`。

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
| 自动压缩 | `foxAi.knowledgeBase.autoSummarize.enabled` / `.threshold`（触发阈值，默认 0.9） / `.keepRecent`（保留最近条数，默认 6） / `.dir` |
| 存储位置 | `foxAi.sessions.storagePath` / `foxAi.memory.storagePath` / `foxAi.skills.storagePath` / `foxAi.planTasks.storagePath` |
| 智能体 | `foxAi.agent.enabled` / `foxAi.agent.maxSteps` / `foxAi.agent.maxContinues` / `foxAi.agent.autoApprove` / `foxAi.agent.blockedCommands` |
| 任务清单 | `foxAi.planTask.enabled` / `.provider` / `.baseUrl` / `.model` |
| 代码验证 | `foxAi.nodePath` / `foxAi.verify.enabled` / `.provider` / `.baseUrl` / `.model` |
| MCP | `foxAi.mcp.enabled`（总开关）/ `foxAi.mcp.priority`（local-first·remote-first）/ `foxAi.mcp.servers`（通用服务器列表）/ `foxAi.mcp.playwright.enabled` |
| 安全策略 | `foxAi.policy.mode` / `.blockedPaths` / `.blockedCommands` |
| 知识库检索 | `foxAi.knowledgeBase.bm25Enabled` / `.topK`（检索 Top-K，默认 10） |
| 项目扫描 | `foxAi.projectScan.cacheEnabled`（结果缓存，默认 true） |
| 行内补全 | `foxAi.inlineCompletion.enabled`（默认 true） / `.model`（专用模型，默认空=主模型） / `.maxTokens`（默认 256） / `.maxFileLines`（默认 8000） / `.useProjectContext`（默认 true） / `.projectContextChars`（默认 1000） / `.debounce` / `.contextLines` |
| 智能体（续） | `foxAi.agent.maxMessageBytes`（历史总字节硬上限，默认 1048576） / `.structuredOutput` / `.projectSkeleton`（L1 代码骨架，默认 true） |

---

## 八、命令参考（Ctrl+Shift+P）

常用命令（名称以“狐狸 AI：”前缀）：

- `狐狸 AI：打开对话面板` —— 打开/聚焦对话面板。
- `狐狸 AI：打开记忆文件` —— 查看与编辑长期记忆。
- `狐狸 AI：打开用户技能目录` —— 打开用户自建技能目录。
- `狐狸 AI：打开任务清单` —— 查看与编辑项目任务清单。
- `狐狸 AI：打开环境管理器` —— 查看环境与端口等信息。
- `狐狸 AI：打开知识库` / `狐狸 AI：整理知识库` —— 知识库浏览与整理。
- `狐狸 AI：让狐狸 AI 修复这个问题` —— 通过 Quick Fix 灯泡菜单触发，针对错误处请求修复。
- `狐狸 AI：暂停` / `取消` / `继续` —— 过程控制。
- `狐狸 AI：撤销上次编辑` / `狐狸 AI：重做上次撤销的编辑` —— 文件改动回滚与恢复。

---

## 九、智能体工具清单

智能体在完成任务时可调用的工具（部分）：

`read_file` `list_dir` `glob` `grep` `write_file` `edit_file` `delete_file` `run_command` `read_terminal` `get_diagnostics` `get_ports` `get_debug_console` `save_memory` `get_memory` `create_skill` `list_skills` `use_skill` `create_plan_task` `update_plan_task` `list_plan_tasks` `call_extension_command` `organize_knowledge` `query_code_graph` `review_changes` `security_audit` `generate_image` 等。

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

*本说明书随软件版本更新。如与界面实际行为存在差异，以当前安装版本为准。*
