【todo】大模型思考过程中，/skills以及/mcp的面板显示不出来
【todo】思考过程中，用户二次输入提示词会被忽略，增加用户提示词输入队列以及用户通过快捷键强制插入给大模型获取回复后继续执行原来的工具调用或者模型推理
【todo】支持用户输入的指令历史缓存，当前会话期间支持按键上/下按键进行历史输入的快速切换，目前好像只能缓存一个，其他的会丢失
【todo】默认权限模式是auto模式
【todo】ctrl + o 打开日志面板的时候，支持默认每次打开滚动到底部查看最新日志，包括工具，系统日志，子agent日志三个面板
【todo】项目的todo清单提供一个/todo_clear的快捷指令
【todo】项目启动的时候，有点慢是不是被mcp启动阻塞了，可以改成异步起动mcp, 如果遇到需要执行的mcp且mcp未就绪则提示用户
【todo】新增 `/btw` 与 `/fork` 命令 ：`/btw` 可以让你在不打断当前任务的情况下，另开一个线程处理临时想到的旁支问题；`/fork` 则能从当前线程分出一条新路线，方便你并行尝试不同的实现方案

---

# 实现状态（已完成）

全部 8 项已落地，`bun test` 592 → 632 用例全绿（51 → 57 个文件），`bun run typecheck` 干净。

| # | 项 | 落点 |
|---|---|---|
| 1 | 思考中 `/skills` `/mcp` 打不开 | `src/prompt-queue.ts` 分流 + `cli.handleLocal`（忙碌期立刻执行） |
| 2 | 忙碌期输入队列 + 强插 | `PromptQueue` + `Ctrl+Enter`（`onInterruptAndSend`） |
| 3 | 输入历史逐条上翻 | `app.tsx` 去掉 `input === ''` 硬条件 + `navigatingRef` 防重置 |
| 4 | 默认 auto 模式 | `initialMode()` 兜底 `auto`，新增 `--default`；controller 同步 |
| 5 | Ctrl+O 打开即贴底 | `output-panel.tsx` 的 `scrollTo(Infinity)` + `afterLayout` |
| 6 | `/todo_clear` | `user-todo.ts:clearAllUserTodos` + cli 分发 + 斜杠菜单 |
| 7 | MCP 异步启动 | `runTtyCli` 改为挂载后 `void agent.initMcp()` |
| 8 | `/btw`（旁支只读提问） | `agent.runBtwThread` + `cli.runBtwCommand`（`/fork` 已按需求移除） |

新增测试：`prompt-queue` / `ui-input-history` / `ui-interrupt-send` /
`mode-default` / `user-todo-clear` / `btw`。

## 遗留说明

- **MCP 窗口期**：异步启动期间模型调用未挂载的 MCP 工具会拿到 `Unknown tool`
  （fail-closed 不变）。这是"快启动"换来的确定性代价，README 已写明。
- **Ctrl+Enter 打断**会让在飞工具作废（与原 Esc 语义一致）。
