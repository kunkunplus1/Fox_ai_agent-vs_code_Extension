'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ws = require('./workspace');
const term = require('./terminal');
const ctxTools = require('./context');
const { webSearch, getCurrentTime } = require('./webSearch');
const mcp = require('./mcp'); // MCP 连接器适配器骨架（默认未启用）
const mcpAuthor = require('./mcpAuthor'); // 自写 MCP 服务器（生成 / 登记 / 自动发现）
const reviewChanges = require('./reviewChanges'); // 原始版 vs 修改版对比 + 深度思考
const securityAudit = require('./securityAudit'); // 只读代码安全自检（自检 Agent）
const skillAudit = require('./skillAudit'); // 技能安全审查（下载技能后启动前只读审查）
const referee = require('./referee'); // 只读第三方裁判 Agent（双盲交叉验证）
const sandboxTest = require('./sandboxTest'); // 沙盒代码自测（隔离运行 + canary 校验）
const imageGen = require('./imageGen'); // 生图通道（独立第二模型，服务总控 agent，类似 vision 识图但反向）
const subagents = require('../subagents'); // 子代理 / 并行 agent / agent teams
const codebaseIndex = require('./codebaseIndex'); // 全仓库语义索引（RAG）
const bridge = require('../extensionBridge'); // 跨扩展命令调用桥
const kb = require('../knowledgeBase'); // 会话隔离与跨会话授权

/**
 * kind: read = 只读（可自动批准）; edit = 改动文件; exec = 执行命令
 */
