# B Code (bcode)

一个从零构建的编码 Agent CLI —— 你自己的 Claude Code。

在终端里用自然语言下达任务：读代码、改文件、跑命令、写计划，全程可见工具调用与权限审批。

> 版本变更见 [CHANGELOG.md](./CHANGELOG.md)。

```
npm i -g @bysking/b-code    # 全局安装
# 或
npx -y @bysking/b-code      # 免安装直接使用
```

## 安装

```bash
# 从 npm 全局安装（推荐）
npm i -g @bysking/b-code

# 或从本仓库安装（需要先构建，见「开发」）
npm run build && npm i -g .
```

安装后得到 `bcode` 命令。开发模式直接运行：

```bash
npm run dev            # 相当于 tsx src/index.ts
```

## 快速开始

**One-shot（执行一条指令后退出）：**

```bash
bcode "Read the README and summarize what this project does"
```

**REPL（交互式多轮对话，每轮自动保存）：**

```bash
bcode
```

## 命令行参数


| 参数                         | 说明                                                |
| ------------------------------ | ----------------------------------------------------- |
| `bcode "指令"`               | One-shot：执行单条指令后保存退出（可含权限确认）    |
| `bcode`                      | REPL：交互式多轮对话                                |
| `bcode --resume`             | REPL 并恢复上次会话                                 |
| `bcode --session <id>`       | 恢复指定会话（配合`--resume`）                      |
| `bcode --plan "指令"`        | Plan 模式：写 / 编辑 / shell 全部拦截，只读规划     |
| `bcode --yolo "指令"`        | Bypass 模式：跳过 confirm（危险命令 deny 仍拦得住） |
| `bcode --auto "指令"`        | Auto 模式：用分类器代替确认框                       |
| `bcode --goal <条件> "指令"` | Auto 追目标：无人值守循环，直到条件达成             |
| `bcode --loop <秒> "指令"`   | 定时重投：每隔 N 秒重复执行指令（Ctrl-C 停止）      |
| `bcode --output-format json "指令"` | headless 输出结构化 JSON（结果/工具/用量），供 CI/脚本消费 |

`--output-format json` 示例输出：

```json
{
  "success": true,
  "session_id": "20260903-101500-ab",
  "model": "claude-sonnet-4-5-20250929",
  "instruction": "读取 package.json",
  "result": "该文件定义了……",
  "tools": [{ "name": "read_file", "input": { "file_path": "package.json" }, "output": "…" }],
  "usage": { "input_tokens": 1200, "output_tokens": 340, "calls": 2 },
  "error": null
}
```

退出时会打印恢复命令，例如：

```
想恢复本次会话，执行:
  bcode --resume --session <id>
```

## 交互界面（TTY）

TTY 下使用 Ink 渲染：思考过程、工具调用块、Markdown 回复、权限确认、斜杠菜单均为声明式 UI。

**斜杠命令（输入 `/` 可唤起补全菜单，菜单超长时随选中项滚动）：**


| 命令               | 说明                                         |
| -------------------- | ---------------------------------------------- |
| `/clear`           | 清空当前对话历史（并重置"本轮自动审批"标记） |
| `/help`            | 显示命令与快捷键帮助                         |
| `/cost`            | 本次会话 token 用量与估算成本                |
| `/model [名字]`    | 查看 / 运行时切换模型                        |
| `/compact`         | 立即压缩上下文（摘要旧消息）                 |
| `/rewind`          | 回退本次会话已改动的文件（检查点还原）       |
| `/todos`           | 查看模型自管的任务清单                       |
| `/plan`            | 切换 Plan（只读）模式                        |
| `/yolo`            | 切换 Bypass 模式                             |
| `/auto`            | 切换 Auto 模式（分类器管控写/shell）         |
| `/default`         | 切换回默认模式                               |
| `/skills`          | 技能面板：空格启用/禁用（禁用的不发给模型）  |
| `/mcp`             | MCP 面板：空格启用/禁用，`R` 重连            |
| `/remember <事实>` | 保存一条长期记忆                             |
| `exit` / `quit`    | 退出                                         |

**快捷键：**

