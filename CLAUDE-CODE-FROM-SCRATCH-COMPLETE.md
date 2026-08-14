# Claude Code 从零实现 —— 完整原理文档

> 一句话：**Coding Agent 的本质是一个 while 循环**——调模型、执行工具、把结果喂回去、再调模型，直到模型说"做完了"。
>
> 本文档用 TypeScript 展示核心代码，带你从零造一个能读代码、改文件、跑测试、跨会话记忆、多 Agent 协作的自主编程助手。

---

## 目录

1. [核心思想：Agent 循环](#1-核心思想agent-循环)
2. [工具系统](#2-工具系统)
3. [System Prompt 工程](#3-system-prompt-工程)
4. [CLI 与会话持久化](#4-cli-与会话持久化)
5. [流式输出与双后端](#5-流式输出与双后端)
6. [权限与安全](#6-权限与安全)
7. [上下文管理](#7-上下文管理)
8. [记忆系统](#8-记忆系统)
9. [技能系统](#9-技能系统)
10. [Plan Mode 只读规划](#10-plan-mode-只读规划)
11. [多 Agent 架构](#11-多-agent-架构)
12. [MCP 集成](#12-mcp-集成)
13. [自治与续跑](#13-自治与续跑goal--loop--auto-mode)
14. [完整架构一览](#14-完整架构一览)

---

## 1. 核心思想：Agent 循环

### 1.1 从聊天到动手

传统 AI 编程助手只能给建议——模型吐出文本，代码打印文本，结束。Coding Agent 多了一个回路：

```
传统模式：  用户输入 → 调模型 → 打印回复 → 结束
Agent 模式： 用户输入 → 调模型 → 有工具调用？→ 执行工具 → 结果喂回 → 再调模型 → ...
                                   ↓ 没有工具调用
                                 结束
```

**决定循环转不转的，从头到尾是模型，不是我们的代码。** 我们没有写任何"如果是读文件请求就……"的分支——是模型自己决定要不要动手、够不够、要不要再来一轮。这一点就是 Agent 和聊天机器人的分界线。

### 1.2 最小实现

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { toolDefinitions, executeTool } from "./tools.js";

/**
 * Agent 类 = 核心循环引擎
 *
 * 整个 Coding Agent 的心脏就是一个 while(true) 循环：
 *   1. 把消息发给模型
 *   2. 模型决定是否调用工具
 *   3. 调了 → 执行工具，结果喂回，回到步骤 1
 *   4. 没调 → 任务完成，退出
 */
export class Agent {
  /** Anthropic SDK 客户端，用于调用 Claude API */
  private client: Anthropic;

  /** 整个对话的消息数组——这是 Agent 的唯一状态 */
  private messages: Anthropic.MessageParam[] = [];

  constructor() {
    // 从环境变量读取 API Key 初始化客户端
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  /**
   * 处理一次用户输入，可能包含多轮工具调用
   * @param userText - 用户的自然语言指令
   */
  async chat(userText: string): Promise<void> {
    // 第一步：把用户输入追加到消息历史
    this.messages.push({ role: "user", content: userText });

    // 核心循环：每次迭代都是一次"模型思考 → 可能动手 → 再看结果"
    while (true) {
      // 调用 API，把工具定义一起发给模型
      // → 关键：tools 参数告诉模型"你有这些工具可用"
      const reply = await this.client.messages.create({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 4096,
        system: "You are Mini Claude Code...",
        tools: toolDefinitions,  // ← 工具清单，模型据此知道能做什么
        messages: this.messages,
      });

      // 记录模型的完整回复（可能包含文本 + 工具调用）
      this.messages.push({ role: "assistant", content: reply.content });

      // 检查模型这次回复中是否包含工具调用请求
      // tool_use 块 = 模型说"我想调某个工具"
      const toolUses = reply.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      // 没有工具调用 → 模型认为任务完成了，退出循环
      if (toolUses.length === 0) break;

      // 有工具调用 → 逐个执行，收集结果
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        console.log(`  → ${tu.name}(${JSON.stringify(tu.input)})`);
        // 执行工具：读文件、写文件、跑命令等
        const output = await executeTool(tu.name, tu.input as Record<string, any>);
        // tool_result 必须关联到对应的 tool_use_id
        results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
      }

      // 把工具执行结果作为 user 消息喂回去
      // → 模型读到这些结果后，会决定下一步怎么做
      this.messages.push({ role: "user", content: results });
      // ↑ 回到 while 开头，模型继续思考
    }
  }
}
```

### 1.3 关键设计原则


| 原则                   | 说明                                                        |
| ------------------------ | ------------------------------------------------------------- |
| **模型决定"做什么"**   | 循环是否继续、下一步调哪个工具，全由模型判断                |
| **代码确保"安全地做"** | 工具执行、权限检查、上下文压缩由代码控制                    |
| **消息数组是唯一状态** | 整个对话历史就是`this.messages`，持久化、压缩、摘要都操作它 |

---

## 2. 工具系统

### 2.1 工具的三要素

一个工具 = 名字 + 说明（给模型看） + 执行函数（代码执行）。

```typescript
/**
 * 工具定义 = 模型看到的"操作手册"
 *
 * 每个工具包含三部分：
 * 1. name: 工具名，模型在回复中用这个名字引用
 * 2. description: 告诉模型这个工具能做什么、什么时候用
 * 3. input_schema: 参数格式，模型按这个 schema 生成参数
 *
 * 这个数组直接传给 Anthropic API 的 tools 参数
 */
export const toolDefinitions: Anthropic.Tool[] = [
  // ── 读文件 ──────────────────────────────────────────
  {
    name: "read_file",
    description: "Read the contents of a file.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The path to the file to read" },
      },
      required: ["file_path"],
    },
  },

  // ── 写文件（覆盖写入） ──────────────────────────────
  {
    name: "write_file",
    description: "Write content to a file. Creates it if missing, overwrites if it exists.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The path to the file to write" },
        content: { type: "string", description: "The content to write" },
      },
      required: ["file_path", "content"],
    },
  },

  // ── 编辑文件（精确替换） ────────────────────────────
  {
    name: "edit_file",
    description: "Replace an exact string in a file with new content. old_string must match exactly and be unique.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The path to the file to edit" },
        old_string: { type: "string", description: "The exact string to find" },
        new_string: { type: "string", description: "The string to replace it with" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },

  // ── 列出文件 ────────────────────────────────────────
  {
    name: "list_files",
    description: "List files matching a glob pattern (e.g. '**/*.ts').",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern to match files" },
        path: { type: "string", description: "Base directory. Defaults to cwd." },
      },
      required: ["pattern"],
    },
  },

  // ── 搜索代码 ────────────────────────────────────────
  {
    name: "grep_search",
    description: "Search for a regex pattern in files. Returns matching lines with paths and line numbers.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The regex pattern to search for" },
        path: { type: "string", description: "Directory or file to search." },
      },
      required: ["pattern"],
    },
  },

  // ── 执行 Shell 命令 ────────────────────────────────
  {
    name: "run_shell",
    description: "Execute a shell command and return its output.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string", description: "The shell command to execute" } },
      required: ["command"],
    },
  },
];
```

### 2.2 工具执行器

```typescript
/**
 * 工具执行器 = 根据名字分派到对应函数
 *
 * 模型只传"工具名 + 参数"，这里负责把名字映射到实现。
 * 这是一个 switch/case 分发器，每个 case 调用对应的工具函数。
 */