const TOOLS = [
  {
    name: 'read_file',
    kind: 'read',
    title: (a) => `读取 ${a.path || ''}`,
    description:
      '读取文件内容，返回带行号的文本。支持工作区内相对路径或绝对路径（可跨工作区读取）。可用 start_line / end_line 只读一段，用 start_char / end_char 只读同一行内的字符范围。修改文件前必须先读。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区根目录的路径，如 src/app.js' },
        start_line: { type: 'integer', description: '起始行（从 1 开始，可选）' },
        end_line: { type: 'integer', description: '结束行（可选）' },
        start_char: { type: 'integer', description: '起始列（从 1 开始，仅与 end_char 同用且 start_line=end_line 时生效，可选）' },
        end_char: { type: 'integer', description: '结束列（包含，可选）' }
      },
      required: ['path']
    },
    run: (a) => ws.readFile(a)
  },
  {
    name: 'list_dir',
    kind: 'read',
    title: (a) => `列出目录 ${a.path || '.'}`,
    description: '列出目录结构，支持相对路径或绝对路径，depth 控制递归层数（1-3），自动跳过 node_modules、.git 等。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，默认为工作区根目录' },
        depth: { type: 'integer', description: '递归深度 1-3，默认 1' }
      }
    },
    run: (a) => ws.listDir(a)
  },
  {
    name: 'find_files',
    kind: 'read',
    title: (a) => `查找文件 ${a.pattern || ''}`,
    description: '按 glob 通配符查找文件路径，例如 **/*.ts、src/**/test_*.py。传 scope=global 可在整个电脑范围搜索（默认从用户目录开始）；也可用 root 指定起始目录。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式' },
        scope: { type: 'string', enum: ['workspace', 'global'], description: '搜索范围：workspace=当前工作区（默认），global=全电脑' },
        root: { type: 'string', description: '全局搜索时起始于哪个目录，默认用户主目录' },
        max_results: { type: 'integer', description: '最多返回多少条。1.1.17 起默认 200、上限 2000（电脑内搜索一次能拿更多，不再「搜不到几个」）。' }
      },
      required: ['pattern']
    },
    run: (a) => ws.findFiles(a)
  },
  {
    name: 'search_text',
    kind: 'read',
    title: (a) => `搜索「${a.query || ''}」`,
    description: '全文搜索关键字或正则，返回 文件:行号: 内容。传 scope=global 可在整个电脑范围搜索（默认从用户目录开始）；也可用 root 指定起始目录。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜索的文本或正则' },
        glob: { type: 'string', description: '限定文件范围，如 src/**/*.js' },
        scope: { type: 'string', enum: ['workspace', 'global'], description: '搜索范围：workspace=当前工作区（默认），global=全电脑' },
        root: { type: 'string', description: '全局搜索时起始于哪个目录，默认用户主目录' },
        is_regex: { type: 'boolean', description: 'query 是否为正则，默认 false' },
        max_results: { type: 'integer', description: '最多返回多少条。1.1.17 起默认 80、上限 500。' }
      },
      required: ['query']
    },
    run: (a) => ws.searchText(a)
  },
  {
    name: 'get_tools',
    kind: 'read',
    title: (a) => `查询工具清单（${a.query || '全部'}）`,
    description:
      '查询当前可用的工具列表、参数与调用格式。**开始任何任务前，第一步必须调用本工具**获取工具清单；之后也可随时用 query 按关键词检索（如"文件""搜索""记忆""执行命令"）。detail="full" 返回完整参数说明，默认 brief（名称+描述+必填参数+调用示例）。本工具返回的内容里会附每个工具的 <foxtool> 调用示例，请严格照抄格式。**已加载的 MCP 工具也会附在清单尾部**：传 query=mcp（或 query 里含 mcp）单独检索。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词（可选），如"文件读写""搜索""执行命令""记忆"' },
        detail: { type: 'string', enum: ['brief', 'full'], description: 'brief=简要（默认），full=完整参数说明' }
      }
    },
    run: (a) => {
      const q = String((a && a.query) || '').trim();
      const detail = (a && a.detail) === 'full' ? 'full' : 'brief';
      const lq = q.toLowerCase();
      let list = TOOLS;
      if (q) list = TOOLS.filter((t) => {
        const props = (t.parameters && t.parameters.properties) || {};
        const hay = (t.name + ' ' + (t.description || '') + ' ' + Object.keys(props).join(' ')).toLowerCase();
        return hay.includes(lq);
      });

      // 已加载的 MCP 工具：query=mcp 或 query 为空时并入结果尾部（不占本地条数）
      let mcpLines = [];
      try {
        const cached = mcp.getCachedTools && mcp.getCachedTools();
        if (Array.isArray(cached) && cached.length) {
          const mcpList = !q || lq === 'mcp' || lq === 'mcp工具' || lq.includes('mcp')
            ? cached
            : cached.filter((t) => {
                const hay = (t.name + ' ' + (t.description || '')).toLowerCase();
                return hay.includes(lq);
              });
          if (mcpList.length) {
            mcpLines = mcpList.map((t) => {
              const name = t.name || (t.remoteName ? 'mcp__' + t.remoteName : '?');
              const desc = (t.description || '').slice(0, 160);
              const params = (t.inputSchema && t.inputSchema.properties) ? Object.keys(t.inputSchema.properties) : [];
              const brief = `【MCP 工具】${name}\n描述：${desc || '（无描述）'}` +
                (params.length ? `\n参数：${params.join('、')}` : '');
              return detail === 'full' ? brief + `\n调用示例：<foxtool name="${name}">\n{"参数名": "参数值"}\n</foxtool>` : brief;
            });
          }
        }
      } catch (_) {}

      if (!list.length && !mcpLines.length) {
        const allNames = TOOLS.map((t) => t.name).join('、') +
          (mcpLines.length ? '' : '');
        return `没有匹配「${q}」的工具。全部可用工具：${allNames}。也试试 query=mcp 看已加载的 MCP 工具。`;
      }
      const lines = list.map((t) => renderToolGuideLine(t, detail));
      let body = `共 ${list.length} 个工具（每条附 <foxtool> 调用示例，严格照抄格式）：\n\n` + lines.join('\n\n');
      if (mcpLines.length) {
        body += `\n\n【已加载 MCP 工具 ${mcpLines.length} 个】\n` + mcpLines.join('\n\n');
      }
      return body +
        '\n\n【调用格式】\n<foxtool name="工具名">\n{"参数名": "参数值"}\n</foxtool>\n写完 </foxtool> 后立即停止输出，等待工具结果。';
    }
  },
  {
    name: 'clarify',
    kind: 'read',
    title: (a) => `向用户澄清：${String((a && a.question) || '').slice(0, 30)}`,
    description:
      '当用户的需求存在相互矛盾、歧义，或你对要求不清楚、无法可靠继续时，调用本工具向用户澄清。给出你的疑问（question）与 2-4 个建议选项（options）；用户在弹窗中点选一个建议，或自行输入补充要求。收到用户答复后，严格依据答复继续，不要猜测。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '向用户提出的澄清问题，一句话说清哪里矛盾/不清楚' },
        options: { type: 'array', items: { type: 'string' }, description: '给用户的建议选项（2-4 个，可选），用户可点选其一，也可自行输入' }
      },
      required: ['question']
    },
    run: async (a, ctx) => {
      if (ctx && typeof ctx.askUser === 'function') {
        return await ctx.askUser({ question: a.question, options: a.options || [] });
      }
      return '（当前环境不支持澄清交互，无法向用户提问。）请基于现有信息给出你的最佳判断；若确实无法继续，直接说明你的困惑与推测即可。';
    }
  },
  {
    name: 'write_file',
    kind: 'edit',
    title: (a) => `写入 ${a.path || ''}`,
    description:
      '创建新文件或整体覆盖已有文件。改动已有文件时优先用 edit_file，避免整篇重写。修改工作区外的文件前，系统会弹出三重确认（警告、输入路径、最终确认）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '完整文件内容' }
      },
      required: ['path', 'content']
    },
    run: (a, c) => ws.writeFile(a, c)
  },
  {
    name: 'edit_file',
    kind: 'edit',
    title: (a) => `修改 ${a.path || ''}`,
    description:
      '精确修改文件：1) 传 old_text + new_text 做片段替换；2) 加 start_line / end_line 限定搜索范围；3) 传 start_line + start_char + end_line + end_char 做字符级范围替换（old_text 可空）。改写文件时优先用本工具，不要整篇 write_file。修改工作区外的文件前，系统会弹出三重确认。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        old_text: { type: 'string', description: '要被替换的原文片段（字符级范围替换时可空）' },
        new_text: { type: 'string', description: '替换后的新内容' },
        replace_all: { type: 'boolean', description: '是否替换所有匹配处，默认 false' },
        start_line: { type: 'integer', description: '搜索/替换起始行（从 1 开始，可选）' },
        end_line: { type: 'integer', description: '搜索/替换结束行（可选）' },
        start_char: { type: 'integer', description: '字符级范围起始列（从 1 开始，可选）' },
        end_char: { type: 'integer', description: '字符级范围结束列（包含，可选）' }
      },
      required: ['path', 'new_text']
    },
    run: (a, c) => ws.editFile(a, c)
  },
  {
    name: 'delete_file',
    kind: 'edit',
    title: (a) => `删除 ${a.path || ''}`,
    description: '删除文件或目录（进系统回收站，可恢复）；也可只删除指定行范围（start_line / end_line）。删除工作区外的文件前，系统会弹出三重确认。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件或目录路径' },
        recursive: { type: 'boolean', description: '删除目录时需要设为 true' },
        start_line: { type: 'integer', description: '只删除从该行开始的范围（可选）' },
        end_line: { type: 'integer', description: '只删除到该行结束的范围（可选）' }
      },
      required: ['path']
    },
    run: (a, c) => ws.deleteFile(a, c)
  },
  {
    name: 'run_command',
    kind: 'exec',
    title: (a) => `执行 ${(a && (a.argv ? a.argv.join(' ') : a.command)) || ''}`,
    description:
      '执行 shell 命令并返回输出与退出码，用于安装依赖、构建、跑测试等。命令必须非交互（自带 -y 等参数），不要用会一直挂起的命令（如 npm run dev 长期驻留服务）。\n\n**推荐 argv 数组模式（转义最省心）**：带空格或特殊字符的参数用 argv 传数组，如 `{"argv":["cat","/path/My Docs"]}`——插件按当前 shell 自动转义拼接（集成终端）或子进程数组模式直传（不经 shell），模型完全不用管转义。纯命令（无空格参数、无管道/重定向）用 `command` 字符串即可。需要管道、重定向、环境变量前缀（如 `cd x && make`）时只能用 command 字符串，带空格参数用单引号包裹（\'/path/My Docs\'）。\n\n**argv 与 command 同时给出时以 argv 为准**；argv 仅限参数数组（argv[0] 为程序），不解析管道/重定向（那属于 shell 语法，走 command）。\n\n**异步模式**：传 bg=true 会立即提交后台任务并返回任务号（不阻塞当前对话），用 background_jobs action=get + id 随时查状态与完整输出，action=cancel 可取消。适合安装依赖、大构建、长测试这类耗时命令；同步等结果最多等到该模型配置的 commandTimeout。',
    parameters: {
      type: 'object',
      properties: {
        argv: { type: 'array', items: { type: 'string' }, description: '参数数组：argv[0] 是程序/命令名，后续是参数。带空格路径直接放数组元素（如 ["cat","/path/My Docs"]），转义由执行层处理。不能含管道/重定向（那属于 shell 语法，用 command）。' },
        command: { type: 'string', description: '要执行的完整命令（含管道/重定向/环境变量前缀时用这个；带空格参数用单引号包裹）' },
        cwd: { type: 'string', description: '工作目录，默认工作区根目录' },
        explanation: { type: 'string', description: '一句话说明为什么要跑这条命令' },
        bg: { type: 'boolean', description: 'true=异步后台执行，立刻返回任务号不阻塞；默认 false（同步等结果）' }
      },
      required: []
    },
    run: (a, c) => term.runCommand(a, c)
  },
  {
    name: 'get_terminal_output',
    kind: 'read',
    title: () => '读取终端输出',
    description:
      '读取当前活动终端里的可见内容（包括用户自己手动执行命令产生的报错），或本次会话最近一次命令的输出。用户说“看下终端报错”时用这个。',
    parameters: {
      type: 'object',
      properties: { lines: { type: 'integer', description: '读取最后多少行，默认 80' } }
    },
    run: (a) => term.readActiveTerminal(a)
  },
  {
    name: 'get_diagnostics',
    kind: 'read',
    title: (a) => (a && a.path ? `检查 ${a.path} 的问题` : '读取问题面板'),
    description:
      '读取 VS Code 问题面板里的报错与警告（语法错误、类型错误、ESLint 等）。改完代码后应当调用它确认有没有引入新问题。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '只看某个文件（可选）' },
        severity: { type: 'string', enum: ['error', 'warning', 'info', 'all'], description: '最低级别，默认 warning' },
        max_results: { type: 'integer', description: '最多返回多少条' }
      }
    },
    run: (a) => ctxTools.getDiagnostics(a)
  },
  {
    name: 'get_editor_context',
    kind: 'read',
    title: () => '查看编辑器状态',
    description: '获取当前打开的文件、光标位置、选中的代码、已打开的标签页。',
    parameters: { type: 'object', properties: {} },
    run: () => ctxTools.getEditorContext()
  },
  {
    name: 'get_debug_console',
    kind: 'read',
    title: () => '读取调试控制台',
    description: '读取当前活动调试会话的调试控制台输出。在分析程序打印日志或调试报错前调用。',
    parameters: {
      type: 'object',
      properties: {
        lines: { type: 'integer', description: '读取最后多少行，默认 80' }
      }
    },
    run: (a) => ctxTools.getDebugConsole(a)
  },
  {
    name: 'get_ports',
    kind: 'read',
    title: () => '读取端口列表',
    description: '获取本机正在监听的端口列表，作为 VS Code「端口」面板的补充。当用户提到服务、端口转发、本地服务器时使用。',
    parameters: {
      type: 'object',
      properties: {
        max_results: { type: 'integer', description: '最多返回多少条，默认 50' }
      }
    },
    run: (a) => ctxTools.getForwardedPorts(a)
  },
  {
    name: 'open_file',
    kind: 'read',
    title: (a) => `打开 ${a.path || ''}`,
    description: '在编辑器里打开文件并跳到指定行，支持相对路径或绝对路径，方便用户查看你说的位置。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        line: { type: 'integer', description: '跳转到第几行' }
      },
      required: ['path']
    },
    run: (a) => ws.openFile(a)
  },
  {
    name: 'query_code_graph',
    kind: 'read',
    title: (a) => `查询代码图谱：${a.target || ''}`,
    description: '查询项目代码图谱：who-calls（谁调用了某文件）、depends-on（某文件依赖谁）、imports（谁导入了某文件）。用来分析依赖、影响范围，不必遍历文件。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['who-calls', 'depends-on', 'imports'], description: '查询类型' },
        target: { type: 'string', description: '目标文件名或相对路径，如 src/agent.js 或 agent.js' }
      },
      required: ['op', 'target']
    },
    run: (a) => {
      const projectScan = require('../projectScan');
      const root = require('./workspace').rootPath();
      const proj = projectScan.detectProjectCached(root);
      return projectScan.queryGraph(proj, a.op, a.target);
    }
  },
  {
    name: 'save_memory',
    kind: 'edit',
    title: (a) => `记住：${(a.text || '').slice(0, 24)}`,
    description:
      '保存一条长期记忆（用户偏好、项目约定、踩过的坑、架构决策等），跨会话持久保存，下次对话会按相关性自动注入。记忆会被自动归类到主题文件里（用户可直接手动编辑），内容近似重复时会自动跳过。topic 可选，不传会自动判断：project-conventions（项目约定/规范）｜user-preferences（用户偏好）｜debugging-lessons（踩坑教训）｜architecture-decisions（架构技术选型）｜workflows（操作流程）｜domain-knowledge（业务领域知识）｜general。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的内容，一句话说清，自包含（别写「像上次那样」这种没有上下文看不懂的）' },
        topic: {
          type: 'string',
          enum: ['project-conventions', 'user-preferences', 'debugging-lessons', 'architecture-decisions', 'workflows', 'domain-knowledge', 'general'],
          description: '可选，指定归入哪个主题；不传则自动判断'
        },
        tags: { type: 'string', description: '可选，逗号分隔的标签，如 偏好,Python' },
        category: { type: 'string', description: '（兼容旧字段）preference / project / lesson / general' }
      },
      required: ['text']
    },
    run: (a, c) => {
      const store = c && c.memory;
      const topics = c && c.topicMemory;
      const tags = a.tags ? String(a.tags).split(',').map((t) => t.trim()).filter(Boolean) : [];
      // 结构化主题记忆（新）：自动路由主题 + 近重复去重
      let topicNote = '';
      if (topics) {
        const legacyMap = { preference: 'user-preferences', project: 'project-conventions', lesson: 'debugging-lessons', general: 'general' };
        const topic = a.topic || legacyMap[a.category] || '';
        const r = topics.write(a.text, { topic: topic || undefined, source: '主动记忆' });
        if (r && r.ok) {
          const { TOPICS } = require('../memoryTopics');
          topicNote = `（归入「${(TOPICS[r.topic] && TOPICS[r.topic].title) || r.topic}」）`;
        } else if (r && r.duplicated) {
          return `这条记忆已经存在（内容近似），未重复保存：${r.text}`;
        }
      }
      // 扁平记忆（旧）：保留写入，兼容既有注入与 UI
      if (store) store.add({ text: a.text, tags, category: a.category });
      if (!store && !topics) return '记忆存储不可用';
      const t = String(a.text || '').trim();
      return t ? `已记住${topicNote}：${t}` : '记忆内容为空，未保存';
    }
  },
  {
    name: 'get_memory',
    aliases: ['recall_memory'], // 1.1.39：兼容模型拼错/记混的工具名，别名统一解析到本工具
    kind: 'read',
    title: (a) => (a.query ? `回忆「${a.query}」` : '回忆全部记忆'),
    description: '检索跨会话长期记忆。带 query 时按主题相关性 + 关键字召回；query 为空时返回各主题概况（有哪些主题、各多少条）。用于确认之前是否记过某件事、或主动回忆项目约定与踩过的坑。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选检索关键字或问题描述' },
        topic: {
          type: 'string',
          enum: ['project-conventions', 'user-preferences', 'debugging-lessons', 'architecture-decisions', 'workflows', 'domain-knowledge', 'general'],
          description: '可选，只看某个主题'
        }
      }
    },
    run: (a, c) => {
      const store = c && c.memory;
      const topics = c && c.topicMemory;
      const out = [];

      if (topics) {
        if (a.topic) {
          const items = topics.read(a.topic);
          const { TOPICS } = require('../memoryTopics');
          const title = (TOPICS[a.topic] && TOPICS[a.topic].title) || a.topic;
          out.push(items.length ? `## ${title}\n` + items.map((t) => '- ' + t).join('\n') : `主题「${title}」下还没有记忆。`);
        } else if (a.query) {
          const r = topics.loadRelevant(a.query, { maxTopics: 4 });
          if (r.text) out.push(r.text);
        } else {
          const list = topics.listTopics().filter((t) => t.count);
          if (list.length) {
            out.push('长期记忆主题概况（共 ' + topics.totalCount + ' 条）：');
            for (const t of list) out.push(`- ${t.title} \`${t.slug}\`：${t.count} 条 —— ${t.desc}`);
            out.push('\n想看某个主题的全部内容，带 topic 参数再调一次。');
          }
        }
      }

      // 合并旧版扁平记忆（历史数据兼容）
      if (store) {
        const items = store.search(a.query);
        if (items.length) {
          const seen = new Set(out.join('\n'));
          const extra = items.map((it) => '- ' + it.text).filter((l) => !seen.has(l));
          if (extra.length) out.push((out.length ? '\n### 其它记忆\n' : '') + extra.join('\n'));
        }
      }

      if (!out.length) {
        if (!store && !topics) return '记忆存储不可用';
        return a.query ? `没找到与「${a.query}」相关的记忆` : '还没有任何长期记忆';
      }
      return out.join('\n');
    }
  },
  {
    name: 'import_skill',
    kind: 'edit',
    title: (a) => `导入技能 ${a.url ? a.url.slice(0, 40) : ''}`,
    description:
      '从网上任意来源下载并导入一个 Agent Skill 到用户技能目录（user-skills/），导入后可用 use_skill 激活。支持多种链接：① GitHub 仓库页 https://github.com/{owner}/{repo}（自动在仓库根 / skills/<repo>/ / skill/<repo>/ 等常见位置找 SKILL.md）；② raw 文件 https://raw.githubusercontent.com/{owner}/{repo}/{branch}/…/SKILL.md；③ GitLab raw https://gitlab.com/{owner}/{repo}/-/raw/{branch}/…/SKILL.md；④ Gitee raw https://gitee.com/{owner}/{repo}/raw/{branch}/…/SKILL.md；⑤ 任意 https 文件直链（.md/.markdown/.txt 结尾，直接当 SKILL.md 内容下载，可接 CDN/静态托管）。SKILL.md 需是标准格式（--- YAML frontmatter：name/description--- + Markdown 指导正文）；缺 when_to_use 会自动补默认值。若仓库同目录有 run.js 会一并导入（含 node --check 校验）。导入前请先向用户确认要导入的仓库来源可信。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '技能来源 URL：GitHub 仓库页 / GitHub raw / GitLab raw / Gitee raw / 任意 .md 直链' },
        name: { type: 'string', description: '可选，自定义技能名（默认取 SKILL.md frontmatter 的 name，缺失则取仓库名）' }
      },
      required: ['url']
    },
    run: async (a, c) => {
      const store = c && c.skills;
      if (!store) return '技能存储不可用';
      const res = await store.importFromUrl(a.url, { name: a.name });
      if (!res.ok) return '技能导入失败：\n' + res.errors.join('\n') + '\n（可改用 raw 文件链接，或先用 list_skills 确认是否已导入）';
      let msg = `技能「${res.name}」已从 GitHub 导入并验证通过，路径：${res.path}`;
      if (res.scriptNote) msg += '\n' + res.scriptNote;
      // ★ 导入后自动接安全审查（对自己刚从网上下载的技能做只读静态审查，先审查再启用）
      msg += '\n\n【安全审查】已自动对该技能做只读静态安全审查：\n' + skillAudit.run({ path: require('path').dirname(res.path) });
      msg += '\n\n审查结论供你判断是否启用：高危需先人工确认/修复，中危确认用途，低危/通过可直接启用。';
      msg += '\n后续可用 use_skill 激活它。';
      return msg;
    }
  },
  {
    name: 'create_skill',
    kind: 'edit',
    title: (a) => `编写技能 ${a.name || ''}`,
    description:
      '为自己编写一个新的用户技能（与自带技能隔开，存于扩展私有目录）。body 是 Markdown 指导正文（写明何时用、怎么做、命令、注意事项）；script 可选，为脚本源码，会写入 run.js 并自动做语法检查。写好后系统会自动验证并返回结果，若失败请自行修正后重新调用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名，小写字母/数字/-/_，如 deploy-check' },
        description: { type: 'string', description: '一句话描述这个技能做什么' },
        when_to_use: { type: 'string', description: '什么时候应该用这个技能，如「用户提到部署/上线/发布前」' },
        body: { type: 'string', description: 'Markdown 指导正文：步骤、命令、注意事项' },
        script: { type: 'string', description: '可选脚本源码，会被保存为 run.js 并自动 node --check 校验' },
        overwrite: { type: 'boolean', description: '可选，true 时强制覆盖已存在的同名技能；默认 false（已存在则拒绝，防止重复创建死循环）' }
      },
      required: ['name', 'body']
    },
    run: (a, c) => {
      const store = c && c.skills;
      if (!store) return '技能存储不可用';
      const res = store.create({
        name: a.name,
        description: a.description,
        whenToUse: a.when_to_use,
        body: a.body,
        script: a.script,
        overwrite: a.overwrite
      });
      if (!res.ok) {
        const errText = res.errors.join('\n');
        // 去重拒绝 → 明确告诉模型「已有同内容技能，直接推进，不要重试」
        const isDuplicate = /已存在/.test(errText);
        return '技能创建失败：\n' + errText
          + (isDuplicate
            ? '\n\n【重要】该技能已经存在且内容相同，无需（也不能）再次创建。请直接用 use_skill 激活它或直接基于其指导开始执行任务，不要再调用 create_skill。'
            : '\n请修正后重新调用 create_skill。');
      }
      let msg = `技能「${a.name}」已创建并验证通过，路径：${res.path}`;
      if (a.script) msg += '\n（含 run.js 脚本，已通过语法检查）';
      msg += '\n后续可用 use_skill 激活它。';
      return msg;
    }
  },
  {
    name: 'list_skills',
    kind: 'read',
    title: () => '列出用户技能',
    description: '列出当前所有用户技能（name、描述、适用场景、是否含脚本），便于选择用哪个。',
    parameters: { type: 'object', properties: {} },
    run: (a, c) => {
      const store = c && c.skills;
      if (!store) return '技能存储不可用';
      const items = store.list();
      if (!items.length) return '还没有任何用户技能，可用 create_skill 编写一个。';
      return items
        .map((it) => `- ${it.name}：${it.description}${it.whenToUse ? '（适用：' + it.whenToUse + '）' : ''}${it.hasScript ? ' [含脚本]' : ''}`)
        .join('\n');
    }
  },
  {
    name: 'use_skill',
    kind: 'exec',
    title: (a) => `激活技能 ${a.name || ''}`,
    description:
      '激活一个用户技能：读取它的指导并注入当前上下文，若技能含 run.js 则先执行脚本。激活后请严格按其指导完成任务。该操作会先询问用户是否允许。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要激活的技能名' },
        query: { type: 'string', description: '本次用户需求，会一并交给技能指导参考' },
        organize: { type: 'boolean', description: '（仅 _knowledge_base）true=只检索「AI 整理后」目录，false=检索全部原文；不传则按知识库页面设置' },
        vector: { type: 'boolean', description: '（仅 _knowledge_base）true=强制用向量语义检索，false=跳过向量走关键词；不传则按知识库页面设置' }
      },
      required: ['name']
    },
    run: async (a, c) => {
      const store = c && c.skills;
      if (!store) return '技能存储不可用';
      // ★ 内置技能：知识库检索（1.1.19 知识库技能化——默认不强制灌入，agent 需要时自主调取）
      // use_skill name=_knowledge_base → 按 query 走真实向量/关键词检索，返回命中的知识内容
      if (a && String(a.name) === '_knowledge_base') {
        try {
          const q = String(a.query || '').trim() || '全部';
          const kb = require('../knowledgeBase');
          // 1.1.27：页面总开关（knowledgeBase.enabled）一票否决——没开则插件模型也用不了工具
          if (!kb.isEnabled()) {
            return '知识库未启用：请在「环境面板 → 知识库」打开「启用本地知识库」总开关（或开启整理/自动压缩/向量语义检索任一子开关）后重试。';
          }
          const o = {
            context: c && c.context,
            onLog: () => {}
          };
          // 模型可通过输入参数覆盖本次检索模式；不传则按页面设置（默认行为）
          if (typeof a.organize === 'boolean') o.forceOrganize = a.organize;
          if (typeof a.vector === 'boolean') o.forceVector = a.vector;
          if (a.vector === false) o.noVector = true;
          const res = await kb.augmentSystemPromptAsync('', q, c && c.sessionId, o);
          // res 是（原 system + 知识块）拼接结果；这里 basePrompt 为空 → 返回的就是知识块本身
          const clean = String(res || '').replace(/^\s*=== 系统指令[\s\S]*?===\s*/, '').trim();
          const mode = o.forceVector ? '向量语义检索' : (o.noVector ? '关键词检索' : (o.forceOrganize ? '整理后目录' : '默认模式'));
          return '已激活内置技能「知识库检索」。检索 query：' + q + '（模式：' + mode + '）\n\n'
            + '【知识库命中内容】\n' + (clean || '（知识库为空或无命中，可换关键词重试）')
            + '\n\n请结合以上知识回答用户问题；若知识不足以回答，明确说明并基于你的通用知识补充。';
        } catch (e) {
          return '知识库检索失败：' + String((e && e.message) || e) + '。可尝试换更短的关键词，或直接基于通用知识回答。';
        }
      }
      const r = store.activate(a.name, a.query);
      if (!r.ok) return r.reason + '（可用 list_skills 查看已有技能）';

      let msg = `已激活技能「${a.name}」。请严格按照以下指导完成任务：\n\n${r.guidance}\n\n【注意】该技能已激活，直接按其指导执行即可，不要再次调用 use_skill 或 create_skill。`;

      // 交互式技能：把 run.js 启动到集成终端，让用户在终端输入；后续用 get_terminal_output 读取结果
      if (r.hasScript && r.interactive) {
        const meta = store.list().find((x) => x.name === a.name);
        const scriptPath = meta ? require('path').join(require('path').dirname(meta.path), 'run.js') : '';
        if (scriptPath && require('fs').existsSync(scriptPath)) {
          try {
            term.startInTerminal(`node "${scriptPath}"`, { cwd: require('path').dirname(scriptPath) });
            msg += '\n\n[已将该技能的交互式脚本启动到 VS Code 终端，用户可在终端直接输入；当用户输入后，请调用 get_terminal_output 读取终端输出并继续交互。]';
          } catch (e) {
            msg += '\n\n[启动交互式脚本失败：' + e.message + ']';
          }
        }
      } else if (r.output) {
        msg += `\n\n[技能脚本输出]\n${r.output}`;
      }

      if (a.query) msg += `\n\n[用户需求]\n${a.query}`;
      return msg;
    }
  },
  {
    name: 'create_mcp_server',
    kind: 'edit',
    title: (a) => `编写 MCP 服务器 ${a.name || ''}`,
    description:
      '为自己编写一个 MCP 服务器并登记/热加载。三种用法三选一：① tools（结构化工具数组，自动生成协议脚本，最稳）；② script（完整服务器源码）；③ script_path（已用 write_file 写好的脚本绝对路径）。写好后可用 /mcp <id> <工具名> [参数] 调用；设 foxAi.mcp.autoInject=true 后自动进入可用工具列表。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '服务器 id（字母/数字/-/_）' },
        description: { type: 'string', description: '一句话描述这个服务器' },
        tools: {
          type: 'array',
          description:
            '结构化工具列表（推荐）。每项：{ name, description, input_schema, handler(函数表达式) }'
        },
        script: { type: 'string', description: '完整服务器源码（纯 Node，实现 MCP stdio）。提供则忽略 tools' },
        script_path: { type: 'string', description: '已写好的脚本绝对路径' },
        enabled: { type: 'boolean', description: '是否启用，默认 true' }
      },
      required: ['name']
    },
    run: async (a, c) => {
      try {
        const res = await mcpAuthor.registerUserServer({
          context: c && c.context,
          cfg: c && c.cfg,
          name: a.name,
          description: a.description,
          script: a.script,
          tools: a.tools,
          scriptPath: a.script_path,
          enabled: a.enabled
        });
        if (!res.ok) {
          return 'MCP 服务器创建失败：' + res.error + (res.path ? '\n脚本路径：' + res.path : '');
        }
        let msg =
          `MCP 服务器「${res.id}」已创建并登记：` +
          `\n- 脚本：${res.path}` +
          `\n- 清单：${res.manifest}` +
          `\n- ${res.configNote}`;
        if (res.live) {
          msg +=
            `\n- 热注册结果：ok=${res.live.ok}` +
            (res.live.status ? ` status=${res.live.status}` : '') +
            (res.live.error ? ` error=${res.live.error}` : '');
        }
        msg += `\n\n完成后可在对话中用 /mcp ${res.id} <工具名> [参数] 调用；若把 foxAi.mcp.autoInject 设为 true，工具会自动进入可用列表。`;
        return msg;
      } catch (e) {
        return 'create_mcp_server 执行出错：' + (e && e.stack ? e.stack : e);
      }
    }
  },
  {
    name: 'create_plan_task',
    kind: 'edit',
    title: (a) => `创建任务：${a.subject || '（AI 总结）'}`,
    description:
      '为当前项目创建一条可见的任务清单项。如果提供 raw_context 而 subject/description 为空，会根据 foxAi.planTask.* 设置调用指定 AI 自动总结任务目标。',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '任务标题（可选，可由 AI 总结）' },
        description: { type: 'string', description: '任务目标/验收标准（可选）' },
        raw_context: { type: 'string', description: '原始需求上下文，供 AI 总结成 subject/description' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], default: 'pending' }
      }
    },
    run: async (a, c) => {
      const store = c && c.planTasks;
      if (!store) return '任务清单存储不可用';
      const item = await store.create({
        subject: a.subject,
        description: a.description,
        rawContext: a.raw_context,
        status: a.status
      });
      return `已创建任务 #${item.id}：${item.subject}${item.description ? '\n' + item.description : ''}`;
    }
  },
  {
    name: 'update_plan_task',
    kind: 'edit',
    title: (a) => `更新任务 #${a.id || ''}`,
    description: '更新任务清单中的某一项：修改标题、目标或状态（pending / in_progress / completed）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id' },
        subject: { type: 'string', description: '新的任务标题（可选）' },
        description: { type: 'string', description: '新的任务目标（可选）' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '新的状态' }
      },
      required: ['id']
    },
    run: (a, c) => {
      const store = c && c.planTasks;
      if (!store) return '任务清单存储不可用';
      const item = store.update(a.id, { subject: a.subject, description: a.description, status: a.status });
      if (!item) {
        // 强引导：模型经常传错 id（记不住随机 id），又没传 subject 让兜底匹配救回来。
        // 失败时直接告诉它「别再试 update 了，改用 set_plan_tasks 整表替换」。
        return `找不到任务 #${a.id}（id 已过期或记错）。不要再用 update_plan_task 反复重试同一个 id——请改用 set_plan_tasks 一次性传完整 [{ content, status }] 列表做整表替换，set_plan_tasks 不依赖 id。`;
      }
      return `任务 #${item.id} 已更新为 ${item.status}：${item.subject}`;
    }
  },
  {
    name: 'list_plan_tasks',
    kind: 'read',
    title: () => '列出项目任务清单',
    description: '列出当前所有项目任务（含状态）。用户问“任务清单”“进度”“还剩哪些”时使用。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '可选按状态筛选' }
      }
    },
    run: (a, c) => {
      const store = c && c.planTasks;
      if (!store) return '任务清单存储不可用';
      let items = store.list();
      if (a.status) items = items.filter((it) => it.status === a.status);
      if (!items.length) return '当前没有任何项目任务。';
      return items
        .map((it) => {
          const mark = it.status === 'completed' ? '✓' : it.status === 'in_progress' ? '🔄' : '○';
          return `${mark} ${it.subject}${it.description ? ' — ' + it.description : ''}`;
        })
        .join('\n');
    }
  },
  {
    name: 'remove_plan_task',
    kind: 'edit',
    title: (a) => `删除任务 #${a.id || ''}`,
    description: '从项目任务清单中删除某一项（如已作废、重复或不再需要）。用户说“删掉这条任务”“去掉某个计划项”时使用。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要删除的任务 id' }
      },
      required: ['id']
    },
    run: (a, c) => {
      const store = c && c.planTasks;
      if (!store) return '任务清单存储不可用';
      const ok = store.remove(a.id);
      if (!ok) return `找不到任务 #${a.id}`;
      return `已删除任务 #${a.id}`;
    }
  },
  {
    name: 'set_plan_tasks',
    kind: 'edit',
    title: () => '整体更新任务清单',
    description:
      '一次性覆盖整个项目任务清单（整表替换）。**todos 必须是数组**（如 [{"content":"第一步","status":"in_progress"}]），**不要传字符串/串行化的 JSON 文本**——字符串会被系统静默忽略导致清单为空。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '完整的最新任务列表，每项 { content, status }。',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '任务内容（一句话，全清单内不重复）' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '状态' }
            },
            required: ['content']
          }
        }
      },
      required: ['todos']
    },
    run: (a, c) => {
      const store = c && c.planTasks;
      if (!store) return '任务清单存储不可用';
      const res = store.replaceAll(a.todos);
      // 1.1.24（对齐 dsh todo_write「响亮失败」）：解析不出任务时把具体错误回灌给模型，
      // 让模型看到「为什么失败、该怎么写」，而不是静默空清单（空清单会让模型以为写成功了）。
      if (res && res._error) {
        return `任务清单未更新：${res._error}。请改用标准格式重试：set_plan_tasks 传完整数组 [{"content":"任务描述","status":"pending|in_progress|completed"}]（不要传字符串/JSON 文本/空数组）。`;
      }
      return `已整体更新任务清单：${res.pending} 待办、${res.inProgress} 进行中、${res.completed} 已完成。`;
    }
  },
  {
    name: 'present_plan',
    kind: 'read',
    title: () => '提交计划',
    description:
      '在已用 create_plan_task 列好计划后调用，把计划展示给用户看。提交后【立即继续执行】第一步，不要等待任何确认——用户可以在聊天面板里随时看到计划并干预；只有遇到真正危险或无法决定的操作才询问用户。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '一句话说明本计划的目标（可选）' }
      }
    },
    run: async (a, c) => {
      const store = c && c.planTasks;
      const n = store ? store.list().length : 0;
      return `计划已提交（共 ${n} 项），用户已可见。继续执行第一步。`;
    }
  },
  {
    name: 'revise_plan',
    kind: 'read',
    title: (a) => '修订计划：' + (a.reason || ''),
    description:
      '执行过程中若需调整计划（增删步骤或改变目标），先调用 update_plan_task / create_plan_task 改好计划，再调用本工具说明原因，然后【立即继续执行】调整后的步骤，不需要用户再次确认。',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '为什么要修订计划（必填，向用户说明）' }
      },
      required: ['reason']
    },
    run: async (a, c) => {
      const reason = String(a.reason || '').trim() || '（未说明原因）';
      return `计划修订已记录，原因：${reason}。继续执行调整后的步骤。`;
    }
  },
  {
    name: 'review_changes',
    kind: 'read',
    title: (a) => `审查改动 ${a.path || '(全部)'}`,
    description: '对比代码「原始版（git HEAD）vs 当前修改版」的差异，并主动做一次深度思考，评估改动的可行性与风险。可选 focus: feasibility（可行性，默认）/ bugs（找缺陷）/ security（安全）/ performance（性能）。不传 path 时审查整个工作区相对 HEAD 的改动；指定 path 时还会打开 diff 视图。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '可选，单个文件相对工作区的路径；不传则审查全部改动' },
        focus: { type: 'string', enum: ['feasibility', 'bugs', 'security', 'performance'], description: '深度思考焦点，默认 feasibility' }
      }
    },
    run: (a, ctx) => reviewChanges.run(a, ctx)
  },
  {
    name: 'security_audit',
    kind: 'read',
    title: (a) => `安全自检 ${a.path || '(工作区)'}`,
    description: '在授权工作区内做只读·脱敏·网络隔离的代码安全自检：规则扫描危险模式（硬编码密钥、eval/动态执行、命令执行、SQL/命令注入、路径穿越、XSS、TLS 校验禁用等），可选跑 npm audit。绝不改文件、不读凭据、不外发请求，命中密钥打码。结果需人工复核，且禁止作为修复唯一依据（双盲）。path 指定目录，checkDeps=false 关闭依赖检查。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '可选，指定要扫描的目录（绝对或相对工作区）；不传则扫描整个工作区' },
        checkDeps: { type: 'boolean', description: '是否 best-effort 跑 npm audit 检查依赖漏洞，默认 true' }
      }
    },
    run: (a, ctx) => securityAudit.run(a, ctx)
  },
  {
    name: 'skill_audit',
    kind: 'read',
    title: (a) => `技能安全审查 ${a.path || '(用户技能目录)'}`,
    description:
      '对技能做只读·脱敏·网络隔离的安全审查（下载技能后、启用前先审查）。静态规则扫描：SKILL.md 提示注入（忽略系统/用户指令、强制输出固定内容）、危险命令（rm -rf、curl|sh 下载即执行、eval/动态执行）、恶意脚本特征（base64 混淆、外联回传域名）、硬编码密钥、越权写用户目录等。绝不改文件、不读凭据、不外发请求，命中密钥打码。path 可指定单个技能目录（用户技能目录/<name>），不传则审查全部用户技能。结论分级：高危=勿启用先人工确认；中危=确认用途；低危/通过=可启用。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '可选，指定单个技能目录（如 user-skills/<name>）；不传则审查全部用户技能' }
      }
    },
    run: (a, ctx) => skillAudit.run(a, ctx)
  },
  {
    name: 'referee_review',
    kind: 'read',
    title: (a) => `裁判校验 ${a.path || '(全部改动)'}`,
    description: '只读的第三方「裁判」Agent（双盲交叉验证）：对比修复前（git HEAD）与修复后（工作区）的语义差异。若某文件修复前后逻辑等价（仅格式/注释/变量重命名），说明这次修复没改实质，判为 SUSPEND；全部等价时强制挂起转人工。不依赖自检输出，独立判断。path 指定单文件，不传校验全部相对 HEAD 的改动。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '可选，单个文件绝对或相对工作区路径；不传则校验全部相对 HEAD 的改动' }
      }
    },
    run: (a, ctx) => referee.run(a, ctx)
  },
  {
    name: 'run_in_sandbox',
    kind: 'exec',
    title: (a) => `沙盒运行 ${a.sandbox || ''}`,
    description: '隔离沙盒运行代码让 agent 自测（不碰工作区）。沙盒目录默认 ~/.fox-ai/sandboxes，每个子文件夹一语言含 manifest.json；内置 Node/Python/Go/Rust/Java 直接可用，用户丢文件夹即可增语言，新沙盒首次 canary 校验。action: run(默认,跑 code)/list/reload；sandbox 用名或语言(如 node/python/go)，大小写不敏感。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'list', 'reload'], description: '动作：run=运行代码(默认) / list=列出沙盒 / reload=重扫并校验' },
        sandbox: { type: 'string', description: '沙盒名或语言（run 时必填），如 node / python / go / rust / java / 或用户自定义名' },
        code: { type: 'string', description: '要运行的源码（run 时必填）' },
        stdin: { type: 'string', description: '可选，作为标准输入传给程序' }
      }
    },
    run: (a, ctx) => sandboxTest.run(a, ctx)
  },
  {
    name: 'search_codebase',
    kind: 'read',
    title: (a) => `语义检索「${String((a && a.query) || '').slice(0, 24)}」`,
    description: '全仓库语义检索（TF-IDF 余弦 + BM25 混合打分）。用自然语言描述想找的功能/逻辑，返回最相关代码片段（文件+行号+原文）。索引缺失或过期会自动建立。知道确切标识符/正则时用 search_text（精确快），只知道「大概想干什么」时用本工具（例：登录 token 在哪刷新、文件上传分片在哪处理）。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '用自然语言描述你想找的功能或逻辑，越具体越好' },
        topK: { type: 'integer', description: '返回条数，默认 8，最多 20' },
        pathFilter: { type: 'string', description: '可选，只在匹配该正则的路径里找，如 "^src/" 或 "\\\\.py$"' },
        withText: { type: 'boolean', description: '是否返回片段原文，默认 true；只想看命中位置可设 false' }
      },
      required: ['query']
    },
    run: (a, ctx) => codebaseIndex.runSearch(a, ctx)
  },
  {
    name: 'index_codebase',
    kind: 'read',
    title: (a) => (a && a.force ? '重建代码索引' : '更新代码索引'),
    description: '建立或增量更新全仓库语义索引（供 search_codebase 使用）。按文件修改时间增量更新，未变更的文件会跳过；删除的文件会自动清出索引。一般不用手动调用——search_codebase 会在索引缺失或过期时自动建立；只有在你刚做了大量改动、想立刻让检索反映最新代码时才需要主动调。force=true 会丢弃旧索引完全重建。',
    parameters: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: '是否完全重建（默认 false，增量更新）' }
      }
    },
    run: (a, ctx) => codebaseIndex.runIndex(a, ctx)
  },
  {
    name: 'spawn_subagent',
    kind: 'exec',
    title: (a) => {
      const n = Array.isArray(a && a.agents) ? a.agents.length : 0;
      return n > 1 ? `派生 ${n} 个子代理` : '派生子代理';
    },
    description: `派生**隔离上下文的子代理**替你干活，可并行、可按依赖组队。适合：①多条互不相干的支线同时推进；②某子任务会产生大量中间过程（翻十几个文件），不想污染主上下文——子代理探索过程不进主上下文，你只收到最终结论。
# 角色与权限
${subagents.renderRoleCatalog()}
# 纪律
- 每个 task 必须具体、自包含；需要背景写进 context（子代理看不到你和用户的对话）。
- 子代理不能再派生子代理，也不能建技能/建 MCP。一次最多 8 个。自己一次工具调用能搞定的就别派。`,
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '这批子代理共同服务的总目标' },
        agents: {
          type: 'array',
          description: '要派生的子代理列表（1~8 个）',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '简短标识，供 depends_on 引用' },
              role: { type: 'string', enum: ['explorer', 'coder', 'reviewer', 'tester', 'researcher', 'planner', 'generalist'], description: '角色决定它能用哪些工具' },
              task: { type: 'string', description: '具体、自包含的任务（必填）' },
              context: { type: 'string', description: '子代理需要的背景（它看不到你的对话）' },
              depends_on: { type: 'array', items: { type: 'string' }, description: '依赖的子代理 name，等前置跑完再执行' }
            },
            required: ['task']
          }
        }
      },
      required: ['agents']
    },
    run: async (a, ctx) => {
      if (!ctx || typeof ctx.spawnSubagents !== 'function') {
        return '当前环境不支持派生子代理（缺少运行时上下文），请自己完成该任务。';
      }
      return ctx.spawnSubagents({ goal: a.goal || '', agents: a.agents || [] });
    }
  },
  {
    name: 'run_background_agent',
    kind: 'exec',
    title: (a) => `后台任务：${String((a && (a.title || a.task)) || '').slice(0, 30)}`,
    description: `把一件**耗时的活儿丢到后台跑**，立刻返回、不占当前对话，用户在等结果时继续聊别的。
# 什么时候用
- 用户明确要求异步（「你先在后台帮我做 X」「顺便把测试补了，我先干别的」）；或活儿明显要跑很久（全项目补测试、大范围重构）。
# 什么时候不要用
- 用户在等这个结果、一两次工具调用能搞定、需要中途问用户（后台没有交互通道）。
# 运行环境
- git 仓库会自动开独立 worktree + 分支，不碰用户正在编辑的文件；结束后产出补丁/分支供 review。非 git 仓库自动降级为只读调研。
- 后台任务没法弹窗确认，高危操作会被直接拒绝。task 必须自包含（看不到你和用户对话）。提交后立刻回复「已在后台开始」，不要原地反复查询。`,
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '具体、自包含的任务（必填），写清目标/范围/完成标准' },
        title: { type: 'string', description: '简短标题，用于列表展示与分支命名' },
        role: {
          type: 'string',
          enum: ['explorer', 'coder', 'reviewer', 'tester', 'researcher', 'planner', 'generalist'],
          description: '执行角色：explorer/researcher 只读，coder 改代码，tester 补测试'
        },
        create_pr: { type: 'boolean', description: '完成后是否推送分支并尝试创建 PR，默认 false' },
        timeout_minutes: { type: 'number', description: '超时分钟数，默认 15，最长 60' }
      },
      required: ['task']
    },
    run: async (a, ctx) => {
      if (!ctx || typeof ctx.runBackgroundAgent !== 'function') {
        return '当前环境不支持后台任务（缺少运行时上下文），请在当前对话里直接完成。';
      }
      return ctx.runBackgroundAgent(a || {});
    }
  },
  {
    name: 'background_jobs',
    kind: 'read',
    title: (a) => {
      const act = (a && a.action) || 'list';
      if (act === 'get') return `查看后台任务 ${(a && a.id) || ''}`;
      if (act === 'cancel') return `取消后台任务 ${(a && a.id) || ''}`;
      if (act === 'clear') return '清理后台任务记录';
      return '查看后台任务列表';
    },
    description: '查看 / 取消 / 清理后台任务。用户问「后台那个跑完了吗」「结果呢」时用 action=get 取回结论；用户说「别跑了」时用 action=cancel。后台任务结束后结论不会自动出现在对话里，必须主动查。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'cancel', 'clear'], description: '操作类型，默认 list' },
        id: { type: 'string', description: '任务号，action 为 get / cancel 时必填' },
        limit: { type: 'number', description: 'list 时最多返回几条，默认 12' }
      }
    },
    run: async (a, ctx) => {
      if (!ctx || typeof ctx.backgroundJobs !== 'function') {
        return '当前环境不支持后台任务查询（缺少运行时上下文）。';
      }
      return ctx.backgroundJobs(a || {});
    }
  },
  {
    name: 'call_extension_command',
    kind: 'exec',
    title: (a) => `调用扩展命令 ${a.command || ''}`,
    description: '调用其它 VS Code 扩展暴露的命令（插件联动）。只能调用用户在「狐狸 AI · 环境与插件 · 插件联动」页面勾选白名单过的命令；调用前会弹窗确认（白名单+免确认设置除外）。当用户明确要求「调用插件」「用某某插件做某事」时，从已授权命令中选择最匹配的一个调用。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '扩展命令 ID，如 github.copilot.chat.triggerPermissiveSignIn' },
        args: { description: '传给该命令的参数，可以是任意 JSON 值（多数命令不需要参数）。' }
      },
      required: ['command']
    },
    run: async (a, c) => {
      const result = await bridge.callExtensionCommand(c && c.context, a.command, a.args, { skipConfirm: !!c && !!c.skipConfirm });
      // 多数 VS Code 命令无返回值；给 agent 一个明确的“已执行”信号，避免它把空输出当失败
      if (result === undefined || result === null) {
        return `扩展命令 ${a.command} 已执行完成（无返回值）。`;
      }
      return result;
    }
  },
  {
    name: 'generate_image',
    kind: 'read',
    title: (a) => `生成图片：${(a.prompt || '').slice(0, 20)}`,
    description:
      '调用专门配置的「生图模型」（foxAi.imageGen.*）根据文字描述生成图片，并把图片直接显示在对话中。' +
      '这是独立于主控聊天模型的第二模型通道——主控 agent 仍用文本模型思考与规划，仅在需要出图时调用本工具，' +
      '两者互不影响。适合需要配图、海报、概念图、示意图、图表等场景。' +
      '工具会按厂商自动选择协议：阿里百炼/通义万相（wanx*）走原生异步 API，OpenAI DALL·E 走 images 接口，其余走 OpenAI 兼容 chat。' +
      '需先在设置里开启 foxAi.imageGen（enabled=true）并填写 provider/baseUrl/apiKey/model（如阿里万相 wanx2.1-t2i-turbo）；未配置时本工具会提示如何开启。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '对要生成图片的文字描述（越具体越好，可含风格、构图、色调、主体等）' },
        size: { type: 'string', description: '可选，期望图片尺寸，如 1024x1024 / 1280x720；阿里万相会转为 1024*1024 格式，不支持时交给模型默认' },
        negative_prompt: { type: 'string', description: '可选，反向提示词：不希望在画面中出现的内容（如 文字/水印/畸形手指），阿里万相等支持' }
      },
      required: ['prompt']
    },
    run: (a, c) => imageGen.run(a, c)
  },
  {
    name: 'allow_session_access',
    kind: 'read',
    title: (a) => `授权读取会话「${a.session_id || ''}」的压缩上下文`,
    description:
      '不同会话的自动压缩上下文默认互相隔离。当用户明确要求「回忆/参考/结合其他会话」时，' +
      '调用本工具请求用户授权读取指定会话的压缩摘要。授权后该会话摘要会进入当前对话的 RAG 检索范围，' +
      '直到本会话结束（或用户下次拒绝）。session_id 可从上下文或 list_other_sessions 获得。',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '目标会话 ID（知识库-2 摘要文件名前缀，如 abc123）' }
      },
      required: ['session_id']
    },
    run: async (a, c) => {
      const res = await kb.requestSessionAccess(a.session_id, c && c.sessionId);
      return res.allowed
        ? `已授权读取会话「${res.sessionId}」的压缩摘要，当前对话现在可以检索其内容。`
        : `未授权读取会话「${res.sessionId}」：${res.reason || '用户拒绝'}`;
    }
  },
  {
    name: 'list_other_sessions',
    kind: 'read',
    title: () => '列出其他会话的压缩摘要',
    description:
      '列出知识库-2 中存在的其他会话压缩摘要（不含当前会话）。用户要求跨会话回忆但没说具体会话时，' +
      '先调用本工具列出可选会话，再让用户选择或用 allow_session_access 授权。',
    parameters: {
      type: 'object',
      properties: {}
    },
    run: async (a, c) => {
      const list = kb.listOtherSessionSummaries(c && c.sessionId);
      if (!list.length) return '当前没有其他会话的压缩摘要文件。';
      return list.map((s) => `• ${s.sessionId}：${s.title}`).join('\n');
    }
  },
  {
    name: 'run_slash_command',
    kind: 'read',
    title: (a) => `命令模板 /${(a && a.name) || ''}`,
    description:
      '读取用户自定义的 Slash Command 模板（.fox-ai/commands/<name>.md 或用户级 commands 目录），把 $ARGUMENTS / $1..$9 替换成参数后返回展开的指令原文。' +
      '用于「用户提到某个自定义命令」或「你想复用项目里已经写好的标准流程」时——先用 action=list 看有哪些模板，再用 action=render 展开并按其内容执行。' +
      '本工具只做模板展开，不会自动执行里面的步骤：拿到展开文本后，你要按它的要求继续调用相应工具。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'render'], description: 'list=列出全部可用命令；render=展开指定命令。默认 render' },
        name: { type: 'string', description: '命令名（不带斜杠），如 review' },
        args: { type: 'string', description: '传给模板的参数串，会替换 $ARGUMENTS 与 $1..$9' }
      }
    },
    run: async (a, c) => {
      const slash = require('../slashCommands');
      const dirs = _slashDirs(c);
      const action = (a && a.action) || (a && a.name ? 'render' : 'list');
      if (action === 'list') {
        const items = slash.listCommands(dirs);
        if (!items.length) return '当前没有任何自定义命令模板。可在工作区 .fox-ai/commands/ 下新建 <名字>.md 来添加。';
        return items.map((i) => `• /${i.name}（${i.source === 'workspace' ? '本项目' : '用户级'}）${i.description ? '：' + i.description : ''}`).join('\n');
      }
      if (!a || !a.name) return '请提供 name（命令名）。';
      const r = slash.renderCommand(a.name, a.args || '', dirs);
      if (!r.ok) {
        return r.error + (r.available && r.available.length ? `\n可用命令：${r.available.map((n) => '/' + n).join('、')}` : '');
      }
      return `命令模板 /${r.name} 展开结果（请按下面的要求继续执行）：\n\n${r.text}`;
    }
  },
  {
    name: 'best_of_n',
    kind: 'read',
    title: (a) => `Best-of-N 多模型对比：${String((a && a.prompt) || '').slice(0, 24)}`,
    description:
      'Best-of-N 多模型对比：同一 prompt 并发发给 N 个候选模型，按评委策略挑最优一份作为最终回答，其余附摘要。适合拿不准哪个模型更好、或关键内容想多模型交叉验证。judge=length（挑最长非空）/ llm（主模型当评委，更准但多一次调用）。候选来自 foxAi.bestOfN.candidates 或调用时传 candidates；未开启且未传时提示如何配置。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '发给所有候选模型的同一问题/任务（必填）' },
        system: { type: 'string', description: '可选，统一 system 指令' },
        candidates: {
          type: 'array',
          description: '可选，覆盖默认候选列表；每项 {provider,model,baseUrl,apiKey,transport?}',
          items: { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' }, baseUrl: { type: 'string' }, apiKey: { type: 'string' }, transport: { type: 'string' } } }
        },
        judge: { type: 'string', enum: ['length', 'llm', 'first'], description: '挑选策略，默认 length；llm 用主模型当评委' },
        temperature: { type: 'number', description: '可选，覆盖候选温度' }
      },
      required: ['prompt']
    },
    run: async (a, c) => {
      const prompt = a && a.prompt;
      if (!prompt || !String(prompt).trim()) return '请提供 prompt（要对比的问题/任务描述）。';
      const vcfg = vscode.workspace.getConfiguration('foxAi');
      const cfg = vcfg.get('bestOfN', {}) || {};
      const enabled = !!cfg.enabled;
      const candidates = (a.candidates && Array.isArray(a.candidates)) ? a.candidates : (cfg.candidates || []);
      const judge = a.judge || cfg.judge || 'length';
      if (!enabled && (!candidates || !candidates.length)) {
        return 'Best-of-N 未开启且没有候选模型。请在设置开启 foxAi.bestOfN（enabled=true）并配置 candidates（N 个 {provider,model,baseUrl,apiKey}），或在调用时直接传入 candidates。';
      }
      if (!c || typeof c.callModel !== 'function') {
        return '当前环境不支持 Best-of-N（缺少模型调用上下文），请在当前对话里直接完成。';
      }
      const bestOfN = require('../bestOfN');
      const res = await bestOfN.runBestOfN({
        prompt,
        system: a.system,
        candidates,
        judge,
        callModel: c.callModel,
        llm: judge === 'llm' ? c.llm : undefined,
        temperature: (a.temperature != null) ? a.temperature : (cfg.temperature != null ? cfg.temperature : undefined)
      });
      if (!res.ok) return res.error || 'Best-of-N 执行失败。';
      if (!res.best) {
        return '所有候选模型都未能返回有效回答：\n' + res.results.map((r) => `• ${r.id}：${r.error || '空响应'}`).join('\n');
      }
      const lines = [];
      lines.push(`✅ 最优回答来自【${res.best.provider || '?'} / ${res.best.model || res.best.id}】（评委：${res.judge}${res.fromCache ? ' · 命中缓存' : ''}）`);
      lines.push('');
      lines.push(res.best.text);
      const others = res.results.filter((r) => r.index !== res.best.index);
      if (others.length) {
        lines.push('');
        lines.push('— 其它候选摘要 —');
        for (const r of others) {
          const head = (r.text || '').slice(0, 200).replace(/\n/g, ' ');
          lines.push(`• ${r.id}（score=${r.score}${r.error ? '，错误：' + r.error : ''}）：${head || '(空)'}`);
        }
      }
      return lines.join('\n');
    }
  },
  {
    name: 'preview_artifact',
    kind: 'read',
    title: (a) => `预览产出物 ${a.path || ''}`,
    description:
      '把刚生成的产出物（HTML 网页 / Markdown / 图片 / PDF）在旁边打开实时预览。调用后聊天窗口右侧会弹出预览面板，'
      + '无需离开 VS Code 即可查看效果（HTML 直接渲染、图片直接显示、Markdown 渲染排版、PDF 用系统默认应用打开）。'
      + '适合在写完网页 / 生成图片 / 产出报告后调用，让用户立即看到结果。参数 type 可省略（按扩展名自动识别）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要预览的文件路径（工作区内相对路径或绝对路径）' },
        type: { type: 'string', description: '文件类型（可选，自动识别）：html / markdown / md / image / png / jpg / pdf' }
      },
      required: ['path']
    },
    run: (a, ctx) => {
      const ws = require('./workspace');
      const fs = require('fs');
      const path = require('path');
      const p = String(a.path || '').trim();
      if (!p) throw new Error('path 不能为空');
      // 解析路径（支持工作区相对/绝对/~）
      let abs = p;
      try { abs = ws.resolveUri(p, { allowOutside: true }).fsPath; } catch (_) { /* 保持原样 */ }
      if (!fs.existsSync(abs)) throw new Error('文件不存在：' + abs);
      const ext = path.extname(abs).toLowerCase().replace('.', '');
      let type = String(a.type || '').toLowerCase();
      if (!type) {
        type = ({ html: 'html', htm: 'html', md: 'markdown', markdown: 'markdown', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image', pdf: 'pdf' })[ext] || 'unknown';
      }
      // 交给上层打开预览面板（ctx.emitArtifact → agent.emit('artifact') → chatView 开 WebviewPanel）
      if (ctx && typeof ctx.emitArtifact === 'function') {
        try { ctx.emitArtifact({ path: abs, type, ext }); } catch (_) {}
      }
      return `已请求打开预览：${abs}（type=${type}）。\n- HTML/Markdown/图片：右侧预览面板已弹出；\n- PDF：已用系统默认应用打开（若未弹出请检查系统关联）。`;
    }
  },
  {
    name: 'convert_file',
    kind: 'read',
    title: (a) => `无损转换文件 ${a.path || ''}`,
    description:
      '把 Office/文档文件【无损提取内容】为可读文本/表格（不依赖外部软件，用内置解包解析）：\n'
      + '  · docx → 提取全部段落文本 + 表格（表格转 Markdown 表格，内容零丢失）\n'
      + '  · xlsx → 提取每个工作表的所有单元格（保留行列结构）\n'
      + '  · pptx → 提取每页文字 + 表格 + 备注\n'
      + '  · 输出可选保存为 .md / .txt / .csv，便于后续处理。\n'
      + '用户上传 docx/pdf/xlsx 等文件、或要求「把 word 变成表格 / 提取文档内容」时调用。'
      + 'PDF 不支持内置无损提取（二进制格式），请用 run_command 调 python 的 pdfplumber/PyMuPDF，或提示用户另存为文本。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要转换的文件路径（.docx / .xlsx / .pptx）' },
        output: { type: 'string', description: '输出文件路径（可选，默认不落盘只返回内容）' },
        format: { type: 'string', description: '输出格式（可选）：text（默认）/ markdown / csv' }
      },
      required: ['path']
    },
    run: async (a) => {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const { execSync } = require('child_process');
      const p = String(a.path || '').trim();
      if (!p) throw new Error('path 不能为空');
      let abs = p;
      try { abs = require('./workspace').resolveUri(p, { allowOutside: true }).fsPath; } catch (_) {}
      if (!fs.existsSync(abs)) throw new Error('文件不存在：' + abs);
      const ext = path.extname(abs).toLowerCase();
      const supported = { '.docx': 'docx', '.xlsx': 'xlsx', '.pptx': 'pptx' };
      if (!supported[ext]) {
        throw new Error('不支持的格式：' + ext + '。支持 docx/xlsx/pptx 无损提取；PDF 请用 python 库（pdfplumber/PyMuPDF）处理。');
      }
      // 用 python 内置 zipfile + 自定义解析（无损，跨平台，无需第三方库）
      const pyScript = path.join(os.tmpdir(), 'fx_convert_' + Date.now() + '.py');
      const kind = supported[ext];
      const outFormat = String(a.format || 'text').toLowerCase();
      const pyCode = [
        'import sys, zipfile, re, json',
        'from xml.etree import ElementTree as ET',
        'path = sys.argv[1]',
        'kind = sys.argv[2]',
        'fmt = sys.argv[3] if len(sys.argv) > 3 else "text"',
        'NS = {',
        '  "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",',
        '  "a": "http://schemas.openxmlformats.org/drawingml/2006/main",',
        '  "x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",',
        '  "p": "http://schemas.openxmlformats.org/presentationml/2006/main",',
        '  "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
        '}',
        'z = zipfile.ZipFile(path)',
        'def q(tag):',
        '  pfx, _, local = tag.partition(":")',
        '  return "{" + NS.get(pfx, "") + "}" + local',
        'out = []',
        'def text_of(el):',
        '  return "".join(el.itertext())',
        'if kind == "docx":',
        '  xml = z.read("word/document.xml")',
        '  root = ET.fromstring(xml)',
        '  body = root.find(q("w:body"))',
        '  for child in body:',
        '    tag = child.tag.split("}")[-1]',
        '    if tag == "p":',
        '      t = text_of(child).strip()',
        '      if t: out.append(t)',
        '    elif tag == "tbl":',
        '      rows = []',
        '      for tr in child.findall(q("w:tr")):',
        '        cells = [" ".join(text_of(tc).split()) for tc in tr.findall(q("w:tc"))]',
        '        rows.append(cells)',
        '      if rows:',
        '        out.append("")',
        '        for r in rows: out.append("| " + " | ".join(r) + " |")',
        '        out.append("")',
        'elif kind == "xlsx":',
        '  shared = {}',
        '  try:',
        '    sx = z.read("xl/sharedStrings.xml")',
        '    sroot = ET.fromstring(sx)',
        '    for i, si in enumerate(sroot.findall(q("x:si"))):',
        '      shared[i] = text_of(si)',
        '  except Exception: pass',
        '  sheets = [n for n in z.namelist() if re.match(r"xl/worksheets/sheet\\d+\\.xml", n)]',
        '  sheets.sort(key=lambda n: int(re.search(r"(\\d+)", n).group(1)))',
        '  for sn in sheets:',
        '    out.append("== 工作表: " + sn + " ==")',
        '    root = ET.fromstring(z.read(sn))',
        '    for row in root.iter(q("x:row")):',
        '      cells = []',
        '      for c in row.findall(q("x:c")):',
        '        v = c.find(q("x:v"))',
        '        t = c.get("t")',
        '        val = ""',
        '        if t == "s" and v is not None and v.text and int(v.text) in shared:',
        '          val = shared[int(v.text)]',
        '        elif v is not None and v.text is not None:',
        '          val = v.text',
        '        cells.append(val)',
        '      if any(cells): out.append("| " + " | ".join(cells) + " |")',
        'elif kind == "pptx":',
        '  slides = sorted([n for n in z.namelist() if re.match(r"ppt/slides/slide\\d+\\.xml", n)],',
        '                  key=lambda n: int(re.search(r"(\\d+)", n).group(1)))',
        '  for si, sn in enumerate(slides, 1):',
        '    root = ET.fromstring(z.read(sn))',
        '    texts = [text_of(el).strip() for el in root.iter() if el.text and el.text.strip()]',
        '    out.append("--- 幻灯片 %d ---" % si)',
        '    for t in texts: out.append(t)',
        'print(json.dumps("\\n".join(out), ensure_ascii=False))'
      ].join('\n');
      fs.writeFileSync(pyScript, pyCode, 'utf8');
      let resultText = '';
      try {
        const py = process.platform === 'win32' ? 'python' : 'python3';
        const raw = execSync(`"${py}" "${pyScript}" "${abs}" ${kind} ${outFormat}`, {
          encoding: 'utf8', timeout: 60000, maxBuffer: 50 * 1024 * 1024
        }).trim();
        resultText = JSON.parse(raw);
      } catch (e) {
        // 尝试 fallback python 可执行名
        try {
          const raw = execSync(`python3 "${pyScript}" "${abs}" ${kind} ${outFormat}`, {
            encoding: 'utf8', timeout: 60000, maxBuffer: 50 * 1024 * 1024
          }).trim();
          resultText = JSON.parse(raw);
        } catch (e2) {
          throw new Error('内容提取失败（需要系统 python，支持 zipfile 即可）：' + String((e && e.stderr || e.message) || e2.message).slice(0, 300));
        }
      } finally {
        try { fs.unlinkSync(pyScript); } catch (_) {}
      }
      if (!String(resultText).trim()) return '该文件内容为空（或无可提取文本）。';
      // 可选落盘输出
      const outPath = String(a.output || '').trim();
      if (outPath) {
        try {
          const outAbs = outPath.startsWith('/') || /^[a-zA-Z]:/.test(outPath) ? outPath : require('./workspace').resolveUri(outPath, { allowOutside: true }).fsPath;
          fs.writeFileSync(outAbs, resultText, 'utf8');
          return `已无损提取「${abs}」内容并保存到 ${outAbs}（${String(resultText).length} 字符）。\n\n${String(resultText).slice(0, 6000)}`;
        } catch (e) {
          throw new Error('输出写入失败：' + e.message);
        }
      }
      return String(resultText).slice(0, 8000) + (String(resultText).length > 8000 ? '\n…（内容较长已截断，可用 output 参数保存到文件查看全文）' : '');
    }
  },
  {
    name: 'report_feedback',
    kind: 'read',
    title: () => '提交修改意见/反馈',
    description:
      '把用户对「刚才生成的产出物（网页/报告/图片等）」的修改意见或使用中遇到的问题记录下来，'
      + '并**引导插件按用户意见直接修改产出物**。用户说「改一下 / 有问题 / 换个样式 / 标题改大点」等时调用。'
      + '执行后系统会记录反馈，并在返回内容里明确要求：根据用户描述去 edit 对应产出物文件、改完调用 preview_artifact 刷新预览。'
      + '参数 target 为目标产出物路径（能推断时可省略）。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '用户的修改意见或问题描述（原样保留）' },
        target: { type: 'string', description: '要修改的产出物文件路径（可选，能推断时省略）' },
        category: { type: 'string', description: '分类（可选）：style / bug / content / other' }
      },
      required: ['content']
    },
    run: (a) => {
      const os = require('os');
      const fs = require('fs');
      const path = require('path');
      // 存档（供追溯）
      const dir = path.join(os.homedir(), '.fox-ai', 'feedback');
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safe = String(a.category || 'other').replace(/[^\w\u4e00-\u9fff-]/g, '_');
      const file = path.join(dir, `${stamp}-${safe}.md`);
      const ver = (() => { try { return require('../../package.json').version || ''; } catch (_) { return ''; } })();
      const body = [
        '# 用户反馈/修改意见',
        '',
        '- 时间：' + new Date().toLocaleString('zh-CN'),
        '- 分类：' + (a.category || 'other'),
        '- 目标：' + (a.target || '（未指定）'),
        '- 插件版本：' + ver,
        '',
        '## 用户描述',
        '',
        String(a.content || ''),
        ''
      ].join('\n');
      try { fs.writeFileSync(file, body, 'utf8'); } catch (e) { throw new Error('写入反馈失败：' + e.message); }
      // ★ 核心：返回行动指令，让主代理按用户意见【直接修改产出物文件】，改完刷新预览（迭代闭环）
      const target = String(a.target || '').trim();
      return '已记录反馈（' + file + '）。\n\n'
        + '[行动指令] 用户对刚才的产出物提出了修改意见，请立即按以下步骤执行：\n'
        + '1. 定位目标产出物文件' + (target ? '「' + target + '」' : '（从当前对话上下文推断最近生成的产出物）') + '；\n'
        + '2. 先 read_file 读取其当前内容，确认现状；\n'
        + '3. 按用户描述 edit_file 修改（用户原话：' + String(a.content || '').slice(0, 500) + '）；\n'
        + '4. 改完后调用 preview_artifact 刷新预览，并简短说明改了什么，请用户确认。\n'
        + '若目标不是文件而是行为/功能问题，则修复对应实现并说明。';
    }
  },
  {
    name: 'verify_ui_anchors',
    kind: 'read',
    title: () => '校验 UI 锚点（视觉↔逻辑对齐）',
    description:
      '静态校验前端代码的「视觉↔逻辑」锚点是否对齐（视觉与功能协调系统·第三层）。传入 html 字符串或 file 路径，' +
      '检查 JS 里 getElementById/querySelector("#id") 引用的元素是否都存在于 HTML（锚点失效 → 有样子没反应），' +
      '以及原子组件（如 fox-modal）是否满足最小契约（必须有 onclose 关闭绑定）。返回文本化缺口报告，供你逐条修正。' +
      '生成任何带交互的前端代码后都应调用本工具自检。',
    parameters: {
      type: 'object',
      properties: {
        html: { type: 'string', description: '完整 HTML 字符串（与 file 二选一）' },
        file: { type: 'string', description: 'HTML 文件路径（与 html 二选一）' }
      }
    },
    run: (a) => require('./uiAnchors').verifyUiAnchors(a || {})
  },
  {
    name: 'ui_selfcheck',
    kind: 'read',
    title: () => '无头自检 UI（渲染级）',
    description:
      '无头浏览器自检 UI（视觉与功能协调系统·第四层，文本化反馈）。传入 html/file，先做静态锚点校验；' +
      '若环境可解析到 Playwright，则额外真实渲染，抓取控制台报错（如 onClose 未定义）、页面异常、关键元素真实坐标/计算样式（如 #modal 是否居中生效）。' +
      'anchors 传 [{id, expect:{属性:期望值}}] 做样式断言（如 {id:"modal", expect:{"left":"50%"}}）。返回文本化报告，你据此修正、重新 ui_selfcheck，最多迭代 3 次。' +
      '无浏览器时自动降级为静态校验并提示安装。',
    parameters: {
      type: 'object',
      properties: {
        html: { type: 'string', description: '完整 HTML 字符串（与 file 二选一）' },
        file: { type: 'string', description: 'HTML 文件路径（与 html 二选一）' },
        anchors: {
          type: 'array',
          description: '样式断言列表，如 [{"id":"modal","expect":{"left":"50%"}}]；不传则只做坐标/报错采集',
          items: { type: 'object' }
        }
      }
    },
    run: async (a) => require('./uiSelfCheck').uiSelfCheck(a || {})
  }
];