- `Esc`：硬中断当前对话——立即取消在飞的模型请求、终止 `run_shell` 子进程，回到输入等待新指令（可继续输入）
- `Ctrl+O`：切换工具输出面板（回看本轮全部工具/子 agent 的真实输出）
- `Shift+Tab`：循环切换模式（default → plan → auto → bypass）
- 历史回看：`PgUp` / `PgDn` 翻页、`↑` / `↓` 逐行、或**鼠标滚轮**
- `↑` / `↓`：输入历史导航
- `Ctrl+V` / `Cmd+V`：粘贴图片（存为 `[image #N]`）；纯文本粘贴由括号粘贴模式自动处理
- `Meta+Enter`（Option+Enter）：输入框内换行
- `Ctrl+C`：第一次提示、2 秒内再按一次退出

非 TTY（管道 / CI / 脚本）下自动退化为 readline 交互，语义保持一致；权限确认只消费 `y/n` 行。

> **关于历史与滚动**：历史渲染在应用内的滚动视口里（不交给终端 scrollback），
> 滚动位置由应用自己管理。三种方式都可用：`PgUp`/`PgDn` 翻页、`↑`/`↓` 逐行、
> **鼠标滚轮**（每格 3 行）。
>
> 为什么不交给终端 scrollback：那样 history 会进 scrollback，但窗口 resize 时 ink
> 需要按新布局重写已打印内容，流式长输出还容易出现"擦除行数对不上导致内容重复"。
> 应用内视口把这些风险都消除了——resize 只是重新布局同一帧，流式再长也只是滚动。
>
> 代价是退出后终端里看不到本次历史，用 `bcode --resume` 回看。另外开启鼠标追踪后
> 终端的原生选中复制会被接管，按住 `Shift` 拖动即可恢复。

## 安装与分发

```bash
npm install -g @bysking/b-code
bcode
```

**无需安装 Node 或 Bun** —— 发布版是 `bun build --compile` 出的单文件可执行程序，
Bun 运行时已嵌入。

### 支持平台

| 平台 | 包名 | 说明 |
|---|---|---|
| macOS (Apple Silicon) | `@bysking/b-code-darwin-arm64` | |
| macOS (Intel) | `@bysking/b-code-darwin-x64` | |
| Linux (glibc) | `@bysking/b-code-linux-x64` | Ubuntu/Debian/CentOS 等 |
| Windows (x64) | `@bysking/b-code-win32-x64` | |

npm 通过 `os`/`cpu` 字段自动只装匹配的平台包，用户只下载自己那份（~75MB）。

### 两套渲染引擎

| | ink（回退） | OpenTUI（默认） |
|---|---|---|
| 运行时 | Node | Bun（已嵌入） |
| 产物 | `dist/cli.mjs` 1.9MB | `dist/bcode` ~75MB |
| 滚动 | 应用内视口（手写虚拟滚动） | 原生 `scrollbox` |
| 鼠标 | 手写 SGR 解析 | 原生 `useRawMouse` |
| markdown | marked + marked-terminal | 原生组件 |

业务组件通过 `src/ui/ui/` 适配层访问渲染能力，与具体引擎解耦。
切换引擎只改适配层的实现，业务代码不动。

**为什么保留 ink**：OpenTUI 的原生 FFI 只实现了 Bun 绑定（Node 26 实测也不行）。
开发态用 Node 跑测试时走 ink 更省事；发布版二进制里用 OpenTUI。

### 构建

```bash
npm run build        # ink 版（Node，1.9MB）— 开发与回退
npm run build:bun    # OpenTUI 版（Bun，~75MB）— 发布
node scripts/pack-platform.js   # 生成平台包
```

**各平台必须原生编译**：OpenTUI 的动态 import 让打包器把所有平台的
`@opentui/core-<platform>` 都当必需依赖，而这些包带 `os`/`cpu` 字段，
npm 只允许装当前平台的 → 交叉编译会因缺包失败。全平台发布由
`.github/workflows/release.yml` 的 CI 矩阵完成。

## 权限与模式

四种模式：`default` / `plan` / `bypass` / `auto`。

权限判定三态：**allow（放行）/ deny（拦截）/ confirm（询问）**，遵循三个原则：

