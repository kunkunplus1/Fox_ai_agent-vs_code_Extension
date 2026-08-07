'use strict';

const vscode = require('vscode');
const ws = require('./workspace');
const term = require('./terminal');
const ctxTools = require('./context');
const { webSearch, getCurrentTime } = require('./webSearch');
const mcp = require('./mcp'); // MCP 连接器适配器骨架（默认未启用）
const mcpAuthor = require('./mcpAuthor'); // 自写 MCP 服务器（生成 / 登记 / 自动发现）
const reviewChanges = require('./reviewChanges'); // 原始版 vs 修改版对比 + 深度思考
const securityAudit = require('./securityAudit'); // 只读代码安全自检（自检 Agent）
const referee = require('./referee'); // 只读第三方裁判 Agent（双盲交叉验证）
const imageGen = require('./imageGen'); // 生图通道（独立第二模型，服务总控 agent，类似 vision 识图但反向）
const bridge = require('../extensionBridge'); // 跨扩展命令调用桥

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
        max_results: { type: 'integer', description: '最多返回多少条，默认 60' }
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
        max_results: { type: 'integer', description: '最多返回多少条，默认 40' }
      },
      required: ['query']
    },
    run: (a) => ws.searchText(a)
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
    title: (a) => `执行 ${a.command || ''}`,
    description:
      '在 VS Code 集成终端里执行 shell 命令并返回输出与退出码，用于安装依赖、构建、跑测试等。命令必须非交互（自带 -y 等参数），不要用会一直挂起的命令（如 npm run dev 长期驻留服务）。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的完整命令' },
        cwd: { type: 'string', description: '工作目录，默认工作区根目录' },
        explanation: { type: 'string', description: '一句话说明为什么要跑这条命令' }
      },
      required: ['command']
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
      '保存一条长期记忆（用户偏好、项目约定、踩过的坑等），下次对话会自动注入作为参考。text 为记忆内容；tags 可选，逗号分隔标签；category 可选：preference/project/lesson/general。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的内容，一句话说清' },
        tags: { type: 'string', description: '可选，逗号分隔的标签，如 偏好,Python' },
        category: { type: 'string', description: '可选分类：preference / project / lesson / general' }
      },
      required: ['text']
    },
    run: (a, c) => {
      const store = c && c.memory;
      if (!store) return '记忆存储不可用';
      const tags = a.tags ? String(a.tags).split(',').map((t) => t.trim()).filter(Boolean) : [];
      const item = store.add({ text: a.text, tags, category: a.category });
      return item ? `已记住：${item.text}` : '记忆内容为空，未保存';
    }
  },
  {
    name: 'get_memory',
    kind: 'read',
    title: (a) => (a.query ? `回忆「${a.query}」` : '回忆全部记忆'),
    description: '检索已有长期记忆。query 为空返回全部；带 query 时按内容/标签关键字模糊匹配。用于确认之前是否记过某件事。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选检索关键字' }
      }
    },
    run: (a, c) => {
      const store = c && c.memory;
      if (!store) return '记忆存储不可用';
      const items = store.search(a.query);
      if (!items.length) return a.query ? `没找到与「${a.query}」相关的记忆` : '还没有任何长期记忆';
      return items.map((it) => `- ${it.text}`).join('\n');
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
        query: { type: 'string', description: '本次用户需求，会一并交给技能指导参考' }
      },
      required: ['name']
    },
    run: async (a, c) => {
      const store = c && c.skills;
      if (!store) return '技能存储不可用';
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
      '为自己编写一个 MCP 服务器并登记/热加载，使狐狸 AI 能识别并使用你写的工具。三种用法三选一：① 传 tools（结构化工具数组，自动生成标准协议脚本，最稳）；② 传 script（完整服务器源码）；③ 传 script_path（你已用 write_file 写好的脚本绝对路径）。写好后可用 /mcp <id> <toolName> [参数] 调用；把 foxAi.mcp.autoInject 设为 true 后工具会自动进入可用列表。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '服务器 id，字母/数字/-/_，如 my-tools' },
        description: { type: 'string', description: '一句话描述这个服务器做什么' },
        tools: {
          type: 'array',
          description:
            '结构化工具列表（推荐）。每项：{ name, description, input_schema(JS 对象或 JSON 字符串), handler(完整函数表达式，如 async (args)=>{ return String(args.q); }) }'
        },
        script: { type: 'string', description: '完整服务器源码（纯 Node，实现 MCP stdio 协议）。提供它则忽略 tools' },
        script_path: { type: 'string', description: '已用 write_file 写好的脚本绝对路径；提供它则直接登记该文件' },
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
      if (!item) return `找不到任务 #${a.id}`;
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
    name: 'present_plan',
    kind: 'read',
    title: () => '提交计划待确认',
    description:
      '在已用 create_plan_task 列好完整计划后调用，把计划提交给用户确认。调用后必须停止，不要执行任何写文件/执行命令的操作，等待用户在对话面板里点「确认执行」。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '一句话说明本计划的目标（可选）' }
      }
    },
    run: async (a, c) => {
      const store = c && c.planTasks;
      const n = store ? store.list().length : 0;
      return `计划已提交，共 ${n} 项，等待用户确认。在用户确认前，不要执行任何步骤。`;
    }
  },
  {
    name: 'revise_plan',
    kind: 'read',
    title: (a) => '修订计划：' + (a.reason || ''),
    description:
      '执行过程中若需调整计划（增删步骤或改变目标），先调用 update_plan_task / create_plan_task 改好计划，再调用本工具并说明原因，等待用户再次确认后才继续；不得擅自偏离已确认的计划。',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '为什么要修订计划（必填，向用户说明）' }
      },
      required: ['reason']
    },
    run: async (a, c) => {
      const reason = String(a.reason || '').trim() || '（未说明原因）';
      return `计划修订已记录，原因：${reason}。已重新提交，等待用户确认后再继续。`;
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
    description: '在授权工作区内做**只读 · 脱敏 · 网络隔离**的代码安全自检（自检 Agent）：用规则扫描危险模式（硬编码密钥、eval/动态代码执行、命令执行、SQL/命令注入、路径穿越、XSS 注入点、TLS 校验禁用等），并可选跑 npm audit 检查依赖漏洞。绝不修改文件、不读取凭据文件内容、不向外发起请求；命中密钥一律打码。结果需人工复核，且**禁止作为修复唯一依据**（双盲）。可选 path 指定扫描目录，checkDeps=false 关闭依赖检查。',
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
    name: 'referee_review',
    kind: 'read',
    title: (a) => `裁判校验 ${a.path || '(全部改动)'}`,
    description: '**只读的第三方「裁判」Agent（双盲交叉验证）**：对比「修复前（git HEAD 原版）」与「修复后（工作区当前版）」的语义差异。若某文件修复前后逻辑完全等价（仅格式/重排/注释/变量重命名差异），说明这次「修复」什么也没改——极可能是自检 Agent 的误报被当真修了，此时该文件判为 SUSPEND；当所有改动文件都等价时整体强制挂起转人工。不依赖自检 Agent 的输出，独立判断。可选 path 指定单文件，不传则校验全部相对 HEAD 的改动。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '可选，单个文件绝对或相对工作区路径；不传则校验全部相对 HEAD 的改动' }
      }
    },
    run: (a, ctx) => referee.run(a, ctx)
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
      '需先在设置里开启 foxAi.imageGen（enabled=true）并填写 provider/baseUrl/apiKey/model（如通义 wan2.1-image）；未配置时本工具会提示如何开启。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '对要生成图片的文字描述（越具体越好，可含风格、构图、色调、主体等）' },
        size: { type: 'string', description: '可选，期望图片尺寸，如 1024x1024 / 1280x720，取决于生图模型支持；不支持时会被当作提示附加到描述里' }
      },
      required: ['prompt']
    },
    run: (a, c) => imageGen.run(a, c)
  }
];

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

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

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
  const provider = vcfg.get('provider') || 'llamacpp';
  const apiMode = vcfg.get('apiMode', 'chat');
  // DeepSeek Responses API 支持服务端内置联网搜索（免费、免 key）。
  // 在 deepseek + responses 模式下自动注入原生 web_search，
  // 不再依赖本地 web_search 开关（webSearch.enabled），避免用户没开开关导致模型看不到联网能力。
  const useProviderSearch = provider === 'deepseek' && apiMode === 'responses';
  const list = filterForPrompt(query, cfg) || allTools();
  const out = [];
  for (const t of list) {
    if (useProviderSearch) {
      // DeepSeek Responses API 的 function 名必须匹配 ^[a-zA-Z0-9_-]+$。
      // MCP 工具名形如 mcp__fetch__fetch-url 或含点/斜杠/大写（mcp__io.github...），会触发 400，
      // 必须在官方联网模式下整体排除；同时用官方 {type:'web_search'} 替换本地 web_search，
      // 避免模型调本地而绕开官方搜索、或把非法名字工具发给 DeepSeek 直接 400。
      if (t.name === 'web_search') continue;
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
  if (useProviderSearch) out.push({ type: 'web_search' });
  return out;
}

/** 文本协议用的说明书（给不支持 tools 的模型）。可选 query/cfg 用于动态子集精简 */
function toTextManual(query, cfg) {
  const list = filterForPrompt(query, cfg) || allTools();
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
      return _truncate(result, ctx);
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
  return _truncate(result, ctx);
}

/** 防御 undefined/null 并截断过长输出（与历史行为一致） */
function _truncate(result, ctx) {
  let text;
  if (typeof result === 'string') {
    text = result;
  } else if (result === undefined || result === null) {
    text = '';
  } else {
    text = JSON.stringify(result);
  }
  const limit = (ctx && ctx.maxToolOutput) || 8000;
  if (text.length > limit) {
    return text.slice(0, limit) + `\n…（输出过长，已截断，共 ${text.length} 字）`;
  }
  return text;
}

module.exports = { TOOLS, getTool, toOpenAITools, toTextManual, allTools, execute, titleOf, kindOf, mcp, sanitizeSchema };