/** 命令模板目录：工作区优先、用户级兜底。工具层单独实现一份，避免依赖 chatView */
function _slashDirs(c) {
  const slash = require('../slashCommands');
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

function webSearchToolEnabled() {
  const cfg = vscode.workspace.getConfiguration('foxAi');
  return cfg.get('webSearch.enabled', false);
}

function currentTimeTool() {
  return {
    name: 'current_time',
    kind: 'read',
    title: () => '获取当前时间',
    description: '获取当前日期和时间。当用户问“现在几点”“今天几号”“当前时间”等问题时必须调用，不要直接回答你不知道。',
    parameters: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: '时区，如 Asia/Shanghai、UTC。默认 Asia/Shanghai' }
      }
    },
    run: async (a) => getCurrentTime(a && a.timezone)
  };
}

function webSearchTool() {
  return {
    name: 'web_search',
    kind: 'read',
    title: (a) => `搜索「${a.query || ''}」`,
    description: '联网搜索最新信息。当用户问到时事、当前事件、最新版本、股价、天气、文档外的问题，或你需要实时数据时使用。builtin/duckduckgo 无需 API Key（稳定性一般），也可配置 tavily/serper。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词或问题' }
      },
      required: ['query']
    },
    run: async (a) => {
      const cfg = vscode.workspace.getConfiguration('foxAi');
      return webSearch(a.query, cfg.get('webSearch.provider', 'builtin'), cfg.get('webSearch.apiKey', ''));
    }
  };
}