1. **deny 优先** —— 危险命令在任何模式（含 `--yolo`）下都拦得住；
2. **fail-closed** —— 未声明模式的工具默认 confirm，不默认放行；
3. **plan 只读由权限层强制** —— 不靠提示词"求"模型别动。

以下危险命令直接 deny（连 `--yolo` 也绕不过）：

```
rm -rf / git reset --hard / sudo / mkfs
> /dev/ 设备写入 / dd（命令名）/ kill（命令名）/ reboot / shutdown
```

> `kill`/`dd` 等短词按**命令边界**匹配（命令串开头或 `;` `&` `|` 之后），
> 因此 `npm run kill-port`、`git add .`、`ls dd-utils` 这类合法命令不会被误杀。

**敏感命令**（如 `git push`）默认需确认，但可授权后**持久化免问**：在确认框选择
批准（Yes / 本轮会话自动审批通过）后，该次授权写入 `{B_CODE_HOME}/settings.json` 的
`permissions.allow`，下次启动依然生效（无需重复批准）。持久化键按语义取值——
shell 按命令整串、文件类按 `工具:路径`（不按内容），避免"一次批准 = 永久放行整个工具"。

### 各模式的实际边界

| | plan | default | auto | bypass |
|---|---|---|---|---|
| `read` 工具 | ✅ 放行 | ✅ 放行 | ✅ 放行 | ✅ 放行 |
| `write` / `shell` | ⛔ 拦截 | ❓ 确认 | 🤖 分类器裁决 | ✅ 放行 |
| `external`（MCP） | ⛔ 拦截 | ❓ 确认 | ❓ **确认** | ✅ 放行 |
| 危险命令（`rm -rf` 等） | ⛔ 拦截 | ⛔ 拦截 | ⛔ 拦截 | ⛔ **拦截** |
| 敏感命令（`git push`） | ⛔ 拦截 | ❓ 确认 | ❓ **确认** | ❓ **确认** |

两个容易被误解的点：

- **bypass 不是"什么都放行"**：危险命令仍被 deny（写死在权限层，任何模式绕不过）；
  `git push` 这类敏感命令即使 bypass 也仍要人工确认。bypass 跳过的是**普通确认框**。
- **auto 模式不自动放行 MCP 工具**：auto 的分类器只裁决 `write` / `shell` 两类。
  MCP 是 `external`，分类器对它的输入（JSON 参数）几乎没有判断力——
  把 `mcp__jira__delete_issue` 交给它，与 `get_issue` 看不出区别，等于盲目放行。
  这是刻意的 fail-closed。

### 让 MCP 工具免确认的两条路

1. **在 `mcp.json` 里声明只读**（推荐给纯读 server）：
   ```json
   { "mcpServers": { "docs": { "command": "npx", "args": ["-y", "@x/docs"], "mode": "read" } } }
   ```
   该 server 所有工具按 `read` 处理：plan 模式放行、任何模式都免确认。

2. **确认一次，授权整个 server**：在确认框选批准后，MCP 工具的持久化键折叠为
   `mcp__<server>__*` 写入白名单——同一个 server 的其他工具不再问（包括 server
   升级后新增的工具）。别的 server 不受影响。

## 技能（Skills）

把常用提示词包装成 `/name 参数` 命令。技能支持两种形态，技能名 = 文件名 / 目录名：

**平铺文件** `{name}.md` —— 单文件即技能：

```markdown
---
name: commit
description: 用规范格式提交代码
user-invocable: true
---

按以下规范提交：$ARGUMENTS
```

**技能目录** `{name}/SKILL.md` —— 对齐 Claude 生态，目录名即技能名，描述与正文读目录下的 `SKILL.md`（或小写 `skill.md`），目录里的其他文件（reference、模板等）作为技能资源：

```
.claude/skills/
├── commit.md                      # 平铺形态
└── changelog-generator/
    ├── SKILL.md                   # 目录形态：描述 + 正文
    └── templates/                 # 技能资源，不参与解析
```

两种形态的差异：

| | 平铺文件 | 技能目录 |
|---|---|---|
| 技能名 | 文件名（去 `.md`） | 目录名 |
| `user-invocable` | 需显式写 `true` | 默认可调用，写 `false` 关闭 |
| 同名冲突 | 同目录内平铺优先 | — |

