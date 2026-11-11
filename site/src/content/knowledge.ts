/**
 * 规范知识模型 —— 渲染的唯一真相源。
 *
 * 每个条目携带 `src` 字段,指向 SHARING.md 的章节锚点,保证内容可回溯原文。
 * `verified` 标记表示该事实已对照 B Code v3.4.4 实际代码核对过;
 * 与原文有出入时用 `correction` 记录,并在 UI 上以「待核实/更正」样式区分。
 */

import type { StageId } from './journey';

export const SOURCE_META = {
  title: '从零实现一个 Claude Code',
  subtitle: 'B Code 的架构与原理',
  audience: '想搞懂「AI Agent CLI 到底怎么跑起来的」的开发者',
  version: '3.4.4',
  loc: 12008,
  testFiles: 51,
  testsTotal: 579,
  testsPass: 578,
  sourceDoc: 'docs/SHARING.md',
} as const;

/** 原文勘误:文档自称 583 条测试,实测 579 条(578 pass / 1 fail) */
export const SOURCE_CORRECTIONS = [
  {
    id: 'test-count',
    claim: '583 条测试',
    actual: '579 条测试(51 个文件,578 通过 / 1 失败)',
    src: '#附录：项目速览',
    note: '实测 `bun test` 输出。失败用例与本次文档无关,是仓库既有状态。',
  },
] as const;

export type SectionId =
  | 'intro'
  | 'loop'
  | 'three-things'
  | 'backend'
  | 'tools'
  | 'permissions'
  | 'minimal'
  | 'pain-points'
  | 'compare'
  | 'roadmap'
  | 'lessons'
  | 'appendix';

export interface SectionMeta {
  id: SectionId;
  num: string;
  title: string;
  /** 导航栏用的短标题 —— 12 个章节全用长标题会横向溢出 */
  short: string;
  /** SHARING.md 中的锚点 */
  src: string;
}

/* SECTIONS 已由 journey.ts 的 STAGES / EPILOGUE 取代 */

// ── §1 核心循环 ────────────────────────────────────────────────

export const LOOP_PSEUDOCODE = `while (true) {
  回复 = 模型调用(历史消息, 可用工具清单)
  if (回复里没有工具调用) break
  结果 = 执行工具(回复里的工具调用名字)
  历史消息.push(结果)
}`;

export interface LoopStep {
  id: string;
  label: string;
  detail: string;
  kind: 'model' | 'decision' | 'exec' | 'done';
}

export const LOOP_STEPS: LoopStep[] = [
  {
    id: 'send',
    label: '把消息发给模型',
    detail: '历史消息 + 可用工具清单,一起作为请求参数发出去。',
    kind: 'model',
  },
  {
    id: 'decide',
    label: '模型决定要不要用工具',
    detail: '这一步的决策者是模型,不是代码。分支是模型现场生成的,不是程序员写死的。',
    kind: 'decision',
  },
  {
    id: 'exec',
    label: '执行工具,结果喂回',
    detail: '工具结果 push 进历史消息,成为下一轮的输入,然后回到第 1 步。',
    kind: 'exec',
  },
  {
    id: 'end',
    label: '任务结束,回答交给用户',
    detail: '回复里没有工具调用,循环 break。',
    kind: 'done',
  },
];

/** 对照:同一条指令下,聊天机器人与 Agent 的行为差异 */
export const COMPARISON_CHAT_VS_AGENT = {
  chat: ['收到问题', '生成一段代码', '交给用户:自己去复制、粘贴、保存、跑测试'],
  agent: ['读 package.json', '跑 bun test', '读报错的那个文件', '改代码', '再跑测试 → 通过'],
  takeaway: '区别不在「AI 更聪明了」,而在于它长出了手:能读、能改、能执行,并且知道自己刚刚做了什么。',
};

// ── §3 后端层:格式对照 ─────────────────────────────────────────

export interface FormatRow {
  concept: string;
  anthropic: string;
  openai: string;
  /** 是否为易踩坑项 */
  pitfall?: boolean;
}

export const FORMAT_DIFF_TABLE: FormatRow[] = [
  { concept: 'system', anthropic: '顶层 `system` 参数,支持多块', openai: '`messages` 里的 `role: "system"`' },
  {
    concept: '工具清单',
    anthropic: '顶层 `tools`:`{ name, description, input_schema }`',
    openai: '顶层 `tools`:`{ type: "function", function: { name, description, parameters } }`',
  },
  {
    concept: '工具调用',
    anthropic: 'assistant `content` 里的 `tool_use` 块',
    openai: 'assistant 消息上的 `tool_calls` 数组',
  },
  {
    concept: '调用参数',
    anthropic: '`input`:**已解析的对象**',
    openai: '`arguments`:**JSON 字符串**(流式下还是分片拼的)',
    pitfall: true,
  },
  {
    concept: '工具结果',
    anthropic: 'user `content` 里的 `tool_result` 块,用 `tool_use_id` 关联',
    openai: '独立的 `role: "tool"` 消息,用 `tool_call_id` 关联',
  },
  {
    concept: '一条 user 消息',
    anthropic: '可同时含 text + image + tool_result',
    openai: '必须拆开:内容走 `user`,结果走 `tool`',
    pitfall: true,
  },
  { concept: '结束原因', anthropic: '`stop_reason`', openai: '`finish_reason`' },
];

export const ANTHROPIC_SAMPLE = `{
  "system": [{ "type": "text", "text": "你是..." }],
  "tools": [
    {
      "name": "read_file",
      "description": "读取文件内容。大文件会被截断。",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": { "type": "string", "description": "文件路径" }
        },
        "required": ["path"]
      }
    }
  ],
  "messages": [
    { "role": "user", "content": "读一下 a.txt" },
    {
      "role": "assistant",
      "content": [
        { "type": "text", "text": "我来读。" },
        { "type": "tool_use", "id": "toolu_1",
          "name": "read_file", "input": { "path": "a.txt" } }
      ]
    },
    {
      "role": "user",
      "content": [
        { "type": "tool_result", "tool_use_id": "toolu_1",
          "content": "文件内容..." }
      ]
    }
  ]
}`;

