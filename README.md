# B Code (bcode)

一个从零构建的编码 Agent CLI —— 你自己的 Claude Code。

在终端里用自然语言下达任务：读代码、改文件、跑命令、写计划，全程可见工具调用与权限审批。

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

退出时会打印恢复命令，例如：

```
想恢复本次会话，执行:
  bcode --resume --session <id>
```

## 交互界面（TTY）

TTY 下使用 Ink 渲染：思考过程、工具调用块、Markdown 回复、权限确认、斜杠菜单均为声明式 UI。

**斜杠命令（输入 `/` 可唤起补全菜单）：**


| 命令               | 说明                                         |
| -------------------- | ---------------------------------------------- |
| `/clear`           | 清空当前对话历史（并重置"本轮自动审批"标记） |
| `/plan`            | 切换 Plan（只读）模式                        |
| `/yolo`            | 切换 Bypass 模式                             |
| `/auto`            | 切换 Auto 模式（分类器管控写/shell）         |
| `/default`         | 切换回默认模式                               |
| `/skills`          | 列出可用技能                                 |
| `/mcp`             | 列出已配置的 MCP server                      |                        |
| `/remember <事实>` | 保存一条长期记忆                             |
| `exit` / `quit`    | 退出                                         |

**快捷键：**

- `Esc`：软中断当前对话（可继续输入新指令）

非 TTY（管道 / CI / 脚本）下自动退化为 readline 交互，语义保持一致；权限确认只消费 `y/n` 行。

## 权限与模式

四种模式：`default` / `plan` / `bypass` / `auto`。

权限判定三态：**allow（放行）/ deny（拦截）/ confirm（询问）**，遵循三个原则：

1. **deny 优先** —— 危险命令在任何模式（含 `--yolo`）下都拦得住；
2. **fail-closed** —— 未声明模式的工具默认 confirm，不默认放行；
3. **plan 只读由权限层强制** —— 不靠提示词"求"模型别动。

以下危险命令直接 deny（连 `--yolo` 也绕不过）：

```
rm -rf / git push / git reset --hard / sudo / mkfs
> /dev/ 设备写入 / dd / kill / reboot / shutdown
```

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

正文里的 `$ARGUMENTS` 会被替换为调用时传入的参数。技能调用优先于普通对话：
`/commit 修复登录 bug` → 命中 `commit` 技能并替换参数。

frontmatter 的 `description` 支持块标量多行写法（`>-` 折叠成一行、`|` 保留换行），与 Claude 生态 SKILL.md 兼容。

**搜索链（越靠前优先级越高，同名技能前者生效）：**

1. `{cwd}/.claude/skills` —— 项目级
2. `$B_CODE_SKILLS_DIR` —— 显式覆盖（CI / 多环境）
3. `$B_CODE_HOME/skills` —— 用户级，随数据根迁移
4. `~/.claude/skills` —— 兼容既有 Claude 生态的兜底

## 记忆（Memory）

跨会话长期记忆。模型通过 `save_memory` 工具主动沉淀（经用户确认后落盘），也可以在 REPL 里用 `/remember` 手动保存。

- **存储**：`{B_CODE_HOME}/projects/{sha256(cwd)前16位}/memory/*.md`
- **召回**：关键词重叠打分，纯确定性、不调模型；top3 注入 system prompt 末尾
- **隔离**：同一目录的工作区各自独立记忆

## MCP

启动时自动挂载配置的 MCP 服务器（失败仅记日志，不阻塞）。

**配置搜索链（env 最高优先，同名 server 后者胜）：**

1. `$B_CODE_MCP_CONFIG` —— 显式覆盖
2. `{cwd}/.claude/mcp.json` —— 项目级
3. `{B_CODE_HOME}/mcp.json` —— 用户级

```json
{
  "mcpServers": {
    "demo": {
      "mode": "read",
      "command": "node",
      "args": ["/path/to/server.cjs"]
    }
  }
}
```

`mode: "read"` 声明该 server 所有工具按只读放行（免确认）；缺省 fail-closed → 需要确认。

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
├── projects/     # 跨项目记忆（按项目哈希隔离）
├── skills/       # 用户级技能
├── plans/        # Plan 文件
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