const BY_NAME = new Map();
for (const t of TOOLS) {
  BY_NAME.set(t.name, t);
  // 1.1.39：注册工具别名（如 get_memory ↔ recall_memory），让 getTool 能按别名解析
  if (Array.isArray(t.aliases)) {
    for (const al of t.aliases) BY_NAME.set(al, t);
  }
}

function allTools() {
  const list = TOOLS.slice();
  list.push(currentTimeTool());
  if (webSearchToolEnabled()) list.push(webSearchTool());
  // 合并已注册的 MCP 远程工具（命名空间隔离）。
  // 仅当 foxAi.mcp.autoInject 为 true 时才注入模型工具列表；
  // 默认 false —— 模型看不到 MCP 工具，只能通过 /mcp 斜杠命令显式调用。
  if (mcp.getPolicy().autoInject) {
    for (const t of mcp.getCachedTools()) list.push(t);
  }
  return list;
}

function getTool(name) {
  if (name === 'current_time') return currentTimeTool();
  if (name === 'web_search' && webSearchToolEnabled()) return webSearchTool();
  const local = BY_NAME.get(name);
  // 扁平模式下，若优先级为 remote-first 且存在同名远程工具，则远程覆盖本地
  const remote = mcp.resolveRemote(name, Boolean(local));
  if (remote && (!local || mcp.getPolicy().priority === 'remote-first')) return remote;
  if (local) return local;
  return remote; // 本地不存在时返回命名空间/扁平远程工具（可能为 null）
}