export async function executeTool(
  name: string,          // 模型要调的工具名，如 "read_file"
  input: Record<string, any>  // 模型给的参数，如 { file_path: "src/agent.ts" }
): Promise<string> {
  switch (name) {
    // 每个 case 把泛型参数转为具体类型，调用对应函数
    case "read_file":   return readFile(input as { file_path: string });
    case "write_file":  return writeFile(input as { file_path: string; content: string });
    case "edit_file":   return editFile(input as { file_path: string; old_string: string; new_string: string });
    case "list_files":  return listFiles(input as { pattern: string; path?: string });
    case "grep_search": return grepSearch(input as { pattern: string; path?: string });
    case "run_shell":   return runShell(input as { command: string });
    case "web_fetch":   return webFetch(input as { url: string });
    case "skill":       return invokeSkill(input as { name: string; args?: string });
    case "agent":       return runSubAgent(String(input.task || ""));
    case "tool_search": return toolSearch(input as { query: string });
    // 安全兜底：模型调了不存在的工具
    default:            return `Unknown tool: ${name}`;
  }
}
```

### 2.3 核心工具实现细节

**`edit_file` 的陷阱**：同一个字符串在文件中出现多次，改错了地方。

```typescript
/**
 * 编辑文件——最需要小心实现的工具
 *
 * 陷阱：old_string 必须在文件中唯一出现，否则改错位置。
 * 比如文件中有两处 "value = 0"，模型只想改第一处，
 * 但 split/join 会两处都改。所以先计数，不唯一就报错。
 */
function editFile(
  input: { file_path: string; old_string: string; new_string: string }
): string {
  const content = readFileSync(input.file_path, "utf-8");

  // 第一步：检查 old_string 是否存在
  if (!content.includes(input.old_string)) {
    return `Error: old_string not found in ${input.file_path}`;
  }

  // 第二步：检查唯一性——出现次数必须为 1
  const count = content.split(input.old_string).length - 1;
  if (count > 1) {
    return `Error: old_string found ${count} times. Must be unique.`;
  }

  // 第三步：执行替换
  // 注意：用 split/join 而不是 String.replace
  // 因为 replace 会处理 $1、$& 等特殊模式，split/join 不会
  const updated = content.split(input.old_string).join(input.new_string);
  writeFileSync(input.file_path, updated);
  return `Successfully edited ${input.file_path}`;
}
```

**`web_fetch`**：获取网页内容并转为纯文本供模型阅读。

```typescript
/**
 * 获取网页内容——让模型能"上网查资料"
 *
 * 核心逻辑：fetch HTML → 去掉 script/style 标签 → 去掉所有标签 → 截断
 */
async function webFetch(input: { url: string }): Promise<string> {
  const resp = await fetch(input.url);
  const html = await resp.text();

  // 简单而有效的 HTML 转纯文本
  // 1. 去掉 <script> 及其内容（JS 代码对模型无用）
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    // 2. 去掉 <style> 及其内容（CSS 对模型无用）
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    // 3. 去掉所有 HTML 标签，只留文本
    .replace(/<[^>]+>/g, "")
    // 4. 合并空白字符
    .replace(/\s+/g, " ")
    .trim();

  // 限制长度，避免撑爆上下文窗口
  return text.slice(0, 10000);
}
```

### 2.4 延迟加载（Deferred Tools）

```typescript
/**
 * 延迟加载：有些工具不是每次对话都用得上
 *
 * 比如 Plan Mode 的 enter_plan_mode / exit_plan_mode，
 * 大多数会话用不到，但加载了就要占 token。
 * 标记 deferred 后，默认不发给模型，需要时才加入。
 */

// 在 toolDefinitions 中标记为 deferred
{
  name: "enter_plan_mode",
  description: "Enter plan mode to switch to a read-only planning phase.",
  input_schema: { type: "object", properties: {} },
  deferred: true,  // ← 默认不加载，省 token
}

// 使用时由 Agent 按需过滤
const tools = shouldIncludePlanTools
  ? toolDefinitions                                  // 全部加载
  : toolDefinitions.filter((t) => !t.deferred);      // 只加载非 deferred 的
```

### 2.5 并行执行

```typescript
/**
 * 并发安全工具集：这些工具可以同时执行，不必等模型生成完毕
 *
 * 流式输出时，模型一边生成文本，系统一边执行这些工具，
 * 等模型生成完毕，工具结果也差不多回来了。
 * 这比串行执行快很多——尤其是读多个文件时。
 */
const CONCURRENCY_SAFE_TOOLS = new Set([
  "read_file",    // 读文件：纯读取，无副作用
  "list_files",   // 列文件：纯读取
  "grep_search",  // 文本搜索：纯读取
  "web_fetch"     // 网页获取：只读 HTTP
]);
```

---

## 3. System Prompt 工程

### 3.1 两段式结构

System Prompt 拆成两半，核心目的是**让静态部分能被 API 缓存**：

```
┌─────────────────────────────────────┐
│ 静态核心（STATIC_CORE）              │ ← 跨会话逐字不变，标 cache_control
│  - 身份定义                          │    稳定命中缓存，费用按 0.1× 计
│  - 行为规则                          │
│  - 工具使用偏好                      │
├─────────────────────────────────────┤
│ 动态上下文（buildDynamicSystemContext）│ ← 每次动态拼，项目相关
│  - 工作目录 / 平台 / Shell            │
│  - Git 状态                          │
│  - 记忆召回                          │
│  - 技能描述 / Agent 描述              │ ← 近因效应，放末尾权重更大
└─────────────────────────────────────┘
```

### 3.2 静态核心

```typescript
/**
 * 静态核心 System Prompt
 *
 * 这是 Agent 的"人格"——告诉模型它是什么、该怎么做事。
 * 跨会话逐字不变，API 可以缓存它，后续会话不用重复传输。
 * 正是因为这个原因，里面不能有任何动态内容（如 cwd、git 状态）。
 */
const STATIC_CORE = `You are Mini Claude Code, a small coding assistant CLI.
You help with software engineering tasks using the tools available to you.

# Doing tasks
 - Do not propose changes to code you haven't read. Read files first.
 - Do not create files unless necessary. Prefer editing existing files.
 - Avoid over-engineering. Only make changes that were requested.

# Executing actions with care
 - Prefer reversible actions. For risky or destructive ones (rm -rf, git push,
   dropping tables), confirm with the user before proceeding.

# Using your tools
 - Use read_file / edit_file / list_files / grep_search instead of shell cat,
   sed, ls, grep. Reserve run_shell for actual shell operations.
 - If several tool calls are independent, make them in parallel.

# Tone and style
 - Keep responses short and concise. Lead with the answer.
 - Reference code as file_path:line_number.`;
```

### 3.3 动态上下文

```typescript
/**
 * 构建完整的 System Prompt = 静态核心 + 动态环境信息
 *
 * 动态部分每次调用前重新构建，包含：
 * - 当前操作系统、工作目录
 * - Git 分支和是否有未提交变更
 * - 记忆召回（第 8 章）
 * - 可用技能描述（第 9 章）
 * - 子 Agent 描述（第 11 章）
 *
 * 动态块放在末尾——利用近因效应，让模型更关注这些信息
 */