export const OPENAI_SAMPLE = `{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "读取文件内容。大文件会被截断。",
        "parameters": {
          "type": "object",
          "properties": {
            "path": { "type": "string", "description": "文件路径" }
          },
          "required": ["path"]
        }
      }
    }
  ],
  "messages": [
    { "role": "system", "content": "你是..." },
    { "role": "user", "content": "读一下 a.txt" },
    {
      "role": "assistant",
      "content": "我来读。",
      "tool_calls": [
        {
          "id": "call_1",
          "type": "function",
          "function": {
            "name": "read_file",
            "arguments": "{\\"path\\":\\"a.txt\\"}"
          }
        }
      ]
    },
    { "role": "tool", "tool_call_id": "call_1",
      "content": "文件内容..." }
  ]
}`;

export const BACKEND_PITFALLS = [
  {
    id: 'arguments-string',
    title: '`arguments` 是字符串不是对象',
    detail:
      '转过去要 `JSON.stringify(input)`,转回来要 `JSON.parse(arguments)`;解析失败时必须兜底成空对象,否则一次坏参数就让整个循环崩掉。',
  },
  {
    id: 'message-count',
    title: '消息条数会变',
    detail:
      'Anthropic 侧一条 user 消息塞了 3 个 `tool_result`,到 OpenAI 侧就裂成 3 条 `role: "tool"` 消息。所以「消息数量」在两套格式里根本对不上 —— 做历史压缩或 token 计数时不能按条数换乘。',
  },
] as const;

// ── §4 工具系统 ────────────────────────────────────────────────

export interface ToolMeta {
  name: string;
  purpose: string;
  /** 权限档位(对应 MountPoint.mode) */
  mode: 'read' | 'write' | 'shell' | 'external';
  note?: string;
}

export const TOOLS: ToolMeta[] = [
  { name: 'read_file', purpose: '读文件', mode: 'read' },
  { name: 'file_content', purpose: '按需取回已读文件 / 探测是否被改动', mode: 'read' },
  { name: 'list_files', purpose: '列目录', mode: 'read' },
  { name: 'grep_search', purpose: '全文搜索(会读 `.gitignore`)', mode: 'read' },
  { name: 'write_file', purpose: '写文件', mode: 'write' },
  { name: 'edit_file', purpose: '精确替换片段', mode: 'write' },
  { name: 'run_shell', purpose: '执行命令', mode: 'shell' },
  { name: 'ask_user', purpose: '向用户提问(选项 / 文本)', mode: 'external', note: '自授权' },
  { name: 'todo_write', purpose: '维护任务清单', mode: 'write', note: '自授权' },
  { name: 'save_memory', purpose: '存一条长期记忆', mode: 'write' },
  { name: 'write_plan', purpose: '写计划文件', mode: 'external', note: 'plan 专用放行' },
  { name: 'agent', purpose: '派子 Agent 调研', mode: 'read' },
  { name: 'review_plan', purpose: '派子 Agent 对抗性审查计划', mode: 'read' },
];

export const NO_DELETE_TOOL = {
  title: '注意没有 `delete_file`',
  detail:
    '删除只能通过 `run_shell` 执行 `rm` —— 而 `rm -rf` 会被危险命令规则直接拒绝。这个设计的意思是:把「不可逆操作」全部收拢到唯一一条需要过权限的通道上。如果单独开一个 `delete_file` 工具,就等于多开了一扇需要单独设防的门。',
};

export const EDIT_FILE_RATIONALE = {
  title: '为什么 `edit_file` 比「重写整个文件」重要',
  problems: [
    '一个大文件几百行,每次改一行就重传全文,token 成本极高',
    '模型很难一字不差地重述整个文件,容易把不相干的地方改掉',
  ],
  benefit: '`edit_file` 只传「把这段原文替换成这段新文」。省 token,且改动范围天然受控。',
};

export const TRUNCATION_TIERS = [
  {
    tier: '第一层',
    action: '单次结果超 5 万字符就截断(保留头尾,中间标省略)',
    solves: '单条结果不会失控',
  },
  {
    tier: '第二层',
    action: '文件读一次后缓存,再读只返回指针(路径 + 行数 + hash)',
    solves: '同一文件不重复占空间',
  },
  { tier: '第三层', action: '整体超阈值就压缩旧消息', solves: '长对话能一直进行下去' },
] as const;

export const COMPRESSION_DEATH_LOOP = {
  title: '第二层解决的是「压缩导致模型失忆」的连锁问题',
  steps: [
    '模型读了 `auth.ts`',
    '对话太长触发压缩,旧消息被摘要掉',
    '`auth.ts` 的内容也跟着没了',
    '模型想改这个文件,只好再读一遍',
    '读一遍又占空间,又触发压缩……',
  ],
  fix: 'B Code 的做法是:文件内容不放在消息历史里(历史里只有一个指针),实际内容存在会话级的缓存中。压缩时生成一份「已读文件索引」,告诉模型「这些文件你读过,需要时用 `file_content` 按需取」。这样压缩不会造成信息丢失,因为权威数据在磁盘和缓存里,不在历史里。',
};

// ── MCP ────────────────────────────────────────────────────────

export const MCP_SDK_RESPONSIBILITIES = [
  {
    sdk: 'JSON-RPC 收发 + 请求配对',
    what: '分配请求 id、把响应匹配回对应的 Promise、超时 reject',
    without: '自己维护一张并发请求的 id 映射表',
  },
  {
    sdk: '握手与能力协商',
    what: '自动 `initialize` 交换版本和能力清单,之后按对方声明拦截不该发的请求',
    without: '对不支持的工具发请求,永远等不到回包',
  },
  {
    sdk: '能力 API + schema 校验',
    what: '`listTools` / `callTool` / `listResources` / `listPrompts`,返回值按 schema 校验成类型化对象',
    without: '手写每个方法的报文构造和解析',
  },
  {
    sdk: 'Transport 抽象',
    what: '统一成 `start/send/close/onmessage` 四个方法,另有 stdio / Streamable HTTP / SSE / WebSocket 四种现成实现',
    without: '每种通信方式各写一套',
  },
  {
    sdk: '反向调用通道',
    what: 'server 也能反过来求 client(借模型推理、问可访问目录、要用户填参数)',
    without: '只能单向调用',
  },
] as const;