**调用参数透传**：`/技能名 参数1 参数2` 的参数会填进技能正文，技能里调用的工具因此能拿到它们。

| 占位符 | 含义 |
| --- | --- |
| `$ARGUMENTS` | 全部参数（原始字符串） |
| `$1` `$2` … | 第 n 个参数（越界替换为空） |

参数按空白切分，双引号可包裹含空格的多词参数：`/merge "feature/login fix" main`。

```
# .claude/skills/merge/SKILL.md
把分支 $1 合并到 $2，完整请求: $ARGUMENTS
```

**正文里一个占位符都没写时，参数会以 `[调用参数] …` 追加到末尾**——避免技能作者忘了写
`$ARGUMENTS` 导致参数被静默丢弃（技能里的工具就拿不到分支名、路径这类必需值了）。

技能调用优先于普通对话（内置命令如 `/clear` 精确匹配，始终优先）：`/commit 修复登录 bug`
→ 命中 `commit` 技能并填入参数。

frontmatter 的 `description` 支持块标量多行写法（`>-` 折叠成一行、`|` 保留换行），与 Claude 生态 SKILL.md 兼容。

**搜索链（越靠前优先级越高，同名技能前者生效）：**

1. `{cwd}/.claude/skills` —— 项目级
2. `$B_CODE_SKILLS_DIR` —— 显式覆盖（CI / 多环境）
3. `$B_CODE_HOME/skills` —— 用户级，随数据根迁移
4. `~/.claude/skills` —— 兼容既有 Claude 生态的兜底

**启用/禁用：** `/skills` 打开交互面板，`↑↓` 选择、`空格` 启停、`Esc` 关闭。
禁用的技能**不进 system prompt**（省 token，模型也不会主动推荐），但手动
`/commit` 依然照常执行——语义是"不主动推给模型"，不是封死。
状态存在 `{B_CODE_HOME}/settings.json` 的 `disabled.skills`（全局生效，跨项目持久）。

## 记忆（Memory）

跨会话长期记忆。模型通过 `save_memory` 工具主动沉淀（经用户确认后落盘），也可以在 REPL 里用 `/remember` 手动保存。

- **存储**：`{B_CODE_HOME}/projects/{sha256(cwd)前16位}/memory/*.md`
- **召回**：关键词重叠打分，纯确定性、不调模型；top3 注入 system prompt 末尾
- **隔离**：同一目录的工作区各自独立记忆

## MCP

基于官方 [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) 接入，
协议细节（JSON-RPC 编解码、版本协商、错误码、超时、session）由 SDK 保证。

**配置搜索链（env 最高优先，同名 server 后者胜）：**

1. `$B_CODE_MCP_CONFIG` —— 显式覆盖
2. `{cwd}/.claude/mcp.json` —— 项目级
3. `{B_CODE_HOME}/mcp.json` —— 用户级

### 两种传输

**本地子进程（stdio）** —— `command` / `args` / `env`：

```json
{
  "mcpServers": {
    "docs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }
  }
}
```

**远程端点（Streamable HTTP）** —— `url` / `headers`：