/**
 * 清洗发给原生 function calling 的 JSON Schema。
 * 许多 MCP 服务器（playwright / chrome-devtools 等）返回的 inputSchema 含
 * $ref / additionalProperties / patternProperties / 超深 anyOf 等 OpenAI/DeepSeek
 * 原生 function calling 不接受的关键字，或单个 schema 过大，直接 400。
 * 这里剥离这些关键字、截断过大的描述/整体 schema，给原生模式一个能跑的机会；
 * 若仍超限，agent.js 的 400 降级分支会自动切到文本协议。
 */
const SCHEMA_DROP_KEYS = new Set([
  '$ref', '$defs', 'definitions', '$schema', 'components', 'examples',
  'additionalProperties', 'patternProperties', 'propertyNames',
  'unevaluatedProperties', 'unevaluatedItems', 'if', 'then', 'else',
  'dependentSchemas', 'dependentRequired', 'contentSchema', 'discriminator', 'externalDocs'
]);

function sanitizeSchemaNode(node, seen) {
  if (!node || typeof node !== 'object') return node;
  if (seen.has(node)) return { type: 'object' }; // 循环引用兜底
  seen.add(node);
  // 含 $ref 但无法就地解析 → 退化为宽松对象，避免把整段 schema 判非法
  if (typeof node.$ref === 'string') {
    return node.description ? { type: 'object', description: String(node.description).slice(0, 800) } : { type: 'object' };
  }
  const out = {};
  for (const k of Object.keys(node)) {
    if (SCHEMA_DROP_KEYS.has(k)) continue;
    if (k === 'description' && typeof node[k] === 'string') {
      out.description = node[k].slice(0, 800);
      continue;
    }
    if (k === 'properties' && node[k] && typeof node[k] === 'object') {
      const props = {};
      for (const pk of Object.keys(node[k])) props[pk] = sanitizeSchemaNode(node[k][pk], seen);
      out.properties = props;
      continue;
    }
    if (k === 'items' && node[k]) {
      out.items = sanitizeSchemaNode(node[k], seen);
      continue;
    }
    if ((k === 'oneOf' || k === 'anyOf' || k === 'allOf') && Array.isArray(node[k])) {
      out[k] = node[k].map((s) => sanitizeSchemaNode(s, seen));
      continue;
    }
    out[k] = node[k];
  }
  seen.delete(node);
  return out;
}

