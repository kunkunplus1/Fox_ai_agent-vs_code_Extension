# 狐狸 AI 智能体

> **制作人**：Cyunkun(kunkunplus1)
>
> **版本**：1.1.28
> **适用平台**：Visual Studio Code 及其兼容衍生版本（Cursor、Trae 等 API 兼容环境亦可）
> **开源协议**：GNU General Public License v3.0（GPL-3.0）

狐狸 AI 智能体是一款运行于 Visual Studio Code 的本地智能体（Agent）扩展。它在你的工作区内自主完成读文件、修改代码、执行命令、查看运行报错等工程任务，全流程支持暂停 / 继续 / 取消，并在关键节点提供审批、预览与回滚控制。

## 模型接入

支持三类模型接入方式：

- **本地推理引擎**：llama.cpp、Ollama、LM Studio 等本地部署的推理服务。
- **云端 API 服务**：DeepSeek、智谱 GLM、通义千问、Kimi、硅基流动、OpenRouter 等国内合规 API 服务，以及 OpenAI 兼容接口、Anthropic Claude 等海外模型。
- **网页版（WebAI2API）**：想用 DeepSeek / Gemini / ChatGPT / Claude / 豆包 / LMArena 等网页版免费额度、又不想碰「逆向接口被封号」的风险时，可本地部署 [WebAI2API](https://github.com/foxhui/WebAI2API)（Camoufox 浏览器自动化 + 拟人化交互，最接近真实用户、最不易被封）。在「环境面板 → WebAI2API」点「下载并配置」即可一键完成，自动生成鉴权密钥并填入服务商。网页版不支持原生函数调用，工具调用走文本协议（`<fox:tool>` 标签），可靠性略低于 API 版。

## 安装

1. 获取扩展包 `fox-ai-1.1.28.vsix`（由源码经 `vsce package` 打包生成，或自发布渠道取得；实际文件名以你下载的版本为准）。
2. 打开扩展视图（侧边栏方块图标，或 `Ctrl+Shift+X`），点击右上角 `…` 选择「从 VSIX 安装」。
3. 选中 `fox-ai-1.1.28.vsix`，安装完成后按提示重新加载（Reload）窗口。

扩展采用纯 Node.js 内置模块实现，无需额外下载运行时依赖，安装包体积小、部署轻便。

## 配置

首次使用前在设置中配置模型连接：打开 **设置 → 扩展 → 狐狸 AI**，或在命令面板搜索 `foxAi`。

必须配置项：

| 配置项 | 说明 |
| --- | --- |
| `foxAi.provider` | 服务商标识（如 `deepseek`、`openai`、`anthropic` 等，或自定义）。 |
| `foxAi.baseUrl` | API 接入地址（端点）。本地引擎填写其 HTTP 地址。 |
| `foxAi.model` | 使用的模型名称。 |
| `foxAi.apiKey` | API 密钥。本地引擎若无需密钥可留空。 |

常用可选项：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `foxAi.maxTokens` | 按厂商 | 单条回复的最大长度。撰写长教程、长文档时建议调大，否则回复可能因达到上限被截断。 |
| `foxAi.temperature` | 由扩展默认 | 采样温度，控制输出随机性。 |
| `foxAi.maxHistory` | — | 携带至模型的对话历史条数。 |
| `foxAi.agent.maxContinues` | `3` | 单条回复被截断时自动“继续”重调的最大次数；`0` 表示关闭。 |

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

## 快速上手

1. 打开目标项目文件夹作为工作区。
2. 使用命令面板执行「狐狸 AI：打开对话面板」，或在活动栏点击狐狸 AI 图标后从“会话”树新建/打开会话。
3. 在对话面板中输入任务，例如：“为当前模块补充单元测试”。
4. 智能体按“思考 → 调用工具 → 观察结果 → 再次思考”的循环自主推进，过程中可随时暂停 / 继续 / 取消。
5. 任务完成后，结果（代码改动、命令输出、结论等）会在对话面板中汇总呈现，并附「📦 本次任务产物」卡片（列出创建 / 修改 / 删除的文件，点击可打开，底部可一键导出 Markdown 报告）。

对话面板默认在编辑器区域以可拖拽、可并排的 Webview 形式打开，而非左侧侧边栏；左侧活动栏仅保留“会话”树，便于切换与续跑历史会话。

## 智能体对话

- **工作流**：智能体并非简单问答工具，而是自主循环调用工具完成任务。复杂任务自动拆分为清单，逐项标记待办 / 进行中 / 已完成。
- **会话栏分步骤时间线**：思考（💭 思考卡）、工具调用（🖥️ 动作卡，标题带目标如「读取 xxx」「执行 xxx」）、最终正文按真实顺序直接铺在会话栏主消息流里，不再糊成一团；点击卡片可展开参数 / 结果详情，重开窗口自动恢复。工作链页另保留一份完整时间线（含等待审批、诊断提示等内部步骤）。
- **纯对话直答**：极短且无任务意图的消息（问候 / 闲聊 / 简短回应，≤10 字且不含任务、时效关键词）自动追加「直接文字回复、不要调工具」提示，避免“你好”也触发 get_tools / 联网烧 token；`current_time`、天气、新闻等时效性查询不受影响。
- **需求澄清**：当用户的需求存在相互矛盾、歧义，或模型对要求不清楚时，模型会调用 `clarify` 工具弹窗向你提问——你点选它给的建议，或自行输入补充要求，它据此继续，不瞎猜。
- **过程控制**：命令「狐狸 AI：暂停 / 取消 / 继续」。取消会立即中断模型输出，并向正在运行的命令发送中断信号（Ctrl+C）。
- **输出截断自动继续**：模型回复因达到 `max_tokens` 被截断时自动插入“继续输出剩余内容”并重调，默认最多 3 次（`foxAi.agent.maxContinues`）。续跑时关闭深度思考、思考被截断但正文未产出时自动补正文、可见正文为空时不空转。
- **长任务自动续跑**：达到 `foxAi.agent.maxSteps` 步数上限时自动追加一轮预算并把断点信息写回历史继续执行（`foxAi.agent.autoResume`，默认开；累计轮数达 `autoResumeRounds` 默认 5 才挂起等用户）。手动暂停永远优先于自动续跑。
- **会话进度记忆**：每个工具执行完记一条进度流水，渲染成【会话进度】随请求注入——模型每轮都知道做过什么、做到哪；崩溃 / 重启后重开会话自动回灌，不再对上下文一片空白。

## 文件操作

- **读写**：可列目录、按 glob 定位文件、全文检索、按行号精确读取，支持工作区相对路径与绝对路径。
- **写入 / 编辑**：智能体先读取真实内容再做精确片段替换，变更前提供差异预览（diff）。`edit_file` 支持 `start_line`/`end_line` 与字符级 `start_char`/`end_char` 范围限定，小改动无需重写整个文件。
- **删除**：先移至回收站（而非永久删除），可在撤销中恢复。
- **工作区外文件**：修改或删除工作区外文件时强制三重确认，防止误触系统或个人文件。
- **换行符**：`write_file`/`edit_file` 自动保留文件原有 `CRLF` 或 `LF`，不会把 Windows 仓库的换行全改为 LF。
- **撤销 / 重做**：命令「狐狸 AI：撤销上次编辑 / 重做上次撤销的编辑」。新建、编辑、删除均可撤销，删除档优先进回收站。
- **带行号预览**：审批预览与审查/自检摘要统一为带 1 索引行号的 diff——删除行标原行号、新增行标新行号，错位处用「原→新」标注（如 `13→14│`），落点偏差一眼可见。`read_file` 行号为总行数定宽，不因位数跳动数错行。
- **超长文件读取**：`read_file` 超预算时从头部保留完整行、绝不挖中间，尾部显式提示“本段共 N 行，请用更小的 start_line/end_line 分段继续读剩余部分”——模型不会误判内容缺失而反复重读。

## 执行命令

- 智能体可在可见的集成终端中执行命令，实时将输出回传模型，适用于依赖安装、构建、测试运行等场景。
- **异步执行**：`bg=true` 模式提交耗时命令后立即返回任务号，用后台任务查询工具随时查看状态与完整输出，`action=cancel` 可取消、`action=clear` 清理记录。
- **读取终端**：可要求智能体读取你自有终端中的输出（目标终端需为当前活动终端）。

## 规划执行

- **默认直接执行**：多步骤任务智能体先用 `create_plan_task` 列出完整计划并展示计划卡片，然后立即继续执行，不再停下等待确认。执行中需调整计划时先用 `set_plan_tasks` 改好再调用 `revise_plan` 说明原因。
- **恢复确认门**：开启 `foxAi.planAndExecute.confirmGate` 后提交计划会暂停，等你点击“确认执行”才继续；`foxAi.planAndExecute.enabled` 可整体关闭规划执行。
- **任务清单**：`set_plan_tasks` 整表替换（无需记住任务 id）、`update_plan_task` 单条微调；任务栏按「进行中 → 未开始 → 已完成」稳定排序，已完成项沉底。

## 技能机制

技能是可复用的固定工作流（`SKILL.md` 含 YAML frontmatter 的 name / description / when_to_use + Markdown 指导正文）：

- **技能目录常驻上下文**：会话稳定块里始终注入【技能目录】清单，智能体每轮都知道有哪些技能可用，需要时按名调用 `use_skill` 加载正文执行（内置技能 `_knowledge_base` 知识库检索始终在目录中）。
- **用户直接触发**：输入 `/技能名` 即触发技能，可带参数（如 `/复习资料 只复习第三章`）。
- **技能管理**：`create_skill` 新建、`list_skills` 查看目录、`import_skill` 从 GitHub 导入、`use_skill` 由智能体按需激活。

## 自动代码审查

每完成一轮代码写操作，智能体自动调用**只读**审查子代理（仅读取、不修改、不执行命令）对改动执行审查，以卡片展示意见。可在 `foxAi.review.enabled` 关闭。

- **不阻塞主回答**：审查后台异步运行，主结论先出、卡片稍后弹出。
- **限时注入**：主控输出前限时等待（默认 8 秒，`foxAi.review.injectTimeout` 可调），审查快则纳入回答、慢则卡片后补。
- **一键修正**：卡片底部「按审查意见修正」自动以审查意见为新任务启动修正；主任务忙时自动排队、结束后应用。
- **基于真实改动**：审查子代理读取文件真实前后状态生成 diff，不会被模型给出的错误编辑参数误导。

## 长期记忆

- **跨会话记忆**：记忆内容作为【长期记忆】段落注入系统提示词，使智能体在多次对话间保持一致。存储于 `globalStorage/fox-ai/memory/memory.json`，命令「狐狸 AI：打开记忆文件」查看 / 编辑（首次使用会生成空文件）。
- **自动沉淀**：会话结束时从对话中规则式抽取「用户纠正 / 明确约定 / 偏好声明」自动入库；抽取时自动过滤协议噪音——工具调用块、系统回灌提示、工具报错 JSON、动态上下文标记等不会被误当用户偏好写进记忆。
- **结构化主题记忆**：按主题文件组织（项目偏好 / 踩坑教训 / 架构决策 / 操作流程 / 领域知识等），`save_memory` 支持 `topic` 参数自动归类、`get_memory` 按主题或相关性取回；存储位置 `globalStorage/fox-ai/memory-topics/`（`MEMORY.md` 索引 + `topics/<slug>.md` 可手改）。与动态上下文共用内容哈希去重——检索结果不变不重复注入，记忆更新或话题切换导致结果变化才重新注入。
- **跨会话授权**：用户明确要求“回忆/参考其他会话”时，agent 调用 `allow_session_access` 弹窗请求授权，授权后该会话摘要才进入当前对话检索范围。

## 知识库整理与检索

- **整理**：命令「狐狸 AI：整理知识库」，将散落的资料归纳为结构化节点。整理 AI 的传输层可用 `foxAi.knowledgeBase.organize.transport` 选择 `auto` / `openai` / `anthropic`（选 anthropic 走 Messages API，自动映射 DeepSeek/智谱/Kimi 等厂商端点；环境面板「知识库 → 传输层」下拉直接切换）。
- **检索**：默认启用 BM25 相关度检索（中文按二元组切分），`foxAi.knowledgeBase.topK`（默认 10）调整召回量。
- **向量语义检索（独立开关）**：环境面板「知识库 → 向量模型」可开启向量召回，与 AI 整理完全独立——只配整理模型时保持纯 BM25；同时配向量模型时向量先做语义召回、整理继续产出笔记，可勾选「与 BM25 混合排序（RRF）」融合。支持 Ollama、阿里百炼 `text-embedding-v4`、智谱 GLM、硅基流动、OpenAI、Gemini/Mistral/OpenRouter 兼容端点、LM Studio、llama.cpp server；DeepSeek / Kimi / Claude 暂无官方 embedding 接口，可在 `custom` 下自配。向量密钥存于独立 SecretStorage 键，任意失败自动回退 BM25。
- **存储位置**：整理产物固定输出到 `~/.fox-ai/knowledge`、自动压缩摘要固定到 `~/.fox-ai/knowledge-2`（1.1.27 起不可自定义，避免目录漂移）；向量缓存位于工作区 `.fox-ai/kb-vec.json`。

## 用户自建技能

- **存储路径**：`%APPDATA%/Code/User/globalStorage/fox-ai/user-skills/<name>/SKILL.md`（可附带 `run.js`）。
- **创建**：通过对话让智能体编写新技能，创建时自动执行 `node --check` 做语法校验。
- **使用**：使用技能前需经人工确认（强制走审批流程，不会被自动批准跳过）。
- **管理**：命令「狐狸 AI：打开用户技能目录」。

## MCP 连接器

MCP（Model Context Protocol）连接器使智能体能够调用外部工具服务器，如网页抓取、浏览器自动化等。

- **总开关**：`foxAi.mcp.enabled`。
- **通用接入**：`foxAi.mcp.servers` 按标准 MCP（stdio）格式添加任意服务器，亦可在 🦊 MCP 面板中通过 UI 添加 / 编辑。
- **内置目录**：内置 Time / Fetch / Git 等纯 Node 实现服务器，无需下载依赖，安装即落盘并热注册。
- **Playwright 快捷开关**：`foxAi.mcp.playwright.enabled`，用于后台读取网页与可访问性树。
- **优先级**：`foxAi.mcp.priority` 可设 `local-first` 或 `remote-first`，决定同名工具优先使用本地还是远程实现。
- **VS Code 原生 MCP**：面板只读展示 VS Code 自身 `mcp.json` 配置的服务器（标记“VS Code 管理”），不会误改其配置。
- **工具可见化**：`get_tools` 同时返回已加载的 MCP 工具（附在清单尾部）；传 `query=mcp` 可单独检索。

## 上下文用量与自动压缩

- **用量面板**：开启 `foxAi.showContextUsage` 后显示当前上下文 token 数与占比；填写 `foxAi.contextWindow`（如 128000）后显示百分比。
- **压缩指示**：面板显示「自动压缩」进度——距触发压缩还差多少百分比 / token，以及“已达阈值、下次对话后压缩”或“已达阈值但无可压缩对话”等状态。
- **自动压缩**：历史接近窗口上限（`foxAi.knowledgeBase.autoSummarize.threshold`，默认 0.9）时，自动对较早内容做增量摘要，保留最近 `keepRecent`（默认 6）条。
- **会话隔离**：同一 session 的历次压缩追加到**同一个** `<sessionId>-summary.md`，不会一次压缩产生一个新文件；检索时只读当前 session 的摘要，其他 session 完全隔离。
- **token 用量记账**：每个请求的输入 / 输出 / 缓存 / 推理 token 与命中率逐行落 `~/.fox-ai/logs/token-usage.log`（每行一条 JSON）；平台未返回 usage 时落 `kind:"no_usage"` 告警行（`reason` 区分“真没给”与“返回空对象”），绝不编造数字。

## 行内补全

默认开启的灰色幽灵文本行内补全，对标 GitHub Copilot：边打字边给出建议，按 `Tab` 接受、`Esc` 拒绝。仅对本地文件（`file` / `untitled`）触发，并与对话 AI 共用项目上下文。

- `foxAi.inlineCompletion.enabled`：总开关（默认 true；命令「狐狸 AI：切换行内补全」一键开关）。
- `provider` / `.baseUrl` / `.apiKey` / `.model`：专用补全模型，留空则跟随 / 继承主对话模型。
- `maxTokens`（默认 256，支持多行块）、`maxFileLines`（默认 8000 行以上跳过）、`debounce`（350ms）、`contextLines`（60）、`suffixLines`（30）、`fimStrategy`（默认 auto）。
- `fimEndpoint`：开启后改走 DeepSeek Beta 的 `/completions` 端点。
- `useProjectContext` / `.projectContextChars`（默认 1000）：结合项目上下文。
- `maxContextChars`（默认 6000）：前文优先保留、后文裁剪。
- `transport`（默认 auto）：跟随 provider（claude 走 Anthropic Messages API，其余走 OpenAI 兼容），可强制 `openai` / `anthropic`。
- `thinking`（默认 off）+ `thinkingEffort`（默认 medium）：开启思考模式，OpenAI 传 `reasoning_effort`、Anthropic 传 `thinking.budget_tokens`（2048 / 4096 / 8192，自动保证小于 maxTokens）。

厂商适配要点：

- **DeepSeek**：`deepseek-chat` / `deepseek-coder` 支持 FIM 补全（需 baseUrl 用 `https://api.deepseek.com/beta` 并开启 `fimEndpoint`）；`deepseek-reasoner` 官方不支持 FIM，开启思考时自动降级为 chat 补全，且不传 `temperature` 等无效采样参数。
- **OpenAI**：推理模型支持顶层 `reasoning_effort`（gpt-5 另支持 minimal/xhigh/none）；行内补全走 FIM token 模板。
- **Anthropic**：`thinking: {type:"enabled", budget_tokens:N}`（budget 最小 1024 且必须小于 max_tokens）；新版 Opus 4.6 推荐 `type:"adaptive"`。无 FIM 端点，走 Messages API + FIM 模板。
- **Gemini**：无官方 FIM 端点，走 OpenAI 兼容端点 + FIM 模板。

> 每次按键都会向模型发一次请求，若主模型较慢或按量计费，建议把 `provider` + `model` 指向快模型；不需要时可关闭 `enabled`。

## 项目概览与文件导航

- **文件导航树**（活动栏“文件”视图）：分“本次会话涉及”（AI 读/写/打开过的文件，按时间倒序，标注操作类型与行号）与“工作区文件”（自动跳过 `node_modules`/`.git`/`out`），点击即跳转。
- **项目概览**：命令「狐狸 AI：生成项目概览」，自动扫描工作区识别 README、入口、配置、源码目录，推断技术栈，可一键“让 AI 梳理项目”。

## 环境管理器

环境管理器（“环境”标签页）汇总当前环境信息，包括转发端口（`get_ports`）与调试控制台输出（`get_debug_console`）。命令：「狐狸 AI：打开环境管理器」。

## 多模态识图中转

主模型不支持图片理解而对话中包含图片时，由独立视觉模型先将图片转述为文字描述再交给主模型。设置位于 `foxAi.vision.*`（enabled / provider / baseUrl / apiKey / model / apiMode / transport）。`transport` 支持 `auto` / `openai` / `anthropic`——选 `anthropic` 走 Anthropic Messages API（支持图片输入块，自动映射 DeepSeek/智谱/Kimi 等厂商端点）。

带图片的输入会跳过知识库直答、直接走智能体，确保识图中转生效。

## 深度思考模式

对话面板顶部有 **🧠 思考** 芯片：左键单击开 / 关；右键单击弹出强度选择（关闭 / `low` / `medium` / `high`），切换后当前会话立即生效。

扩展按服务商与协议自动翻译思考参数：

| 服务商 / 协议 | 实际下发的参数 |
| --- | --- |
| OpenAI（o 系 / gpt-5）、Gemini 2.5+、grok-3-mini、中转站同类模型 | `reasoning_effort: low\|medium\|high` |
| Responses 协议（OpenAI / DeepSeek v4） | `reasoning: { effort }` |
| Claude（原生 Messages API 或中转站 claude 模型） | `thinking: { type: "enabled", budget_tokens }` |
| 通义千问 Qwen3（DashScope / 硅基流动） | `enable_thinking: true` + `thinking_budget` |
| 智谱 GLM-4.5 系 | `thinking: { type: "enabled" }` |
| OpenRouter | `reasoning: { effort }` 或 `reasoning: { max_tokens }` |
| 无原生开关的模型 | 系统提示词兜底，要求分步推理后再作答 |

配套细节：

- **思考过程实时可见**：推理过程逐字流式推送到「思考」步骤卡片（会话栏与工作链页均展示）。
- **回答逐字实时输出**（native 与文本协议均支持）；文本协议下自动剥掉 `<fox:tool>` 工具调用块只推正文。
- **关闭时显式下发关闭参数**：对默认就思考的模型（尤其 DeepSeek 非 reasoner 的 `v4-flash`/`v4-pro`，走 Responses API 时默认开启思考）主动下发 `reasoning.effort=none` 关闭思考，否则思考意识流会吃光输出预算。
- **思考链回传省 token**：多轮回放只在「带工具调用的回合」回传思考链，纯文本回合不再回传。

> 深度思考会显著增加响应时长与 token 消耗，日常建议保持关闭，疑难 bug、架构设计、复杂推理时再临时开启。

## 协议接入

- **Anthropic Messages API 全模型接入**（`foxAi.apiMode` / `foxAi.transport`）：若中转站 / 网关只提供 Anthropic 格式端点（`/v1/messages`），有三种做法：① `foxAi.apiMode` 选 `anthropic`——任意模型（含 deepseek/gemini/自定义等）改用 Anthropic Messages API 格式；② `foxAi.transport` 设为 `anthropic`；③ 对话栏「选择模型服务」选「自定义 Anthropic 兼容服务」。同理，需要 OpenAI Responses API（`/v1/responses`）时可选「自定义 Responses 服务」。对话栏现提供三种自定义：`custom`（/chat/completions）、`customResponses`（/v1/responses）、`customAnthropic`（/v1/messages）。
- **厂商 Anthropic 端点自动映射**（依据官方文档）：切到 Anthropic 协议时自动映射厂商的 Anthropic 兼容端点，无需手动改 baseUrl：

| 服务商 | OpenAI 端点（原 baseUrl） | Anthropic 兼容端点（自动映射） |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `https://api.deepseek.com/anthropic` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `https://open.bigmodel.cn/api/anthropic` |
| Kimi / 月之暗面 | `https://api.moonshot.cn/v1` | `https://api.moonshot.cn/anthropic` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `https://api.siliconflow.cn`（base 不带 /v1） |
| 腾讯混元 | `https://api.hunyuan.cloud.tencent.com/v1` | `https://api.hunyuan.cloud.tencent.com/anthropic` |
| 阿里百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `https://dashscope.aliyuncs.com/apps/anthropic` |
| MiniMax | `https://api.minimaxi.com/v1` | `https://api.minimaxi.com/anthropic` |
| 火山方舟 / 豆包 | `https://ark.cn-beijing.volces.com/api/v3` | `https://ark.cn-beijing.volces.com/api/coding` |
| Anthropic 官方 | `https://api.anthropic.com/v1` | 原样（本就走 Messages） |
| 其它中转站 / 自定义 | 自定义 | 原样 baseUrl + `/v1/messages` |

若 404 依旧，报错信息会给出对应厂商的 Anthropic 端点提示。

## 文生图

智能体可调用独立生图模型生成图片（插画、海报、图标、概念图等），是独立于主控模型的第二个模型通道。

- **开启与配置**：设置 `foxAi.imageGen.enabled` 为 `true`，填写 `provider` / `baseUrl` / `apiKey` / `model`（如通义万相兼容端点）。未配置时 AI 提示“生图通道未开启”而非静默失败。`transport` 支持 `auto` / `openai` / `anthropic`（注意 Anthropic Messages API 不输出图片，生图首选 OpenAI 兼容端点）。
- **触发**：自然语言描述即可，如“画一棵大树”“生成一张活动海报”。生图工具常驻，AI 主动调用而非用 SVG/代码替代。
- **保存与持久化**：图片在对话中展示，右下角「保存」按钮一键另存；会话中的图片以轻量引用存档，重开窗口原样恢复。
- **结果可信**：只从约定的图片字段提取结果，模型返回错误页 / 无关内容时明确提示“未返回可识别图片”。

## 子代理 / 并行 Agent

复杂任务可拆分给多个子代理（Subagent）并行执行，主代理负责调度与结果聚合。

- **角色分工**：内置 `coder`（写代码）/ `tester`（测试验证）/ `explorer`（只读调研）/ `researcher`（资料检索）等角色，也可自定义角色提示词。
- **工具 `spawn_subagent`**：主代理按需派生一个或多个子代理并行干活，互不阻塞，结果回传主对话。
- **典型场景**：大规模重构（拆模块并行改）、跨模块调研、批量修复 + 自动测试、长链路任务分治。
- **权限固定**：每个子代理的工具权限启动时按角色固定，无权工具不反复重试，而是说明「超出权限」交回主代理；子代理不能派生子代理、不能改全局配置。
- **结论截断感知**：子代理单次输出被截断时明确标注「结论可能不完整」并把状态记为 truncated，主代理不会把半截结论当真。

## 后台 Agent

不阻塞当前对话的后台智能体：提交任务后立即返回，任务在后台独立运行，进度通过通知回流。

- **安全隔离**：在 git 仓库内自动开独立 worktree + 独立分支干活，绝不碰主工作区文件；非 git 仓库自动降级为只读调研。
- **可选产出 PR**：提交时带 `create_pr`，任务完成后推送分支并用 `gh` 创建 Pull Request。
- **治理护栏**：并发上限（默认 2）、任务超时（默认 15 分钟）、队列上限（12）、历史保留（默认 60 条）在「后台任务」设置组可调。
- **查看与管理**：工具 `background_jobs` 或命令「狐狸 AI：查看后台任务」。

## Checkpoint 回滚

智能体在关键步骤自动打检查点（快照），出错或想换思路时可一键回滚到任意历史节点。命令「狐狸 AI：回滚到检查点」→ 选择检查点 → 确认即回滚。设置组「检查点与回滚」：`foxAi.checkpoints.enabled` / `foxAi.checkpoints.maxSnapshots`。

## 生命周期 Hooks

在智能体运行的生命周期节点挂载自定义脚本：`preToolUse` / `postToolUse`（工具调用前后）、会话开始 / 结束等。用途：自动格式化、安全拦截危险命令、入参/出参审计、自动打标签。命令「狐狸 AI：打开 Hooks 配置」直接编辑；`foxAi.hooks.enabled` 总开关。

## 全仓库向量 RAG

对整个代码仓库建立语义索引，支持自然语言代码检索：

- 工具 `search_codebase` 语义检索、`index_codebase` 手动增量或强制重建。
- 设置组「代码库语义索引」：`foxAi.rag.extensions` / `foxAi.rag.maxFiles` / `foxAi.rag.autoRebuildHours`。
- 命令「狐狸 AI：重建代码索引」强制全量重建并带进度。

## 项目规则

开启后每次对话开始时自动读取项目根目录的约定文件（`CLAUDE.md` / `AGENTS.md` / `.fox-ai/rules` 等），注入系统提示词。设置组：`foxAi.projectRules.enabled` / `foxAi.projectRules.budget`（token 预算，0 不限制）。大型仓库建议保留以统一风格。

## 智能体模式

同一套智能体按模式改变工具范围、可写路径与系统提示词，并支持每模式独立模型：**编码 code**（默认，全权限）、**架构 architect**（只写文档）、**问答 ask**（纯只读）、**排错 debug**（先取证再动手）。切换命令：「狐狸 AI：切换智能体模式」。

## Slash Commands

把常用工作流写成模板，对话输入 `/<名字>` 即可调用。项目级优先：`<workspace>/.fox-ai/commands/<名字>.md`；用户级：`~/.fox-ai/commands/<名字>.md`。打开命令：「狐狸 AI：打开命令模板目录」。

## Auto Mode

开启后对写 / 改 / 删 / 执行类动作先用轻量 LLM 分类做 allow / deny / ask 门控，减少人工审批负担。设置组：`foxAi.autoMode.enabled` / `allow`（白名单）/ `deny`（黑名单）。

## Best-of-N

一次提问并发跑 N 个候选模型，由评委挑最优回答。工具：`best_of_n`。设置组：`foxAi.bestOfN.enabled` / `judge`（llm·llm·first）/ `candidates` / `temperature`。

## 冲突感知与未读禁止写

- **冲突感知**：人类在智能体读取文件后又改了该文件时，写前检测到冲突会暂停写操作转人工裁决。设置：`foxAi.conflictWatch.enabled`（默认开）。
- **未读禁止写**：修改「已存在文件」前必须在本会话先用 `read_file` 读过真实内容——代码级硬门控，不是提示词建议。未读直接写会被拦截并回灌“请先 read_file”。规则：① 新建文件无需先读；② 写成功后记录「已读/已写」，多轮编辑不重复拦截；③ 读过之后文件被外部改过，由冲突感知暂停转人工；④ `foxAi.conflictWatch.requireRead`（默认开）可关闭此硬门控。

## 规划器

多步骤任务执行前先用一次低成本小模型调用把需求拆成 DAG 步骤清单，思考与执行解耦。`foxAi.planner.enabled` **默认开启**（auto 模式：单步 / 简单需求自动跳过；也可设 `mode` 为 `on`/`off`）。规划结果写入任务清单，执行时逐步标记进度。

## 本地自动化

纯本地定时 / 事件触发，把重复任务交给后台 agent 异步执行。两种触发：定时（cron / interval）与本地 webhook（GitHub / Slack 等 POST 触发，只收指令不回传资料）。管理命令：「狐狸 AI：管理自动化」。

## Headless / CI 集成

把狐狸 AI 当无状态非流式调用嵌入 CI / 脚本 / 命令行，输出到 stdout，退出码表成败：`node foxai --prompt "..." -P deepseek`，支持 `--base-url`/`--api-key`/`--model`/`--stream`/`--json`/`--session`/`--turns` 等参数与 `FOXAI_*` 环境变量。编辑器内命令：「狐狸 AI：运行 Headless 调用」。

## 沙盒代码自测

环境面板「🧪 沙盒」标签页管理隔离运行环境：内置 Node.js / Python / Go / Rust / Java；用户沙盒把带 `manifest.json` 的文件夹丢进 `~/.fox-ai/sandboxes/` 即可新增语言。工具 `run_in_sandbox`（run / list / reload），超时由 `foxAi.sandbox.timeout` 控制。

## 失败自动切换

主模型挂掉 / 超时 / 限流时自动切到备用模型兜底。设置 `foxAi.failover`：`enabled` / `triggers` / `maxRetries` / `targets`。命中 triggers 才切换，参数错（400）不切。

## 本地 / 弱模型适配

- **协议自动选择**：`foxAi.agent.toolProtocol` 默认 `auto`，按厂商 / 模型名智能选择原生 function calling 或 text 协议；本地 / 小模型走 text 协议并加固非严格 JSON 解析。
- **弱模型辅助模式**：`foxAi.agent.localWeakModelMode`（auto / on / off）对小模型自动开启约束解码、工具检索精简、闭环校验、上下文锚点。
- **grammar 探测**：`foxAi.agent.localConstrainedDecoding` 默认 `auto`，先探测服务端是否支持约束解码。
- **本地无响应兜底**：本地模型返回空时自动以纯对话模式重试一次。
- **原生空轮自适应**：原生 function calling 下，模型「输出正文但不调工具」即视为任务完成给出最终答案，不再反复 nudge 逼它调工具（避免正文重复多段、审批刷屏）；首轮既没调工具、也非闲聊的「空话」仍按需降级文本协议兜底。

## WebAI2API 接入

想用网页版免费额度时，在「环境面板 → WebAI2API」点「下载并配置」一键完成（自定义目录 + 百分比进度 + 可中途停止，自动生成鉴权密钥并填入服务商）。部署方式固定为**源码部署**（git clone + npm install + npm run init），不使用 Docker；随后点「▶ 启动服务 / ⏹ 停止服务」一键管理（启动时自动检测端口冲突，可勾选「随 VS Code 启动」；首次使用需在项目目录跑一次 `npm start -- -login` 登录网页账号）。手动部署则 apiKey 填 `config.yaml` 里的 `auth`，baseUrl 默认 `http://localhost:3000/v1`。

- **自动幂等补丁**：「下载并配置」时自动给项目注入幂等补丁（`scripts/init.js` 已就绪跳过下载 + `auth.js` 鉴权加固 timingSafeEqual + 指纹约束放宽 + playwright-core 版本锁定），预下载的 Camoufox zip 自动解压并补 version.json——无论 clone 到什么版本、什么用户，点「下载并配置」都能完整享受多线程加速 + 不重复下载 + 鉴权加固，重新 clone 自动重打。
- **多线程安全下载**：无代理时自动用分段并发下载（Range 分 8 个连接抓取 Camoufox / GeoLite / Node 等大文件，分片断点续传、逐片重试、按序合并、字节数完整性校验）；有代理时走代理下载。GitHub 访问不畅可在「镜像前缀」填 ghproxy 类镜像自动重试；`npm run init` 卡 `ECONNRESET` 时在「代理」框填代理地址（留空自动探测系统代理 / 本机端口 7890/1080 等）。
- **Node 版本自动管理**：「下载并配置」与「启动服务」时自动选择 / 下载合适 Node（优先 PATH 中的 LTS 22/20/18 → 已缓存 `~/.fox-ai/node/` → 自动下载 Node 22 LTS 约 30MB 解压使用），无需手动安装切换。代理 / TLS 拦截环境自动注入 `NODE_TLS_REJECT_UNAUTHORIZED=0`（仅本进程）。
- **有头模式**：服务默认有头模式启动（`headless: false`，Camoufox 窗口可见，登录/验证码可人工操作，比无头更不易被网站风控）。
- **文本协议深度优化**：① 越权风控——无审批 UI 时高危操作（写文件/执行命令/删除）默认拒绝，宁可少做不可越权；② `<foxtool>` 块闭合标签感知（参数 JSON 内嵌 `</foxtool>` 不再提前截断），单轮超 5 个工具调用回传模型逐个执行；③ textOnly 接入同样启用 JSON Schema 参数校验，畸形参数自动反馈修正；④ `get_memory` 增加别名 `recall_memory`，拼错工具名也能解析执行。
- **函数调用语法容错**：识别 `read_file("路径")` 等函数样式并转为真实调用（`edit_file`/`delete_file` 参数顺序不可靠不自动猜，写/删/执行仍走审批与预览）；「声称已调用」完成式叙述无实际调用时回灌修正提示；「只说不做」输出方案 / 请求确认时回灌「直接执行」；多块同名调用全执行（明确标签来源的同名调用不按工具名去重）。
- **首轮锁死 get_tools**：新增工具 `get_tools` 按需检索（关键词过滤，返回必填参数与 `<foxtool>` 调用示例），system 不再全量塞入全部工具 schema，模型第一步必须用固定格式调用一次 get_tools 锚定格式（开关 `foxAi.agent.toolGuide`：`auto` 仅 WebAI2API 等 textOnly 模型启用 / `on` 全部文本协议强制 / `off` 关闭）。恢复旧会话时自动扫描历史，已有 get_tools 成功记录则跳过首轮强制。
- **动态上下文按内容去重**：textOnly 下每轮重复的大块动态上下文（【深度思考】【当前环境】【长期记忆】等）改为内容哈希去重——内容与会话上次注入完全一致则本轮直接不注入，严格「只有内容变化才发一次」；恢复旧会话自动预扫描历史记录指纹。
- **首轮精简**：textOnly 首轮若模型只输出分析而无工具调用，直接移除该轮无价值 assistant 消息再回灌 get_tools，让任务从第一轮起就进入真实调用。
- **无文件夹兜底工作区根**：未开 VS Code 文件夹时自动用配置目录作「虚拟工作区根」（`foxAi.workspace.fallbackDir` 显式指定，或复用已注册的 `foxAi.webai2api.projectDir`），文件工具的相对路径也能解析。
- **工具参数本地容错**：网页渲染破坏的转义（`\n` 变真换行、吞反斜杠、`\"` 变裸引号）在参数校验时先本地修复，修复成功直接执行、不再回灌模型重试。
- **get_tools 清单精简**：工具参数表为紧凑单行（`"参数名": 类型 必填/可选 说明`），调用示例占位值用「…」单字符，避免网页渲染破坏后模型照抄出错。
- **会话同步**：狐狸 AI「新建会话后首条消息」自动携带 `fox_new_session` 信号，经 WebAI2API 透传到各文本适配器（DeepSeek / ChatGPT / Claude / Gemini / 豆包 / LMArena / z.ai），点击站点「新对话」按钮重置浏览器侧会话（找不到则安全跳过）；同补丁去除 warmup ping 噪音（文本协议本就不走 API 前缀缓存，不再把 ping 当真实消息打进网页对话）。DeepSeek 适配器还支持复用当前对话：先在当前页面等输入框、找不到才 goto 主页兜底，多轮工具调用与网页侧天然衔接。
- **工具调用符号映射**：工作区 `.fox-ai/tool-tag-map.json`（优先）或用户级 `~/.fox-ai/tool-tag-map.json` 可自定义工具调用标签（格式 `{ "open": "[[tool:%name%]]", "close": "[[/tool]]" }`），避免固定 `<foxtool>` 标签在网页对话中太显眼被风控识别；解析前先归一化为内部标准调用，功能与默认完全一致。示例配置已写入 `~/.fox-ai/tool-tag-map.json`，可自行修改或改回 `{}` 停用。

## 界面与渲染

- **统一视觉风格**：聊天面板、环境与插件面板、活动栏与树视图统一圆角、accent 渐变、毛玻璃、精致代码块与思考链卡片；颜色基于 VS Code 主题变量（`--vscode-*`），深浅主题自适应，不引入外部字体。
- **富文本渲染**：对话气泡支持完整 Markdown——代码语法高亮、LaTeX 公式（KaTeX，块级 `$$…$$` 与行内 `$…$`）、外链图片缩略图、GFM 表格（含标题后无空格 `##1.`、列表符号后无空格 `-按`、分割线粘连 `---建议` 等非规范写法）；高亮与公式依赖本地 `media/vendor/`，运行时无需联网。
- **搜索引用角标**：模型回答里的引用以可点击角标呈现，点击用系统浏览器打开来源；浮窗含来源摘要（snippet）。兼容中文来源标签、markdown 脚注 `[^n]`、`[n]` 编号索引；正文裸链接自动可点；多厂商原生联网搜索的真实 URL 统一汇入角标。
- **多语言**：界面自动跟随 VS Code 显示语言——简体中文（默认）与 English。命令面板与设置项走 `package.nls` 机制，聊天面板走内置 `t()` 函数，后端通知走 `src/i18n.js` 的 `tw()`。其它语言可复制 `l10n/webview.en.json` 为对应语言包接入 `src/i18n.js`。

## 设置项参考

| 分组 | 关键配置 |
| --- | --- |
| 连接 | `foxAi.provider` / `foxAi.baseUrl` / `foxAi.model` / `foxAi.apiKey` |
| 对话 | `foxAi.temperature` / `foxAi.maxTokens` / `foxAi.maxHistory` / `foxAi.streamFormat` / `foxAi.vision.*` |
| 深度思考 | `foxAi.deepThinking.enabled` / `.effort` / `.budgetTokens` / `.promptFallback` |
| 生图 | `foxAi.imageGen.enabled` / `.provider` / `.baseUrl` / `.apiKey` / `.model` |
| 审查注入 | `foxAi.review.enabled` / `foxAi.review.injectTimeout` |
| 上下文用量 | `foxAi.showContextUsage` / `foxAi.contextWindow` |
| 自动压缩 | `foxAi.knowledgeBase.autoSummarize.enabled` / `.threshold` / `.keepRecent`（目录固定 `~/.fox-ai/knowledge-2`） |
| 存储位置 | `foxAi.sessions.storagePath` / `foxAi.memory.storagePath` / `foxAi.skills.storagePath` / `foxAi.planTasks.storagePath` |
| 智能体 | `foxAi.agent.enabled` / `foxAi.agent.maxSteps` / `foxAi.agent.maxContinues` / `foxAi.agent.autoApprove` / `foxAi.agent.blockedCommands` / `foxAi.agent.providerProfile`（auto·deepseek·openai·claude·none） |
| 任务清单 | `foxAi.planTask.enabled` / `.provider` / `.baseUrl` / `.model` |
| 代码验证 | `foxAi.nodePath` / `foxAi.verify.enabled` / `.provider` / `.baseUrl` / `.model` |
| MCP | `foxAi.mcp.enabled` / `foxAi.mcp.priority` / `foxAi.mcp.servers` / `foxAi.mcp.playwright.enabled` |
| 安全策略 | `foxAi.policy.mode` / `.blockedPaths` / `.blockedCommands` |
| 知识库检索 | `foxAi.knowledgeBase.bm25Enabled` / `.topK` |
| 项目扫描 | `foxAi.projectScan.cacheEnabled` |
| 行内补全 | `foxAi.inlineCompletion.enabled` / `.provider` / `.baseUrl` / `.apiKey` / `.model` / `.maxTokens` / `.maxFileLines` / `.maxContextChars` / `.suffixLines` / `.fimStrategy` / `.fimEndpoint` / `.useProjectContext` / `.projectContextChars` / `.debounce` / `.contextLines` |
| 智能体（续） | `foxAi.agent.maxMessageBytes` / `.structuredOutput` / `.projectSkeleton` |
| 失败切换 | `foxAi.failover.enabled` / `.triggers` / `.maxRetries` / `.targets` |
| 沙盒 | `foxAi.sandbox.enabled` / `.dir` / `.timeout` / `.allowDocker` |
| 本地/弱模型 | `foxAi.agent.toolProtocol` / `foxAi.agent.localWeakModelMode` / `foxAi.agent.localConstrainedDecoding` |
| 子代理与并行 | `foxAi.subagents.enabled` / `.concurrency` / `.maxSteps` / `.maxToolCalls` / `.timeoutMs` / `.autoApproveWrites` |
| 后台任务 | `foxAi.background.enabled` / `.maxConcurrent` / `.timeoutMs` / `.maxSteps` / `.maxToolCalls` / `.allowMainWorkspaceWrites` / `.keepWorktree` / `.maxHistory` / `.storagePath` |
| 检查点与回滚 | `foxAi.checkpoints.enabled` / `.maxSnapshots` |
| 生命周期钩子 | `foxAi.hooks.enabled` |
| 代码库语义索引 | `foxAi.rag.extensions` / `.maxFiles` / `.autoRebuildHours` |
| 结构化长期记忆 | `foxAi.memory.topics.enabled` / `.budget` / `.autoHarvest` |
| 项目规则 | `foxAi.projectRules.enabled` / `.budget` |
| 智能体模式 | `foxAi.modes.current` / `foxAi.modes.overrides` / `foxAi.modes.models` |
| 自定义命令 | `foxAi.slashCommands.storagePath` |
| Auto Mode | `foxAi.autoMode.enabled` / `foxAi.autoMode.allow` / `foxAi.autoMode.deny` |
| Best-of-N | `foxAi.bestOfN.enabled` / `foxAi.bestOfN.judge` / `foxAi.bestOfN.candidates` / `foxAi.bestOfN.temperature` |
| 冲突感知 | `foxAi.conflictWatch.enabled` / `foxAi.conflictWatch.requireRead`（未读禁止写） |
| 规划器 | `foxAi.planner.enabled`（默认开） / `.mode` / `.model` / `.maxTokens` / `.timeoutMs` |
| 本地自动化 | `foxAi.automations.enabled` / `foxAi.automations.storagePath` / `foxAi.automations.webhookPort` / `foxAi.automations.webhookSecret` |
| Headless / CI | `foxAi.headless.enabled` / `foxAi.headless.provider` / `foxAi.headless.baseUrl` / `foxAi.headless.apiKey` / `foxAi.headless.model` / `foxAi.headless.apiMode` / `foxAi.headless.transport` / `foxAi.headless.temperature` / `foxAi.headless.maxTokens` / `foxAi.headless.timeout` |
| WebAI2API | `foxAi.webai2api.autoStart` / `foxAi.webai2api.mirror` / `foxAi.webai2api.projectDir` / `foxAi.webai2api.proxy` |
| 工具引导 | `foxAi.agent.toolGuide`（auto / on / off） |
| 工具符号映射 | 工作区 `.fox-ai/tool-tag-map.json` 或 `~/.fox-ai/tool-tag-map.json` |

## 命令参考

命令名称以「狐狸 AI：」为前缀（命令面板 `Ctrl+Shift+P`）：

- `打开对话面板` —— 打开 / 聚焦对话面板。
- `打开记忆文件` —— 查看与编辑长期记忆。
- `打开用户技能目录` —— 打开用户自建技能目录。
- `打开任务清单` —— 查看与编辑项目任务清单。
- `打开环境管理器` —— 查看环境与端口等信息。
- `打开知识库` / `整理知识库` —— 知识库浏览与整理。
- `让狐狸 AI 修复这个问题` —— 通过 Quick Fix 菜单灯泡触发修复。
- `暂停` / `取消` / `继续` —— 过程控制。
- `撤销上次编辑` / `重做上次撤销的编辑` —— 文件改动回滚与恢复。
- `查看后台任务` —— 可视化查看后台 Agent 任务列表。
- `回滚到检查点` —— 选择检查点并一键回滚。
- `重建代码索引` —— 强制全量重建全仓库语义索引。
- `打开 Hooks 配置` —— 编辑生命周期钩子。
- `打开主题记忆` —— 浏览结构化长期记忆的主题目录。
- `切换智能体模式` —— 在编码 / 架构 / 问答 / 排错之间切换。
- `打开命令模板目录` —— 创建 / 打开 Slash Command 模板。
- `切换 Auto Mode` —— 开关自动门控。
- `管理自动化` —— 创建 / 打开本地自动化定义。
- `运行 Headless 调用` —— 用当前主对话模型做一次无状态调用。

## 工具清单

智能体可调用的部分工具：`read_file` `list_file` `glob` `grep` `write_file` `edit_file` `delete_file` `run_command` `read_terminal` `get_diagnostics` `get_ports` `get_debug_console` `save_memory` `get_memory` `create_skill` `list_skills` `use_skill` `create_plan_task` `update_plan_task` `list_plan_tasks` `call_extension_command` `organize_knowledge` `query_code_graph` `review_changes` `security_audit` `generate_image` `search_codebase` `index_codebase` `spawn_subagent` `run_background_agent` `background_jobs` `clarify` `get_tools` 等。

> 智能体工作准则：用户要求“读 / 看 / 打开 / 检查某文件”时，必须立即调用 `read_file` 读取真实内容，不凭记忆猜测或编造。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 扩展图标不显示 | 确认 `package.json` 的 `icon` 指向存在的 `media/fox.png` |
| AI 审查不生效 | 检查 `foxAi.verify.enabled` 是否为 `true`，且 provider / model 可达 |
| 终端读不到输出 | 确保目标终端是当前活动终端，或点击“读取终端”按钮 |
| 记忆文件打不开 | 首次使用先执行「狐狸 AI：打开记忆文件」生成空文件 |
| 语法校验报错 | 检查 `foxAi.nodePath` 指向的 node 是否可用 |
| 上下文用量为 0 | 仅发送消息后才会统计；若始终为 0，检查 `foxAi.showContextUsage` 是否开启 |
| 上下文占比不显示 | 填写 `foxAi.contextWindow`（如 128000）后才显示百分比 |
| 会话 / 历史消息不显示 | 扩展会同步保存会话 ID；重启后丢失会自动恢复至最近会话 |
| 报错 «Messages with role 'tool' must be a response...»（400） | 发送前已自动清洗孤立工具消息，正常情况下不再触发 |
| 让 AI“读某文件”它却反问 | 工作准则要求必须立即 `read_file`，可明确强调“请先读取文件” |
| 续跑任务提示“关联的对话会话已丢失” | 已实现多层兜底：本存储查找 → 默认/历史目录导入 → 当前会话继续 |
| 多步骤任务想先确认再执行 | 开启“规划确认模式”（`foxAi.planAndExecute.enabled` + `confirmGate`） |
| 内存占用偏高 | 减少知识库超大文件、关闭非必要路径，或调小 `foxAi.agent.maxMessageBytes` |
| 知识库检索不到想要内容 | 调大 `foxAi.knowledgeBase.topK`，或开启“知识库整理” |
| 让 AI 画图没反应 | 生图是独立通道，需开启 `foxAi.imageGen.enabled` 并配置生图模型 |
| 图片不是想要的 | 属生图模型质量问题；抓取逻辑已加固，可更换生图模型 |
| 对话里的图片重开窗口后消失 | 图片已持久化存档，重开自动恢复；检查 `foxAi.sessions.storagePath` |
| WebAI2API 网页对话里动态块反复出现 | 已实现「内容哈希去重 + 会话级只发一次」：内容不变不重复注入 |
| 重启服务后旧会话又强制调 get_tools | 恢复会话自动识别历史里已有的 get_tools 记录，跳过重复强制 |
| 长期记忆里混入系统提示 | 自动沉淀已过滤工具调用块 / 回灌提示 / 报错 JSON 等协议噪音 |
| 让 AI 写第 N 行、结果写偏 | 审批预览与自检摘要为带 1 索引行号的 diff，落点偏差一眼可见 |
| 环境与插件面板的审计日志无记录 | 审计日志统一写入 `~/.fox-ai/logs/`（runtime-audit.log / bridge-audit.log / kb-organize.log），面板「刷新」即读该目录 |

## 许可证

本扩展以 **GNU General Public License v3.0（GPL-3.0）** 发布，为自由软件。您享有运行、研究、分发与修改的自由；分发或修改时须遵守 GPL-3.0 中保持开源、提供对应源代码等条款。

> 本扩展仅在 GitHub 发布，未上架任何插件平台（如 VS Code Marketplace、Open VSX 等扩展商店）。请从 GitHub 官方仓库获取版本，避免通过第三方渠道下载被篡改的安装包。

许可证完整文本见仓库根 `LICENSE` 文件，亦可访问 <https://www.gnu.org/licenses/gpl-3.0.html> 查阅官方版本。

## 常见问题

**Q1：本扩展是免费的吗？**
是的。GPL-3.0 自由软件，可自由运行、研究、分发与修改，但须遵守 GPL 关于保持开源与提供对应源代码的条款。

**Q2：可以使用本地模型吗？**
可以。`foxAi.baseUrl` 填本地推理引擎（llama.cpp / Ollama / LM Studio 等）的 HTTP 地址，无需密钥时 `apiKey` 留空。

**Q3：为什么长回答会中途停止？**
通常是 `foxAi.maxTokens` 偏小导致输出被截断。可先调大 `maxTokens`；扩展也会在截断时自动继续（见「输出截断自动继续」）。

**Q4：如何保证 AI 不误删系统文件？**
工作区外文件修改 / 删除强制三重确认；`rm -rf`、`git reset --hard` 等不可逆命令在自动批准关闭时须征求同意。可在 `foxAi.policy.blockedPaths` / `blockedCommands` 进一步加固。

**Q5：会话数据保存在哪里？**
会话、记忆、技能、任务清单均有独立存储路径，可在设置的“存储位置”分组查看与迁移。

**Q6：怎么让狐狸 AI 画图？**
开启 `foxAi.imageGen.enabled` 并配置生图模型（provider / baseUrl / apiKey / model）。配置好后直接说“画一个 XX”即可，图片可一键保存，会话重开不丢失。

**Q7：WebAI2API 网页版对话里，工具参数偶尔被拒绝？**
网页渲染会破坏 JSON 转义（`\n` 变真换行、`c:\Users` 变非法转义、`\"` 变裸引号）。扩展会在参数校验时先本地修复，修复成功直接执行、不再回灌模型重试。

**Q8：网页对话里的【动态上下文】大块会每轮重复吗？**
不会。动态上下文按内容哈希去重：内容与会话上次一致就不重复注入（网页自带历史、模型始终可见），只有内容变化才发一次；重启服务恢复旧会话也不重复首发。

## 前缀缓存优化

输入总量很大（十万级 token）时，服务商的前缀缓存（Prompt Cache / KV Cache）能把请求开头固定不变那段缓存下来，后续只计费 / 计算增量，大幅省 token 与延迟。fox-ai 做了一系列工程配合：

- **铁打前缀**：系统提示词与工具定义在请求最前面且一成不变；知识库检索、长期记忆、技能、任务清单、项目规则、项目结构、时间等每轮变动内容统一注入「最后一条用户消息」前（请求尾部），绝不回写 system，确保前缀缓存整段命中。
- **知识库是工具、不进前缀**：知识库内容不注入每轮请求——智能体需要时用 `use_skill(_knowledge_base)` 按需检索，只发一行“知识库已就绪”技能提示，避免每轮把知识灌进请求造成整段 miss。
- **历史只追加、不改写**：工具结果用前缀保持的确定性截断（保留前 N 字符、截断一次即冻结），绝不把旧结果改写成摘要——改写会让断点之后的整段前缀缓存失效。
- **token 预算截断（而非固定条数滑动窗口）**：历史只追加增长，超预算（`foxAi.agent.maxHistoryTokens`，默认约上下文六成）才从最早截断一次；固定条数窗口每轮“丢最旧、加最新”会让前缀每轮漂移。
- **DeepSeek 专用 text 协议**：DeepSeek 原生 function calling 把 `tools` 序列化在 messages 之后不参与前缀缓存，工具 schema 每轮原价计费、命中率封顶约 85%；因此 DeepSeek 默认走 text 协议把工具定义写进 system（可缓存），长任务命中率约 98%。需要原生 function calling 时改 `foxAi.agent.toolProtocol = native`。
- **工具集固化**：非 DeepSeek 云端模型始终发送全量工具定义，并按函数名排序固化序列化顺序，避免 `tools` 字段抖动破坏前缀。
- **缓存命中监控**：从响应 `usage` 抽取缓存命中 token，计算本轮 / 会话累计命中率并经 `cacheStats` 上报状态栏；同时计算请求前缀 SHA 指纹，与首轮不一致即告警。
- **缓存预热（可选）**：`foxAi.cacheWarmup.enabled = true` 后新会话首轮先发一个只含 system+tools、`max_tokens` 极小的请求把铁打前缀提前灌进缓存。默认关闭；WebAI2API 文本协议自动跳过（浏览器自带会话历史，无 API 前缀缓存需求）。

---

*本说明书随软件版本更新。如与界面实际行为存在差异，以当前安装版本为准。*