```json
{
  "mcpServers": {
    "sentry": {
      "url": "https://mcp.sentry.dev/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

同时写了 `command` 和 `url` 时按本地子进程处理。

### 权限模式

每个工具的权限按三级判定（优先级从高到低）：

1. **server 级 `mode: "read"`** —— 整片声明信任，该 server 所有工具按只读放行
2. **工具自身的 `annotations.readOnlyHint`** —— MCP 规范的语义标注，可信，自动按只读处理
3. **缺省 fail-closed** —— `external`，任何写入都需要确认

```json
{ "mcpServers": { "docs": { "command": "npx", "args": ["..."], "mode": "read" } } }
```

`annotations.destructiveHint` 为真的工具会在描述里标 `⚠️ destructive`，让模型自己谨慎。

**确认一次 = 授权整个 server**：在确认框选批准后，白名单写入 `mcp__<server>__*`，
该 server 的其他工具（包括 server 升级后新增的）不再询问。别的 server 不受影响。

### 启用/禁用与重连

`/mcp` 打开交互面板：`↑↓` 选择、`空格` 启停、`R` 重连、`Esc` 关闭。

- **禁用** = 该 server 的工具从模型可见的 `toolsSchema` 摘掉（不花 token）；连接保持，
  重新启用瞬时生效。与技能不同，MCP 没有"手动调用"通道，所以禁用即模型不可见。
- **重连（`R`）** = 重新建立传输 → 重新握手 → 重新注册工具。用于进程崩了、远程端点
  换了 token、或配置文件改了想立刻生效。失败时该 server 的工具会被完全摘除
  （不留指向死连接的 handler）。
- 状态存在 `{B_CODE_HOME}/settings.json` 的 `disabled.mcpServers`（全局生效）。

**子进程 stderr 不会污染终端**：传输层把 server 的 stderr 收进日志系统
（`Ctrl+O` 的"日志"页可查），而不是直接继承终端——否则 server 随手一行输出就会
打乱 TUI 画面。

**资源（resources）**：server 若声明 `resources` 能力并返回资源列表，b-code 会把它们
聚合为一个只读工具 `mcp__<server>__read_resource`（参数 `uri`），模型可按 URI 读取
`resources/read` 的内容；不支持资源的 server 自动跳过，不影响工具发现。

### 动态工具与通知

- **工具热更新**：server 发 `notifications/tools/list_changed` 时，b-code 会重新拉取
  工具列表并自动重注册——**不需要手动按 `R` 重连**。用于 server 按需解锁功能的场景。
- **资源订阅**：server 声明 `resources.subscribe` 时可订阅某 URI，内容变更时收到
  `notifications/resources/updated` 推送。

### 反向调用（server → client）

MCP 允许 server 请求客户端代做它自己做不到的事。b-code 默认支持两项：

| 能力 | 作用 | 是否默认开启 |
|---|---|---|
| `roots` | 告诉 server 工作区根目录 | ✅（就用当前工作目录） |
| `sampling` | server 借用宿主模型跑一次补全 | ✅（用当前配置的模型） |
| `elicitation` | server 弹表单问用户 | ❌ 刻意不声明 |

**为什么 sampling 是安全的**：server 没有 LLM 凭证，借我们的模型是规范内的设计；
调用走本 agent 的模型通道，但**不写入会话历史**（旁路调用，不污染对话上下文）。

**为什么不开 elicitation**：那等于让 server 绕过 b-code 的交互与权限体系直接弹窗，
既可能打断用户正在做的事，也会绕过权限确认。等有明确需求再说。

原则是**注入才声明**：不注入宿主能力就不向 server 声明该 capability，
server 会据此自行降级，而不是发一个永远没人处理的请求然后超时。

## 任务清单（TodoWrite）

模型可调用 `todo_write` 工具维护一份**结构化任务清单**（`pending` / `in_progress` / `completed`），
多步任务里据此自我跟踪进度；底部固定面板展示清单与完成度（如 `任务清单 2/5`），跨会话存续。

- 存储：`{B_CODE_HOME}/projects/{sha256(cwd)前16}/todo.json`（按项目隔离）
- 查看：`/todos`；该工具只写自身数据目录，**免权限确认**

> 与工具调用面板（"正在跑什么"）不同，这份清单描述**"要做什么、做到哪了"**。

## 回退（/rewind）

`write_file` / `edit_file` 执行前会自动记录文件前像（检查点），`/rewind` 按逆序还原，
把工程恢复到本次会话改动前（新建的文件会被删除）。回退是**破坏性操作**，会先经确认框确认。

## 生命周期钩子（Hooks）

在 `settings.json` 的 `hooks` 字段配置外部命令，在关键节点自动执行（协议对齐 Claude Code）：

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "command": "node ./hooks/lint-prompt.mjs" }],
    "PreToolUse": [{ "matcher": "^write_|^edit_", "command": "node ./hooks/guard.mjs", "timeoutMs": 10000 }],
    "PostToolUse": [{ "matcher": "^run_shell$", "command": "node ./hooks/notify.mjs" }]
  }
}
```