function sanitizeSchema(schema) {
  try {
    const cleaned = sanitizeSchemaNode(schema || { type: 'object', properties: {} }, new Set());
    const s = JSON.stringify(cleaned);
    if (s.length > 4000) return { type: 'object', properties: {} };
    return cleaned;
  } catch (_) {
    return { type: 'object', properties: {} };
  }
}

/**
 * 「手术刀式」工具精简：按当前 query 语义从全量工具挑出最相关的子集注入系统提示词，
 * 避免 31 个工具的描述（占 context 30%+）全量常驻。对应生产级方法论「工具按语义动态检索子集」。
 * 纯逻辑抽到无依赖的 ./toolSelect，便于独立单测；这里只负责接入全量工具列表与配置。
 */
const toolSelect = require('./toolSelect');

/**
 * 返回应注入的工具名数组；未开启或 query 无信号时返回 null（表示注入全量）。
 */
function selectToolNames(query, cfg) {
  const ds = (cfg && cfg.tools && cfg.tools.dynamicSubset) || {};
  const names = toolSelect.selectSubsetNames(allTools(), query, ds);
  if (names) {
    const { appendLog } = require('../log');
    const all = allTools().map((t) => t.name);
    const excluded = all.filter((n) => !names.includes(n));
    appendLog('toolSelect', '[subset] query=' + String(query || '').slice(0, 60) + ' enabled=' + !!ds.enabled + ' included=' + names.length + '/' + all.length + ' excluded=' + (excluded.length ? excluded.join(',') : '无'));
  }
  return names;
}

/** 按 query 子集过滤工具列表；未开启/无信号返回 null */
function filterForPrompt(query, cfg) {
  const names = selectToolNames(query, cfg);
  if (!names) return null;
  const set = new Set(names);
  return allTools().filter((t) => set.has(t.name));
}

// ---- 韧性·超时熔断统一护栏 ----
// 纯逻辑在 ./timeoutGuard，这里负责接入实时配置与按工具维护熔断计数器。
const { withTimeout, CircuitBreaker } = require('./timeoutGuard');
const _breakers = new Map(); // 工具名 -> CircuitBreaker

function _getBreaker(name, maxFailures) {
  // 把 maxFailures 并入 key：配置改变后新建 breaker（熔断计数随之重置），
  // 保证 foxAi.tools.globalTimeout.maxFailures 实时生效，而不是永远硬编码 3。
  const mf = maxFailures > 0 ? maxFailures : 3;
  const key = name + '#' + mf;
  let b = _breakers.get(key);
  if (!b) {
    b = new CircuitBreaker(mf, 60000);
    _breakers.set(key, b);
  }
  return b;
}

/** 读取运行时全局超时配置（实时生效，不打断会话） */
function _globalTimeoutConfig() {
  const vcfg = vscode.workspace.getConfiguration('foxAi');
  return {
    enabled: vcfg.get('tools.globalTimeout.enabled', false),
    timeoutMs: vcfg.get('tools.globalTimeout.timeoutMs', 30000),
    maxFailures: vcfg.get('tools.globalTimeout.maxFailures', 3)
  };
}

