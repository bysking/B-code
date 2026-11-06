# Changelog

本项目所有值得记录的变更都会写在这里。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 SemVer](https://semver.org/lang/zh-CN/)。

分类：`Added`（新增）/ `Changed`（变更）/ `Fixed`（修复）/ `Removed`（移除）。

> **维护约定**：改动合并前，把面向用户的变更追加到 `[Unreleased]` 对应分类下；
> 发版时把 `[Unreleased]` 内容移到新版本号小节并标注日期（同时更新 `package.json` 的 `version`）。

---

## [Unreleased]

### Fixed

- **只改 `version` 就会被 CI 拦下**：`check-version` job 在 `version:sync` 之前跑，
  于是「本地只改了 version、4 行平台包还是旧版本」这种**正常状态**被当成错误拦下——
  而发布流程本身（`prepublishOnly`）会自动补上，产物是对的。
  - CI 改为先执行 `bun scripts/sync-version.js` 同步，再校验，与本地 `prepublishOnly`
    的行为对齐。
  - `check-version.js` 的其余 6 项校验（平台清单四处一致、`files` 覆盖 main/bin、
    git tag 与版本一致、`engines.node` 与 `MIN_NODE_MAJOR` 一致）**保留**——
    这些是真实配置错误，不会、也不该被自动修复。
  - tarball 实际内容的校验（`Verify packed manifest`）照旧，它才决定用户最终装到什么。
  - 测试同步调整：`optionalDependencies 已写进 package.json 且版本等于主包` 拆成两条——
    一条只断言"字段存在"（守住 v3.2.1 那个事故），一条断言"每个平台的键都在"；
    不再断言版本号字面相等，因为改完 version 未同步是正常中间状态。
    （原写法会让"本地只改 version"时 `bun test` 直接失败。）
- **「缺少平台包」的提示会把人带偏**：原来的输出只让用户加 `--include=optional`，
  但这条错误最常见的根因其实是**npm 默认 registry 指向了私有镜像**（企业源、淘宝源等），
  镜像上没有同步这个公共包，而 npm 装不上可选依赖时**不报错、只静默跳过**。
  现在提示会打印用户**实际生效的 registry**（含 `@bysking:registry` scope 覆盖），
  非官方源时给出明确警告，并按概率给出排查顺序（换源 / `--include=optional` / 平台不支持）。
  registry 为文件级解析，不 spawn `npm config`，避免拖慢启动或 npm 不在 PATH 时失败。
- **Node 版本门槛放宽到主版本 `>= 24`**：原来写的 `>=24.22.2` 只代表发布时的环境，
  不是真实下限，却会把 24.0.0~24.22.1 这些完全能用的版本拦在门外；预发布版
  （如 `27.0.0-alpha.0.0`）也会被 yarn 的 engine 检查误判。
  - `engines.node` 改为 `>=24`，启动器同步改为 `MIN_NODE_MAJOR = 24`，只比主版本。
  - 顺带修掉版本解析的隐患：原实现用 `parseInt`，垃圾输入得到 `NaN`，
    而 `NaN < 24` 为 `false` 会**错误放行**；现在改为正则取开头数字，解析不出则拦截。
  - 拦截提示里的 `nvm install 24` 等命令改为按门槛动态生成，避免改门槛后提示不一致。
  - `check-version.js` 增加反向校验：`engines.node` 若带次/修订号即报错，
    防止有人又把粗粒度门槛改细。
- **v3.2.1 安装后报「缺少平台包」**：`optionalDependencies` 在 registry **元数据**里是
  空的，npm/pnpm 因此根本不去拉取 4 个平台包，且安装过程**没有任何报错**。
  - 根因是上一版引入的 `prepack` 注入 / `postpack` 还原方案：npm publish 的顺序是
    `prepack → 打 tarball → postpack → 读取 package.json 组装元数据 → 上传`，
    `postpack` 在元数据组装**之前**就把字段删了。症状极具迷惑性——
    **tarball 里的 package.json 有该字段，registry 元数据里没有**，而安装时读的是元数据。
  - 改为把 4 行 `optionalDependencies` **直接写进 package.json 并提交**，
    `version` 仍是唯一手改点，由 `bun run version:sync` 展开；`prepublishOnly`
    强制执行，忘记跑也会被拦。彻底消除对钩子时序的依赖。
  - CI 新增发布前断言：`package.json` 必须含该字段且版本等于 `version`
    （脚本会提示"不要用 postpack 删除该字段"）。
- **v3.0.1 的二进制在用户机器上执行报 `EACCES`**：发布的 tarball 里 `bcode` 权限是
  `644` 而非 `755`。根因是 `actions/upload-artifact` 用 zip 跨 job 传递产物，
  **官方明确不保留 Unix 权限**（所有文件变 `644`），`pack-platform.js` 里设的
  `chmod 755` 被静默抹掉。这类问题 CI 全绿、发布成功、registry 有包，只有用户安装后
  才会暴露。
  - `build` job 改为 tar 打包后 `archive: false` 上传，`publish-platforms`
    解包并显式 `chmod +x`，再加一步 `Verify exec bit preserved` 硬校验。
  - `pack-platform.js` 打包后立即检查 mode 含 `0o111`，本地就把问题挡住。
  - 已发布的 `3.0.1` 需要重新发一个版本修复（npm 不允许覆盖已发布版本）。
  - 解包步骤修正：不能先 `rm -rf` 目标目录（tar 文件本身就在里面，会把自己删掉），
    改为解到临时目录再整体替换；且目标路径必须用 artifact 目录名
    `bcode-<platform>`（而不是 `<platform>`），否则后续 `dist-pkg/bcode-*/` 匹配不到。
- **两个测试只在 CI（Linux）上失败**——都是测试自身对平台/速度的脆弱假设，与业务代码无关：
  - `grep_search 返回 path:行号:内容 且命中正确行`：断言 `out.startsWith('a.txt:2:')`，
    但它搜的是**共享的** `dir`，而前面 `edit_file` 的用例已往该目录写入同样含
    `value = 0` 的 `dup.txt`。命中顺序取决于 `readdir` 的返回顺序，macOS 上恰好
    `a.txt` 在前，Linux 上 `dup.txt` 在前 → 断言失败。改为使用独立临时目录（只留一个
    命中文件）并精确断言整行输出，不再依赖遍历顺序。
  - `回归：用户消息单独 push 后立刻展示`：用固定 `wait(30)` 等待渲染提交，CI 机器较慢时
    30ms 可能赶不上一次帧提交。改用文件内已有的 `waitForFrame` 轮询（上限 3s）。
    断言的本意是"最终会显示"，不该受帧调度速度影响。
  - CI 的 test / publish-main 两个 job 仍在用 pnpm，而 `pnpm-lock.yaml` 是 ink 时代的
    （没有 `@opentui/*`），`--frozen-lockfile` 必然报 OUTDATED_LOCKFILE，且
    `pnpm test` 调的是 `bun test`。统一改为 Bun。
  - `publish-platforms` 的发布循环路径多套了一层 `/*`，导致 `package.json` 检测恒假、
    一个平台包都不会发。改为直接遍历 `dist-pkg/bcode-*/`，并在目录为空或缺少
    `package.json` 时报错退出（不再静默跳过）。
  - `publish-main` 原本跑 `pnpm build` 产出 77MB 的 `dist/bcode`，而主包 `main`
    指向的 `dist/cli.mjs` 是已废弃的 ink 回退版。主包现在不含构建产物。
  - `package.json` 的 `main` 指向已 gitignore 的 `dist/cli.mjs`，npm 仍会把它塞进
    tarball（实测 2.5MB / 681KB 压缩）。改为 `lib/index.js`，tarball 降到约 30KB。
  - 发布版主包原本挂了 12 个运行时依赖（`@opentui/*`、`react`、`@anthropic-ai/sdk` 等），
    但启动器只用 node 内置模块、二进制自带一切。全部移入 `devDependencies`。
  - `pack-platform.js` 用 `chmod` / `du` 外部命令，Windows runner 上不一定存在，
    改用 `fs.chmodSync` / `fs.statSync`。
  - **CI 的 macOS runner 标签已失效**：`macos-13` 早已不可用，`macos-14` 全部镜像
    于 2026-11-02 退役（actions/runner-images#15226），两个 darwin job 会直接排队失败。
    改用 `macos-15`（arm64）与 `macos-15-intel`（x64）。`build-bun.js --all-check`
    里的提示同步更新。
  - musl 检测与打包逻辑存在，但平台清单未登记，导致 Alpine 用户会得到
    "暂不支持"。`pack-platform.js` 的 `supported` 补入 `linux-x64-musl`，
    README 说明其启用方式。

### Added

- **发布改用 npm Trusted Publishing (OIDC)**，不再依赖长期 `NPM_TOKEN`：
  `publish-platforms` / `publish-main` 声明 `permissions: id-token: write`，
  npm 自动换取短时令牌并生成 provenance。CI 的 Node 从 22 升到 24（Node 22 自带
  npm 10.9.x，低于 Trusted Publishing 要求的 11.5.1），并加了一步硬校验防止
  回退到旧 npm 后静默失效。
  - **全新包的限制已解除**：npm 不允许用 OIDC 发布尚不存在的包（npm/cli#8544 仍 open），
    因此 4 个平台包先发布了 `1.0.0` 占位版本（仅 README + package.json，无二进制），
    占住包名以便配置 Trusted Publishing。现所有包均可走 OIDC，实测无需 token。
    workflow 仍保留 `NPM_TOKEN` 回退，供将来新增平台包时使用。
  - 发布步骤改为自建 `.npmrc` 且**不给 `setup-node` 传 `registry-url`**——后者会写入
    占位 token，OIDC 交换失败后回退到假 token，报出与真实原因无关的 E404/ENEEDAUTH。
  - 发布循环加幂等：已存在的版本跳过，避免"4 个平台发了 2 个后失败"的重跑从头报错。
  - 新增手动触发支持：`workflow_dispatch` 可选 `dry_run`（只构建校验、不发布）；
    tag 校验在手动触发时自动跳过（此时 `GITHUB_REF_NAME` 是分支名）。
- `scripts/check-version.js`：校验 `package.json` 版本与 4 行平台包版本一致、平台清单在
  `optionalDependencies` / `bin/bcode.js` / `lib/index.js` / `scripts/pack-platform.js`
  四处对齐、`files` 覆盖 `main` 与 `bin`、以及 git tag（CI 传入）与版本号一致。
  已挂到 `prepublishOnly`（`bun run check:version`）和 CI 的 `check-version` job——
  npm 对 optionalDependencies 的解析失败是静默的，漏改版本号会让用户"装成功却跑不起来"。
- `lib/index.js`：主包库入口，`import('@bysking/b-code')` 可拿到 `name` / `version` /
  `platforms`，不再一 `require` 就启动 TUI。
- [`docs/RELEASING.md`](./docs/RELEASING.md)：发布手册。记录 5 包结构、OIDC 认证机制与
  「首次发布必须用 token」的过渡步骤、各平台必须原生编译的原因、runner 标签会过期的注记、
  发布前自检清单，以及按症状查的排错表。

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