export function buildSystemPrompt(): string {
  const parts: string[] = [STATIC_CORE];

  // ── 环境信息：让模型知道自己在哪 ──
  parts.push(`\n# Environment\n- Platform: ${os.platform()}`);
  parts.push(`- Working directory: ${process.cwd()}`);
  parts.push(`- Shell: ${os.userInfo().shell || "/bin/bash"}`);

  // ── Git 状态：让模型知道当前代码库状态 ──
  try {
    const branch = execSync("git branch --show-current", { encoding: "utf-8" }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf-8" }).trim();
    parts.push(`\n# Git\n- Branch: ${branch}`);
    if (dirty) parts.push(`- Uncommitted changes:\n${dirty.slice(0, 500)}`);
  } catch {
    // 不在 git 仓库中，跳过
  }

  // 动态扩展：记忆、技能、子 Agent 描述
  parts.push(buildMemoryPromptSection());    // 跨会话记忆
  parts.push(buildSkillDescriptions());       // 可用技能
  parts.push(buildAgentDescriptions());       // 子 Agent 类型

  return parts.join("\n");
}
```

### 3.4 CLAUDE.md 加载

```typescript
/**
 * 加载项目规则文件 CLAUDE.md
 *
 * 从当前目录向上查找，找到所有 CLAUDE.md 合并。
 * 支持 @include 指令引用其他文件：
 *   @./relative/path   → 相对路径
 *   @~/home/path       → 用户 home 目录
 *   @/absolute/path    → 绝对路径
 */
export function loadClaudeMd(): string {
  const parts: string[] = [];
  let dir = process.cwd();

  // 从当前目录向上查找，直到根目录
  while (dir !== "/") {
    const path = join(dir, "CLAUDE.md");
    if (existsSync(path)) {
      parts.push(
        `<file key="${path}">\n${resolveIncludes(readFileSync(path, "utf-8"), dir)}\n</file>`
      );
    }
    dir = resolve(dir, "..");
  }
  return parts.join("\n");
}

/**
 * 解析 @include 指令，替换为对应文件内容
 * 支持最多 5 层嵌套，防止循环引用
 */
function resolveIncludes(content: string, baseDir: string): string {
  return content.replace(/^@(.+)$/gm, (_, path) => {
    // 解析路径：~ → home, / → 绝对路径, 其他 → 相对于 baseDir
    const resolved = path.startsWith("~")
      ? join(os.homedir(), path.slice(1))
      : path.startsWith("/")
        ? path
        : join(baseDir, path);

    // 文件不存在时给出友好提示，不崩溃
    return existsSync(resolved)
      ? readFileSync(resolved, "utf-8")
      : `<!-- not found: ${path} -->`;
  });
}
```

---

## 4. CLI 与会话持久化

### 4.1 REPL 循环

```typescript
/**
 * CLI 入口：支持两种模式
 *
 * 1. One-shot 模式：直接执行一条指令后退出
 *    $ mini-claude "Read src/agent.ts"
 *
 * 2. REPL 模式：交互式对话，逐行输入
 *    $ mini-claude
 *    > Read src/agent.ts
 *    > Now write a test for it
 *
 * 同时支持 --resume 恢复上次会话
 */
import * as readline from "readline";
import { Agent } from "./agent.js";
import { saveSession, loadSession } from "./session.js";

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const agent = new Agent();

  // ── 处理 --resume 参数 ──
  // 从磁盘加载上次保存的消息历史，恢复对话上下文
  const resume = argv.includes("--resume");
  argv = argv.filter((a) => a !== "--resume");
  if (resume) {
    const saved = loadSession();
    if (saved) {
      agent.loadHistory(saved as any);
      console.log(`(resumed ${saved.length} messages)`);
    }
  }

  // ── One-shot 模式 ──
  // 命令行参数中剩余的部分当作一条指令直接执行
  const oneShot = argv.join(" ").trim();
  if (oneShot) {
    await agent.chat(oneShot);
    saveSession(agent.history());  // 执行完保存
    return;
  }

  // ── REPL 模式 ──
  // 使用 readline 实现交互式命令行
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = () => rl.question("> ", async (line) => {
    const input = line.trim();

    // 退出命令
    if (input === "exit" || input === "quit") { rl.close(); return; }

    // 清空历史
    if (input === "/clear") {
      agent.clearHistory();
      saveSession(agent.history());
      console.log("(history cleared)");
    } else if (input) {
      // 如果输入以 / 开头，先尝试解析为技能调用
      const resolved = resolveSkill(input) ?? input;
      await agent.chat(resolved);
      saveSession(agent.history());  // 每轮对话后自动保存
    }
    ask();  // 继续等待下一条输入
  });

  ask();
}
```

### 4.2 会话持久化

```typescript
/**
 * 会话持久化 = 把消息数组存成 JSON 文件
 *
 * 整个 Agent 的状态就是 this.messages，所以"存会话"就是
 * 把这个数组 JSON 序列化写盘。"恢复会话"就是读回来。
 *
 * 文件位置：~/.mini-claude/session.json
 * 每次 chat 后自动保存，--resume 时自动恢复。
 */
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/** 会话文件路径：用户 home 目录下的隐藏文件 */
const SESSION_FILE = join(homedir(), ".mini-claude", "session.json");

/**
 * 保存会话：把消息数组写成 JSON
 * 出错时静默失败（不阻塞主流程）
 */
export function saveSession(messages: unknown[]): void {
  try {
    writeFileSync(SESSION_FILE, JSON.stringify(messages, null, 2));
  } catch {
    // 磁盘满或权限问题时静默失败
  }
}

/**
 * 加载会话：从 JSON 文件恢复消息数组
 * @returns 消息数组，如果文件不存在或损坏则返回 null
 */
export function loadSession(): unknown[] | null {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    return JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
  } catch {
    // JSON 解析失败（文件损坏）时返回 null
    return null;
  }
}
```

### 4.3 支持的 CLI 命令


| 命令               | 作用                               |
| -------------------- | ------------------------------------ |
| `--resume`         | 恢复上次会话                       |
| `--yolo`           | 跳过所有权限确认                   |
| `--plan`           | 以只读规划模式启动                 |
| `--auto`           | 启用 Auto Mode（分类器替代确认框） |
| `--goal <条件>`    | 设定目标，持续执行直到达成         |
| `--model <模型名>` | 指定模型                           |
| `/clear`           | 清空当前对话历史                   |
| `/cost`            | 显示当前会话费用                   |
| `/compact`         | 手动触发上下文压缩                 |

---

## 5. 流式输出与双后端

### 5.1 流式替换

```typescript
/**
 * 流式调用模型
 *
 * 之前是 await client.messages.create(...) — 等模型全部生成完才返回。
 * 换成 .stream() 后，模型每生成一小段文本就回调一次，
 * 用户体验从"卡住几秒然后啪地冒出一大段"变成"逐字显示"。
 *
 * 关键：stream.finalMessage() 返回的 Message 对象和非流式完全一样，
 * 所以后续代码不需要改——工具调用提取、消息记录等都一样处理。
 */
async function callModel(): Promise<Anthropic.Message> {
  // 发起流式请求
  const stream = this.client.messages.stream({
    model: this.model,
    max_tokens: 16384,
    system: this.systemPrompt,
    tools: toolDefinitions,
    messages: this.messages,
  });

  // 每收到一段文本就立即打印，实现"边想边写"的效果
  stream.on("text", (text) => process.stdout.write(text));

  // 等待完整响应——stream.finalMessage() 返回和非流式一样的 Message
  const finalMessage = await stream.finalMessage();
  process.stdout.write("\n");
  return finalMessage;
}
```

### 5.2 OpenAI 兼容后端

```typescript
/**
 * OpenAI 兼容后端的流式调用
 *
 * Anthropic 和 OpenAI 的流式协议不同：
 * - Anthropic: SDK 封装了全部 SSE 解析，stream.on("text") 直接给文本
 * - OpenAI: 需要手动解析 SSE 流，tool_calls 参数分 chunk 到达
 *
 * 这个函数把 OpenAI 的流式响应重建为 Anthropic 兼容格式。
 */