export const MCP_HANDSHAKE = [
  { from: 'client', to: 'server', payload: '协议版本 + 我支持的能力' },
  { from: 'server', to: 'client', payload: '协议版本 + 我提供的能力' },
  { from: 'client', to: 'server', payload: 'initialized(握手完成)' },
] as const;

export const MCP_PRINCIPLE =
  '宿主没注入的能力就绝不声明 —— server 据此知道「这个客户端做不到」,自己就不发这类请求了;反过来若声明了却没人处理,就成了一个永远超时的坑。';

// ── §5 权限系统 ────────────────────────────────────────────────

export interface PermMode {
  id: 'default' | 'plan' | 'auto' | 'bypass';
  label: string;
  onWrite: string;
  when: string;
}

export const PERM_MODES: PermMode[] = [
  { id: 'default', label: 'default', onWrite: '每次都问你', when: '日常使用(默认)' },
  { id: 'plan', label: 'plan', onWrite: '全部拦截,只能读', when: '让它先出方案,你确认后再执行' },
  { id: 'auto', label: 'auto', onWrite: '用一个 AI 分类器代替你判断', when: '你信任它,但还想留一道保险' },
  { id: 'bypass', label: 'bypass', onWrite: '不问,直接干', when: '完全信任 / 沙箱环境' },
];

export interface DangerousCmd {
  pattern: string;
  why: string;
  /** 源码中的实际正则 */
  regex: string;
}

/** 与 src/permissions.ts 的 DANGEROUS_PATTERNS 逐条对应(共 7 条) */
export const DANGEROUS_COMMANDS: DangerousCmd[] = [
  { pattern: 'git reset --hard', why: '丢弃未提交改动', regex: 'CMD_START + git\\s+reset\\s+--hard' },
  { pattern: 'sudo', why: '提权,后续命令不再受控', regex: 'CMD_START + sudo\\b' },
  { pattern: 'mkfs', why: '格式化磁盘', regex: 'CMD_START + mkfs\\b' },
  { pattern: 'dd', why: '磁盘级操作', regex: 'CMD_START + dd\\s' },
  { pattern: 'kill', why: '杀进程', regex: 'CMD_START + kill\\b' },
  { pattern: 'reboot', why: '重启', regex: 'CMD_START + reboot\\b' },
  { pattern: 'shutdown', why: '关机', regex: 'CMD_START + shutdown\\b' },
];

/** 单独一条:跑在原文上(不走引号剥离),故不并入上表 */
export const DEVICE_WRITE_RULE = {
  pattern: '> /dev/裸设备',
  why: '直接写设备节点。/dev/null、/dev/stdout 等安全重定向已排除 —— 否则最常见的降噪习惯会被误杀',
  regex: '/>\\s*["\']?\\/dev\\/(?!(?:null|zero|stdout|stderr|stdin|tty|random|urandom|fd)…)/',
};

/** rm 分级:破坏力取决于目标,不在无条件 deny 表里 */
export const RM_TIERS = [
  {
    tier: 'deny',
    label: '灾难目标',
    targets: '/ · ~ · * · . · .. · $HOME · 顶层目录 · 工作目录本身',
    note: '删掉就回不来。提不出目标时(嵌套 shell)也按这一档算。',
  },
  {
    tier: 'confirm',
    label: '其他目标',
    targets: '项目内路径 · /tmp · node_modules / dist / build',
    note: '日常清理。确认一次后可持久化免问 —— 本仓库刻意没有 delete_file,删产物只能走 shell。',
  },
] as const;

export const SENSITIVE_COMMANDS = [
  { pattern: 'git push', why: '推送代码(会改动远端) —— 敏感但可商量,允许用户授权后免问' },
];

export const CMD_BOUNDARY_NOTE =
  '`git reset` / `sudo` / `mkfs` / `kill` / `dd` / `reboot` / `shutdown` 这类词必须匹配到「命令边界」:命令串以它开头,或出现在 `;` `&` `|` 之后。否则 `npm run kill-port`、`git commit -m "add sudo docs"` 这类正常命令会被误杀。';

export const PERM_DECISION_CHAIN = [
  {
    order: '①',
    question: '危险命令?',
    result: 'deny',
    resultLabel: '拒绝',
    note: '最高优先级,任何模式(含 bypass)。rm 按目标分级:' + '灾难目标 deny,其余落到 ⑤',
  },
  { order: '②', question: 'plan 模式?', result: 'deny', resultLabel: '拒绝', note: '非只读操作一律拒绝' },
  { order: '③', question: '只读操作?', result: 'allow', resultLabel: '放行', note: '读文件不需要打扰用户' },
  {
    order: '④',
    question: '敏感命令?',
    result: 'confirm',
    resultLabel: '必须确认',
    note: '如 git push,但用户可授权「以后别问」',
  },
  { order: '⑤', question: '其他', result: 'confirm', resultLabel: '必须确认', note: 'fail-closed 兜底' },
] as const;

export const FAIL_CLOSED_NOTE =
  'fail-closed(默认拒绝)的意思是:如果一个工具没有声明自己属于哪一类(比如未来新接入的 MCP 工具,或者别人写的插件),系统默认要求确认,而不是默认放行。反过来(fail-open)会让新工具自动获得权限 —— 一个恶意的 MCP server 接进来就能随便读你的文件。安全的默认值必须是「不确定就拦」。';

export const ALLOWLIST_RULES = [
  { rule: '长度不超过 200 字符', why: '超长命令几乎必然是一次性脚本' },
  { rule: '不含 inline 脚本 / heredoc', why: '内容每次都不同,记住也没用' },
  { rule: '命令做归一化(折叠空白)', why: '否则格式抖动会造出一堆近似重复项' },
  { rule: '条目数封顶,超出淘汰最旧', why: '防止配置文件无限膨胀' },
] as const;