/** OpenAI function calling 格式。可选 query/cfg 用于动态子集精简（不传则全量） */
function toOpenAITools(query, cfg) {
  const vcfg = vscode.workspace.getConfiguration('foxAi');
  const gprovider = vcfg.get('provider') || 'llamacpp';
  const gapiMode = vcfg.get('apiMode', 'chat');
  const provider = (cfg && (cfg.provider || cfg.providerId)) || gprovider;
  const apiMode = (cfg && cfg.apiMode) || gapiMode;
  // 多厂商原生联网（服务端执行）：仅当 provider/apiMode 命中对应能力才注入原生工具，
  // 避免给不相关的厂商误加会导致 400。能力判定集中在 src/nativeSearch.js（纯函数、可单测）。
  let nsProvider = null;
  let nsTool = null;
  try {
    const ns = require('../nativeSearch');
    nsProvider = ns.nativeSearchProvider({ provider, apiMode });
    nsTool = ns.nativeSearchTool({ provider, apiMode });
  } catch (_) {}
  const useProviderSearch = !!nsProvider;
  // 云端模型：用固定全集（固化工具列表），保证 tools 字段序列化顺序确定、前缀缓存可命中；
  // 本地弱模型上下文窄，仍按 query 精简子集省 token（本地模型通常不缓存、且锚点已使前缀变动）。
  const isLocal = !!(cfg && cfg.meta && cfg.meta.local);
  const list = isLocal ? (filterForPrompt(query, cfg) || allTools()) : allTools();
  const out = [];
  // 纯联网抓取类本地工具（与官方 web_search 能力重复）。当 provider 具备原生联网时，
  // 无论本轮是否「时效性」，都在这里统一剔除：既杜绝模型用 fetch/MCP 绕过官方联网，
  // 又保证 tools 字段跨轮字节稳定（不再随「时效性」在 callModel 里做二次子集替换 → 前缀漂移）。
  // mcp__* 是前缀匹配（所有 MCP 工具），其余是精确名匹配。
  const NETWORK_ONLY_EXACT = /^(web_fetch|fetch[_-]?url|browser|scrape|crawl|open_page|find_in_page|web_search)$/i;
  for (const t of list) {
    if (useProviderSearch && (/^mcp__/i.test(t.name) || NETWORK_ONLY_EXACT.test(t.name))) continue; // 原生联网已接管，移除本地联网抓取类工具
    if (provider === 'deepseek' && apiMode === 'responses') {
      // DeepSeek Responses API 的 function 名必须匹配 ^[a-zA-Z0-9_-]+$。
      // MCP 工具名形如 mcp__fetch__fetch-url 或含点/斜杠/大写（mcp__io.github...），会触发 400，
      // 必须在官方联网模式下整体排除；同时用官方 {type:'web_search'} 替换本地 web_search，
      // 避免模型调本地而绕开官方搜索、或把非法名字工具发给 DeepSeek 直接 400。
      if (!/^[a-zA-Z0-9_-]+$/.test(t.name)) continue;
    }
    out.push({
      type: 'function',
      function: {
        name: t.name,
        description: (t.description || '').slice(0, 800),
        parameters: sanitizeSchema(t.parameters)
      }
    });
  }
  // 云端模型：工具按名排序，固化 tools 字段的序列化顺序，避免发现顺序抖动导致前缀缓存失效
  if (!isLocal) out.sort((a, b) => String(a.function.name).localeCompare(String(b.function.name)));
  if (nsProvider === 'responses') {
    // OpenAI / DeepSeek / 通义百炼 Responses 原生 web_search（由 toResponsesTools 透传）
    // DeepSeek 官方 web_search 不返回真实 URL，改用新版 web_search_2025_08_26 尝试获取 citations/URL
    const respSearchType = provider === 'deepseek' ? 'web_search_2025_08_26' : 'web_search';
    out.push({ type: respSearchType });
  } else if (nsTool) {
    // 智谱 GLM web_search / Kimi $web_search（注入原生工具，服务端执行）
    out.push(nsTool);
  }
  return out;
}

/**
 * 按工具定义列表转 OpenAI function calling 格式（不做子集精简、不注入 provider 原生工具）。
 * 子代理用：它的工具集由角色白名单严格决定，不能再被动态子集二次裁剪，
 * 否则「探索员拿不到 read_file」这种荒唐事就会发生。
 */
function toOpenAIToolsFrom(list) {
  const out = [];
  for (const t of (list || [])) {
    if (!t || !t.name) continue;
    out.push({
      type: 'function',
      function: {
        name: t.name,
        description: (t.description || '').slice(0, 800),
        parameters: sanitizeSchema(t.parameters)
      }
    });
  }
  return out;
}

/** 文本协议用的说明书（给不支持 tools 的模型）。可选 query/cfg 用于动态子集精简 */
function toTextManual(query, cfg) {
  // 非本地模型：用固定全集（固化工具列表），保证文本协议下 system 前缀可缓存；
  // 本地弱模型上下文窄，仍按 query 精简子集省 token（本地模型通常不支持前缀缓存，且锚点已使前缀变动）。
  const isLocal = !!(cfg && cfg.meta && cfg.meta.local);
  const list = isLocal ? (filterForPrompt(query, cfg) || allTools()) : allTools();
  // 本地小模型：完整 schema 会压垮上下文且模型常抄不对结构。
  // 精简为「名称 + 描述 + 必填参数名」即可，让模型用极简 JSON 调用。
  // 弱模型模式（1.1.17）进一步：必填参数 + 有穷选项(Enum)参数都标注取值限制，直接缩小模型选择空间。
  if (cfg && cfg.meta && cfg.meta.local) {
    return list.map((t) => {
      const props = (t.parameters && t.parameters.properties) || {};
      const req = (t.parameters && t.parameters.required) || [];
      const reqSet = new Set(req);
      // 必填参数 + 带 Enum 的可选参数（限制模型选择面，弱模型尤其受益）
      const show = req.slice();
      for (const k of Object.keys(props)) {
        if (!reqSet.has(k) && Array.isArray(props[k].enum) && props[k].enum.length) show.push(k);
      }
      const args = show.length
        ? '\n  参数：' + show.map((k) => {
            const p = props[k];
            const enumHint = p && Array.isArray(p.enum) && p.enum.length
              ? ` 取值限：${p.enum.join(' / ')}`
              : '';
            const reqMark = reqSet.has(k) ? '（必填）' : '';
            return `"${k}"${reqMark}${enumHint}`;
          }).join('，')
        : '\n  参数：无（可空对象 {}）';
      return `● ${t.name}：${t.description}${args}`;
    }).join('\n\n');
  }
  return list.map((t) => {
    const props = (t.parameters && t.parameters.properties) || {};
    const req = (t.parameters && t.parameters.required) || [];
    const argLines = Object.keys(props).map((k) => {
      const p = props[k];
      return `    "${k}": ${p.type === 'integer' || p.type === 'number' ? '数字' : p.type === 'boolean' ? 'true/false' : '"字符串"'}  // ${req.includes(k) ? '必填' : '可选'} ${p.description || ''}`;
    });
    return `● ${t.name}：${t.description}\n  参数：\n{\n${argLines.join('\n')}\n}`;
  }).join('\n\n');
}

/**
 * ===== 1.1.15 工具调用符号映射（规避固定 <foxtool> 标签被网页风控识别，防封号）=====
 * 配置文件（优先级：工作区 .fox-ai/tool-tag-map.json > 用户级 ~/.fox-ai/tool-tag-map.json）：
 *   { "open": "[[tool:%name%]]", "close": "[[/tool]]" }
 * %name% 为工具名占位。配置后：
 *   - 系统提示 / get_tools 示例会用自定义符号渲染，引导模型照抄（网页上不再出现统一 <foxtool>）；
 *   - parseTextCalls 解析前会把自定义符号归一化为内部 <foxtool> 再执行。
 * 留空 / 无配置文件 → 默认 <foxtool> 标签，行为不变。
 */
let _toolTagMapCache = null;
function loadToolTagMap() {
  if (_toolTagMapCache) return _toolTagMapCache;
  _toolTagMapCache = { open: '', close: '' };
  try {
    const cands = [];
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length) {
      cands.push(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.fox-ai', 'tool-tag-map.json'));
    }
    cands.push(path.join(os.homedir(), '.fox-ai', 'tool-tag-map.json'));
    for (const f of cands) {
      if (fs.existsSync(f)) {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (j && typeof j.open === 'string' && typeof j.close === 'string' && j.open.includes('%name%')) {
          _toolTagMapCache = { open: j.open, close: j.close };
        }
        break;
      }
    }
  } catch (_) { /* 配置异常走默认标签 */ }
  return _toolTagMapCache;
}
function toolTagMap(opts) { return loadToolTagMap(opts); }
function usingCustomToolTag(opts) { return !!(loadToolTagMap(opts).open); }
/**
 * 用当前生效的符号包裹一个工具调用示例（open 含 %name% 占位）。
 * 1.1.25（照 dsh 删改重构，用户「除 web 外全走原生」）：自定义标签（[[tool:]]）只为规避网页风控而生，
 * 只在 textOnly（WebAI2API）路径渲染；直连 native 路径一律渲染标准 <foxtool>——
 * 否则 native 模型收到 get_tools 示例里的 [[tool:]] 会与回灌提示的 <foxtool> 打架（日志实证空轮中断）。
 * @param {object} [ctx] 可选：{ textOnly: boolean } 明确标注当前路径
 */
function wrapToolCall(name, body, ctx) {
  const m = loadToolTagMap();
  // 1.1.25（用户「只有 web 要自定义，其他降级 text 也不能自定义」）：
  // 自定义标签只认 WebAI2API（ctx.textOnly 或全局 customTag 标记），
  // 直连 text（降级/显式配置/auto 落 text）一律标准 <foxtool>。
  const onlyWeb = !!(ctx && ctx.textOnly) || _customTagOn();
  if (!m.open || !onlyWeb) return `<foxtool name="${name}">\n${body}\n</foxtool>`;
  return `${m.open.replace('%name%', name)}\n${body}\n${m.close}`;
}

// 1.1.25（用户「除了 web 要用自定义，其他降级 text 也不能和 web 一样自定义」）：
// 全局「WebAI2API 自定义标签模式」标记——由 AgentSession 在确认路径后设置。
// 自定义标签（[[tool:]]）只为网页防风控而生，**只认 cfg.meta.textOnly（WebAI2API）**；
// native 直连、以及 native 失败降级后的 text 直连，一律渲染标准 <foxtool>——
// 降级 text 只是「用文本协议调用工具」，绝不能附带网页风控用的自定义标签。
let _customTagMode = false;
function _customTagOn() { return _customTagMode; }
function _setCustomTagMode(on) { _customTagMode = !!on; }
function customTagActive() { return _customTagMode; }
function setCustomTagMode(on) { _customTagMode = !!on; }
/** 把文本里的自定义符号归一化为内部标准 <foxtool>（解析前调用；无自定义配置则原样返回） */
function normalizeToolTags(text) {
  const m = loadToolTagMap();
  if (!m.open || !m.close) return String(text == null ? '' : text);
  try {
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const openPat = esc(m.open).replace(esc('%name%'), '([A-Za-z0-9_]+)');
    const openRe = new RegExp(openPat, 'gi');
    const closeRe = new RegExp(esc(m.close), 'gi');
    return String(text == null ? '' : text)
      .replace(openRe, '<foxtool name="$1">')
      .replace(closeRe, '</foxtool>');
  } catch (_) { return String(text == null ? '' : text); }
}

/**
 * get_tools 检索结果的单工具渲染：名称 + 描述 + 必填参数 + 调用示例。
 * brief = 名称+描述+必填参数+示例；full = 追加完整参数表。
 * 示例中的参数值用占位符，模型照抄结构、替换为真实值即可（格式锚定核心）。
 * 示例符号跟随用户自定义的 tool-tag-map.json（规避固定 <foxtool> 标签）。
 */
function renderToolGuideLine(t, detail) {
  const props = (t.parameters && t.parameters.properties) || {};
  const req = (t.parameters && t.parameters.required) || [];
  const reqSet = new Set(req);
  const head = `● ${t.name}：${t.description || ''}`;
  let body = '';
  if (detail === 'full' && Object.keys(props).length) {
    // 1.1.15：参数表改为紧凑单行（"参数名": 类型 必填/可选 说明），不再逐行展开多行 JSON 模板——
    // WebAI2API 网页渲染会把示例里的 \n 变成真换行，模型照抄时 JSON 转义被破坏导致反复重试。
    const rows = Object.keys(props).map((k) => {
      const p = props[k];
      return `"${k}": ${p.type === 'integer' || p.type === 'number' ? '数字' : p.type === 'boolean' ? 'true/false' : '"字符串"'}${reqSet.has(k) ? ' 必填' : ' 可选'}${p.description ? ' ' + p.description : ''}`;
    });
    body += `\n  参数：${rows.join('，')}`;
  } else if (req.length) {
    body += `\n  必填参数：${req.join('、')}`;
  }
  // 调用示例：用必填参数拼调用占位 JSON（符号跟随用户自定义 tool-tag-map）。
  // 占位值统一用「…」单字符，避免示例里出现引号/换行等会被网页渲染破坏的字符。
  const exampleArgs = req.length
    ? '{' + req.map((k) => `"${k}": "…"`).join(', ') + '}'
    : '{}';
  body += `\n  调用示例：\n${wrapToolCall(t.name, exampleArgs)}`;
  return head + body;
}

function titleOf(name, args) {
  const t = getTool(name);
  if (!t) return name;
  try {
    return t.title(args || {});
  } catch (_) {
    return name;
  }
}

function kindOf(name) {
  const t = getTool(name);
  return t ? t.kind : 'read';
}

// ---- 只读工具结果会话内去重（前缀缓存优化）----
// 思路借鉴社区「Append-Only Agent + 缓存友好的工具结果去重」公开实践（如 Reasonix 等），
// 但为 fox-ai 独立实现、未复制任何第三方源码。fox-ai 自身以 GPL-3.0 发布。
// 背景：同一会话里模型常反复 read_file 同一个未改动的文件，每读一次都完整内容重新塞进上下文，
// 这部分是「每轮必 miss 的不可缓存增量」，正是前缀缓存命中率卡在 80%+ 难上 98% 的主因之一。
// 做法：对只读文件工具（read_file / view），按「工具名 + 路径」维护本会话一份内容指纹；
// 若本次返回内容与上次完全一致，只回一个极短占位，让模型去上方上下文引用，从而缩小每轮增量、拉高命中率。
// 安全：指纹基于「实际返回内容」而非文件 mtime，文件被改（返回内容不同）必当新调用、绝不返回旧内容；
// 首读永远返回完整内容；任何异常都退化为原行为（返回完整文本）。
const _DEDUP_TOOLS = (() => {
  const s = new Set(['read_file']);
  try { if (BY_NAME.has('view')) s.add('view'); } catch (_) {}
  return s;
})();
const _dedupCaches = new Map(); // sessionId -> Map("name::path" -> contentSig)
const _DEDUP_MAX_SESSIONS = 256;