async function callOpenAIStream(): Promise<any> {
  const response = await fetch(`${this.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`
    },
    body: JSON.stringify({
      model: this.model,
      messages: this.openAiMessages,
      // 工具定义需要转为 OpenAI 的格式
      tools: toolDefinitions.map(convertToOpenAI),
      stream: true,  // ← 开启流式
    }),
  });

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // 累积收集的完整响应，最后重建为 Anthropic 兼容格式
  const collected: any = { content: [], tool_calls: [] };

  // 逐块读取 SSE 流
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    // 累积 buffer，按行分割（SSE 协议每行一条数据）
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      // SSE 数据行以 "data: " 开头
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") break;  // 流结束标记

      const chunk = JSON.parse(data);
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      // 文本增量 → 立即打印
      if (delta.content) process.stdout.write(delta.content);

      // tool_calls 增量 → 累积（OpenAI 的 tool_calls 是分块到达的，
      // 每个 chunk 只带一部分，需要合并重建）
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          // 合并同一 index 的 tool_call 片段
          // 略：实际实现需要按 index 合并 name、arguments 等
        }
      }
    }
  }

  // 返回重建后的完整消息（兼容 Anthropic 格式）
  return convertToAnthropicMessage(collected);
}
```

### 5.3 切换后端

```typescript
/**
 * 构造函数中自动选择后端
 *
 * 逻辑：如果同时配置了 OPENAI_API_KEY + OPENAI_BASE_URL，
 * 就走 OpenAI 兼容路径；否则走 Anthropic 路径。
 * 用户只需要改环境变量，不需要改代码。
 */
constructor() {
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL) {
    // 走 OpenAI 兼容后端
    this.useOpenAI = true;
    this.apiKey = process.env.OPENAI_API_KEY;
    this.baseUrl = process.env.OPENAI_BASE_URL;
  } else {
    // 走 Anthropic 原生后端
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
}
```

---

## 6. 权限与安全

### 6.1 核心原则

**deny 优先，连 `--yolo` 也拦得住。** 先查 deny 规则，再看 plan 只读契约，然后才轮到 bypass / allow 规则 / 内置危险检测 / 用户确认。

### 6.2 7 层权限检查

```
工具调用 → ① deny 规则命中？→ 直接拦截
         → ② plan 模式且写/shell？→ 拦截
         → ③ bypassPermissions（--yolo）？→ 放行
         → ④ allow 规则命中？→ 放行
         → ⑤ 内置危险模式检测？→ 安全则放行
         → ⑥ 会话白名单已有？→ 放行
         → ⑦ 用户确认框 → 确认则放行，否认则拦截
```

### 6.3 最小实现

```typescript
/**
 * 权限检查器
 *
 * 返回值三态：
 * - "allow":  安全，直接执行
 * - "deny":   危险，直接拦截（连 --yolo 也拦不住）
 * - "confirm": 需要用户确认
 *
 * 设计原则：fail-closed
 * 新的工具类型如果忘记声明权限级别，默认按"需要确认"处理
 */

// 危险命令正则列表——匹配即拦截
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\b/,             // 递归删除
  /\bgit\s+push\b/,           // 推送代码
  /\bgit\s+reset\s+--hard\b/, // 硬重置
  /\bsudo\b/,                  // 提权
  /\bmkfs\b/,                  // 格式化磁盘
  />\s*\/dev\//,              // 写入设备
  /\bdd\s/,                    // 磁盘操作
  /\bkill\b/,                  // 杀进程
  /\breboot\b/,                // 重启
  /\bshutdown\b/,              // 关机
];

export function checkPermission(
  name: string,               // 工具名
  input: Record<string, any>, // 工具参数
  mode: string                // 当前模式 (default/plan/bypass/auto)
): "allow" | "deny" | "confirm" {

  // 1. deny 规则优先——匹配到直接拦截，任何模式都绕不过
  if (name === "run_shell" &&
      DANGEROUS_PATTERNS.some((re) => re.test(String(input.command || "")))) {
    return "deny";
  }

  // 2. plan 模式只读——写文件、编辑、跑 shell 全部拒绝
  if (mode === "plan" && ["write_file", "edit_file", "run_shell"].includes(name)) {
    return "deny";
  }

  // 3. 安全操作直接放行——读操作没风险
  if (["read_file", "list_files", "grep_search", "web_fetch"].includes(name)) {
    return "allow";
  }

  // 4. 其他操作（写文件、编辑、跑命令）需要用户确认
  return "confirm";
}
```

### 6.4 在 Agent 循环中集成

```typescript
/**
 * 在 Agent 循环中集成权限检查
 *
 * 每个工具执行前都过一遍 checkPermission：
 * - deny → 不执行，返回拒绝信息给模型
 * - confirm → 弹框问用户（bypass 模式跳过）
 * - allow → 直接执行
 */
for (const tu of toolUses) {
  const permission = checkPermission(tu.name, tu.input as Record<string, any>, this.mode);

  let output: string;

  if (permission === "deny") {
    // 直接拒绝，不执行
    output = `Denied: ${tu.name} was blocked by the permission system.`;

  } else if (permission === "confirm" && this.mode !== "bypass") {
    // 需要用户确认（实际项目中用 UI 弹框）
    output = await askUser(`Allow ${tu.name}? (y/n) `)
      ? await executeTool(tu.name, tu.input as Record<string, any>)
      : `Denied: user rejected ${tu.name}.`;

  } else {
    // 放行，直接执行
    output = await executeTool(tu.name, tu.input as Record<string, any>);
  }

  results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
}
```

### 6.5 会话级白名单

```typescript
/**
 * 会话级白名单
 *
 * 同一个操作确认过一次就不再问，减少对用户的干扰。
 * 比如用户允许了一次 "git push"，这个会话内再 push 就不问了。
 */
const sessionAllowlist = new Set<string>();

/**
 * 生成白名单键：同一条命令在同一会话内唯一
 * 对于 shell 命令，用命令内容作为键；其他用工具名
 */
function getAllowlistKey(name: string, input: Record<string, any>): string {
  if (name === "run_shell") return `shell:${input.command}`;
  return name;
}
```

---

## 7. 上下文管理

### 7.1 问题

消息数组每轮都在变长，跑几十轮必然撑爆模型的上下文窗口。一旦超了，API 直接报错。

### 7.2 四层压缩流水线

从最轻到最重，逐级加码：

```
Tier 0: 执行时截断 → 单次工具输出超过 50K 字符自动截断
Tier 1: Budget 截断 → 窗口使用 50-70% 时截到 30K，70-85% 时截到 15K
Tier 2: Snip 裁剪 → 删除同文件重复读取、旧搜索结果
Tier 3: Microcompact → 空闲超过 5 分钟时微压缩
Tier 4: Auto-compact → 超过 85% 窗口时，LLM 摘要替换旧消息
```

### 7.3 最小实现：LLM 摘要

```typescript
/**
 * 上下文压缩：超过阈值时用 LLM 把旧消息总结成摘要
 *
 * 原理：旧消息 → 渲染为纯文本 → 调一次模型做摘要 → 替换原文
 * 保留最近 KEEP_RECENT 条不做压缩，保证模型能记住最近的上下文。
 *
 * 在 agent.ts 中每次调模型前调用：
 *   this.messages = await maybeCompact(this.messages, this.client, MODEL);
 */
const COMPACT_THRESHOLD = 15;  // 超过 15 条消息就触发压缩
const KEEP_RECENT = 5;         // 保留最近 5 条，不压缩