export const ALLOWLIST_PHILOSOPHY =
  '持久化白名单应该沉淀「可复用的能力」,而不是「一次性的具体调用」。`bun test` 值得记住,`node -e "console.log(123)"` 不值得。';

// ── §7-§13 七个痛点 ────────────────────────────────────────────

export interface PainPoint {
  id: string;
  num: number;
  src: string;
  symptom: string;
  cause: string;
  solution: string;
  /** 关键设计要点 */
  keys: string[];
  /** 可视化组件标识 */
  visual?: 'prompt' | 'compaction' | 'checkpoint' | 'subagent' | 'events' | 'goal' | 'abort';
}

export const PAIN_POINTS: PainPoint[] = [
  {
    id: 'unstable',
    num: 1,
    src: '§7',
    symptom: '你让它修 bug,它的第一反应是直接改代码 —— 但它根本没读过那个文件,改出来的东西语法都不对。',
    cause:
      '模型的行为很大程度上由 system prompt 决定。没有约束的话,它倾向于「快速给出答案」而不是「先看清楚再动手」。',
    solution: '两段式 System Prompt:静态核心(一字不变,可被缓存)+ 动态上下文(每次重建)。',
    keys: [
      '静态核心在前:大模型 API 对完全相同的前缀有缓存折扣,命中部分只按约 1/10 价格计费。',
      '动态内容放最后:近因效应 —— 模型对末尾内容注意力更高,最新的环境信息影响更大。',
      '一个长会话里,这个差别是几倍的成本差距。',
    ],
    visual: 'prompt',
  },
  {
    id: 'context-full',
    num: 2,
    src: '§8',
    symptom: '聊了 40 轮之后,程序报错:上下文超长。',
    cause: '模型有上下文窗口上限。历史消息只增不减,撞墙是必然的。',
    solution: '分级压缩:从轻到重的多道防线,而不是「满了再处理」。',
    keys: [
      '保留最近 5 条:最近的对话是「当前正在做的事」,摘要会丢掉行号、函数名这类细节。',
      '阈值取窗口的 40% 而非 90%:一是 token 按字符估算,中文/代码偏低,需留余量;二是压缩本身要调一次模型,把旧消息全读一遍。',
    ],
    visual: 'compaction',
  },
  {
    id: 'rewind',
    num: 3,
    src: '§9',
    symptom: 'Agent 改坏了 5 个文件,你想全部还原。',
    cause: '写操作没有留退路。',
    solution: '检查点:在任何会改文件的工具执行前,先把该文件的「改动前内容」记下来。',
    keys: [
      '`/rewind` 时按逆序还原 —— 先改的后还原,这样同一文件被改多次也能正确回到最初状态。',
      '同一文件被改多次时只记录最早的那一次:你要回退的是「这轮会话开始前的状态」。',
      '不落盘(只在内存里)是有意的:检查点只服务于当前会话,退出即失效,避免磁盘堆满没人清理的备份。',
    ],
    visual: 'checkpoint',
  },
  {
    id: 'subagent',
    num: 4,
    src: '§10',
    symptom:
      '让它调研项目用了什么测试框架 —— 它读了 20 个文件,全是无关紧要的内容,把上下文撑满了。而你只想要一句结论。',
    cause: '一个 Agent 干所有事,调研噪声全留在主对话历史里。',
    solution: '派一个独立的临时 Agent 去做调研,主 Agent 只收到摘要。',
    keys: [
      '独立上下文:子 Agent 的消息数组是独立的,读完即弃。',
      '只读权限:限制是在工具层面做的,不是在提示词里「请求」它别写。提示词约束可以被绕过,工具面没有那个工具就是物理上做不到。',
      '不能嵌套自己:子 Agent 的工具列表里没有「派生子 Agent」这个工具,否则无限递归直接把程序跑死。',
    ],
    visual: 'subagent',
  },
  {
    id: 'visibility',
    num: 5,
    src: '§11',
    symptom: 'Agent 在跑,屏幕上什么都不动。你不知道它在思考、在读文件、还是卡死了。',
    cause: '核心循环与 UI 耦合,或者干脆没有中间状态。',
    solution: '结构化事件流:核心循环不直接画 UI,而是发出事件,UI 层订阅渲染。',
    keys: [
      '核心循环完全不知道 UI 长什么样 —— 同一套内核能服务交互式终端、`--output-format json`、管道/非 TTY 三种场景。',
      '隐藏好处:如果核心循环自己打印 UI,它就没法在测试里跑了。事件流让核心逻辑可以脱离终端被完整测试。',
    ],
    visual: 'events',
  },
  {
    id: 'goal',
    num: 6,
    src: '§12',
    symptom:
      '你让它「一直改到测试通过为止」。它说「好的」,然后跑了 3 次就停了 —— 因为它觉得自己做完了,但实际测试还挂着。',
    cause: '让执行者自己打分,它倾向于说「我干完了」。',
    solution: '目标评估器:`--goal <条件>` 模式,主循环跑完一轮后另起一次模型调用专门判断目标达成没。',
    keys: [
      '「干活的」和「检查的」应该是两个独立判断。',
      '死循环刹车:如果评估器发现条件永远不可能达成,返回 `impossible`,主循环停止。没有这个刹车,无人值守模式会一直烧钱。',
    ],
    visual: 'goal',
  },
  {
    id: 'abort',
    num: 7,
    src: '§13',
    symptom: '它正在跑一个 5 分钟的命令,你发现方向错了想停下来。',
    cause: '中断信号没有贯穿到每一个可能阻塞的地方。',
    solution: 'AbortSignal 贯穿全链路。按 `Esc` 会同时做三件事。',
    keys: [
      '取消正在飞的 HTTP 请求',
      '杀掉 `run_shell` 起的子进程',
      '让正在等待的重试退避立刻返回 —— 否则用户按了 Esc,程序还在傻等那 2 分钟的退避,表现就是「按了没反应」。',
    ],
    visual: 'abort',
  },
];

