import { useCallback, useEffect, useRef, useState } from 'react';
import { useKeyboard, usePaste, useRenderer, useTerminalDimensions } from '@opentui/react';
import type { AppController, SlashItem, ToolCallDisplay } from './controller.js';
import type { Mode } from '../permissions.js';
import type { ClipboardImage } from '../utils/clipboard.js';
import { readClipboardImage } from '../utils/clipboard.js';
import { Transcript, BusyLine } from './views/transcript.js';
import { PromptInput } from './views/input.js';
import { SlashMenu } from './views/slash-menu.js';
import { OutputPanel, outputPanelMaxScroll } from './views/output-panel.js';
import { TaskPanel } from './views/task-panel.js';
import { TodoPanel } from './views/todo-panel.js';
import { ModeBar } from './views/mode-bar.js';
import { Confirm } from './views/confirm.js';
import { Wizard } from './views/wizard.js';
import { CapabilityPanel } from './views/capability.js';
import { UserTodoEditor } from './views/user-todo.js';
import { AskInput } from './views/ask-input.js';
import { buildSubmitLine, filterSlash } from './slash.js';
import { COLORS } from './primitives/theme.js';

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

export function App({
  ctrl,
  onSubmit,
  onInterrupt,
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
  const [panelScroll, setPanelScroll] = useState(0);
  const [panelTab, setPanelTab] = useState<'tools' | 'logs'>('tools');
  const inputHistory = useRef<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const imagesRef = useRef<ClipboardImage[]>([]);

  /** 需要用户当场作答的交互（确认/向导/文本提问） */
  const needsAnswer = Boolean(ctrl.askState || ctrl.askWizardState || ctrl.askTextState);
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

    // Ctrl+O：工具输出面板
    if (ctrl.outputPanel) {
      if (e.name === 'tab') {
        setPanelTab((t) => (t === 'tools' ? 'logs' : 'tools'));
        setPanelScroll(0);
        return;
      }
      const step = e.name === 'pageup' || e.name === 'pagedown' ? Math.max(termRows - 12, 5) : 1;
      if (e.name === 'up' || e.name === 'pageup') {
        setPanelScroll((s) =>
          Math.min(
            s + step,
            outputPanelMaxScroll(allToolOutputs(ctrl), panelTab, ctrl.logs, termRows),
          ),
        );
        return;
      }
      if (e.name === 'down' || e.name === 'pagedown') {
        setPanelScroll((s) => Math.max(s - step, 0));
        return;
      }
      if (e.name === 'escape') {
        ctrl.toggleOutputPanel(false);
        return;
      }
    }
    if (e.ctrl && e.name === 'o') {
      ctrl.toggleOutputPanel();
      setPanelScroll(0);
      return;
    }

    // Shift+Tab：循环切换模式
    if (e.name === 'tab' && e.shift) {
      ctrl.cycleMode();
      onSetMode(ctrl.mode);
      return;
    }

    // ↑↓：输入框为空时用于输入历史导航（有内容时交给 textarea 移光标）
    const interactiveOpen = Boolean(
      ctrl.slashOpen || ctrl.askState || ctrl.askWizardState || ctrl.askTextState,
    );
    if (e.name === 'up' && !e.ctrl && !e.meta && !interactiveOpen && input === '') {
      const hist = inputHistory.current;
      if (hist.length > 0 && historyIdx < hist.length - 1) {
        const next = historyIdx + 1;
        setHistoryIdx(next);
        setInput(hist[hist.length - 1 - next] ?? '');
      }
      return;
    }
    if (e.name === 'down' && !e.ctrl && !e.meta && !interactiveOpen && input === '') {
      if (historyIdx > 0) {
        const next = historyIdx - 1;
        setInput(inputHistory.current[inputHistory.current.length - 1 - next] ?? '');
        setHistoryIdx(next);
      } else if (historyIdx === 0) {
        setHistoryIdx(-1);
        setInput('');
      }
      return;
    }

    // Esc
    if (e.name === 'escape') {
      // 有选中态时优先清选中（用户想取消选择，而不是中断对话）
      const sel = renderer.getSelection?.();
      if (sel?.getSelectedText?.()) {
        renderer.clearSelection?.();
        return;
      }
      if (ctrl.outputPanel) {
        ctrl.toggleOutputPanel(false);
        return;
      }
      if (ctrl.askTextState) {
        ctrl.resolveAskText('', true);
        return;
      }
      if (!ctrl.askState && !ctrl.askWizardState && ctrl.busy !== null) {
        onInterrupt();
      }
    }
  });

  /* ── 粘贴 ─────────────────────────────────────────── */
  usePaste((event) => {
    if (inputDisabled) return;
    setInput((v) => v + new TextDecoder().decode(event.bytes));
  });

  const handleChange = useCallback(
    (value: string) => {
      setInput(value);
      if (historyIdx !== -1) setHistoryIdx(-1);
      if (value.startsWith('/')) ctrl.openSlash(value.slice(1));
      else if (ctrl.slashOpen) ctrl.closeSlash();
    },
    [ctrl, historyIdx],
  );

  /** Ctrl+V：只用来取图片（文本走括号粘贴） */
  const handlePasteImage = (): string | null => {
    const img = readClipboardImage();
    if (!img) return null;
    const idx = imagesRef.current.length + 1;
    imagesRef.current.push(img);
    return `[image #${idx}]`;
  };

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
    setHistoryIdx(-1);
    setInput('');
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
          tools={allToolOutputs(ctrl)}
          logs={ctrl.logs}
          tab={panelTab}
          scroll={panelScroll}
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

      {/* ── 底部固定区：退出提示 + 输入框 + 模式栏 ──
          提示必须在这里（flexShrink=0 的底栏内部），不能放在滚动区后面：
          斜杠菜单/输出面板一展开就把滚动区顶高，提示会被挤出可见区
          （实测 22 行终端下完全看不到，用户以为 Ctrl+C 没反应）。 */}
      <box flexDirection="column" flexShrink={0}>
        {quitArmed ? (
          <text fg={COLORS.warning}>(再按一次 Ctrl+C 退出)</text>
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