function _normPath(p) {
  try { return require('path').resolve(String(p)).replace(/\\/g, '/'); } catch (_) { return String(p || '').trim(); }
}
function _hash32(s) {
  // FNV-1a 32-bit，对返回文本做全量哈希（read 结果已被 _truncate 截到 maxToolOutput 上限，成本可忽略）
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function _sessionDedup(sessionId) {
  if (!sessionId) return null;
  let m = _dedupCaches.get(sessionId);
  if (!m) {
    if (_dedupCaches.size > _DEDUP_MAX_SESSIONS) {
      const keys = Array.from(_dedupCaches.keys());
      for (const k of keys.slice(0, Math.ceil(keys.length / 3))) _dedupCaches.delete(k);
    }
    m = new Map();
    _dedupCaches.set(sessionId, m);
  }
  return m;
}
function _applyCacheDedup(name, args, ctx, text) {
  try {
    if (!text || text.length < 64) return text; // 太短（错误或空结果）不值得去重
    if (!_DEDUP_TOOLS.has(name)) return text;
    const p = args && (args.path || args.file_path || args.filePath);
    if (!p) return text;
    let enabled = true;
    try { enabled = vscode.workspace.getConfiguration('foxAi').get('cacheDedup.enabled', true); } catch (_) { enabled = true; }
    if (!enabled) return text;
    const sessionId = ctx && ctx.sessionId;
    if (!sessionId) return text;
    const cache = _sessionDedup(sessionId);
    if (!cache) return text;
    const key = name + '::' + _normPath(p);
    const sig = _hash32(text);
    if (cache.get(key) === sig) {
      return '(已去重) 文件「' + p + '」本次会话此前已读取过且内容未变，完整内容已在上方上下文中，此处省略重复注入以省 token。';
    }
    cache.set(key, sig);
    return text;
  } catch (_) {
    return text; // 任何异常都不阻断正常返回
  }
}

async function execute(name, args, ctx) {
  const tool = getTool(name);
  if (!tool) throw new Error(`没有名为 ${name} 的工具，可用工具：${allTools().map((t) => t.name).join('、')}`);

  const gt = _globalTimeoutConfig();
  if (gt.enabled) {
    const { appendLog } = require('../log');
    const breaker = _getBreaker(name, gt.maxFailures);
    if (breaker.isOpen()) {
      appendLog('timeoutGuard', '[circuit-open] tool=' + name + ' max=' + breaker.max + ' 冷却中');
      throw new Error(`工具 ${name} 已熔断（连续失败达 ${breaker.max} 次），请改用其它方式或稍后重试。`);
    }
    try {
      // MCP 远程工具走连接器调用，本地工具走自带 run
      const result = await withTimeout(() => {
        return tool.mcp
          ? mcp.executeRemote(tool, args || {}, ctx || {})
          : tool.run(args || {}, ctx || {});
      }, gt.timeoutMs);
      breaker.recordSuccess();
      return _applyCacheDedup(name, args, ctx, _truncate(result, ctx));
    } catch (e) {
      // 超时或任何执行异常都计入熔断
      breaker.recordFailure();
      const isTimeout = !!(e && e.isTimeout);
      const prefix = isTimeout
        ? `工具 ${name} 执行超时（>${gt.timeoutMs}ms）`
        : `工具 ${name} 执行异常`;
      const hint = isTimeout
        ? '，请改用其它方式、把任务拆小，或调大 foxAi.tools.globalTimeout.timeoutMs。'
        : '，请换条路走或检查参数。';
      appendLog('timeoutGuard', '[' + (isTimeout ? 'timeout' : 'error') + '] tool=' + name + ' timeoutMs=' + gt.timeoutMs + ' err=' + (e && e.message ? e.message : String(e)));
      if (breaker.isOpen()) {
        appendLog('timeoutGuard', '[circuit-blown] tool=' + name + ' 连续失败达 ' + breaker.max + ' 次，已熔断');
      }
      throw new Error(prefix + hint + (e && e.message ? ' 原始错误：' + e.message : ''));
    }
  }

  // 未开启全局超时：原路径
  const result = tool.mcp
    ? await mcp.executeRemote(tool, args || {}, ctx || {})
    : await tool.run(args || {}, ctx || {});
  return _applyCacheDedup(name, args, ctx, _truncate(result, ctx));
}

/**
 * 目录/清单类工具输出预算（对齐 dsh「完整注入」：工具清单是给模型看目录的，
 * 不能因通用 8000 上限被「头尾保、中间挖」——中间消失的工具模型照抄即解析失败 → 空轮中断）。
 * get_tools 默认给足完整目录预算（50 全量 brief 约 12K 字符，24000 足够含 detail=full 参数表）；
 * 调用方显式传 ctx.maxToolOutput 时仍尊重（外部约束优先），超了再走条目截断兜底。
 */
function _catalogLimit(ctx, name) {
  // get_tools 是「目录」：对齐 dsh 完整注入——固定大预算，不受外部 maxToolOutput 压缩。
  // 外部 maxToolOutput（默认 4000）是「普通工具结果」的长度上限；
  // 目录若被它「头60%+尾40%+中间挖掉」，中间工具从模型视野消失 → 照抄空名 →
  // parseTextCalls 解析失败 count=0 → 空轮 → 会话「莫名终止」（1.1.24 实锤链路）。
  // 40000 足够容纳 detail=full 全量 50 工具参数表 + MCP 尾部；再超走整条目兜底。
  if (name === 'get_tools') return 40000;
  // read_file 是「读整段看内容」语义：完整返回是语义，任何 read_file 结果都不该被
  // 通用 4000「头60%+尾40%+中间挖」——无论定向分段读还是大文件全量预览（骨架+前400行），
  // 挖掉中间 → 模型永远看不到段尾/完整预览 → 反复读 → 上下文膨胀 100% → 被迫收尾
  // （1.1.24 用户实测：docx_full.txt 分段读每段 6454/7119/11665 字全被中间省略）。
  // 30000 足够容纳约 600 行原文（1678 行全书分 3 段读完）；再超走整行截断兜底（不挖中间）。
  if (name === 'read_file') return 30000;
  return (ctx && ctx.maxToolOutput) || 8000;
}

/**
 * 主链路后台输入降噪（对齐 WorkBuddy RTK / 输入降噪，零侵入、不改工作流）。
 * 默认开启；关掉用 foxAi.denoiseOutput.enabled=false。
 * 只处理「命令行/日志类工具」的原始输出，read_file 读源码不降噪（保代码原样）。
 * 1) 剥 ANSI：ESC 控制序列（颜色/光标/擦除/OSC 标题），剥成纯文本。
 * 2) 折叠 \r 进度刷行：同一行反复被 \r 重刷的进度条/百分比只保留最后一次（最新状态），
 *    正常纯 \r\n 换行不误伤；没有 \r 的文本原样。
 * 3) 折叠连续完全重复行 ≥3：折叠为一行并标注 ×N，占位行（长度<4）不折叠防误伤。
 */
// 只对「命令行执行」类工具的输出做后台降噪（RTK 对应）：命令输出、终端输出、沙箱执行。
// read_file / search 等读类工具不降噪，保证源码与检索原文原样进上下文。
const _DENOISE_TOOLS = new Set(['run_command', 'get_terminal_output', 'run_in_sandbox']);
const _ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
function _denoiseOutput(name, text) {
  try {
    if (!_DENOISE_TOOLS.has(name)) return text;
    if (!text || typeof text !== 'string' || text.length < 24) return text;
    let enabled = true;
    try { const v = vscode.workspace.getConfiguration('foxAi').get('denoiseOutput.enabled'); if (v === false) enabled = false; } catch (_) { /* 默认开 */ }
    if (!enabled) return text;
    let out = String(text).replace(_ANSI_RE, '');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(out)) {
      out = out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    }
    if (out.indexOf('\r') !== -1) {
      const parts = out.split(/\r\n|\n|\r/);
      const lines = [];
      for (const seg of parts) {
        const t = seg.replace(/\s+$/g, '');
        // \r 刷行：该段非空且是「上一次刷行残留」→ 用本轮覆盖（只在 \r 分割下产生）
        if (t && lines.length && lines[lines.length - 1] && /^\d+(\.\d+)?%|progress|下载|加载|render|提取|处理中|Compiling|Building|Fetching|Starting/i.test(t)) {
          lines[lines.length - 1] = t;
        } else {
          lines.push(t);
        }
      }
      // 再次折叠重复行
      out = _collapseRepeat(lines.join('\n'));
    } else {
      out = _collapseRepeat(out);
    }
    return out;
  } catch (_) {
    return text; // 任何异常都不影响原路径
  }
}
function _collapseRepeat(text) {
  const lines = text.split('\n');
  const out = [];
  let run = 1;
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    const prev = lines[i - 1];
    if (i > 0 && cur === prev && cur.trim().length >= 4) {
      run++;
      continue;
    }
    if (run >= 3 && prev !== undefined) {
      out.push(prev + '　×' + run);
      run = 1;
      // 不 continue：当前行是转折后的新行，必须保留
    }
    run = 1;
    out.push(cur);
  }
  if (run >= 3 && lines.length) {
    out.push(lines[lines.length - 1] + '　×' + run);
  } else if (run > 1 && run < 3 && lines.length) {
    // 2 次连重不折叠（可读），补回最后一次的行
    out.push(lines[lines.length - 1]);
  }
  return out.join('\n');
}

/**
 * 防御 undefined/null 并截断过长输出（与历史行为一致）。
 * 目录/清单类输出（get_tools 等）：走「整条目截断」，绝不挖中间——
 * 对齐 dsh（deepseek-harness）system-prompt/tools 的做法：结构化清单要么完整、
 * 要么按条目边界保留并显式声明 truncated/total，绝不做「头60%+尾40%+中间省略」，
 * 否则模型视野里中间工具整体消失（如 1.1.24 前 get_tools 全量 50 条 11893 字符
 * 被 8000 上限截成 8046，create_mcp_server/规划/审查/子代理等 16 个工具凭空失踪，
 * 模型照抄中间工具名 → parseTextCalls 解析失败 count=0 → 空轮 → 会话中断）。
 */
function _truncate(result, ctx) {
  let text;
  if (typeof result === 'string') {
    text = result;
  } else if (result === undefined || result === null) {
    text = '';
  } else {
    text = JSON.stringify(result);
  }
  // 主链路后台降噪（RTK）：先剥杂讯再算长度，同一输出在降噪后可能不再超限
  text = _denoiseOutput(ctx && ctx.toolName, text);
  const limit = _catalogLimit(ctx, ctx && ctx.toolName);
  if (text.length <= limit) return text;
  // 目录/清单类工具（get_tools）：整条目截断，不挖中间。
  // 条目标记：每行「● 工具名：」开头为一个条目（renderToolGuideLine 输出格式）。
  // 超预算时按条目边界保留尾部（保留条目标题行 + 正文），并在头部补明确提示，
  // 让模型知道「完整清单可调用 get_tools query=xxx 单独检索」，杜绝工具名凭空消失。
  const toolName = ctx && ctx.toolName;
  if (toolName === 'get_tools' && text.includes('\n● ')) {
    const segs = text.split(/(?=\n● )/);
    // 头部说明段（第一个 ● 之前的「共 N 个工具…」）始终保留
    const intro = segs[0] && !segs[0].startsWith('● ') ? segs[0] : '';
    const entries = intro ? segs.slice(1) : segs;
    // 从尾部开始整条保留，直到塞满 limit（条目不劈半）
    const kept = [];
    let used = intro.length;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (used + e.length > limit) break;
      kept.unshift(e);
      used += e.length;
    }
    if (!kept.length) {
      // 极限小预算：至少保一条 + 提示，绝不输出空目录
      const first = entries[0] || intro;
      return first.slice(0, limit) + '\n…（工具目录超出预算，请用 get_tools query=xxx 单独检索）…';
    }
    const total = entries.length;
    const shown = kept.length;
    return (intro ? intro + '\n' : '')
      + `…（工具目录共 ${total} 条，预算 ${limit} 字仅能展示 ${shown} 条，完整清单请用 get_tools query=关键词 单独检索）…\n`
      + kept.join('');
  }
  // read_file 超预算（1.1.25：不再限于定向读，全量读同样适用）：整行截断，不挖中间、不劈行。
  // 逐行从头部保留完整行直到塞满；剩余行数在尾部显式提示模型用更小分段继续读，
  // 保证段尾/段头自然边界都在，模型不会误判「内容缺失」而反复重读 → 上下文膨胀；
  // 全量读大文件（无 start/end 参数）也不会被通用「头尾保、中间挖」砍掉中段。
  if (toolName === 'read_file') {
    const lines = String(text).split('\n');
    const keptLines = [];
    let used = 0;
    for (const ln of lines) {
      if (used + ln.length + 1 > limit) break;
      keptLines.push(ln);
      used += ln.length + 1;
    }
    const totalLines = lines.length;
    const keptCount = keptLines.length;
    return keptLines.join('\n')
      + `\n…（本段共 ${totalLines} 行，预算 ${limit} 字仅能展示前 ${keptCount} 行；请用更小的 start_line/end_line 分段继续读剩余部分）…`;
  }
  // 智能截断：头 + 尾。命令输出 / 测试结果 / 日志的关键报错与失败摘要常在尾部，
  // 从头硬截断会丢掉失败原因，导致模型（尤其弱模型）误判“成功”或反复重试。
  // 1.1.24（对齐 dsh pruner）：按 Unicode 码点切分（Array.from 天然不劈代理对），
  // 避免 emoji/CJK 扩展区在裁剪边界被切成乱码半个字符。
  const headLen = Math.floor(limit * 0.6);
  const tailLen = limit - headLen;
  const points = Array.from(text);
  if (points.length <= limit) return text; // 码点计长下可能不需裁（如大量 emoji 场景）
  const headPart = points.slice(0, headLen).join('');
  const tailPart = points.slice(points.length - tailLen).join('');
  return headPart
    + '\n…（输出过长已截断，共 ' + points.length + ' 字，中间省略；如需完整内容请用更精确参数重新调用）…\n'
    + tailPart;
}

module.exports = { TOOLS, getTool, toOpenAITools, toOpenAIToolsFrom, toTextManual, allTools, execute, titleOf, kindOf, mcp, sanitizeSchema, toolTagMap, usingCustomToolTag, wrapToolCall, normalizeToolTags, setCustomTagMode, customTagActive, _denoiseOutput, _collapseRepeat };