| 事件 | 时机 | 可否拦截 |
|------|------|----------|
| `UserPromptSubmit` | 用户提交、发给模型之前 | ⚠️ 退出码 2 → 原因作为 `[hook notice]` 追加进 prompt |
| `PreToolUse` | 工具执行前（权限通过后） | ✅ 退出码 2 或 stdout 输出 `{"decision":"block","reason":"…"}` → 拦截 |
| `PostToolUse` | 工具执行后 | – stdout 作为 `[PostToolUse hook]` 追加到结果 |

- 事件 JSON 经 **stdin** 传入，`hook_event_name` 区分事件；环境变量 `B_CODE_HOOK_EVENT` 同样可用
- `matcher` 为工具名正则（仅 Pre/PostToolUse 有意义；缺省匹配全部）
- 命令超时（缺省 60s）、异常、非 2 非 0 退出码一律 **fail-open**（不阻断主流程）

## 配置

### settings.json

配置文件位于 `{B_CODE_HOME}/settings.json`（`B_CODE_CONFIG` 可覆盖路径），复制 `settings.example.json` 后按需填写。

**合并原则：真实环境变量优先，配置只是缺省值** —— 已 export 的键不会被覆盖。


| 字段       | 说明                                                    |
| ------------ | --------------------------------------------------------- |
| `provider` | `"anthropic"` 或 `"openai"`（缺省按 endpoint 智能判断） |
| `apiKey`   | 对应 provider 的密钥                                    |
| `baseUrl`  | 对应 provider 的端点（支持 OpenAI 兼容端点）            |
| `model`    | 覆盖默认模型名（等价`B_CODE_MODEL`）                    |
| `env`      | `{ KEY: value }` 注入环境变量                           |
| `permissions` | `{ "allow": ["…"] }` 持久化白名单（授权"记住不再问"后自动写入） |
| `hooks`    | 生命周期钩子（见「生命周期钩子」章节）                  |

### 环境变量


| 变量                                     | 说明                                          |
| ------------------------------------------ | ----------------------------------------------- |
| `B_CODE_HOME`                            | 数据根目录（必须绝对路径；缺省`~/.b-code`）   |
| `B_CODE_CONFIG`                          | 配置文件路径覆盖                              |
| `B_CODE_MODEL`                           | 模型名覆盖                                    |
| `B_CODE_MAX_TOKENS`                      | 单次输出上限 token（缺省 4096）               |
| `B_CODE_THINKING`                        | 正整数时开启 extended thinking（预算 token）  |
| `B_CODE_HTTP_TIMEOUT`                    | OpenAI 兼容后端流式空闲超时 ms（缺省 120000） |
| `B_CODE_SHELL_TIMEOUT`                   | `run_shell` 命令超时 ms（缺省 30000）         |
| `B_CODE_SKILLS_DIR`                      | 技能目录覆盖                                  |
| `B_CODE_MCP_CONFIG`                      | MCP 配置文件覆盖                              |
| `B_CODE_LOG_LEVEL`                       | 日志级别：`debug` / `info` / `warn` / `error` |
| `B_CODE_LOG_FILE`                        | `true` 时输出日志到文件                       |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`   | 对应 provider 的密钥                          |
| `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` | 对应 provider 的端点                          |

## 数据目录

启动时自动创建（对齐 Claude Code 的约定目录）：

```
{B_CODE_HOME}/
├── sessions/     # 会话持久化
├── logs/         # 调试日志
├── projects/     # 跨项目记忆 + 任务清单（按项目哈希隔离）
├── skills/       # 用户级技能
├── plans/        # Plan 文件
├── settings.json # 全局配置（含持久化白名单 / hooks）
├── session.json  # 最近一次会话
└── mcp.json      # 用户级 MCP 配置
```

## 开发

```bash
npm install        # 安装依赖
npm run dev        # 开发运行（tsx 直跑 TS 源码）
npm run typecheck  # 类型检查
npm test           # 单元测试
npm run build      # esbuild 打包 → dist/cli.mjs（单文件，含全部依赖）
node dist/cli.mjs  # 验证产物
```

发布前 `prepublishOnly` 会自动执行 `npm run build && npm test`。

## License

MIT
