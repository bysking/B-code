import { useCallback, useEffect, useRef, useState } from 'react';
import { useKeyboard, usePaste, useRenderer, useTerminalDimensions } from '@opentui/react';
import type { AppController, SlashItem, ToolCallDisplay } from './controller.js';
import type { Mode } from '../permissions.js';
import type { ClipboardImage } from '../utils/clipboard.js';
import { readClipboardImage } from '../utils/clipboard.js';
import { Transcript, BusyLine } from './views/transcript.js';
import { PromptInput } from './views/input.js';
import { SlashMenu } from './views/slash-menu.js';
import { OutputPanel, PANEL_TABS, type PanelTab } from './views/output-panel.js';
import { TaskPanel } from './views/task-panel.js';
import { TodoPanel } from './views/todo-panel.js';
import { ModeBar } from './views/mode-bar.js';
import { Confirm } from './views/confirm.js';
import { Wizard } from './views/wizard.js';
import { CapabilityPanel } from './views/capability.js';
import { UserTodoEditor } from './views/user-todo.js';
import { AskInput } from './views/ask-input.js';
import { buildSubmitLine, clampIndex, filterSlash } from './slash.js';
import { COLORS, attrs } from './primitives/theme.js';

/**
 * 根组件（OpenTUI 原生写法）。
 *
 * ## 布局
 *
 * ```
 * ┌─────────────────────────────┐
 * │ <scrollbox>  会话历史       │  flexGrow=1，原生滚动 + 视口裁剪
 * ├─────────────────────────────┤
 * │ 交互区（菜单/确认/面板）     │  按需出现
 * ├─────────────────────────────┤
 * │ <textarea> 输入框           │  原生光标/选区/粘贴
 * ├─────────────────────────────┤
 * │ 模式栏                      │
 * └─────────────────────────────┘
 * ```
 *
 * ## 与 ink 版的根本区别
 *
 * - **滚动**：交给 `<scrollbox>`（原生视口裁剪 + 粘性滚动 + 鼠标滚轮），
 *   不再手写虚拟滚动、位置收敛、触摸板累积。
 * - **输入**：交给 `<textarea>`（原生光标、选区、undo）。
 * - **键盘**：`useKeyboard` 直接给 `KeyEvent`，用 `e.name` 判断，
 *   不再需要 `KeyLike` 归一化层。
 */

/** 汇总本轮会话全部工具调用（供 Ctrl+O 面板展示） */
function allToolOutputs(ctrl: AppController): ToolCallDisplay[] {
  return ctrl.turns.flatMap((t) => t.tools);
}

/** 输入历史保留条数（↑↓ 翻起来够用，又不至于无限涨） */
const HISTORY_MAX = 200;

