# 自定义 Agent 架构设计与分步实施计划

> **配套文档：** `CLAUDE-CODE-FROM-SCRATCH-COMPLETE.md`（原理与代码）→ 本文档（架构设计与施工图）
>
> **一句话目标：** 基于源码文档的 14 章原理，设计一个**以"能力可插拔"为核心**的 Agent 架构，并给出**一步一步可执行、每步可独立运行**的任务计划，方便你边学边做、让 AI 协助编码。
>
> **适用读者：** 想从零动手实现一个 Coding Agent，且关心"未来怎么加新能力"的人。

---

## 目录

- [Part 1 · 源码文档核心提炼](#part-1--源码文档核心提炼)
- [Part 2 · 可扩展架构设计](#part-2--可扩展架构设计)
- [Part 3 · 分步任务计划](#part-3--分步任务计划)
- [Part 4 · AI 协助编码工作流](#part-4--ai-协助编码工作流)
- [附录 A · 目标文件结构](#附录-a--目标文件结构)
- [附录 B · 学习路线对照表](#附录-b--学习路线对照表)

---

## Part 1 · 源码文档核心提炼

### 1.1 文档讲了什么（一张表）

源码文档 `CLAUDE-CODE-FROM-SCRATCH-COMPLETE.md` 共 14 章，从"一个 while 循环"一路造到"能自治续跑的完整 Agent"。每一章 = 一块可独立验收的能力：


| 章节 | 能力块        | 一句话本质                                                 | 对应源文件              |
| ------ | --------------- | ------------------------------------------------------------ | ------------------------- |
| 1    | Agent 循环    | 调模型 → 执行工具 → 结果喂回，直到模型说"做完"           | `agent.ts`              |
| 2    | 工具系统      | 工具 = 名字 + 说明 + schema + 执行函数，switch 分发        | `tools.ts`              |
| 3    | System Prompt | 静态核心（可缓存）+ 动态上下文（环境/记忆/技能）           | `prompt.ts`             |
| 4    | CLI 与会话    | REPL 循环 + one-shot +`--resume`，消息数组即状态           | `cli.ts` / `session.ts` |
| 5    | 流式与双后端  | `stream()` 逐字输出；OpenAI 兼容后端复用同一循环           | `agent.ts`              |
| 6    | 权限与安全    | 7 层检查，deny 优先、fail-closed，plan 只读强约束          | `permissions.ts`        |
| 7    | 上下文管理    | 5 档压缩流水线（截断→预算→裁剪→微压缩→摘要）+ 前缀缓存 | `context.ts`            |
| 8    | 记忆系统      | 文件 + frontmatter + 关键词召回，跨会话持久                | `memory.ts`             |
| 9    | 技能系统      | `/name 参数` → 替换为文件中的 prompt，可带 $ARGUMENTS     | `skills.ts`             |
| 10   | Plan Mode     | 只读模式 + 特制 prompt + plan 文件 + 审批四选              | `agent.ts`              |
| 11   | 多 Agent      | 主 Agent fork 只读子 Agent，返回文本结果                   | `subagent.ts`           |
| 12   | MCP 集成      | spawn 子进程 + JSON-RPC + 前缀注册，外部工具即插即用       | `mcp.ts`                |
| 13   | 自治与续跑    | `/goal` 评估器回灌 + `/loop` 定时 + Auto Mode 分类器放行   | `autonomy.ts`           |
| 14   | 完整架构      | 8 步循环 × 6 类子系统的整体图 + 从零构建路线              | —                      |

### 1.2 三条贯穿全文的核心思想

这是理解整套架构的钥匙，也是设计"可扩展架构"的立足点：

1. **Agent 的本质是一个 while 循环。** 循环里没有"如果是读文件请求就……"的分支——**决定转不转的是模型，不是代码**。代码负责的是"安全地做"。
2. **提示词是最便宜的代码。** System Prompt 里的一句话，效果等同几个 if 语句，实现成本为 0。能靠提示词解决的就别写代码。
3. **工具设计决定能力上限。** 让模型做"理解意图、生成代码"，让工具做"精确匹配、文件操作、进程管理"。

### 1.3 从"学习文档"到"可扩展架构"的跃迁

源码文档按**功能顺序**（先循环，再工具、权限、记忆……）组织，适合逐章学习。但它的可扩展性是隐含的——文档没有把"新增一个能力"的路径显式抽象出来。本文档 Part 2 要做的，就是把隐含的扩展点显式化：

> **源码文档：** 造出 13 块能力，拼成一个 Agent。
>
> **本文档：** 设计一个"**内核稳定、能力可插拔**"的容器，让未来每块新能力（工具、后端、记忆源、权限策略、编排模式……）都通过**同一套扩展接口**挂进来，而不修改内核。

---

## Part 2 · 可扩展架构设计

### 2.1 设计目标与五条原则

**设计目标：** 内核（Agent 循环）一旦稳定就几乎永不改动；任何新能力通过"插入点"接入；接入成本 = 实现一个接口 + 注册一行。


| # | 原则                        | 含义                                                                | 违背时的代价                           |
| --- | ----------------------------- | --------------------------------------------------------------------- | ---------------------------------------- |
| 1 | **内核不可变**              | 主循环（调模型→执行工具→喂回）是骨架，禁止为单个能力往循环里塞 if | 每次加能力都要回归整个循环，扩展点失控 |
| 2 | **能力即插件**              | 一切能力表达为"接口实现 + 注册"，收敛到统一注册表                   | 能力互相耦合，无法单独替换/禁用        |
| 3 | **策略可替换**              | 权限/上下文/记忆/后端这类"同一职责多实现"的，用策略接口隔离         | 换实现要改核心代码                     |
| 4 | **渐进增强**                | 从最小可用循环起步，每阶段独立可跑；不追求一次到位                  | 无法分步验证，Debug 地狱               |
| 5 | **失败封闭（fail-closed）** | 未声明的工具类型默认"需确认"，新能力默认最安全                      | 新能力默认危险，事故                   |
| 6 | **配置驱动发现**            | 能通过目录/JSON 发现的能力（技能、MCP、规则）不写死                 | 加能力要发版                           |

### 2.2 总体分层架构

```
┌──────────────────────────────────────────────────────────────────────┐
│  L1 交互层（表示）                                                     │
│   cli.ts REPL / one-shot / --resume     ui.ts 终端渲染 / 确认框 / 流式│
└───────────────────────────┬──────────────────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  L2 编排层（内核 — 稳定不变）                                          │
│   agent.ts 主循环：                                                   │
│   ①上下文压缩 → ②SystemPrompt构建 → ③调模型 → ④流式输出             │
│   → ⑤解析tool_use → ⑥权限检查 → ⑦执行工具/路由 → ⑧结果喂回         │
│   mode 状态机：default / plan(只读) / bypass(--yolo) / auto           │
└──────┬───────────────┬───────────────┬───────────────┬──────────────┘
       ▼               ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ L3 能力层（可插拔）                                             │
│  工具   │  技能   │  子Agent │  MCP   │ 自治   │ Plan   │
│  tools  │  skills │ subagent │  mcp   │ auto   │  mode  │
│  内置    │  /name  │  fork-   │ 外部工具│  goal/  │  只读  │
│  工具    │  发现   │  return  │  挂载   │  loop   │  规划  │
└──────────────┴──────────────┴──────────────┴──────────────┘
       │               │               │               │
       ▼               ▼               ▼               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  L4 基础设施层（可替换）                                               │
│  backend.ts  模型后端（Anthropic / OpenAI兼容 / 未来任意 Provider）    │
│  context.ts  上下文策略（截断 / 摘要 / RAG / 分层上下文）              │
│  memory.ts   记忆后端（文件 / 向量库 / 数据库）                        │
│  permissions 权限策略（规则表 / 会话白名单 / AI 分类器）               │
└──────────────────────────────────────────────────────────────────────┘
```

**层级职责与依赖规则：**

- **依赖只许向下**：L2 可以调用 L3/L4，L3 可以调用 L4，反向禁止。
- **L1/L3/L4 都可以替换**，L2 尽可能稳定。
- 横向之间（工具↔MCP、记忆↔上下文）通过**统一接口**间接协作，不直接引用。

### 2.3 稳定内核：Agent 循环的 8 步

主循环是整座架构的"脊椎"。把它写稳，后面所有能力都是往这 8 步的"插槽"里挂东西。

```
while (true) {
  ① maybeCompact(this.messages)          ← 插槽：上下文策略
  ② systemPrompt = buildSystemPrompt()   ← 插槽：技能/记忆/Agent描述注入
  ③ reply = model.stream({...})          ← 插槽：模型后端
  ④ 流式渲染到终端
  ⑤ toolUses = extract(reply)            ── 无 tool_use → break（任务完成）
  ⑥ for each tool: checkPermission()     ← 插槽：权限策略
  ⑦ output = routeAndExecute(tool)       ← 插槽：工具/子Agent/MCP 统一路由
  ⑧ messages.push(tool_results)          ── 回到 ①
}
```

**为什么"内核不可变"成立：** 第 ⑦ 步的 `routeAndExecute` 是一个**统一分发点**——它不关心"这是个内置工具、MCP 工具、技能，还是子 Agent"，只认"工具名 → 处理器"的注册表。新增任何能力 = 往注册表加一条映射，**循环一行都不用改**。这正是 MCP 章节那句"对 Agent Loop 来说，MCP 工具和内置工具没有区别"的推广。

### 2.4 能力扩展机制（核心章节）

#### 2.4.1 一切能力 = "工具三要素"的超集

源码文档最深刻的抽象是工具三要素：**name + description + input_schema + handler**。可扩展架构把它推广为统一能力模型：


| 能力载体       | 本质                 | 对内核呈现为                 |
| ---------------- | ---------------------- | ------------------------------ |
| 内置工具       | 代码注册的工具       | 一个工具                     |
| MCP 工具       | 外部服务器注册的工具 | 一个带前缀的工具             |
| 技能（Skill）  | 提示词级工具         | 一个"把提示词喂回循环"的工具 |
| 子 Agent       | 超大参数的工具       | 一个"运行子循环"的工具       |
| Plan Mode 工具 | 模式切换             | 两个 deferred 工具           |

> **推论：** 只要能把一个能力表达成"名称 + 描述 + 参数 schema + 处理器"，它就能挂进内核，无需改循环。

#### 2.4.2 三类扩展点（面向未来的扩展清单）

**A. 工具类扩展 —— 给模型更多"手"**

- 内置：`tools.ts` 里注册 → `routeAndExecute` 分派
- 外部：MCP 服务器 JSON 配置 → 前缀注册
- 提示词：技能文件 → `/name` 调用
- 未来：**远程工具网关**（HTTP 调用远端工具，MCP 的"非本机"版本）、**网页/浏览器工具**、**数据库工具**、**代码搜索工具（如 CodeGraph）**

**B. 策略类扩展 —— 改变 Agent 的决策与资源管理**

- 模型后端：`backend` 策略接口 → Anthropic / OpenAI 兼容 / 任意 OpenAI 兼容 / 多 Provider 路由
- 权限策略：`permission` 策略接口 → 规则表 / 会话白名单 / AI 分类器 / 企业审计策略
- 上下文策略：`context` 策略接口 → 截断 / LLM 摘要 / RAG / 分层上下文（压缩 + 外挂）
- 记忆后端：`memory` 策略接口 → 文件 / SQLite / 向量库 / 数据库

**C. 编排类扩展 —— 改变 Agent 如何组织执行**

- 子 Agent 类型：`explore / plan / general` → 未来更多角色（tester / reviewer / researcher）
- 自治模式：goal / loop / auto → 未来定时任务、批量批处理、多 Agent 编排
- 会话模式：default / plan / bypass / auto → 未来审计模式、无头模式

#### 2.4.3 统一注册表设计

```typescript
// registry.ts —— 所有可挂载能力收敛到这里
interface MountPoint {
  name: string;          // 唯一名，如 "read_file" / "mcp__fs__read" / "skill:commit"
  description: string;
  inputSchema: JSONSchema;
  handler(input: any, ctx: RuntimeContext): Promise<string> | string;
  // 元数据（可选，用于分组/权限/路由）
  kind?: 'builtin' | 'mcp' | 'skill' | 'subagent';
  mode?: 'read' | 'write' | 'shell' | 'external';   // 供权限层判断
  deferred?: boolean;                                 // 是否默认加载（省 token）
}

class Registry {
  private mountPoints = new Map<string, MountPoint>();

  // 唯一入口：所有能力（内置/技能/MCP/子Agent）都调用它注册
  register(mp: MountPoint): void;

  // 内核唯一查询点：模型/路由/权限全部走这里
  resolve(name: string): MountPoint | undefined;
  list(filter?: (mp: MountPoint) => boolean): MountPoint[];  // 供 System Prompt 注入 + deferred 过滤
}
```

内核（L2）对注册表**只读**。三种加载器各自往注册表写：


| 加载器           | 发现方式                                  | 注册内容                            |
| ------------------ | ------------------------------------------- | ------------------------------------- |
| `builtin-loader` | 代码直接调用`register()`                  | 6 个核心工具 + web_fetch + 模式工具 |
| `skill-loader`   | 扫描`~/.claude/skills` + `.claude/skills` | 技能 → 注册为"提示词注入"型挂载点  |
| `mcp-loader`     | 读`mcp.json` → spawn → `tools/list`     | 每个外部工具 → 前缀挂载点          |

#### 2.4.4 为什么这样设计能"适配未来各种核心能力扩展"

一个能力要进入 Agent，未来只有一条固定路径：**实现接口 → 注册 → 内核自动可见**。四种未来场景验证：


| 未来需求     | 做法（都不改内核）                                    |
| -------------- | ------------------------------------------------------- |
| 接入新模型商 | 写一个`backend` 策略实现，env 切换                    |
| 挂远程工具   | 写一个`remote-loader`（HTTP 版 mcp-loader），注册回来 |
| 换记忆存储   | 写一个`memory` 策略实现（向量库），注册               |
| 加"审计模式" | 加一种`mode` + 一个权限策略实现                       |

**扩展成本对比：** 无架构（文档原样堆叠）加一个能力 = 改循环 + 改工具分发 + 改权限判断 + 回归；有架构加一个能力 = 一个文件 + 一行注册。

### 2.5 各能力模块设计要点


| 模块                          | 职责                         | 关键接口/设计                                                           | 扩展方式                                         | 未来演进                   |
| ------------------------------- | ------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------- |
| **工具系统** `tools.ts`       | 核心工具实现 + 分发          | 工具三要素；`edit_file` 唯一性校验；`CONCURRENCY_SAFE_TOOLS` 并行白名单 | 注册表                                           | 更多文件/搜索/调试工具     |
| **System Prompt** `prompt.ts` | 静态核心（缓存）+ 动态上下文 | 两段式；动态块放末尾利用近因效应；`cache_control`                       | 动态块是"插槽"：记忆/技能/子Agent 描述都是注入物 | 项目文档注入、能力清单注入 |
| **CLI** `cli.ts`              | REPL / one-shot / 参数       | 消息数组即状态，`/` 开头先解析技能                                      | 新命令就是新解析分支                             | 子命令、交互式确认 UI      |
| **模型后端** `backend.ts`     | 统一模型调用                 | 流式 + 非流式统一返回`Message`；OpenAI 兼容转换器                       | `backend` 策略                                   | 多 Provider 路由、自动降级 |
| **权限** `permissions.ts`     | 7 层检查、fail-closed        | deny 优先 → plan 只读 → bypass → allow → 危险检测 → 白名单 → 确认 | `permission` 策略                                | AI 分类器、企业审计        |
| **上下文** `context.ts`       | 5 档压缩 + 前缀缓存          | 截断→预算→裁剪→微压缩→LLM 摘要；`cache_control`                     | `context` 策略                                   | RAG、外挂知识库            |
| **记忆** `memory.ts`          | 跨会话持久 + 召回            | frontmatter + 关键词重叠召回；不额外调模型                              | `memory` 策略                                    | 向量召回、自动沉淀         |
| **技能** `skills.ts`          | 提示词复用                   | `/name 参数` + `$ARGUMENTS`；项目级覆盖用户级                           | 目录发现（零代码）                               | 技能市场、动态技能         |
| **子 Agent** `subagent.ts`    | 任务分解                     | 独立消息数组 + 只读工具集 + 返回纯文本；进程内同步                      | 注册新角色类型                                   | 并行子 Agent、协作工作流   |
| **MCP** `mcp.ts`              | 外部工具挂载                 | spawn + JSON-RPC + 前缀防冲突 + 懒连接                                  | 配置发现（零代码）                               | 远程/HTTP MCP、工具市场    |
| **自治** `autonomy.ts`        | 无人值守                     | goal 评估器三态回灌 / loop 定时 / auto 分类器                           | 新增自治模式                                     | 定时任务、批处理           |

### 2.6 架构落地的三条实现建议

1. **先按文档原样做，后重构。** Phase 0–6 完全按源码文档的写法做（不提前抽象），Phase 7 再统一收敛到注册表。过早抽象 = 学不到"先能用再变好"的路径。
2. **接口先行，实现后置。** 在 `types.ts` 里先把 `Tool` / `Skill` / `Backend` / `Permission` / `Context` / `Memory` 六个接口定义出来，各模块按接口实现。接口就是"契约"，让 AI 协作时可以并行。
3. **每阶段留验收命令。** 每阶段结束时有一个能运行的命令（如 `npm run demo`），保证"可独立运行"。

---

## Part 3 · 分步任务计划

### 3.1 阶段总览（依赖关系）

```
Phase 0 脚手架 ──► Phase 1 最小循环(MVP) ──► Phase 2 交互外壳 ──► Phase 3 安全与上下文
                                                    │                      │
                                                    ▼                      ▼
                                               Phase 4 记忆与技能 ──► Phase 5 能力扩展机制
                                                                            │
                                                    ┌───────────────────────┘
                                                    ▼
                                               Phase 6 自治与高级 ──► Phase 7 架构固化
```


| 阶段 | 名称                   | 时长（参考） | 产出（可运行）              | 里程碑                     |
| ------ | ------------------------ | -------------- | ----------------------------- | ---------------------------- |
| P0   | 脚手架与运行环境       | 0.5 天       | 空项目能`npm run dev`       | 骨架可用                   |
| P1   | 最小 Agent 循环（MVP） | 1–2 天      | 6 工具 + 循环               | `"read a file"` 能跑通     |
| P2   | 交互外壳与模型接入     | 1–2 天      | CLI/REPL/持久化/流式/双后端 | 可交互、可`--resume`       |
| P3   | 安全与上下文           | 1–2 天      | 权限 + plan + 压缩 + 缓存   | 危险命令被拦、长对话不爆窗 |
| P4   | 记忆与技能             | 1–2 天      | 记忆 + 技能 + CLAUDE.md     | 跨会话记忆、`/commit` 可用 |
| P5   | 能力扩展机制           | 2–3 天      | 子 Agent + MCP + 注册表     | 接外部工具不改源码         |
| P6   | 自治与高级             | 1–2 天      | goal / loop / auto          | 无人值守续跑               |
| P7   | 架构固化（可扩展）     | 1–2 天      | 插件化重构 + 六接口         | 新能力一行注册接入         |

> 全程约 8–14 天（业余节奏），每阶段独立可跑、可验收、可中断。

---

### 3.2 各阶段详细任务

每个阶段统一用同一模板，方便你对照执行，也方便把每个任务直接交给 AI。

---

#### Phase 0 · 脚手架与运行环境

**目标：** 一个能跑的空 TypeScript 项目，为后续所有阶段提供基础。
**前置：** Node 18+，一个 `ANTHROPIC_API_KEY`（或兼容后端）。

- [ ]  初始化 `package.json` + `tsconfig.json`（NodeNext、strict）
- [ ]  安装依赖：`@anthropic-ai/sdk`、`typescript`、`tsx`（开发时直接跑 TS）
- [ ]  建目录：`src/`、`src/tools/`、`src/services/`、`test/`
- [ ]  `src/index.ts` 打印 `hello`，`npm run dev` 跑通
- [ ]  加入 `.env` + `dotenv` 加载

**验收命令：** `npm run dev` → 输出 `b-code skeleton ready`
**学习要点：** strict TS 配置（`noUncheckedIndexedAccess` 等）、NodeNext ESM 与 CJS 差异。
**AI 协助 prompt 模板：**

```
用 TypeScript（NodeNext + strict）初始化一个 CLI 项目脚手架：
- package.json、tsconfig.json、.env 支持、tsx 开发运行
- 目录 src/、src/tools/、src/services/、test/
- npm run dev 打印 "b-code skeleton ready"
不安装任何多余依赖，只装 @anthropic-ai/sdk、dotenv、tsx、typescript。
```

---

#### Phase 1 · 最小 Agent 循环（MVP）

**目标：** 复现源码文档第 1–2 章：一个 while 循环 + 6 个核心工具，能让模型"读文件、搜代码、跑命令"。
**前置：** P0。
**学习材料：** 源码文档 §1.2、§2.1–2.3。

- [ ]  定义 `Tool` 类型（name/description/inputSchema/handler）
- [ ]  实现 6 个核心工具：`read_file` / `write_file` / `edit_file` / `list_files` / `grep_search` / `run_shell`
- [ ]  `edit_file` 实现**唯一性校验**（重复 old_string 报错）——源码文档强调的坑
- [ ]  实现 `Agent` 类：`messages` 数组 + `while(true)` 循环 + tool_use 提取 + 结果喂回
- [ ]  `executeTool` switch 分发（先不做注册表）
- [ ]  最小 `system` prompt（"You are b-code Code…"）
- [ ]  手动测试：`"Read src/index.ts"`、`"grep 'TODO' in src"`

**验收命令：**

```
npx tsx src/index.ts "Read src/index.ts and summarize"
# → 模型调用 read_file → 输出文件内容摘要 → 无更多 tool_use → 退出
```

**学习要点：** tool_use / tool_result 的消息协议（tool_result 必须关联 tool_use_id）；模型决定循环转不转。
**AI 协助 prompt 模板：**

```
实现一个最小 Agent 循环（TypeScript，NodeNext）：
- Agent 类：this.messages 保存对话，while(true) 循环调 Anthropic messages.create，
  提取 content 中的 tool_use 块，逐个执行，结果以 {type:'tool_result', tool_use_id, content}
  作为 user 消息喂回；无 tool_use 时 break。
- 6 个工具：read_file / write_file / edit_file / list_files / grep_search / run_shell，
  工具定义是 {name, description, input_schema} 数组。
- edit_file 必须：old_string 不存在→报错；出现次数>1→报错，用 split/join 替换（不用 String.replace）。
- 命令行入口：node 传入的参数作为用户指令。
请给出完整可运行的 src/ 代码，不要省略工具实现。
```

---

#### Phase 2 · 交互外壳与模型接入

**目标：** 复现源码文档 §3–5：REPL、会话持久化、流式输出、双后端。
**前置：** P1。

- [ ]  两段式 System Prompt：静态核心（标 `cache_control`）+ 动态上下文（环境/Git 状态）
- [ ]  `CLAUDE.md` 向上查找加载（含 `@include` 指令、5 层嵌套限制）
- [ ]  REPL 循环（`readline`）+ one-shot 模式 + `/clear` / `exit`
- [ ]  会话持久化：`~/.b-code/session.json`，每轮自动保存，`--resume` 恢复
- [ ]  流式输出：`client.messages.stream()`，`stream.on('text')` 逐字打印
- [ ]  双后端：`OPENAI_API_KEY + OPENAI_BASE_URL` 存在则走 OpenAI 兼容路径（SSE 解析 + 格式转换），否则 Anthropic
- [ ]  手动测试：`--resume` 恢复上下文；切到 OpenAI 兼容后端跑通一次

**验收命令：**

```
npm run dev -- --resume          # 显示 (resumed N messages)
npm run dev "explain this repo"  # 流式逐字输出
OPENAI_BASE_URL=... OPENAI_API_KEY=... npm run dev "hello"   # 双后端切换
```

**学习要点：** 缓存命中如何省钱（静态核心 0.1× 计费）；消息数组即状态的持久化哲学。
**AI 协助 prompt 模板：**

```
给现有 Agent 加交互外壳（TypeScript）：
1. 两段式 system prompt：静态核心（加 cache_control: {type:'ephemeral'}）
   + 动态上下文（platform/cwd/shell、git branch 和 dirty 状态），动态块放末尾。
2. CLAUDE.md：从 cwd 向上逐级查找合并，支持 "@path" 引用（~ / 绝对 / 相对，最多 5 层）。
3. readline REPL：支持 /clear /exit，输入以 / 开头先尝试解析技能（先留 resolveSkill 空实现）。
4. 会话持久化：消息数组 JSON 存 ~/.b-code/session.json，chat 后自动保存，--resume 恢复。
5. 流式：改用 client.messages.stream()，on('text') 打印，finalMessage() 返回完整消息。
6. 双后端：若同时有 OPENAI_API_KEY 和 OPENAI_BASE_URL 走 OpenAI 兼容（fetch /chat/completions，
   SSE 逐块解析），否则 Anthropic。
保持现有循环结构不变，分文件组织：prompt.ts / cli.ts / session.ts。
```

---

#### Phase 3 · 安全与上下文

**目标：** 复现源码文档 §6–7：权限 7 层检查、plan 只读、上下文压缩、前缀缓存。
**前置：** P2。

- [ ]  权限检查器：返回 `allow / deny / confirm` 三态，**deny 优先、fail-closed**
- [ ]  危险命令正则表（`rm -rf` / `git push` / `sudo` 等）
- [ ]  在循环第 ⑥ 步接入权限检查（deny 直接拒、confirm 弹框、bypass 跳过）
- [ ]  会话级白名单：确认过一次的 `shell:<command>` 不再问
- [ ]  Plan Mode 最小版：`--plan` 启动 → 写/编辑/shell 全部拦截 → 只读工具放行
- [ ]  上下文压缩 Tier 0–1：执行时结果截断（50K 字符）+ 预算截断
- [ ]  前缀缓存：最后一条消息打 `cache_control` 断点
- [ ]  `maybeCompact`：消息超 15 条 → LLM 摘要替换旧消息，保留最近 5 条
- [ ]  测试：`rm -rf` 被拦；`--plan` 下写文件被拒；长对话触发压缩

**验收命令：**

```
npm run dev -- --yolo "rm -rf /tmp/x"     # 即使 yolo，rm -rf 也被 deny
npm run dev -- --plan "write a file"      # plan 模式写文件被拒
npm run dev -- "repeat 20 times"          # 观察 (compacted N messages)
```

**学习要点：** fail-closed 设计（新工具默认 confirm）；权限是循环的一步而非外挂；压缩的分级是"从最轻到最重"。
**AI 协助 prompt 模板：**

```
给 Agent 加安全与上下文管理（TypeScript）：
1. permissions.ts：checkPermission(name, input, mode) → 'allow'|'deny'|'confirm'。
   - 危险命令正则（rm -rf、git push、git reset --hard、sudo、mkfs、dd、kill 等）命中→deny
   - mode==='plan' 且工具是 write_file/edit_file/run_shell → deny
   - 只读工具（read_file/list_files/grep_search/web_fetch）→ allow
   - 其余 → confirm
2. 在循环中：deny→返回拒绝信息；confirm 且非 bypass→问 y/n；会话级白名单
   （shell 用命令内容做 key）记住已确认操作。
3. context.ts：maybeCompact(messages, client, model)，超 15 条把旧的（除最近 5 条）
   渲染为文本让模型摘要，返回 [summary, ...recent]。保留 tool_use/tool_result 配对不被拆散。
4. truncateResult：工具输出超 50000 字符截断，保留头尾各半。
5. system prompt 静态部分加 cache_control，messages 最后一条也打断点。
给完整代码。
```

---

#### Phase 4 · 记忆与技能

**目标：** 复现源码文档 §8–9：跨会话记忆、`/name` 技能调用、CLAUDE.md 增强。
**前置：** P3。

- [ ]  frontmatter 解析器（`parseFrontmatter`，记忆/技能共用）
- [ ]  记忆存储：`~/.b-code/projects/{hash}/memory/`，YAML frontmatter + 正文
- [ ]  语义召回：关键词重叠打分，top 3 注入 System Prompt 末尾（纯确定性、不调模型）
- [ ]  技能发现：`~/.claude/skills`（用户级）+ `.claude/skills`（项目级覆盖）
- [ ]  `resolveSkill`：`/name 参数` → frontmatter + 正文 + `$ARGUMENTS` 替换
- [ ]  技能描述注入 System Prompt（只注入 `user-invocable`）
- [ ]  写一个 `commit` 技能测试端到端
- [ ]  测试：重启进程后 `/commit` 技能仍可用；记忆跨会话召回

**验收命令：**

```
npm run dev                     # 启动
> save this fact: staging url is https://staging.example.com
# 重启进程
npm run dev -- --resume
> what is the staging url?      # 从记忆召回命中
> /commit                       # 技能提示词生效
```

**学习要点：** 记忆用"关键词重叠"而非向量——快、便宜、可预测；技能是"提示词级工具"。
**AI 协助 prompt 模板：**

```
给 Agent 加记忆与技能系统（TypeScript）：
1. frontmatter.ts：parseFrontmatter(content) → {meta, body}，解析 ---key: value--- 块。
2. memory.ts：saveMemory(name, description, type, content) 存为 md 文件；
   recallMemories(query) 用关键词重叠打分，取 top3 拼成 "# Memory" 段落返回。
   记忆目录 ~/.b-code/projects/{sha256(cwd)前16位}/memory/。
3. skills.ts：SKILL_DIRS=[~/.claude/skills, ./.claude/skills]，
   resolveSkill(input)："/name args" → 找 name.md，替换 $ARGUMENTS 为 args，返回正文。
   buildSkillDescriptions()：列出 user-invocable 技能注入 system prompt。
4. 在 REPL 中输入以 / 开头时先 resolveSkill。
5. 写一个 skills/commit.md 示例技能（frontmatter: name/description/user-invocable:true）。
给完整代码。
```

---

#### Phase 5 · 能力扩展机制（可扩展核心）

**目标：** 复现源码文档 §10–12 并落地 Part 2 的注册表抽象：Plan Mode 完整化、子 Agent、MCP、统一注册。
**前置：** P4。

- [ ]  **统一注册表 `registry.ts`**（接口先行）：`register / resolve / list`，见 §2.4.3
- [ ]  迁移内置工具到注册表（`builtin-loader`），循环改走 `registry.resolve`
- [ ]  **Plan Mode 完整版**：`enter/exit_plan_mode`（deferred）+ 只读约束 + plan 文件输出 + 审批四选
- [ ]  **子 Agent `subagent.ts`**：`runSubAgent(task, client, model)`，独立消息数组 + 只读工具集 + 返回纯文本
- [ ]  `agent` 工具：模型调 `agent({task})` → fork 子 Agent → 结果回灌
- [ ]  **MCP `mcp.ts`**：`connectMcp(command, args)`（spawn + JSON-RPC 握手 + `tools/list`）
- [ ]  `mcp-loader`：读 `mcp.json` → 前缀注册（`mcp__server__tool`）→ `routeAndExecute` 按前缀路由
- [ ]  测试：接一个真实 MCP 服务器（如 filesystem）不改源码即可调用

**验收命令：**

```
npm run dev -- --plan "plan a refactor"      # 只读规划 → 写 plan 文件 → 审批
# mcp.json 加 filesystem server 后：
npm run dev "list files via mcp"             # 不写代码就多了一个工具
```

**学习要点：** 这是"可扩展架构"落地的关键阶段——体验"改配置不改代码"的扩展方式；子 Agent 是"超大参数的工具"。
**AI 协助 prompt 模板（分三个任务）：**

```
任务A：实现统一工具注册表 registry.ts。
  - MountPoint 接口：{name, description, inputSchema, handler, kind?, mode?, deferred?}
  - Registry 类：register/resolve/list。内核循环只通过 registry.resolve(name) 拿到
    定义和 handler 再执行，禁止在循环里 switch 工具名。
任务B：实现子 Agent subagent.ts。
  - runSubAgent(task, client, model)：独立 messages 数组，只给只读工具
    （read_file/list_files/grep_search），无 tool_use 时返回文本。
  - 注册一个 "agent" 工具：handler 调 runSubAgent，把结果返回。
任务C：实现 MCP 客户端 mcp.ts + 前缀路由。
  - connectMcp：spawn(command,args,{stdio})，readline 逐行，JSON-RPC 请求按 id 分发；
    initialize 握手 → notifications/initialized → tools/list。
  - 注册 mcp__<server>__<tool>，executeTool 中 name.startsWith('mcp__') 时
    拆出 server/tool 名转发，结果转文本。
```

---

#### Phase 6 · 自治与高级

**目标：** 复现源码文档 §13：`/goal` 评估器回灌、`/loop` 定时、Auto Mode 分类器。
**前置：** P5。

- [ ]  `evaluateGoal(condition, transcript)`：独立模型调用，三态输出（MET / NOT_MET<原因> / NOT_MET impossible）
- [ ]  `pursueGoal`：最多 5 轮"执行→评估→原因回灌→再执行"
- [ ]  `/loop`：定时重新投递（先做固定间隔，再做自定节奏）
- [ ]  `classifyAction`：脱敏对话记录 → ALLOW / BLOCK<原因>
- [ ]  Auto Mode：`mode === 'auto'` 且写/编辑/shell 时先过分类器，BLOCK 则不执行
- [ ]  `--auto` / `--goal <条件>` / `--loop` CLI 参数接入
- [ ]  测试：`--goal "done.txt exists"` 无人值守创建文件后达成

**验收命令：**

```
npm run dev -- --goal "file test.txt exists" "create test.txt if missing"
# → 评估器未达成 → 原因回灌 → 模型创建 → 再评估 → MET 退出
```

**学习要点：** 评估器"只判断不干活"（不给工具）；分类器看的是脱敏记录；这是"模型做决策，代码做护栏"的极致。
**AI 协助 prompt 模板：**

```
给 Agent 加自治能力（TypeScript）：
1. evaluateGoal(condition, transcript, client, model)：独立模型调用（不给工具），
   系统提示要求回复 'MET' 或 'NOT_MET: <reason>'，解析为 {met, reason}。
2. pursueGoal(condition, prompt)：执行初始 prompt 后循环最多 5 次：
   评估→未达成则把原因拼接成新用户消息（"goal not met: <reason>, keep working"）再 chat。
3. classifyAction(name, input, transcript, client, model)：回复 'ALLOW' 或 'BLOCK: <reason>'。
4. auto 模式下，写/编辑/shell 工具先过 classifyAction，BLOCK 则返回拒绝信息不执行。
5. CLI 加 --auto / --goal <cond> / --loop 参数。
```

---

#### Phase 7 · 架构固化（可扩展重构）

**目标：** 把前 6 阶段收敛为 Part 2 的完整架构：六接口 + 策略模式 + 配置驱动。**这是"适配未来能力扩展"的收尾。**
**前置：** P6。
**学习材料：** 本文档 Part 2 全部。

- [ ]  定义六大策略接口：`Tool` / `Skill` / `Backend` / `Permission` / `Context` / `Memory`
- [ ]  `backend.ts` 抽出 `Backend` 策略：Anthropic 实现 + OpenAI 兼容实现，env 切换
- [ ]  `permissions.ts` 抽出 `Permission` 策略：规则表实现 / 白名单实现 / 分类器实现
- [ ]  `context.ts` 抽出 `Context` 策略：截断实现 / 摘要实现
- [ ]  `memory.ts` 抽出 `Memory` 策略：文件实现（未来可换向量库）
- [ ]  技能/MCP 加载器统一走 `registry.register`
- [ ]  `types.ts` 集中导出全部接口，供所有模块引用（依赖只许向下）
- [ ]  写一份 `EXTENDING.md`：说明"加一个新能力/新后端/新记忆源"的 3 步模板
- [ ]  回归测试：Phase 1–6 的所有验收命令重跑一遍，全部通过

**验收命令：** 重跑 P1–P6 全部验收命令；`npm run typecheck && npm run test` 通过。
**学习要点：** 这是"先能用再变好"的收尾——用实际代码验证接口设计是否够用；写 EXTENDING.md 的过程会暴露接口的缺口。
**AI 协助 prompt 模板：**

```
对我当前的 b-code 项目做一次"策略模式"重构（TypeScript）：
- 抽出六大接口到 types.ts：Tool、Skill、Backend、Permission、Context、Memory
  （每个接口 1 个方法 + 1 个注册标识即可，别过度设计）
- backend：AnthropicBackend / OpenAIBackend 两个实现，env 决定用哪个
- permission：RulePermission / AllowlistPermission / ClassifierPermission 三个实现
- context：TruncateContext / SummaryContext 两个实现
- memory：FileMemory 实现
- 保持所有现有行为不变，跑通原验收命令后，写一份 EXTENDING.md 说明扩展步骤。
先列出重构计划再动手，逐模块迁移并每步跑测试。
```

---

### 3.3 里程碑与"完成"标准


| 里程碑      | 一句话                  | 完成标志                   |
| ------------- | ------------------------- | ---------------------------- |
| M1（P1 后） | 你的 Agent 会读代码了   | `"read a file"` 端到端跑通 |
| M2（P2 后） | 你的 Agent 可以日常用了 | 交互 + 恢复 + 流式         |
| M3（P4 后） | 你的 Agent 有长期记忆了 | 跨会话召回 +`/commit`      |
| M4（P5 后） | 你的 Agent 能扩展了     | 改 mcp.json 就多一个工具   |
| M5（P7 后） | 你的 Agent 架构成型     | 六接口 + 一行注册加能力    |

---

## Part 4 · AI 协助编码工作流

### 4.1 推荐工作流（每阶段通用）

```
1. 读文档对应章节（源码文档 §N + 本文档对应阶段）→ 先理解"为什么"
2. 把阶段里的任务拆成 1–3 个可提交的小任务
3. 对每个小任务：用本文档的 AI prompt 模板（改上你自己的文件名/需求）发给 AI
4. 拿到代码 → 自己 review 一遍（对照源码文档的关键实现，如 edit_file 唯一性）
5. 跑该阶段的验收命令 → 通过才进入下一阶段
```

### 4.2 让 AI 帮你的六条实战建议

1. **给上下文，不给全部代码。** prompt 里引用源码文档章节号（"实现 §6 的权限检查"）+ 你当前的关键类型，比贴整份文件更精准。
2. **一次一个任务。** 别让 AI 一次实现"权限+压缩+缓存"，拆成三个 prompt。
3. **要求"先计划后动手"。** 复杂任务（Phase 5、7）让 AI 先给重构计划再写码，避免跑偏。
4. **坚持验收命令。** AI 说"完成"不算，验收命令过了才算。
5. **让它写测试。** Phase 3 后每个新工具都要求带一个冒烟测试。
6. **保留源码文档作为"参考答案"。** 你的实现和文档不一致时，先想清楚是文档简化了还是你错了。

### 4.3 卡住时的 Debug 清单（按概率排序）


| 现象               | 最可能原因                               | 查哪                                    |
| -------------------- | ------------------------------------------ | ----------------------------------------- |
| 模型一直不调工具   | system prompt 没写工具用法 / tools 没传  | `prompt.ts`、`agent.ts` 的 `tools` 参数 |
| tool_result 报错   | `tool_use_id` 没关联 / 消息格式不符      | 循环第 ⑧ 步                            |
| 权限把正常操作拦了 | 工具没声明`mode` / 新工具默认 confirm    | `permissions.ts`、registry 的 `mode`    |
| 压缩后模型失忆     | 压缩把最近的 tool_use/tool_result 拆散了 | `maybeCompact` 的 KEEP_RECENT 与配对    |
| MCP 工具不出现     | 握手没完成 /`tools/list` 失败            | `mcp.ts` 的 initialize 顺序             |
| 会话恢复异常       | JSON 里混入函数/不可序列化对象           | `session.ts` 存的是纯数据               |

---

## 附录 A · 目标文件结构

```
src/
├── index.ts            # 入口
├── agent.ts            # 主循环（L2 内核，保持精简）
├── registry.ts         # 统一注册表（扩展核心）
├── types.ts            # 六大接口 + 公共类型（契约层）
├── prompt.ts           # System Prompt 两段式构建
├── cli.ts              # REPL / one-shot / 参数解析
├── session.ts          # 会话持久化
├── backend.ts          # Backend 策略（Anthropic / OpenAI）
├── permissions.ts      # Permission 策略（规则/白名单/分类器）
├── context.ts          # Context 策略（截断/摘要）
├── memory.ts           # Memory 策略（文件）
├── skills.ts           # 技能发现与解析
├── subagent.ts         # 子 Agent
├── mcp.ts              # MCP 客户端
├── autonomy.ts         # goal / loop / auto
├── frontmatter.ts      # frontmatter 解析
├── loaders/
│   ├── builtin-loader.ts   # 内置工具 → 注册表
│   ├── skill-loader.ts     # 技能目录 → 注册表
│   └── mcp-loader.ts       # mcp.json → 注册表
└── tools/              # 各内置工具实现（read_file.ts / edit_file.ts / …）
```

## 附录 B · 学习路线对照表


| 本文档阶段 | 源码文档章节  | 学完能回答的问题                                         |
| ------------ | --------------- | ---------------------------------------------------------- |
| P0         | —            | 脚手架的意义：为什么先搭骨架                             |
| P1         | §1–2        | 工具三要素是什么？循环为什么由模型决定停                 |
| P2         | §3–5        | 静态核心为什么能缓存省钱？消息数组为什么是唯一状态       |
| P3         | §6–7        | fail-closed 是什么？压缩为什么分级                       |
| P4         | §8–9        | 为什么记忆用关键词不用向量？技能和工具的区别             |
| P5         | §10–12      | 为什么 MCP 工具和内置工具"没有区别"？子 Agent 为什么只读 |
| P6         | §13          | 评估器为什么不给工具？分类器看什么                       |
| P7         | 本文档 Part 2 | 扩展一个能力的最小成本是多少？                           |

---

> **收尾一句话：** 源码文档教你"从零造出 Agent"，本文档教你把这份 Agent 变成"**可生长的平台**"。做到 Phase 7 时你会拥有一个内核稳定、六接口齐备、新能力一行注册即可接入的属于自己的 Coding Agent——**这就是你自己的、可持续扩展的 Claude Code。**

---

## Part 5 · 平台兼容与日志前置（2026-08-14 增补）

> 规划文档的 P0–P7 专注功能演进；本节补充"跨设备能跑、出问题能查"的基础设施，
> 它们不改变任何功能的验收标准，只保证功能在 Windows / macOS / Linux 与 CI 环境下一致可复现。

### 5.1 已落地：数据根目录 + 日志（P0b）


| 模块           | 文件                 | 约定                                                                                                                                                            |
| ---------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 统一数据根目录 | `src/utils/paths.ts` | `basePath = $B_CODE_HOME || os.homedir()/.b-code`；所有数据（会话/日志/记忆/mcp.json）以它为根；`safeName()` 清洗 Windows 非法字符                              |
| 调试日志       | `src/utils/log.ts`   | `B_CODE_LOG_LEVEL`(debug/info/warn/error，默认 info) + `B_CODE_LOG_FILE` 落盘到 `{basePath}/logs/b-code-YYYY-MM-DD.log`；**日志走 stderr**，stdout 专供模型文本 |

**设计理由**

- `os.homedir()` 天然跨平台（Win→USERPROFILE，POSIX→HOME），无需手写分支。
- 环境变量覆盖是测试隔离 / 换机迁移 / CI 注入的唯一正解；相对路径直接报错防歧义。
- 日志与 Agent 输出分离（stderr/stdout），one-shot 输出与管道不被日志污染；P6 无人值守靠日志复盘。

### 5.2 兼容清单：分档时机


| 时机           | 项                        | 说明                                                                                                                                                                         |
| ---------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 🟢 已做（P0b） | 路径/目录/safeName + 日志 | 见 5.1                                                                                                                                                                       |
| 🟢 已做（P0b） | **代理穿透**              | 自包含用`undici@6`（与 Node 22 内置同源，兼容器外 v8 会报 `invalid onRequestStart`）；`EnvHttpProxyAgent` 自动读 HTTP(S)_PROXY/NO_PROXY，未设则直连；两个 fetch 路径统一走它 |
| 🟢 已做（P0b） | **EOL 保持**              | `edit_file` 检测文件主导换行符（CRLF 计数 vs LF），CRLF 文件把 new_string 的 `\n` 统一转 `\r\n`，杜绝混行换行与 git 全红 diff；两向都有测试                                  |
| 🔵 各阶段落    | 错误分类 + 退出码         | P2 CLI 一起定（P6 自治要吃退出码）                                                                                                                                           |
| 🔵 各阶段落    | 六接口/注册表             | P5–P7 再落（文档明文"先别过度抽象"）                                                                                                                                        |
| 🔵 各阶段落    | 信号/Ctrl-C 优雅退出      | P3 权限 confirm 交互更关键                                                                                                                                                   |
| 🔵 各阶段落    | skill/MCP 目录可配置      | P4/P5 各自接入时支持 env 覆盖（对齐 B_CODE_HOME 哲学）                                                                                                                       |