export async function maybeCompact(
  messages: Anthropic.MessageParam[],
  client: Anthropic,
  model: string,
): Promise<Anthropic.MessageParam[]> {
  // 消息不够多，不压缩
  if (messages.length <= COMPACT_THRESHOLD) return messages;

  // 分割：旧消息（要压缩的） + 最近消息（保留的）
  const older = messages.slice(0, messages.length - KEEP_RECENT);
  const recent = messages.slice(messages.length - KEEP_RECENT);

  // 把旧消息渲染为纯文本，传给模型做摘要
  // 注意：用 [tool call / result] 代替 tool_use/tool_result 的详细内容
  // 避免 tool_use 和 tool_result 跨消息被拆散
  const transcript = older
    .map((m) => `${m.role}: ${
      typeof m.content === "string" ? m.content : "[tool call / result]"
    }`)
    .join("\n");

  // 一次额外的模型调用，专门做摘要
  const reply = await client.messages.create({
    model, max_tokens: 1024,
    system: "Summarize the conversation so far in a few sentences, keeping key facts.",
    messages: [{ role: "user", content: transcript }],
  });
  const summary = reply.content
    .filter((b) => b.type === "text")
    .map((b: any) => b.text).join("");

  console.log(`  (compacted ${older.length} messages into a summary)`);

  // 返回：摘要 + 最近消息
  return [
    { role: "user", content: `[Summary of earlier conversation]\n${summary}` },
    ...recent
  ];
}
```

### 7.4 执行时截断

```typescript
/**
 * 执行时结果截断
 *
 * 有些工具（如 read_file、run_shell）可能返回超大结果。
 * 超过 50K 字符就截断，保留头尾各一半，中间用省略标记。
 * 这是第一道防线，防止单次工具输出就撑爆窗口。
 */
const MAX_RESULT_CHARS = 50000;

function truncateResult(result: string): string {
  if (result.length <= MAX_RESULT_CHARS) return result;

  const keepEach = Math.floor((MAX_RESULT_CHARS - 60) / 2);
  return (
    result.slice(0, keepEach) +
    `\n\n[... truncated ${result.length - keepEach * 2} chars ...]\n\n` +
    result.slice(-keepEach)
  );
}
```

### 7.5 前缀缓存

```typescript
/**
 * 前缀缓存：让重复的 system prompt 不用每次重新传输
 *
 * 原理：静态核心（STATIC_CORE）跨会话逐字不变，标上 cache_control
 * 后，API 会缓存它。后续会话中，相同的前缀按 0.1× 计费。
 * 最后一条消息也打一个断点，让缓存覆盖到最新消息之前的所有内容。
 *
 * 费用对比：
 * - 未命中：$3/Mtok（完整费用）
 * - 缓存命中：$0.30/Mtok（10% 费用）
 * 多轮对话中，第二轮起基本都命中缓存。
 */

// 在 system 参数中设置缓存标记
const system = [
  // 静态核心：标 cache_control，跨会话稳定命中
  { type: "text", text: STATIC_CORE, cache_control: { type: "ephemeral" } },
  // 动态上下文：不缓存，每次重新生成
  { type: "text", text: dynamicContext },
];

// 最后一条消息也打一个断点
// 这样缓存覆盖到最新消息之前的所有内容
messages[messages.length - 1] = {
  ...messages[messages.length - 1],
  cache_control: { type: "ephemeral" },
};
```

---

## 8. 记忆系统

### 8.1 问题

会话一关就全忘了——下次得从头再来。需要跨会话的长期记忆。

### 8.2 存储结构

```
~/.mini-claude/projects/{sha256(cwd).slice(0,16)}/memory/
├── MEMORY.md                    # 索引文件
├── user_prefers_concise.md      # 用户偏好
├── project_auth_migration.md    # 项目事实
└── reference_staging_url.md     # 参考信息
```

### 8.3 记忆文件格式

```markdown
---
name: 部署到 staging
description: Staging 环境 URL
type: reference
---
Staging server: https://staging.example.com
Credentials in 1Password.
```

### 8.4 语义召回

```typescript
/**
 * 语义召回：按关键词重叠度召回相关记忆
 *
 * 核心思路：把用户的问题和记忆文件做关键词匹配。
 * 不额外调模型，纯确定性算法——快、省钱、可预测。
 *
 * 召回时机：每次 chat 开始前，将召回结果追加到 System Prompt 末尾。
 * 利用近因效应，让模型优先关注这些记忆。
 */
export function recallMemories(query: string): string {
  const memoryDir = getMemoryDir();
  if (!existsSync(memoryDir)) return "";

  // 提取用户问题中的关键词（长度 > 2 的单词）
  const queryWords = new Set(
    query.toLowerCase().split(/\W+/).filter((w) => w.length > 2)
  );

  // 遍历所有记忆文件，计算相关性得分
  const scored: { text: string; score: number }[] = [];
  for (const file of readdirSync(memoryDir).filter((f) => f.endsWith(".md"))) {
    const { meta, body } = parseFrontmatter(
      readFileSync(join(memoryDir, file), "utf-8")
    );
    // 搜索范围包括：文件名、描述、正文
    const searchText =
      `${meta.name || ""} ${meta.description || ""} ${body}`.toLowerCase();
    const words = new Set(searchText.split(/\W+/));

    // 得分 = 问题关键词和记忆内容的重叠词数
    let score = 0;
    for (const w of queryWords) if (words.has(w)) score++;

    if (score > 0) {
      scored.push({ text: `- ${meta.name}: ${body}`, score });
    }
  }

  if (scored.length === 0) return "";

  // 按得分排序，取前 3 条
  const top = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.text)
    .join("\n");

  return `\n\n# Memory\n${top}`;
}
```

### 8.5 记忆保存

```typescript
/**
 * 保存一条记忆
 *
 * 记忆文件 = YAML frontmatter + Markdown 正文
 * frontmatter 包含：name、description、type（用于搜索匹配）
 * 正文存放在记忆内容（用于语义召回）
 */
export function saveMemory(
  name: string,        // 记忆名称，如 "部署到 staging"
  description: string, // 简短描述，用于搜索匹配
  type: string,        // 类型：project/feedback/reference
  content: string      // 记忆正文
): void {
  const dir = getMemoryDir();
  mkdirSync(dir, { recursive: true });

  // 构建 YAML frontmatter
  const frontmatter = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    `type: ${type}`,
    "---",
  ].join("\n");

  // 文件名：名称转小写+下划线
  const filePath = join(dir, `${name.replace(/\s+/g, "_").toLowerCase()}.md`);
  writeFileSync(filePath, `${frontmatter}\n${content}`);
}
```

### 8.6 Frontmatter 解析

```typescript
/**
 * 解析 YAML frontmatter
 *
 * 记忆文件、技能文件都使用同样的 frontmatter 格式：
 * ---
 * key: value
 * ---
 * 正文内容...
 *
 * 解析结果：meta = { key: value }，body = 正文
 */
export function parseFrontmatter(
  content: string
): { meta: Record<string, string>; body: string } {
  const lines = content.split("\n");

  // 第一行必须是 "---"，否则当作纯正文处理
  if (lines[0]?.trim() !== "---") return { meta: {}, body: content };

  // 找到结束的 "---"
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { endIdx = i; break; }
  }
  if (endIdx === -1) return { meta: {}, body: content };

  // 解析 key: value 对
  const meta: Record<string, string> = {};
  for (let i = 1; i < endIdx; i++) {
    const colonIdx = lines[i].indexOf(":");
    if (colonIdx === -1) continue;
    const key = lines[i].slice(0, colonIdx).trim();
    const value = lines[i].slice(colonIdx + 1).trim();
    if (key) meta[key] = value;
  }

  // 正文 = frontmatter 之后的所有内容
  const body = lines.slice(endIdx + 1).join("\n").trim();
  return { meta, body };
}
```

---

## 9. 技能系统

### 9.1 问题

有些提示词会反复用到——"读 diff、写 commit message、提交"这套，每次手打一遍很烦。

### 9.2 技能文件格式

```markdown
---
name: commit
description: Create a git commit with a descriptive message
when_to_use: When the user asks to commit changes or says "commit"
allowed-tools: run_shell, read_file
user-invocable: true
---
Look at the current git diff and staged changes. Write a clear, concise
commit message following conventional commits format.