export function App({
  ctrl,
  onSubmit,
  onInterrupt,
  onInterruptAndSend,
  onExit,
  onSetMode,
  onToggleCapability,
  onReconnectCapability,
  refreshCapability,
  initialOutput,
}: {
  ctrl: AppController;
  onSubmit: (text: string | { text: string; images?: ClipboardImage[] }) => void;
  onInterrupt: () => void;
  /**
   * 忙碌期强插（Ctrl+Enter）：中断在飞的那一轮，立刻把这条提示词发给模型。
   * 缺省回落到 `onInterrupt` + `onSubmit` 的组合语义（测试/嵌入方可只给前两个）。
   */
  onInterruptAndSend?: (text: string) => void;
  onExit: () => void;
  onSetMode: (mode: Mode) => void;
  onToggleCapability?: (name: string) => void;
  onReconnectCapability?: (name: string) => void;
  refreshCapability?: () => void;
  initialOutput?: string[];
}) {
  const [, force] = useState(0);
  useEffect(() => ctrl.subscribe(() => force((v) => v + 1)), [ctrl]);

  const { width: termCols, height: termRows } = useTerminalDimensions();
  const renderer = useRenderer() as unknown as {
    getSelection(): { getSelectedText(): string } | null;
    copyToClipboardOSC52(text: string): boolean;
    clearSelection?(): void;
  };

  const [input, setInput] = useState('');
  const [quitArmed, setQuitArmed] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>('tools');
  /** 「子 Agent」页当前看第几个（←/→ 切换；黏性跟随见下面的 effect） */
  const [subAgentIdx, setSubAgentIdx] = useState(0);
  /** 已提交的提示词（旧的在前），供 ↑/↓ 翻历史 */
  const inputHistory = useRef<string[]>([]);
  /**
   * 历史游标：-1 = 不在历史中；0 = 最新一条，越大越旧。
   *
   * 用 **ref 而非 state**，有三个实打实的理由：
   *   1. 它只参与按键判断、从不参与渲染——放 state 里白白多一轮重渲染；
   *   2. `useKeyboard` 的回调可能读到上一次渲染的闭包，state 值会陈旧，
   *      表现就是"连按 ↑ 一直停在同一层"；
   *   3. `↓` 的下界判断依赖它，陈旧值会让 `↓` 直接判成"不在历史中"而彻底失灵。
   */
  const historyIdxRef = useRef(-1);
  /**
   * 最近一次由图标的"程序化写值"（↑↓ 导航、提交清空）产生的草稿。
   *
   * `setInput` 会让 `PromptInput` 走 `setText`，后者发 `content-changed`
   * → `onChange` → `handleChange`。拿**值**比对比"一次性布尔标记"可靠得多：
   * 标记只能挡一次事件，而 `setText` 在不同终端/内容下可能发不止一次，
   * 漏挡的那次就会把游标重置成 -1（"上翻第二条失效"、"↓ 完全不响应"都源于此）。
   */
  const programmaticRef = useRef<string | null>(null);
  const imagesRef = useRef<ClipboardImage[]>([]);

  /** 需要用户当场作答的交互（确认/向导/文本提问） */
  const needsAnswer = Boolean(ctrl.askState || ctrl.askWizardState || ctrl.askTextState);
  /**
   * 是否有"挡住主界面"的面板/交互层打开。
   *
   * Esc 的调度依赖它：**这一层开着时 Esc 只关这一层，绝不中断模型**。
   * 三个字段覆盖了全部会覆盖输入区的界面：
   *   - `outputPanel`     Ctrl+O 输出面板
   *   - `capabilityPanel` /skills、/mcp 能力面板
   *   - `userTodoOpen`    /todo 交互编辑器
   * 其余确认/向导/斜杠菜单本身就是"正在等用户作答"，不属于"推理中被误伤"的场景。
   */
  const uiLayerOpen = Boolean(ctrl.outputPanel || ctrl.capabilityPanel || ctrl.userTodoOpen);
  /** 输入框是否可用 */
  const inputDisabled = needsAnswer || ctrl.userTodoOpen || !!ctrl.capabilityPanel;

  /* ── 键盘 ─────────────────────────────────────────────
   *
   * OpenTUI 的 useKeyboard 给 KeyEvent（name/ctrl/shift/meta），直接用 name 判断，
   * 不需要 ink 时代的 KeyLike 归一化。输入字符由 <textarea> 自己处理，这里只管快捷键。
   */
  useKeyboard((e) => {
    /**
     * Ctrl+Shift+C：复制鼠标选中的文本。
     *
     * ## 为什么需要自己实现
     *
     * OpenTUI 开启鼠标追踪（1000h/1002h/1003h）后，终端把"按下-拖动-释放"
     * 整套手势交给应用，**不再执行原生文本选中**——用户按住左键拖选，
     * 屏幕上没有任何高亮，Ctrl+C 也复制不到东西。
     *
     * OpenTUI 自己实现了选中（`renderer.getSelection()`）与 OSC52 写剪贴板
     * （`copyToClipboardOSC52`，跨 SSH 也有效），但复制动作原本只绑在它内置的
     * console overlay 里。这里把它接到主 UI：选中 → Ctrl+Shift+C → 进系统剪贴板。
     *
     * 快捷键：**Ctrl+Shift+C**。
     *
     * 为什么不是 mac 惯例的 Cmd+C：macOS 上 Cmd+C 是**系统/终端级快捷键**
     * （Terminal.app、VS Code 终端都自己先吃掉），根本传不到运行在里面的程序。
     * 只有实现了 Kitty 键盘协议的终端（Kitty / WezTerm）才能把 super 修饰键
     * 报给应用。所以 Cmd+C 也监听（支持的终端自然生效），但主推 Ctrl+Shift+C
     * ——它在 raw mode 下能可靠传到应用，也是终端里复制的事实标准
     * （GNOME Terminal / VS Code / iTerm2 默认都是这个）。
     */
    // Cmd+C（macOS）与 Ctrl+Shift+C（Linux/Windows 惯例）都触发复制
    if (((e.meta || (e.ctrl && e.shift)) && e.name === 'c')) {
      const sel = renderer.getSelection?.();
      const text = sel?.getSelectedText?.() ?? '';
      if (text) {
        const ok = renderer.copyToClipboardOSC52?.(text);
        ctrl.pushOutput(
          ok
            ? `(已复制 ${text.length} 个字符到剪贴板)`
            : '(复制失败：当前终端不支持 OSC52)',
        );
        // 复制后清掉选中态：否则下一次拖动会接着上次的锚点继续扩选，
        // 表现为"再拖就选不中新的地方"
        renderer.clearSelection?.();
      } else {
        ctrl.pushOutput('(没有选中文本——按住左键拖动选中后按 Ctrl+Shift+C 复制)');
      }
      return;
    }

    // Ctrl+C：有交互 → 取消；否则双击退出
    if (e.ctrl && e.name === 'c') {
      if (ctrl.askState) {
        const deny = ctrl.askState.options.find((o) => o.value === 'no');
        ctrl.resolveAsk(deny?.value ?? ctrl.askState.options[0]?.value ?? '');
        return;
      }
      if (ctrl.askWizardState) {
        ctrl.resolveAskWizard('__cancel__');
        return;
      }
      if (ctrl.askTextState) {
        ctrl.resolveAskText('', true);
        return;
      }
      if (quitArmed) {
        onExit();
        return;
      }
      setQuitArmed(true);
      setTimeout(() => setQuitArmed(false), 2000);
      return;
    }

    /**
     * Ctrl+Enter：忙碌期强插。
     *
     * 语义（与普通 Enter 的区别）：普通 Enter 在模型忙碌时只能排队等这一轮结束；
     * Ctrl+Enter 是"我说的话比你现在做的事更要紧"——立刻中断在飞请求，把这条
     * 提示词插到队首发出。
     *
     * 为什么在这里拦而不是在 textarea 的 keyBindings 里：需要拿到 `input` 与
     * `ctrl.busy`，而 keyBindings 只能表达"按了什么键→执行哪个编辑器动作"。
     * App 的 useKeyboard 走在 textarea 的原生按键处理**之前**（内部 keypress
     * 先派发给全局监听者），所以 `preventDefault()` 能干净地把这次按键截下来。
     */
    if (e.name === 'return' && e.ctrl) {
      const text = input.trim();
      const blocked = Boolean(
        ctrl.askState || ctrl.askWizardState || ctrl.askTextState || ctrl.userTodoOpen || ctrl.capabilityPanel,
      );
      if (text && !blocked) {
        e.preventDefault();
        if (ctrl.busy !== null && onInterruptAndSend) {
          historyIdxRef.current = -1;
          setInputProgrammatically('');
          imagesRef.current = [];
          ctrl.closeSlash();
          onInterruptAndSend(text);
        } else {
          // 空闲时与普通 Enter 等价（用户不该为了"发出去"记两套键）
          handleSubmit(text);
        }
      }
      return;
    }

    // Ctrl+O：工具输出面板
    //
    // 滚动完全交给面板内部的 <scrollbox>（原生滚轮 + ↑↓ 由它自己消费），
    // 这里只管：Tab 换页、←/→ 换子 Agent、Esc 关闭。
    // 别再引入"手算偏移"的 state——那是 ink 时代的遗留物，对 scrollbox 无效。
    if (ctrl.outputPanel) {
      if (e.name === 'tab') {
        // 三页轮换（工具输出 → 系统日志 → 子 Agent）
        setPanelTab((t) => PANEL_TABS[(PANEL_TABS.indexOf(t) + 1) % PANEL_TABS.length] ?? 'tools');
        return;
      }
      // ←/→：在「子 Agent」页里切换看第几个（面板里这两个键原本没被占用）
      if (panelTab === 'subagents' && (e.name === 'left' || e.name === 'right')) {
        const n = ctrl.subagents.length;
        if (n > 0) setSubAgentIdx((i) => clampIndex(i + (e.name === 'right' ? 1 : -1), n));
        return;
      }
      if (e.name === 'escape') {
        ctrl.toggleOutputPanel(false);
        return;
      }
    }
    if (e.ctrl && e.name === 'o') {
      ctrl.toggleOutputPanel();
      return;
    }

    // Shift+Tab：循环切换模式
    if (e.name === 'tab' && e.shift) {
      ctrl.cycleMode();
      onSetMode(ctrl.mode);
      return;
    }

    // ↑↓：输入历史导航。
    //
    // 触发条件：**空框** 或 **已经在历史浏览中**。
    // 多行草稿里 ↑↓ 必须留给 textarea 移光标（`test/ui-input.test.tsx` 锁着这条），
    // 但只要已经翻进历史（游标 >= 0），继续 ↑↓ 就该一直翻下去。
    //
    // `↑`/`↓` 的写法刻意对称：都在**同一处**判断边界、都走同一个 helper 写值。
    // 之前的不对称（`↑` 判空框、`↓` 判游标）是"只能上翻、下键失灵"的根源——
    // 游标一旦被误重置成 -1，`↓` 就再也进不来。
    const interactiveOpen = Boolean(
      ctrl.slashOpen || ctrl.askState || ctrl.askWizardState || ctrl.askTextState,
    );
    const atHistory = historyIdxRef.current >= 0;
    if (
      (e.name === 'up' || e.name === 'down') &&
      !e.ctrl &&
      !e.meta &&
      !interactiveOpen &&
      (input === '' || atHistory)
    ) {
      navigateHistory(e.name === 'up' ? -1 : 1);
      return;
    }

    // Esc：**先关面板，没有面板才中断**。
    //
    // 判定顺序（重要）：Esc 的第一职责是"退出当前界面层"，只有当前不在任何
    // 面板/交互里时，它才是"打断模型"。曾经这里只拦了输出面板与文本提问，
    // `/skills`、`/mcp` 的能力面板和 `/todo` 编辑器漏在外面——用户在面板里
    // 按 Esc 想关面板，结果连带把正在推理的模型也中断了。
    if (e.name === 'escape') {
      // ① 有选中态时优先清选中（用户想取消选择，而不是中断对话）
      const sel = renderer.getSelection?.();
      if (sel?.getSelectedText?.()) {
        renderer.clearSelection?.();
        return;
      }
      // ② 文本提问没有自己的 Esc 处理（AskInput 只有 <input>），
      //    必须由这里取消——但取消提问同样**不是**中断模型。
      if (ctrl.askTextState) {
        ctrl.resolveAskText('', true);
        return;
      }
      // ③ 任意面板打开 → 交给它自己关（各自都有 Esc 处理），一律不中断
      if (uiLayerOpen) return;
      // ④ 都没有 → Esc 才是"硬中断当前对话"
      if (!ctrl.askState && !ctrl.askWizardState && ctrl.busy !== null) {
        onInterrupt();
      }
    }
  });

  /**
   * 子 Agent 条数变化时收敛「子 Agent」页的选中项。
   *
   * **黏性跟随**：新子 Agent 开始时，只有用户本来正停在最后一个才跟着切过去
   * ——他要是正在翻前面的步骤，就被抢走视线了。条数变少（/clear、上限淘汰）
   * 时把下标收进有效范围。
   */
  const subAgentCount = ctrl.subagents.length;
  const prevSubAgentCount = useRef(0);
  useEffect(() => {
    const prev = prevSubAgentCount.current;
    prevSubAgentCount.current = subAgentCount;
    if (subAgentCount > prev) {
      setSubAgentIdx((i) => (prev === 0 || i === prev - 1 ? subAgentCount - 1 : i));
    } else if (subAgentCount < prev) {
      setSubAgentIdx((i) => Math.min(i, Math.max(0, subAgentCount - 1)));
    }
  }, [subAgentCount]);

  /* ── 粘贴 ─────────────────────────────────────────── */

  /**
   * Ctrl+V / Cmd+V：只用来取图片（文本走括号粘贴）。
   *
   * 只给 `PromptInput` 用，**不**在 App 层再兜一次：图片占位符要插在光标处，
   * 只有拿到 textarea 实例才做得到。App 层若也处理同一次粘贴，两边都会
   * 登记一张图（重复的 `[image #N]`）。
   */
  const handlePasteImage = (): string | null => {
    const img = readClipboardImage();
    if (!img) return null;
    const idx = imagesRef.current.length + 1;
    imagesRef.current.push(img);
    return `[image #${idx}]`;
  };

  /**
   * 粘贴事件（括号粘贴）：**只处理文本**。
   *
   * 空的粘贴事件留给 `PromptInput` 的 `onPaste`——那里能插到光标处，也能在
   * 空内容时探剪贴板图片（Windows Terminal 把 Ctrl+V 转成自己的粘贴动作，
   * 剪贴板是图片时事件是空的，那条路径只能从粘贴事件走）。
   *
   * 职责分开是为了避免重复插入：同一次粘贴这个 hook 和组件的 `onPaste`
   * 都会收到，谁都不该处理两遍。
   */
  usePaste((event) => {
    if (inputDisabled) return;
    const text = new TextDecoder().decode(event.bytes);
    if (text) setInput((v) => v + text);
  });

  /**
   * 写值进输入框并**标记为程序化赋值**。
   *
   * 走 `setInput` 之后，`PromptInput` 的同步 effect 会 `setText`，进而发
   * `content-changed` → `onChange`。`programmaticRef` 记下"这个值是我写的"，
   * `handleChange` 认出来就跳过重置游标。用值比对而不是布尔标记：
   * `setText` 可能触发不止一次事件，布尔标记被第一次消费后就会失效。
   */
  const setInputProgrammatically = (value: string) => {
    programmaticRef.current = value;
    setInput(value);
  };

  /**
   * 历史导航一步。
   *
   * 语义刻意做成"能来回走"：
   *   - `↑`（delta=-1）到顶就停在最早一条，不清空、不越界；
   *   - `↓`（delta=+1）到底**退回空框**并把游标复位（-1），让 `↓` 与 `↑`
   *     组成闭环——这是"按上键翻历史、按下键倒回来"该有的手感。
   *   - 不在历史里时按 `↓` 什么都不做（不能把用户刚打的草稿清掉）。
   */
  const navigateHistory = (delta: -1 | 1) => {
    const hist = inputHistory.current;
    if (hist.length === 0) return;

    const cur = historyIdxRef.current;
    if (delta === 1 && cur < 0) return; // 不在历史中：↓ 不接管

    // 游标 0 = 最新一条，越大越旧；因此 ↑ 让游标 +1、↓ 让游标 -1
    const next = delta === -1 ? cur + 1 : cur - 1;
    if (next > hist.length - 1) return; // 已是最早一条
    if (next < 0) {
      // 翻过最新一条 = 回到空框（用户没提交内容的原始状态）
      historyIdxRef.current = -1;
      setInputProgrammatically('');
      return;
    }
    historyIdxRef.current = next;
    setInputProgrammatically(hist[hist.length - 1 - next] ?? '');
  };

  const handleChange = useCallback(
    (value: string) => {
      setInput(value);
      // 程序化写值的回声不算"用户开始编辑"：重置游标会让 ↑ 断在第二条、
      // 让 ↓ 彻底失灵。按值认领（见 setInputProgrammatically）。
      if (programmaticRef.current === value) {
        programmaticRef.current = null;
      } else {
        historyIdxRef.current = -1;
      }
      if (value.startsWith('/')) ctrl.openSlash(value.slice(1));
      else if (ctrl.slashOpen) ctrl.closeSlash();
    },
    [ctrl],
  );

  const handleComplete = (item: SlashItem) => {
    const completed = `/${item.name} `;
    setInput(completed);
    ctrl.openSlash(item.name);
  };

  const handleSubmit = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    // 解析 [image #N] 占位符
    const images = imagesRef.current;
    const usedImages: ClipboardImage[] = [];
    const regex = /\[image #(\d+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(trimmed)) !== null) {
      const idx = parseInt(match[1] ?? '', 10) - 1;
      if (idx >= 0 && idx < images.length) usedImages.push(images[idx]!);
    }
    const cleanText = trimmed.replace(/\[image #\d+\]/g, '').trim();

    const hist = inputHistory.current;
    if (hist[hist.length - 1] !== trimmed) hist.push(trimmed);
    // 去重后的历史也要限长：长会话里几千条会把 ↑↓ 翻成体力活
    if (hist.length > HISTORY_MAX) hist.splice(0, hist.length - HISTORY_MAX);
    historyIdxRef.current = -1;
    setInputProgrammatically('');
    imagesRef.current = [];
    ctrl.closeSlash();

    if (usedImages.length > 0) onSubmit({ text: cleanText, images: usedImages });
    else onSubmit(trimmed);
  };

  const compact = termRows < 30;

  return (
    <box
      flexDirection="column"
      width={termCols}
      height={termRows}
      // VS Code 2026 深色：编辑区底色作为整体背景
      backgroundColor={COLORS.surfaceDeep}
    >
      {/*
        会话历史：<scrollbox> 原生滚动。
        stickyScroll 让新内容自动贴底；viewportCulling 只渲染可见部分
        （原生虚拟滚动，不用再手算行数）。
      */}
      <scrollbox
        style={{ flexGrow: 1, flexShrink: 1 }}
        stickyScroll
        stickyStart="bottom"
        viewportCulling
        scrollY
        focusable={false}
      >
        <box flexDirection="column">
          <Transcript
            turns={ctrl.turns}
            output={ctrl.output}
            initialOutput={initialOutput}
            cols={termCols}
          />
          {ctrl.busy && ctrl.busySince !== null ? (
            <box marginTop={1}>
              <BusyLine
                text={ctrl.busy}
                since={ctrl.busySince}
                thinking={ctrl.busyThinking}
                inputTokens={ctrl.busyInputTokens}
              />
            </box>
          ) : null}
        </box>
      </scrollbox>

      {/* ── 交互区（同时最多一种） ── */}
      {ctrl.askWizardState ? (
        <Wizard ask={ctrl.askWizardState} onResolve={(v) => ctrl.resolveAskWizard(v)} />
      ) : ctrl.askState ? (
        <Confirm ask={ctrl.askState} onResolve={(v) => ctrl.resolveAsk(v)} />
      ) : null}

      {ctrl.askTextState ? (
        <AskInput
          question={ctrl.askTextState.question}
          onSubmit={(v) => ctrl.resolveAskText(v)}
        />
      ) : null}

      {ctrl.slashOpen ? (
        <SlashMenu
          query={ctrl.slashQuery}
          items={ctrl.slashItems}
          onPick={(item) => handleSubmit(buildSubmitLine(input, item.name))}
          onComplete={handleComplete}
          onClose={() => ctrl.closeSlash()}
          termRows={termRows}
        />
      ) : null}

      {ctrl.outputPanel ? (
        <OutputPanel
          key={`panel-${panelTab}-${panelTab === 'subagents' ? subAgentIdx : 0}`}
          tools={allToolOutputs(ctrl)}
          logs={ctrl.logs}
          subAgents={ctrl.subagents}
          subAgentIdx={subAgentIdx}
          tab={panelTab}
          termRows={termRows}
        />
      ) : null}

      {ctrl.task && !compact ? <TaskPanel task={ctrl.task} /> : null}

      <TodoPanel todos={ctrl.todos} />

      {ctrl.userTodoOpen ? (
        <UserTodoEditor
          todos={ctrl.userTodos}
          onChange={(todos) => ctrl.setUserTodos(todos)}
          onClose={() => ctrl.setUserTodoOpen(false)}
        />
      ) : null}

      {ctrl.capabilityPanel ? (
        <CapabilityPanel
          kind={ctrl.capabilityPanel.kind}
          items={ctrl.capabilityPanel.items}
          onToggle={(name) => onToggleCapability?.(name)}
          onReconnect={(name) => onReconnectCapability?.(name)}
          onRefresh={() => refreshCapability?.()}
          onClose={() => ctrl.closeCapability()}
        />
      ) : null}

      {/* ── 底部固定区：退出提示 + 队列提示 + 输入框 + 模式栏 ──
          提示必须在这里（flexShrink=0 的底栏内部），不能放在滚动区后面：
          斜杠菜单/输出面板一展开就把滚动区顶高，提示会被挤出可见区
          （实测 22 行终端下完全看不到，用户以为 Ctrl+C 没反应）。 */}
      <box flexDirection="column" flexShrink={0}>
        {quitArmed ? (
          <text fg={COLORS.warning}>(再按一次 Ctrl+C 退出)</text>
        ) : null}
        {ctrl.queuedPrompts.length > 0 ? (
          <text fg={COLORS.muted} attributes={attrs('dim')}>
            {' '}
            ⏳ 已排队 {ctrl.queuedPrompts.length} 条，本轮结束后按序发送 · Ctrl+Enter 立即插队
          </text>
        ) : null}
        <PromptInput
          value={input}
          onChange={handleChange}
          // 斜杠菜单**有候选**时 Enter 归菜单管（避免双发）；
          // 无候选时菜单不消费，输入框照常提交（用户敲的是没被索引的命令或普通对话）
          onSubmit={
            ctrl.slashOpen && filterSlash(ctrl.slashQuery, ctrl.slashItems).length > 0
              ? () => {}
              : handleSubmit
          }
          onImagePaste={handlePasteImage}
          disabled={inputDisabled}
        />
        <ModeBar mode={ctrl.mode} updateInfo={ctrl.updateInfo} />
      </box>
    </box>
  );
}