// ── §14 对比 ──────────────────────────────────────────────────

export interface CompareRow {
  dimension: string;
  claudeCode: string;
  bcode: string;
  note?: string;
}

export const COMPARE_ROWS: CompareRow[] = [
  { dimension: '核心循环', claudeCode: '相同', bcode: '相同', note: '都是「模型决定循环转不转」' },
  { dimension: '工具系统', claudeCode: '内置 + MCP', bcode: '内置 + MCP', note: 'MCP 协议两边都支持' },
  {
    dimension: '权限模型',
    claudeCode: '多档模式',
    bcode: '四档模式',
    note: '思路一致,B Code 明确区分「危险命令」和「敏感命令」',
  },
  {
    dimension: '上下文压缩',
    claudeCode: '自动压缩',
    bcode: '分级压缩 + 文件指针',
    note: 'B Code 用文件缓存解决「压缩后失忆」',
  },
  { dimension: '子 Agent', claudeCode: '支持', bcode: '支持,工具面独立', note: 'B Code 强制只读 + 禁止嵌套' },
  { dimension: '持久化记忆', claudeCode: '有', bcode: '有(项目隔离)', note: '召回策略不同' },
  {
    dimension: '技能系统',
    claudeCode: '支持',
    bcode: '兼容其目录格式',
    note: 'B Code 可直接读 `~/.claude/skills`',
  },
  { dimension: 'Hooks', claudeCode: '支持', bcode: '兼容其协议', note: '事件名、退出码语义一致' },
  {
    dimension: '模型后端',
    claudeCode: '仅 Anthropic',
    bcode: 'Anthropic + OpenAI 兼容',
    note: 'B Code 可接国产模型 / 自建',
  },
  { dimension: 'UI 技术栈', claudeCode: '闭源', bcode: 'OpenTUI(开源)' },
  { dimension: '分发方式', claudeCode: 'npm(需 Node)', bcode: '单文件可执行(零依赖)' },
  { dimension: '自主循环', claudeCode: '有', bcode: '有(`--goal` / `--loop`)', note: '都靠独立评估器判断' },
];

/**
 * §14 持久化记忆 —— 对照 `src/memory.ts` + `src/prompt.ts` + `src/agent.ts` 核对过。
 *
 * 站点的这一节只留核心:存在哪(MEMORY_STORAGE)、怎么跨会话往返(MEMORY_DEMO)。
 * 召回的取舍放在 §14 对比里(MEMORY_RECALL)—— 别在两边重复维护同一段文案。
 */

/** 存储路径:项目隔离是主题键,不是可选优化 */
export const MEMORY_STORAGE = {
  root: '~/.b-code',
  /** 覆盖根目录的环境变量(测试隔离 / 换机迁移 / CI 注入) */
  envOverride: 'B_CODE_HOME',
  layout: '{basePath}/projects/{sha256(cwd) 前 16 位}/memory/*.md',
  format: 'YAML frontmatter(name / description / type)+ Markdown 正文',
  why: '键是「工作目录的哈希」而不是项目名:同一个项目在不同机器上路径不同,记忆各自独立;换个目录打开同一个仓库,记忆也不会串。',
  note: '按 cwd 隔离的代价是「同一仓库 clone 到两个目录 = 两套记忆」。这是刻意的取舍 —— 路径是唯一不需要额外配置就能拿到的稳定标识。',
} as const;

/** 一次完整的跨会话演示:第三个会话它已经知道前两次的事了 */
export const MEMORY_DEMO = {
  /** 会话 1:模型主动提出要记一条 */
  session1: {
    label: '会话 1 · 你纠正了它一次',
    turns: [
      { role: 'user' as const, text: '装个依赖,加个 date-fns' },
      { role: 'assistant' as const, text: '好 —— `npm install date-fns`' },
      { role: 'user' as const, text: '别用 npm,这仓库用 pnpm' },
      { role: 'assistant' as const, text: '明白。我记一下,免得下次再犯。' },
    ],
    /** 待确认的工具调用 */
    call: {
      tool: 'save_memory',
      input:
        '{"name":"包管理器用 pnpm","type":"project","content":"这个仓库用 pnpm,不要用 npm 或 yarn。装依赖:`pnpm add <pkg>`。"}',
    },
    confirm: 'save_memory 属于 write 档 → 弹确认',
  },
  /** 会话 2:新目录、新进程,命中召回 */
  session2: {
    label: '会话 2 · 新开一个终端',
    query: '帮我装个 lodash',
    /** 打进 system prompt 末尾的段落 */
    injected: `# Memory
- 包管理器用 pnpm: 这个仓库用 pnpm,不要用 npm 或 yarn。装依赖:\`pnpm add <pkg>\`。`,
    hit: 'query 切出「帮我 / 我装 / 装个」,其中「装个」在记忆正文里出现过 → score 1 → top 3 内命中这条',
    outcome: '它直接用了 `pnpm add lodash` —— 你没再提一次',
  },
  /** 会话 3:反例,说明「不是万能」 */
  session3: {
    label: '会话 3 · 同一个仓库,换个目录 clone',
    note: '换了路径 → cwd 变了 → sha256 变了 → 是另一个记忆目录',
    outcome: '它又用回了 npm —— 项目隔离的代价,老老实实暴露出来',
  },
} as const;

/** 召回策略:主线只留一句话,完整取舍放在这里(§14 对比用) */
export const MEMORY_RECALL = {
  strategy: '纯确定性关键词重叠打分',
  steps: ['拿当前查询跟记忆的标题、描述、正文做词集重叠', '算个分,取前 3 条注入 system prompt'],
  whyNoVector: ['快(不用调 embedding API)', '省(不花钱)', '可预测(同样的输入永远同样的结果,好调试)'],
  cost: '代价是语义近似的召回会弱一些。代码里留了接口抽象,将来换向量库是替换一个实现类的事。',
};

// ── §15 演进顺序 ──────────────────────────────────────────────