The user's request: $ARGUMENTS
```

### 9.3 技能发现与解析

```typescript
/**
 * 技能解析器：把 "/name 参数" 替换为技能文件中的 prompt
 *
 * 搜索路径（项目级覆盖用户级）：
 * 1. ~/.claude/skills/  — 用户级，全局可用
 * 2. .claude/skills/    — 项目级，覆盖同名用户级技能
 *
 * 支持 $ARGUMENTS 占位符替换，让技能可以接收参数
 */

const SKILL_DIRS = [
  join(homedir(), ".claude", "skills"),     // 用户级（低优先级）
  join(process.cwd(), ".claude", "skills"),  // 项目级（高优先级，覆盖用户级）
];

export function resolveSkill(input: string): string | null {
  // 不以 / 开头 → 不是技能调用
  if (!input.startsWith("/")) return null;

  // 解析："/commit 新功能" → name="commit", args="新功能"
  const [name, ...rest] = input.slice(1).split(" ");
  const args = rest.join(" ").trim();

  // 在两处目录中依次查找
  for (const dir of SKILL_DIRS) {
    const file = join(dir, `${name}.md`);
    if (!existsSync(file)) continue;

    const content = readFileSync(file, "utf-8");
    const { meta, body } = parseFrontmatter(content);

    // 替换 $ARGUMENTS 占位符为实际参数
    let prompt = body;
    if (args) prompt = prompt.replace(/\$ARGUMENTS/g, args);

    return prompt;
  }
  return null;  // 没找到对应的技能文件
}
```

### 9.4 技能描述注入 System Prompt

```typescript
/**
 * 构建技能描述列表，注入 System Prompt
 *
 * 让模型知道有哪些技能可用，什么情况下该调用哪个技能。
 * 只注入 user-invocable 的技能（用户可主动调用的），
 * 内部技能（模型自动触发的）不暴露给用户。
 */
export function buildSkillDescriptions(): string {
  const skills = discoverSkills();
  if (skills.length === 0) return "";

  const lines = skills
    .filter((s) => s.userInvocable)
    .map((s) => `- /${s.name}: ${s.description}`);

  return `\n\n# Available Skills\n${lines.join("\n")}`;
}
```

---

## 10. Plan Mode 只读规划

### 10.1 问题

有时候不想让 agent 一上来就改代码，想先看看它打算怎么干、批准了再动手。

### 10.2 核心机制

Plan Mode = 只读模式 + 特殊 System Prompt + plan 文件输出 + 审批流程。

```
--plan 启动 → 权限切换为只读 → 注入 Plan Mode 提示词
  → Agent 读代码、写 plan 文件 → 调用 exit_plan_mode
  → 用户审批（4 选项：照做 / 改改再做 / 手动 / 继续规划）
  → 批准后切换回写模式执行
```

### 10.3 实现

```typescript
/**
 * Plan Mode 实现
 *
 * 关键：只读约束由代码强制（权限系统检查），不是靠提示词"求"模型别动。
 * 即使模型想写文件，也会被 checkPermission 拦截。
 */
export class Agent {
  /**
   * 当前模式
   * - "default": 正常模式，可读可写
   * - "plan":    只读规划模式，写操作被拒绝
   * - "bypass":  --yolo 模式，跳过所有确认
   * - "auto":    Auto Mode，分类器替代确认框
   */
  mode = "default";

  async chat(userText: string): Promise<void> {
    // ...循环逻辑...

    // 执行工具前检查
    // 两个条件任一满足就拦截：
    // 1. 权限系统判为 deny（危险命令）
    // 2. plan 模式下企图写文件/编辑/跑 shell
    const blocked =
      checkPermission(tu.name, tu.input as Record<string, any>, this.mode) === "deny"
      || (this.mode === "plan"
          && ["write_file", "edit_file", "run_shell"].includes(tu.name));

    const output = blocked
      ? `Denied: ${tu.name} was blocked (${this.mode} mode).`
      : await executeTool(tu.name, tu.input as Record<string, any>);
  }

  /** 切换模式 */
  setMode(m: string): void { this.mode = m; }
}
```

### 10.4 Plan Mode 工具定义

```typescript
/**
 * Plan Mode 的两个工具
 *
 * 标记为 deferred，因为大多数会话不需要 Plan Mode。
 * 只有在 --plan 启动或模型主动调用时才加载，省 token。
 */
{
  name: "enter_plan_mode",
  description: "Enter plan mode to switch to a read-only planning phase.",
  input_schema: { type: "object", properties: {} },
  deferred: true,  // ← 默认不加载
},
{
  name: "exit_plan_mode",
  description: "Exit plan mode after writing your plan file.",
  input_schema: { type: "object", properties: {} },
  deferred: true,
},
```

---

## 11. 多 Agent 架构

### 11.1 问题

一个大任务全塞进一个 Agent，上下文很快就满了。需要"分而治之"。

### 11.2 子 Agent 模式

主 Agent 派生一个独立的子 Agent 去啃某个子任务，有自己干净的上下文，啃完只把结果带回来。

```
主 Agent → agent({task: "..."}) → 子 Agent（只读，独立循环）
                                 → 返回文本结果 → 主 Agent 继续
```

### 11.3 子 Agent 类型


| 类型      | 可用工具                           | 用途       |
| ----------- | ------------------------------------ | ------------ |
| `explore` | read_file, list_files, grep_search | 代码探索   |
| `plan`    | read_file, list_files, grep_search | 规划       |
| `general` | 完整工具集                         | 通用子任务 |

### 11.4 实现

```typescript
/**
 * 子 Agent：一个独立的、只读的 Agent 循环
 *
 * 和主 Agent 的区别：
 * 1. 有自己的消息数组（干净上下文）
 * 2. 只给读工具（不能写文件、不能跑命令）
 * 3. 返回纯文本结果（不附带中间过程）
 * 4. 进程内同步调用，不 fork 子进程
 */

// 只读工具集：子 Agent 只能读不能写
const EXPLORE_TOOLS = new Set(["read_file", "list_files", "grep_search"]);

/**
 * 运行一个子 Agent
 * @param task - 子任务描述
 * @param client - 共享的 Anthropic 客户端
 * @param model - 使用的模型
 * @returns 子 Agent 最终输出的文本
 */
export async function runSubAgent(
  task: string,
  client: Anthropic,
  model: string
): Promise<string> {
  // 子 Agent 有自己的消息数组，从零开始
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: task }
  ];

  // 只给只读工具——从工具层面就断掉写操作的可能
  const tools = toolDefinitions.filter((t) => EXPLORE_TOOLS.has(t.name));

  // 子 Agent 的循环和主 Agent 完全一样
  while (true) {
    const reply = await client.messages.create({
      model, max_tokens: 4096,
      system: "You are an explore sub-agent. Investigate read-only and report back a concise summary.",
      tools, messages,
    });
    messages.push({ role: "assistant", content: reply.content });

    const toolUses = reply.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    // 没有工具调用 → 子任务完成，返回文本结果
    if (toolUses.length === 0) {
      return reply.content
        .filter((b) => b.type === "text")
        .map((b: any) => b.text).join("");
    }

    // 执行工具调用
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const output = EXPLORE_TOOLS.has(tu.name)
        ? await executeTool(tu.name, tu.input as Record<string, any>)
        : `Denied: the sub-agent is read-only.`;
      results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }
}
```

### 11.5 在 Agent 中集成

```typescript
/**
 * 在 Agent 的工具执行循环中特殊处理 "agent" 工具
 *
 * 当模型调 "agent" 工具时，不是执行本地逻辑，
 * 而是 fork 一个子 Agent，把结果拿回来。
 */
