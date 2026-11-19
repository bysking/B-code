【todo】右键复制后无法再选中文本（等 OpenTUI 上游修复，细节见下方专项记录）

---

# 实现状态（已完成）

全部 9 项已落地，`bun test` 661 用例全绿（61 个文件），`bun run typecheck` 干净。


| # | 项                             | 落点                                                                                           |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1 | 思考中 `/skills` `/mcp` 打不开 | `src/prompt-queue.ts` 分流 + `cli.handleLocal`（忙碌期立刻执行）                               |
| 2 | 忙碌期输入队列 + 强插          | `PromptQueue` + `Ctrl+Enter`（`onInterruptAndSend`）                                           |
| 3 | 输入历史逐条上翻               | `app.tsx` 去掉 `input === ''` 硬条件 + `navigatingRef` 防重置                                  |
| 4 | 默认 auto 模式                 | `initialMode()` 兜底 `auto`，新增 `--default`；controller 同步                                 |
| 5 | Ctrl+O 打开即贴底              | `output-panel.tsx` 的 `scrollTo(Infinity)` + `afterLayout`                                     |
| 6 | `/todo_clear`                  | `user-todo.ts:clearAllUserTodos` + `agent.ts:clearTodoList`（两份一起清）+ cli 分发 + 斜杠菜单 |
| 7 | MCP 异步启动                   | `runTtyCli` 改为挂载后 `void agent.initMcp()`                                                  |
| 8 | `/btw`（旁支只读提问）         | `agent.runBtwThread` + `cli.runBtwCommand`（`/fork` 已按需求移除）                             |
| 9 | ↑ 撤回排队输入 + 光标贴末尾    | `PromptQueue.shiftLast` + cli `onRecallQueued` + `app.tsx` `queueRecallRef`；`input.tsx` 改用 `measureText` 定位光标 |

新增测试：`prompt-queue` / `ui-input-history` / `ui-interrupt-send` /
`mode-default` / `user-todo-clear` / `btw` / `ui-queue-recall`。

## 遗留说明

- **MCP 窗口期**：异步启动期间模型调用未挂载的 MCP 工具会拿到 `Unknown tool`
  （fail-closed 不变）。这是"快启动"换来的确定性代价，README 已写明。
- **Ctrl+Enter 打断**会让在飞工具作废（与原 Esc 语义一致）。

---

# 专项：右键复制后无法再选中（未解决，等 OpenTUI 上游）

**状态**：根因已定位、已实测复现；应用层无自洽解法，**等 OpenTUI 升级后再试**。

## 现象

拖选文本 → 右键 → 点「复制」→ 之后再也选不中文本。**只要右键弹出终端自己的
上下文菜单就会坏，不必点复制**（已确认）。

环境：VS Code 终端（xterm.js 6.1.0-beta.304），`@opentui/core` 0.9.3。

## 根因（`BCODE_MOUSE_DEBUG` 抓到的真实字节）

```
mouse up   b=0  "\e[<0;19;15m"    ← 第一次拖选正常收尾
mouse down b=2  "\e[<2;18;15M"    ← 右键按下，终端弹自己的菜单
                                  ← b=2 的抬起永远不会到来（被菜单吃掉）
mouse down b=0  ... dragging:true ← 再按左键，新选中开始
mouse move b=0  "\e[<35;17;14M"   ← 35 = 移动 +「没有按键」
                                  ← 之后几百条全是 35，选中再不长
```

两个事实叠加：

1. **右键的抬起丢失**，OpenTUI 的 `currentSelection.isDragging` 永久停在 `true`；
2. 此后终端对按键状态的认知与应用分叉，**移动一律报成 `35`**（SGR 低两位 `3`
   = 当前没有按键），连"真的按住左键拖"也不再发 `32`。

OpenTUI 只在这一条分支里推进选中焦点：

```js
if (mouseEvent.type === "drag" && this.currentSelection?.isDragging) { … }
```

`move` 不推进 → 选中冻结在原地，且 `isDragging` 收拾不掉。0.9.3 虽有
「左键按下时结束旧手势」的自愈（上游 #2065），但**它只在按下那一刻复位，
之后的移动依旧是 35，无法扩选**。

## 试过的方向（都不可取，已全部撤掉）


| 方向                  | 做法                                   | 结果                                                                                                                              |
| ----------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A. `move` 时继续扩选  | `move` + `isDragging` → 升级成 `drag` | **能用但错误**：不按鼠标、只移动光标也会不停扩选，选中内容跟着乱长，比原 bug 更烦人                                               |
| B. 自己记左键 down/up | 左键按着 + `isDragging` 才升级         | 正常路径可扩选，但**日志实况里左键 up 也常被吃掉**，于是松手后仍然野长；且与"按住拖动才行"的要求自相矛盾                          |
| C. 悬停即结束拖动     | `move` 时把 `isDragging` 置 false      | 语义正确（选中只保留、不再生长），但**"重按左键可再选"仍是坏的**——重按后终端继续发 35，选不中新的。实测该补丁对"能否选中"零改善 |
| D. 焦点回流时收尾     | 监听 `focus`，清 `isDragging`          | 可与 C 互补，但同样不解决"重按后选不中"这个根本问题                                                                               |

**矛盾点**：终端把"按住拖动"和"纯悬停"报成同一个 `35`，应用侧已无法区分。
任何让选中跟随 `move` 生长的做法都会误伤纯悬停；任何收尾做法都无法让重按后
恢复扩选。信息在终端那侧就已经丢失。

## 等上游什么

需要 OpenTUI 在**鼠标状态失步时重新向终端声明鼠标模式**（重发 `1000h/1002h/ 1003h/1006h`），或提供公开 API 强制重置手势状态 + 重新 sync 按键位。相关迹象：

- 上游 `focusHandler` 有"焦点回来时 `restore-modes`"的逻辑，但**依赖终端先发
  焦点上报（1004）**；实测本环境启动时 `1004h` **未被开启**（应用只发了
  `CSI ? 1004 $p` 查询，xterm.js 的回报未让上游启用）；
- 参考 issue：`#2065`（左键按下结束旧手势，0.9.x 已修）、`#1497`（同一现象，
  内含"mouse mode 一次性发出、焦点回流不重新声明"的分析）、`#1396`/`#1333`
  （焦点上报被 DECRQM 门控，部分终端不启用）。

## 升级后怎么验证

1. `bun add -d @opentui/core@<新版> @opentui/react@<新版>`
2. 打开诊断：`BCODE_MOUSE_DEBUG=/tmp/mouse.log bun dev`
3. 拖选 → 右键弹菜单 → Esc 关掉 → 再拖选，日志里看两件事：
   - 右键那次手势的 `isDragging` 有没有被复位；
   - 重按左键后的移动是 `32`（能选）还是仍然 `35`（还没修）。
4. 跑 `bun test test/ui-selection.test.tsx`（已含"悬停不该改变选中"的基线用例）。

## 已落地的相关修复（与上述问题独立，已验证有效）

- `copyToClipboardOSC52` 在 0.9.x 会抛 `NativeError: InvalidPhase`（不是返回
  false），`Ctrl+Shift+C` 回调原无兜底，异常会让后面的 `clearSelection()` 不执行。
  已加 `try/catch`。
- markdown 选中补丁抽到 `src/ui/markdown-selection.ts`，挂载与测试共用。
- 诊断通道 `src/ui/mouse-diagnostics.ts`（`BCODE_MOUSE_DEBUG=<路径>`）。