export interface RoadmapStep {
  step: number;
  title: string;
  needs?: string;
  reason: string;
  /** 前六步是「不做就不能用」,之后是锦上添花 */
  essential: boolean;
}

export const ROADMAP: RoadmapStep[] = [
  { step: 1, title: 'while 循环 + 一个 read_file 工具', reason: '能跑通就证明了核心原理', essential: true },
  {
    step: 2,
    title: '加 write_file + run_shell',
    needs: '必须立刻加权限确认',
    reason: '否则不能给人用',
    essential: true,
  },
  { step: 3, title: '加流式输出 + 事件流', reason: '否则用户体验是「卡死」', essential: true },
  { step: 4, title: '加工具结果截断 + 上下文压缩', reason: '否则长对话必然崩溃', essential: true },
  { step: 5, title: '加 system prompt 约束', reason: '否则模型行为不稳定', essential: true },
  { step: 6, title: '加检查点', reason: '否则改坏了没法收拾', essential: true },
  { step: 7, title: '子 Agent、记忆、技能、MCP、自主循环', reason: '锦上添花', essential: false },
];

export const ROADMAP_WARNING =
  '很多项目倒在第三步之前 —— 因为前两步做完觉得很酷,直接跳过权限去做花哨功能了。';

// ── §16 教训 ──────────────────────────────────────────────────

export interface Lesson {
  id: string;
  title: string;
  body: string;
  takeaway: string;
}

export const LESSONS: Lesson[] = [
  {
    id: 'clipboard',
    title: '剪贴板这类系统能力,每个平台都是独立工程',
    body: 'macOS 用 `osascript`,Linux 用 `xclip` / `wl-paste`,Windows 用 PowerShell + .NET 的 `System.Windows.Forms`。Windows 还有额外的坑:`Clipboard` 是 STA COM 组件,而 PowerShell 7 默认以 MTA 启动,不显式加 `-STA` 就直接抛异常。',
    takeaway:
      'Windows 上失败的表现是「什么都没发生」,所以必须有明确的探测和降级路径,不能靠 try/catch 吞掉就完事。',
  },
  {
    id: 'infinite-loop',
    title: '死循环的种子往往在「好心」的设计里',
    body: '子 Agent 能派生子 Agent → 无限递归;压缩导致文件内容丢失 → 模型重读 → 又触发压缩;目标评估器永远返回「未达成」→ 无限烧钱。',
    takeaway:
      '每个「循环」和「自动重试」的机制旁边,都必须有一个明确的刹车。B Code 里分别是:工具面过滤、文件指针缓存、`impossible` 判定。',
  },
];

// ── §17 结语 + 附录 ────────────────────────────────────────────

export const CLOSING_MAP = [
  { problem: '模型会犯错', module: '权限' },
  { problem: '上下文会满', module: '压缩' },
  { problem: '用户会等急', module: '流式' },
  { problem: '改坏要能退', module: '检查点' },
  { problem: '任务太杂', module: '子 Agent' },
  { problem: '无人值守', module: '独立评估器' },
];

export const CLOSING_PRINCIPLE =
  '每加一个模块,都应该能回答「它解决了哪一个具体问题」。回答不上来的,大概是过度设计。';

export const APPENDIX_MODULES = [
  { file: 'agent.ts', duty: '核心循环引擎' },
  { file: 'backend.ts', duty: '模型通信(双后端 + 流式 + 代理)' },
  { file: 'registry.ts / tools.ts', duty: '工具注册与实现' },
  { file: 'permissions.ts', duty: '权限判定' },
  { file: 'context.ts / file-store.ts', duty: '上下文管理与文件缓存' },
  { file: 'prompt.ts', duty: '两段式 system prompt' },
  { file: 'subagent.ts', duty: '子 Agent' },
  { file: 'checkpoint.ts', duty: '文件检查点' },
  { file: 'session.ts', duty: '会话持久化' },
  { file: 'mcp.ts', duty: 'MCP 协议客户端' },
  { file: 'skills.ts / memory.ts / hooks.ts', duty: '扩展能力' },
  { file: 'ui/', duty: 'OpenTUI 渲染层' },
];

export const COMMANDS = [
  { cmd: 'bcode "指令"', desc: '单次执行' },
  { cmd: 'bcode', desc: '交互式' },
  { cmd: 'bcode --plan "指令"', desc: '只读规划' },
  { cmd: 'bcode --yolo "指令"', desc: '跳过确认(危险命令仍拦)' },
  { cmd: 'bcode --goal <条件> "指令"', desc: '跑到条件达成为止' },
];

export const SHORTCUTS = [
  { key: 'Esc', desc: '中断' },
  { key: 'Ctrl+O', desc: '工具输出面板' },
  { key: 'Shift+Tab', desc: '切模式' },
  { key: 'Ctrl+V', desc: '贴图' },
];

// ── 知识自测 ──────────────────────────────────────────────────

export interface QuizQuestion {
  id: string;
  /** 回溯到 SHARING.md 的章节 */
  src: string;
  /** 对应主线上的哪一站 —— 答错时告诉读者「回哪一节再看」 */
  stage: StageId;
  question: string;
  options: string[];
  answer: number;
  /** 对整体答案的解释(答对/答错都显示) */
  explanation: string;
  /**
   * 每个选项各自错在哪 —— 长度必须与 options 一致,正确项填 null。
   * 只给一个「正确答案是 B」是没用的:读者真正需要知道的是「我选的这个为什么不对」。
   */
  optionNotes: (string | null)[];
}

/**
 * 知识自测 —— 十道题覆盖主线的十一个时刻。
 *
 * 出题原则:
 *   1. 每一题的考点都必须是那一节真的讲过的东西(都能在组件里指出来),不考原文没提的细节。
 *   2. 错项要是「看起来有道理」的常见误解,不能是凑数的废话 —— 否则答对了也学不到东西。
 *   3. 答错只告诉你「不对」是浪费一次教学机会,所以每题都带 optionNotes:选哪个都有人管。
 *
 * 覆盖对照:一题一站,顺序和主线一致 ——
 *   q1 你开口 · q2 循环转起来 · q3 先立规矩 · q4 换个模型 · q5 它要动手了
 *   q6 差点删库 · q7 塞不下了 · q8 派个人去查 · q9 谁说了算 · q10 记住下次
 * (第 10 个时刻「跑通了」是全篇的收束,不单独出题 —— 它的结论已经落在 q1 的选项里。)
 */