if (tu.name === "agent") {
  const summary = await runSubAgent(
    String((tu.input as any).task || ""),  // 子任务描述
    this.client,
    this.model
  );
  results.push({
    type: "tool_result",
    tool_use_id: tu.id,
    content: summary,  // 子 Agent 的最终结果
  });
  continue;  // 跳过后面的权限检查和本地执行
}
```

---

## 12. MCP 集成

### 12.1 问题

工具全写死在代码里——想加个新工具就得改源码。MCP 让 Agent 动态挂载外部工具。

### 12.2 核心思路

**spawn 子进程 → JSON-RPC 握手 → 发现工具 → 前缀注册 → 透明路由**

对 Agent Loop 来说，MCP 工具和内置工具没有区别——都是名字 + schema + 执行函数。

### 12.3 配置格式

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": {}
    }
  }
}
```

### 12.4 MCP 客户端实现

```typescript
/**
 * MCP 客户端：通过 stdio JSON-RPC 与外部工具服务器通信
 *
 * 协议流程：
 * 1. spawn 服务器子进程
 * 2. 发送 initialize 请求握手
 * 3. 发送 notifications/initialized
 * 4. 发送 tools/list 发现可用工具
 * 5. 把工具（带前缀）注册到 Agent 的工具列表
 * 6. 收到 mcp__server__tool 调用时，转发给对应服务器
 */

import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";

interface McpTool {
  name: string;
  description: string;
  input_schema: any;
}

export interface McpConnection {
  tools: McpTool[];
  callTool(name: string, args: any): Promise<string>;
}

/**
 * 连接 MCP 服务器
 * @param command - 启动命令，如 "node" 或 "npx"
 * @param args - 命令参数
 * @returns McpConnection 对象，包含发现的工具和调用方法
 */
export async function connectMcp(
  command: string, args: string[]
): Promise<McpConnection> {
  // 1. spawn 子进程，通过 stdio 通信
  const proc = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
  const rl = createInterface({ input: proc.stdout! });
  let nextId = 1;
  const pending = new Map<number, (v: any) => void>();

  // 监听 stdout，收到响应时根据 id 分发给对应的 pending promise
  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    } catch {
      // 忽略非 JSON 行（如服务器启动日志）
    }
  });

  // JSON-RPC 请求发送器
  const request = (method: string, params?: unknown) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      proc.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
      );
    });

  // 2. 初始化握手
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mini-claude", version: "1.0" },
  });

  // 3. 发送初始化完成通知
  proc.stdin!.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
  );

  // 4. 发现工具
  const listed = await request("tools/list");
  const tools: McpTool[] = (listed.result?.tools || []).map((t: any) => ({
    name: t.name,
    description: t.description || "",
    input_schema: t.inputSchema,
  }));

  return {
    tools,
    // 5. 工具调用：转发给服务器，解析返回结果
    async callTool(name, args) {
      const resp = await request("tools/call", { name, arguments: args });
      return resp.result?.content?.[0]?.text ?? JSON.stringify(resp.result);
    },
  };
}
```

### 12.5 在 Agent 中集成

```typescript
/**
 * MCP 工具集成
 *
 * MCP 工具以 "mcp__服务器名__工具名" 的格式注册到 Agent 工具列表。
 * 当模型调用时，Agent 根据前缀识别并路由到对应 MCP 服务器。
 */

private mcp: McpConnection | null = null;

/** 首次调用前连接 MCP 服务器，发现工具 */
async ensureMcp(): Promise<void> {
  if (this.mcp) return;
  const servers = loadMcpConfig();
  for (const [name, server] of Object.entries(servers)) {
    this.mcp = await connectMcp(server.command, server.args);
    // 工具名带前缀：mcp__filesystem__read_file
    this.mcpTools.push(...this.mcp.tools.map((t) => ({
      name: `mcp__${name}__${t.name}`,  // ← 前缀防止命名冲突
      description: t.description,
      input_schema: t.input_schema,
    })));
  }
}

// 在工具执行循环中按前缀路由
if (tu.name.startsWith("mcp__")) {
  // 解析：mcp__filesystem__read_file → server=filesystem, tool=read_file
  const [, serverName, ...toolNameParts] = tu.name.split("__");
  const toolName = toolNameParts.join("__");
  const output = await this.mcp.callTool(toolName, tu.input);
  results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
  continue;
}
```

---

## 13. 自治与续跑（/goal · /loop · Auto Mode）

### 13.1 问题

之前的章节让 Agent 能在一个 turn 里把活干完。但怎么让 Agent 跨很多 turn、在无人盯着的情况下继续往前走？

### 13.2 三件套分工


| 能力      | 解决的问题                 | 一句话                           |
| ----------- | ---------------------------- | ---------------------------------- |
| `/goal`   | 决定**要不要**继续         | 独立的评估器每轮判断条件是否达成 |
| `/loop`   | 决定**什么时候**开始下一次 | 定时重投或自定节奏               |
| Auto Mode | 决定**能不能**放行某个动作 | 分类器代替确认框                 |

### 13.3 `/goal` — 评估器回灌

```typescript
/**
 * 目标评估器：独立判断"目标是否达成"
 *
 * 这是一个独立的模型调用，不参与主对话。
 * 它只读一遍对话记录，回答"条件满足了吗？"。
 * 如果没满足，还要说"为什么没满足"，这个原因会被回灌给主模型。
 *
 * 三态输出：
 * - MET: 条件已满足
 * - NOT_MET <原因>: 条件未满足，原因是……
 * - NOT_MET impossible <原因>: 条件不可能满足（死循环刹车）
 */
export async function evaluateGoal(
  condition: string,    // 目标条件，如 "done.txt 存在"
  transcript: string,   // 当前对话记录
  client: Anthropic,
  model: string,
): Promise<{ met: boolean; reason: string }> {
  const reply = await client.messages.create({
    model, max_tokens: 256,
    // 评估器只判断，不干活——不给它任何工具
    system: `You are a goal evaluator. Given a condition and a transcript,
reply exactly 'MET' if the condition is satisfied,
otherwise 'NOT_MET: <short reason>'.`,
    messages: [{
      role: "user",
      content: `Condition: ${condition}\n\nTranscript so far:\n${transcript}`,
    }],
  });
  const text = reply.content
    .filter((b) => b.type === "text")
    .map((b: any) => b.text).join("").trim();

  if (text.startsWith("MET")) return { met: true, reason: "" };
  return { met: false, reason: text.replace(/^NOT_MET:?\s*/, "") };
}
```

当条件未达成时，评估器的原因被回灌到下一轮：

```typescript
/**
 * 追逐目标：反复执行直到条件达成
 *
 * 流程：
 * 1. 执行用户的初始 prompt
 * 2. 评估器判断条件是否达成
 * 3. 达成 → 退出
 * 4. 未达成 → 把原因回灌，让模型继续工作
 * 5. 最多 5 次迭代，超时放弃
 */
async pursueGoal(condition: string, prompt: string): Promise<void> {
  // 第一步：执行初始 prompt
  await this.chat(prompt);

  // 第二步：最多 5 轮评估-回灌循环
  for (let i = 0; i < 5; i++) {
    const verdict = await evaluateGoal(
      condition,
      this.transcriptText(),
      this.client,
      this.model
    );

    if (verdict.met) {
      // 目标达成
      console.log(`✓ goal met: ${condition}`);
      return;
    }

    // 目标未达成：把原因回灌给主模型
    console.log(`  (goal not met — ${verdict.reason}; continuing)`);
    await this.chat(
      `The goal "${condition}" is not met yet: ${verdict.reason}. Keep working toward it.`
    );
  }

  // 超时放弃
  console.log(`  (gave up after 5 iterations without meeting: ${condition})`);
}
```

