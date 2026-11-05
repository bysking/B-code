# Changelog

本项目所有值得记录的变更都会写在这里。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 SemVer](https://semver.org/lang/zh-CN/)。

分类：`Added`（新增）/ `Changed`（变更）/ `Fixed`（修复）/ `Removed`（移除）。

> **维护约定**：改动合并前，把面向用户的变更追加到 `[Unreleased]` 对应分类下；
> 发版时把 `[Unreleased]` 内容移到新版本号小节并标注日期（同时更新 `package.json` 的 `version`）。

---

## [Unreleased]

## [3.0.0] - 2026-11-05

渲染层全面重写：从 ink 切换到 [OpenTUI](https://github.com/anomalyco/opentui)（Zig 原生核心）。
这不是一次普通升级——约 1350 行补偿代码被删除，构建与分发方式也一并更换。

### Changed

- **渲染引擎：ink → OpenTUI**。业务代码直接写 OpenTUI 原生标签
  （`<box>` / `<text>` / `<scrollbox>` / `<input>` / `<markdown>`），
  `tsconfig.json` 配 `jsxImportSource: "@opentui/react"`，不再有适配层。
  换来的是原生视口裁剪滚动、原生输入框（光标/选区/undo）、原生 markdown
  解析（tree-sitter + 代码高亮）。
- **运行时改为 Bun**。OpenTUI 的原生 FFI 只实现了 Bun 绑定（Node 26 实测同样报
  `native FFI is not available`），因此 `dev` / `build` / `test` 全部走 Bun。
- **发布形态改为单文件可执行程序**（`bun build --compile`，~75MB，内含 Bun 运行时）。
  用户 `npm i -g @bysking/b-code` 后即可用 `bcode`，**无需安装 Node 或 Bun**。
  按平台拆成 optionalDependencies（darwin-arm64 / darwin-x64 / linux-x64 / win32-x64），
  npm 通过 `os`/`cpu` 字段只装匹配的那一份。
- **主题换成 VS Code「2026 深色」**。色值直接取自 VS Code 默认主题文件
  （`editor.background` / `statusBar.foreground` / `input.placeholderForeground` 等），
  不是凭印象调的；用户/助手角色标题用绿/蓝区分。
- **测试运行器：`node --test` → `bun test`**。测试用 OpenTUI 的 `createTestRenderer`
  替代 `ink-testing-library`。

### Added

- **`/export [路径]`**：把当前会话导出为 markdown（默认 `./bcode-<sessionId>.md`），
  含会话 ID / 模型 / 时间 / 轮次与完整问答。TTY 与非 TTY 都支持。
- **退出补打**：备用屏退出即销毁，现在会把最近 3 轮对话打到真实终端。
- **拖选复制**：会话内容可鼠标拖选，`Ctrl+Shift+C` 复制（走 OSC52，跨 SSH 也有效）。
- **LaTeX 公式**：markdown 里的 `$$…$$` / `\[…\]` / `$…$` / ` ```latex ` 代码块
  自动转成 Unicode 数学符号（`∫₍-∞₎⁽+∞⁾ e⁽-x^2⁾ dx = √(π)`）。
- **空态欢迎横幅**：全新会话时展示 ASCII 大字、slogan 与快捷键提示，
  有对话内容后自动让位。
- **`--goal` / `--loop` / 中断的输出恢复**：目标结论、循环累积输出、
  中断前的部分回复，退出后都能在真实终端看到。

### Removed

- 依赖 `ink` / `ink-text-input` / `ink-testing-library`
- 手写虚拟滚动与位置收敛（`ScrollView` / `viewport`，~270 行）——`<scrollbox>` 原生提供
- 手写输入框光标管理（`input-box`，~150 行）——`<input>` 原生提供
- marked + marked-terminal 的 markdown 管线（~100 行）——`<markdown>` 原生提供
- 滚轮 SGR 序列解析（`mouse.ts`，~200 行）——OpenTUI 原生处理鼠标
- 渲染引擎适配层（`ui/ui/`，~520 行）——不再需要兼容两套引擎
- `build.js`（esbuild 打 ink 版）——产物在 Node 下无法初始化 OpenTUI

### Fixed

- 退出时鼠标追踪未关闭，回 shell 后一动鼠标刷出 `35;41;30M` 裸转义序列
- session id 提示打在备用屏上，退出后看不到（无法 `--resume`）
- one-shot 结果、goal 结论、loop 输出、中断内容退出后全部消失
- `<markdown>` 区域无法拖选（OpenTUI 基类 `shouldStartSelection` 硬编码返回 false，
  而鼠标命中的是最顶层节点）
- 单行输入框用 `<textarea>` 导致回车不提交（其默认绑定是 Enter 插入换行）
- `Ctrl+C` 的"再按一次退出"提示被斜杠菜单/输出面板挤出可见区
- 超长流式输出导致帧高失控、内容重复显示

## [2.0.2] 及更早

见 [git 历史](https://github.com/bysking/b-code/commits/main)。

以下为此前累积的能力（渲染层仍为 ink）：

- **结构化任务清单**：`todo_write` 工具维护 `pending / in_progress / completed`，
  底部面板展示完成度；按项目隔离存储，跨会话存续。`/todos` 查看。
- **运行时命令**：`/help` / `/cost` / `/model [名字]` / `/compact`。
- **`--output-format json`**：headless 结构化输出，供 CI 与脚本消费。
- **生命周期钩子（Hooks）**：`UserPromptSubmit` / `PreToolUse`（可拦截）/ `PostToolUse`，
  协议对齐 Claude Code，超时与异常一律 fail-open。
- **检查点回退**：`/rewind` 按逆序还原 `write_file` / `edit_file` 的改动。
- **MCP**：stdio + Streamable HTTP 双传输（官方 SDK）；`resources/list` + `resources/read`
  聚合为只读工具；`/mcp` 面板启停与重连；`readOnlyHint` 自动判定只读；
  动态工具变更（`notifications/tools/list_changed`）；反向调用（`roots` / `sampling`）。
- **技能系统**：`/技能名 参数` 调用，支持平铺 `.md` 与 `SKILL.md` 目录两种形态；
  `/skills` 面板启停（禁用的不注入 system prompt）。
- **`.gitignore` 支持**：`grep_search` / `list_files` 尊重 git 语义
  （锚定、`!` 取反、仅目录、`**/`）。
- **权限系统**：`default` / `plan` / `auto` / `bypass` 四模式；危险命令任何模式都拦得住；
  白名单持久化 + 通配折叠 + 噪声过滤；MCP 工具一次确认授权整个 server。
