# Changelog

本项目所有值得记录的变更都会写在这里。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 SemVer](https://semver.org/lang/zh-CN/)。

分类：`Added`（新增）/ `Changed`（变更）/ `Fixed`（修复）/ `Removed`（移除）。

> **维护约定**：改动合并前，把面向用户的变更追加到 `[Unreleased]` 对应分类下；
> 发版时把 `[Unreleased]` 内容移到新版本号小节并标注日期（同时更新 `package.json` 的 `version`）。

---

## [Unreleased]

### Added

- **结构化任务清单**：新增 `todo_write` 工具，模型可维护 `pending / in_progress / completed`
  状态的任务清单，底部固定面板展示完成度；按项目隔离存储（`projects/{hash}/todo.json`），
  跨会话存续。新增 `/todos` 查看命令。
- **运行时命令**：`/help`（命令与快捷键）、`/cost`（本次会话 token 用量与估算成本）、
  `/model [名字]`（运行时切换模型）、`/compact`（立即压缩上下文）。
- **`--output-format json`**：headless 结构化输出（结果 / 工具调用 / 用量 / 错误），
  供 CI 与脚本消费，退出码 0/1。
- **生命周期钩子（Hooks）**：`settings.json` 的 `hooks` 字段可挂外部命令，支持
  `UserPromptSubmit` / `PreToolUse`（可拦截）/ `PostToolUse`；协议对齐 Claude Code
  （事件 JSON 走 stdin、退出码 2 拦截），超时与异常一律 fail-open。
- **检查点回退**：`/rewind` 可把 `write_file` / `edit_file` 的改动按逆序还原（回退前确认）。
- **MCP 资源**：支持 `resources/list` + `resources/read`，聚合为只读工具
  `mcp__<server>__read_resource`；不支持的 server 自动跳过。
- **`.gitignore` 支持**：`grep_search` / `list_files` 现在尊重 `.gitignore`
  （含锚定、`!` 取反、仅目录、`**/` 等 git 语义与目录级作用域）。

### Changed

- **权限白名单持久化**：确认框选择授权后写入 `settings.json` 的 `permissions.allow`，
  下次启动仍免问（此前仅会话内有效）。
- **`git push` 改为可授权**：从"无条件 deny"改为"一律确认、可持久化免问"（`plan` 模式仍只读拦截）。
- **斜杠菜单滚动**：候选超过 12 项时窗口随选中项滚动并显示位置提示（此前超出部分不可见）。
- **`/skills`、`/mcp` 改走 Ink 渲染通道**（此前直写 stdout，会与实时渲染抢屏）。

### Fixed

- **子 Agent 无限递归**：`agent` 工具不再出现在子 Agent 的工具面，执行路径同样拦截（fail-closed）。
- **globstar 语义**：`**/*.ts` 等模式此前漏配根级文件（`**/` 被误编译为"至少一层目录"）。
- **危险命令误杀**：`kill` / `dd` / `reboot` / `shutdown` 改为按命令边界匹配，
  `npm run kill-port`、`git add .`、`ls dd-utils` 不再被误拦。
- **记忆召回噪声过滤**：纯噪声词查询（如 `is`）不再召回无关记忆（此前过滤逻辑未生效）。
- **`/clear` 后页面跳动**：清空时重置消息流渲染层，避免残留与高度骤变导致的抖动。

---