### 13.4 Auto Mode — 分类器代替确认

```typescript
/**
 * Auto Mode 动作分类器
 *
 * 代替人工确认框：读一段对话记录，判断某个操作是否安全。
 * 分类器只看"脱敏"的对话记录（只含角色和文本，不含工具参数细节），
 * 然后回答 ALLOW 或 BLOCK。
 *
 * 这样 Agent 在无人值守时也能自己决定"这个操作能不能做"。
 */
export async function classifyAction(
  name: string,                 // 工具名
  input: Record<string, any>,   // 工具参数
  transcript: string,           // 对话记录（脱敏）
  client: Anthropic,
  model: string,
): Promise<{ allow: boolean; reason: string }> {
  const reply = await client.messages.create({
    model, max_tokens: 256,
    system: `You are an action classifier. Given a tool call and the conversation
transcript, reply 'ALLOW' if the action is safe, or
'BLOCK: <reason>' if it looks dangerous.`,
    messages: [{
      role: "user",
      content: `Tool: ${name}(${JSON.stringify(input)})\n\nTranscript:\n${transcript}`,
    }],
  });
  const text = reply.content
    .filter((b) => b.type === "text")
    .map((b: any) => b.text).join("").trim();

  if (text.startsWith("ALLOW")) return { allow: true, reason: "" };
  return { allow: false, reason: text.replace(/^BLOCK:?\s*/, "") };
}
```

在 Agent 循环中集成：

```typescript
/**
 * Auto Mode 拦截器
 *
 * 在权限检查之前插入：如果当前是 auto 模式，
 * 且模型要执行写/编辑/跑命令，先让分类器判断。
 * 分类器说 BLOCK 就不执行，说 ALLOW 才继续走权限检查。
 */
if (this.mode === "auto" && ["write_file", "edit_file", "run_shell"].includes(tu.name)) {
  const verdict = await classifyAction(
    tu.name, tu.input, this.transcriptText(), this.client, this.model
  );
  if (!verdict.allow) {
    // 分类器判拦截
    results.push({
      type: "tool_result", tool_use_id: tu.id,
      content: `Blocked by auto-mode monitor: ${verdict.reason}`,
    });
    continue;  // 跳过后续的权限检查
  }
  // ALLOW → 继续走正常的权限检查流程
}
```

---

## 14. 完整架构一览

### 14.1 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    用户输入 / CLI                             │
│  cli.ts: REPL 循环 + 参数解析 + 会话恢复                     │
└──────────────────────┬──────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    Agent 主循环 (agent.ts)                    │
│  while(true) {                                               │
│    ① 上下文压缩 → ② System Prompt 构建 → ③ 调模型          │
│    ④ 流式输出 → ⑤ 解析 tool_use → ⑥ 权限检查              │
│    ⑦ 执行工具 / 路由子Agent / MCP → ⑧ 结果喂回             │
│  }                                                           │
└─────────────────────────────────────────────────────────────┘
     │          │          │          │          │
     ▼          ▼          ▼          ▼          ▼
┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
│ tools.ts │ │ mcp.ts  │ │ memory  │ │ skills  │ │ subagent│
│ 6 核心   │ │ MCP 客户 │ │ .ts     │ │ .ts     │ │ .ts     │
│ + web_   │ │ 端 +    │ │ 跨会话  │ │ 技能    │ │ 子 Agent│
│ fetch    │ │ JSON-RPC│ │ 记忆    │ │ 系统    │ │ 系统    │
│ + skill  │ │ 外部工具 │ │ 语义召回│ │ /name   │ │ fork-   │
│ + agent  │ │         │ │         │ │ 调用    │ │ return  │
└─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘
```

### 14.2 文件结构

```
src/
├── agent.ts      # Agent 主循环（~2169 行）
├── tools.ts      # 工具定义与执行（~400 行）
├── prompt.ts     # System Prompt 构建（~300 行）
├── cli.ts        # CLI 入口与 REPL（~200 行）
├── session.ts    # 会话持久化（~50 行）
├── ui.ts         # 终端 UI（~200 行）
├── permissions.ts # 权限系统（~200 行）
├── context.ts    # 上下文压缩（~200 行）
├── memory.ts     # 记忆系统（~200 行）
├── skills.ts     # 技能系统（~200 行）
├── subagent.ts   # 子 Agent 系统（~200 行）
├── mcp.ts        # MCP 集成（~300 行）
├── autonomy.ts   # 自治系统（~300 行）
├── frontmatter.ts # YAML frontmatter 解析（~50 行）
└── ...
```

### 14.3 核心设计原则总结


| 原则                                       | 描述                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| **Agent 的本质是一个 while 循环**          | 调模型 → 执行工具 → 结果喂回，所有复杂性都是围绕这个循环的增强和防护 |
| **提示词是最便宜的代码**                   | System Prompt 里的一句话，效果等同于一个 if 语句，实现成本为 0         |
| **工具设计决定能力上限**                   | 让模型做理解意图、生成代码；让工具做精确匹配、文件操作、进程管理       |
| **上下文管理是 Agent 的"内存管理"**        | 4 层压缩流水线让有限窗口提供"无限"错觉                                 |
| **安全不是事后补丁**                       | 权限检查是循环的一个步骤，不是外挂 middleware。fail-closed 设计        |
| **模型决定"做什么"，代码确保"安全地做"**   | 协作边界划得好，Agent 既灵活又可靠                                     |
| **从 3000 行到 50 万行的差距在于边缘情况** | 兼容性、可靠性、用户多样性、企业审计——这些"无聊"的代码才是产品关键   |

### 14.4 从零开始的构建路线

```
第 1 章：十几行的聊天循环
    ↓ 加工具回路
第 2 章：能读文件、改代码的 Agent
    ↓ 加 System Prompt
第 3 章：知道自己是谁、在哪干活
    ↓ 加 CLI + 会话
第 4 章：有 REPL 界面，能 --resume
    ↓ 加流式
第 5 章：输出逐字显示，支持 OpenAI 后端
    ↓ 加权限
第 6 章：危险操作被拦下，安全可配置
    ↓ 加上下文管理
第 7 章：长对话自动压缩，不撑爆窗口
    ↓ 加记忆系统
第 8 章：跨会话记住偏好和项目事实
    ↓ 加技能系统
第 9 章：/commit 一声就调起技能
    ↓ 加 Plan Mode
第 10 章：先规划再动手，审批后执行
    ↓ 加多 Agent
第 11 章：大任务拆给子 Agent 并行啃
    ↓ 加 MCP
第 12 章：接外部工具，不写代码扩展能力
    ↓ 加自治系统
第 13 章：/goal 追条件，/loop 定时跑，Auto Mode 无人值守
```

---

> 约 5500 行 TypeScript（或 5000 行 Python），13 个核心文件，覆盖了一个 Coding Agent 的全部核心组件。
>
> 从零开始，一次只加一块能力，每块都能单独跑。最终得到的是一个能读代码、改文件、跑测试、跨会话记忆、多 Agent 协作、接外部工具、还能自治续跑的完整编程助手。
>
> **这就是你自己的 Claude Code。**