export const QUIZ: QuizQuestion[] = [
  {
    id: 'q1',
    src: '§0',
    stage: 'ask',
    question: '同一个「这个 bug 帮我修一下」,聊天机器人和 Agent 的分界线在哪?',
    options: [
      'Agent 的模型更大、更聪明,所以给出的代码质量更高',
      'AI 走到「生成代码」就到边界了,剩下复制、粘贴、保存、跑测试都在你手里;Agent 整条链路都在自己手里',
      'Agent 有更长的上下文窗口,能一次读完整个项目',
      'Agent 用了向量数据库来检索相关代码',
    ],
    answer: 1,
    explanation:
      '区别不在「AI 更聪明了」,而在于它长出了手:能读、能改、能执行,并且知道自己刚刚做了什么。竞速图里两条轨道最后比的是「你需要动手几次」—— 一个 3 次,一个 0 次。',
    optionNotes: [
      '模型变强不会让「复制粘贴」这一步消失 —— 那一步是工具能力的边界,不是模型的智力问题。',
      null,
      '上下文窗口决定「能装多少」,不决定「能不能动手」,和这条分界线无关。',
      '向量检索只影响「怎么找到相关代码」,而这里的差别是「找到之后能不能直接改」。',
    ],
  },
  {
    id: 'q2',
    src: '§1',
    stage: 'loop',
    question: '把消息发给模型之后,「要不要再转一圈」是谁决定的?',
    options: [
      '代码里写好的:工具调用次数达到上限就停',
      '模型自己:它这一轮回复里没带工具调用,循环就 break',
      '用户:每一轮都要你点一次「继续」',
      '权限系统:每一轮都重新判定一次才允许继续',
    ],
    answer: 1,
    explanation:
      '这是全篇的第一性原理。传统程序的 `if 文件不存在 then 创建` 是程序员写死的;Agent 的下一步是模型读完上一步结果后现场决定的。代码只提供「能做什么」的清单,不规定「先做什么后做什么」。',
    optionNotes: [
      '次数上限是防跑飞的保险(比如目标评估器的刹车),不是循环的正常退出条件 —— 正常情况下它根本不该被触发。',
      null,
      '「每一步都要你点一次」那就不叫自主循环了 —— 那还是你在传动整条链路。',
      '权限系统管的是「这个操作允不允许做」,不管「循环转不转」,两者在流程图上位置都不同。',
    ],
  },
  {
    id: 'q3',
    src: '§7',
    stage: 'prompt',
    question: '两段式 system prompt 里,为什么静态核心必须放在最前面?',
    options: [
      '因为模型对开头的内容记得更牢,放后面会被忘掉',
      '因为大模型 API 对完全相同的前缀有缓存折扣,静态内容放前面才能稳定命中',
      '因为动态内容太长,放前面会把静态部分挤掉',
      '因为方便开发者调试时一眼看到行为准则',
    ],
    answer: 1,
    explanation:
      '命中缓存的部分只按约 1/10 价格计费,而缓存是按前缀匹配的 —— 只要每次都变的动态内容混在前面,后面的静态部分就永远打不中。动态内容则放到最后,利用近因效应。',
    optionNotes: [
      '「记得更牢」说的是近因效应,它恰好是**反方向**的论据:注意力更高的是末尾,所以动态内容才放最后。',
      null,
      '两段之间没有「挤掉」的关系,拼接顺序不影响各自的长度。真正的理由在成本,不在长度。',
      '可读性只是顺带的好处。如果只是为了好调试,顺序怎么排都行,这个设计就没有存在理由了。',
    ],
  },
  {
    id: 'q4',
    src: '§3',
    stage: 'backend',
    question: '从 OpenAI 侧拿回工具调用时,`arguments` 字段和 Anthropic 的 `input` 差在哪?',
    options: [
      '没有差别,两边都是已解析好的对象',
      '`arguments` 是 JSON 字符串(流式下还是分片拼的),用之前必须自己 `JSON.parse`,还要兜底解析失败',
      '`arguments` 是数组,`input` 是对象',
      '`arguments` 会被 SDK 自动解析好,业务代码不用管',
    ],
    answer: 1,
    explanation:
      '这是全章最容易踩的坑:转过去要 `JSON.stringify(input)`,转回来要 `JSON.parse(arguments)`,解析失败必须兜底成空对象 —— 否则一次坏参数就让整个循环崩掉。也正因为这类差异集中在边界处,内部才统一成 Anthropic 形状,把转换关进 `toOpenAIMessages` / `fromOpenAIResponse` 两个可单独测试的纯函数里。',
    optionNotes: [
      'Anthropic 的 `input` 确实已经是对象,但 OpenAI 的 `arguments` 是字符串 —— 这正是两边最容易出偏差的地方。',
      null,
      '两边都是「对象形状的参数」,区别在于是字符串还是已解析,不是数组和对象之别。',
      '流式响应下这个字符串是分片到达、要自己拼接的,SDK 不会把「拼好 + 解析 + 兜底」全做完。',
    ],
  },
  {
    id: 'q5',
    src: '§4',
    stage: 'tools',
    question: 'B Code 为什么故意不提供 `delete_file` 工具?',
    options: [
      '实现起来太复杂,不值得',
      '删除文件的需求很少,优先级低',
      '把不可逆操作全部收拢到唯一一条需要过权限的通道(run_shell)上',
      '为了节省工具清单占用的 token',
    ],
    answer: 2,
    explanation:
      '单独开一个 `delete_file` 就等于多开一扇需要单独设防的门。收拢到 `run_shell` 之后,`rm` 会被危险命令规则接管、按目标分级 —— 「不可逆」这件事只需要在一个地方管住。',
    optionNotes: [
      '删除文件的实现比 `edit_file` 简单得多,复杂度从来不是这里的问题。',
      '「需求少」不等于「可以不管」—— 恰恰因为它少,更该收进已有的那条受管控通道。',
      null,
      '工具清单省下的那几个 token 微不足道;这是安全边界的设计,不是成本优化。',
    ],
  },
  {
    id: 'q6',
    src: '§5',
    stage: 'permissions',
    question: '在 `--yolo`(bypass)模式下,`rm -rf /` 会被执行吗?',
    options: [
      '会,bypass 的意思就是全部放行',
      '不会,危险命令在任何模式(含 bypass)下都被拒绝',
      '取决于命令是否落在项目目录内',
      '取决于用户是否在配置里显式允许过',
    ],
    answer: 1,
    explanation:
      '这不是疏忽,是刻意的。问不问用户属于「效率」取舍,但有些操作一旦执行就无法挽回 —— 那就不该给任何模式开绿灯。判定链上它是①,优先级高于所有模式判断。',
    optionNotes: [
      'bypass 跳过的是「确认」,不是「危险检测」。这两件事在判定链上位于不同的优先级。',
      null,
      '目标是否在项目内会改变 `rm` 的分级(灾难目标 vs 日常清理),但 `rm -rf /` 是灾难目标,和目录无关。',
      '没有任何配置项能放行危险命令 —— 连 bypass 都绕不过,白名单自然也不行。',
    ],
  },
  {
    id: 'q7',
    src: '§4 / §8',
    stage: 'context',
    question: '「文件指针 + 会话级缓存」这套机制,解决的到底是什么连锁问题?',
    options: [
      '文件太大,一次性读不进来',
      '压缩把文件内容摘要掉 → 模型只好重读 → 重读又占空间 → 又触发压缩的死循环',
      '多个 Agent 同时修改同一个文件会冲突',
      '不同文件的编码不一致导致读出来是乱码',
    ],
    answer: 1,
    explanation:
      '文件内容不放在消息历史里(历史里只留一个指针),实际内容存在会话级缓存。压缩时生成「已读文件索引」。权威数据在磁盘和缓存里,不在历史里,所以压缩不会造成信息丢失。',
    optionNotes: [
      '单次读取过大是另一道防线(第一层截断)负责的,和指针机制不是同一层。',
      null,
      '并发写冲突要靠检查点和写操作串行化来解决,指针机制管的是「压缩后还找不找得到内容」。',
      '编码问题会在读取阶段就被处理掉,不会演化成跨轮次的循环问题。',
    ],
  },
  {
    id: 'q8',
    src: '§10',
    stage: 'subagent',
    question: '子 Agent 的「只读」限制为什么必须做在工具层面,而不是写在提示词里叮嘱它?',
    options: [
      '因为提示词的写法太复杂,容易写错',
      '因为提示词约束是可以被绕过的,而工具面里没有那个工具就是物理上做不到',
      '因为多写一段提示词会消耗更多 token',
      '因为工具层的实现更简单,不用调模型',
    ],
    answer: 1,
    explanation:
      '这是个重要的区分:提示词是「请求」,工具面是「能力边界」。同样地,禁止子 Agent 嵌套也必须靠工具面过滤 —— 不能用 `deferred` 来做,因为 `deferred` 对主循环同样生效,会误伤主 Agent。',
    optionNotes: [
      '提示词写法再讲究也改变不了它的性质 —— 它是建议,不是约束。',
      null,
      'token 成本是次要的。提示词就算不花一个 token,也依然是「可以被绕过的约束」。',
      '工具面过滤实现起来并不更简单,之所以选它,是因为只有它真的挡得住。',
    ],
  },
  {
    id: 'q9',
    src: '§12',
    stage: 'goal',
    question: '`--goal` 模式下,判断「目标达成了没」为什么要另起一次模型调用?',
    options: [
      '因为同一个模型无法理解目标条件',
      '因为让执行者给自己打分,它倾向于说「我干完了」;检查必须是独立判断',
      '因为独立调用更快,可以并行执行',
      '因为主循环里已经没有上下文空间了',
    ],
    answer: 1,
    explanation:
      '「干活的」和「检查的」应该是两个独立判断。此外还必须有 `impossible` 刹车:条件永远达不成时返回 `impossible` 让主循环停下,否则无人值守模式会一直烧钱。',
    optionNotes: [
      '同一个模型完全能理解目标条件 —— 问题不在于「懂不懂」,而在于「愿不愿意说自己没做完」。',
      null,
      '它并不更快:这是额外的一次调用,是纯粹的成本。之所以还这么做,是因为独立性的价值大于这次成本。',
      '评估用的是独立的一次调用、独立的消息,和主循环的上下文余量无关。',
    ],
  },
  {
    id: 'q10',
    src: '§14',
    stage: 'memory',
    question: '记忆召回选了「关键词重叠打分」而不是向量检索,最站得住脚的理由是哪个?',
    options: [
      '向量检索的召回效果一定更差',
      '快(不用调 embedding API)、省(不花钱)、可预测(同样输入永远同样结果,出问题好复现)',
      '向量数据库的授权费用太高',
      '项目规模太小,还用不上向量检索',
    ],
    answer: 1,
    explanation:
      '代价是语义近似的召回会弱一些:你问「怎么部署」,记忆里写的是「发布流程」,就可能一个词都不重叠、得分全 0。代码里留了 `Memory` 接口抽象,将来换向量库是新增一个实现类的事 —— 这是「先做对,再做好」。',
    optionNotes: [
      '恰恰相反,向量检索在语义近似的召回上更强。选关键词是权衡,不是因为它更准。',
      null,
      '费用不是主因 —— 即使 embedding 免费,多一次网络往返也依然违背「召回发生在每次 chat 入口」这个位置的要求。',
      '规模和这三条理由无关。即使记忆只有几条,「可预测、好调试」依然是真实收益。',
    ],
  },
];
