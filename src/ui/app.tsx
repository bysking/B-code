import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import type { AppController, SlashItem, ToolCallDisplay } from './controller.js';
import type { Mode } from '../permissions.js';
import type { ClipboardImage } from '../utils/clipboard.js';
import { readClipboardImage } from '../utils/clipboard.js';
import { Transcript, BusyLine } from './transcript.js';
import { ScrollView } from './viewport/scroll-view.js';
import {
  INITIAL_SCROLL,
  isAtBottom,
  scrollDown,
  scrollToBottom,
  scrollUp,
  type ScrollState,
} from './viewport/viewport.js';
import { Confirm } from './confirm.js';
import { Wizard } from './wizard.js';
import { SlashMenu } from './slash-menu.js';
import { InputBox } from './input-box.js';
import { OutputPanel, outputPanelMaxScroll, type PanelTab } from './output-panel.js';
import { isCompactTerminal, terminalRows } from './scroll-budget.js';
import { TaskPanel } from './task-panel.js';
import { TodoPanel } from './todo-panel.js';
import { UserTodoEditor } from './user-todo-editor.js';
import { CapabilityPanel } from './capability-panel.js';
import { AskInput } from './ask-input.js';
import { ModeBar } from './mode-bar.js';
import { buildSlash, buildSubmitLine } from './slash.js';

/**
 * ink 根组件（ink 8 滚动视口版）。
 *
 * 布局：滚动视口（历史 + 底部状态行） → 交互区（确认/向导/菜单/面板） → 输入框 → 模式栏。
 *
 * 与旧实现的关键差别：
 *   1. 历史不再交给终端 scrollback，而是画在 `<ScrollView>` 里。resize 时重排的是
 *      **同一帧**，不存在"按旧布局行数擦除新内容"这种必然花屏的路径。
 *   2. 视口高度由 flexGrow 让 Yoga 算，不再用 estimateLines 猜底栏占几行。
 *   3. 滚动状态是我们自己的（距底行数 + 是否跟随），取代向终端发 CPR 问光标位置。
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
  /** 能力面板空格：切换技能/MCP 启停（cli 负责落盘并回灌列表） */
  onToggleCapability?: (name: string) => void;
  /** 能力面板 R：重连 MCP server（仅 kind === 'mcp' 时触发） */
  onReconnectCapability?: (name: string) => void;
  /** 面板刷新数据源（每次按键后重拉，避免列表过期） */
  refreshCapability?: () => void;
  initialOutput?: string[];
}) {
  const [, force] = useState(0);
  useEffect(() => ctrl.subscribe(() => force((v) => v + 1)), [ctrl]);

  // ── 滚动状态 ──────────────────────────────────────────────
  const [scroll, setScrollState] = useState<ScrollState>(INITIAL_SCROLL);
  const scrollRef = useRef(scroll);
  scrollRef.current = scroll;
  const setScroll = useCallback((next: ScrollState) => {
    if (next === scrollRef.current) return; // 同引用 = 无需更新
    setScrollState(next);
  }, []);

  // 需要用户当场作答的交互（确认/向导/文本提问）必须可见 → 强制回到底部
  const needsAnswer = Boolean(ctrl.askState || ctrl.askWizardState || ctrl.askTextState);
  useEffect(() => {
    if (needsAnswer && !scrollRef.current.following) setScroll(scrollToBottom());
  }, [needsAnswer, setScroll]);

  // 终端 resize：触发一次重渲染让 flexGrow 重新布局。ScrollView 内部用 useBoxMetrics
  // 感知高度变化并修正距底行数（保持用户看到的内容不跳）。
  useEffect(() => {
    const onResize = () => force((v) => v + 1);
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);

  const [input, setInput] = useState('');
  // 补全时 ++ 强制 TextInput 重挂：让光标回到新文本末尾
  const [inputNonce, setInputNonce] = useState(0);
  // 双 Ctrl+C：第一次提示，第二次真正退出（2s 内有效）
  const [quitArmed, setQuitArmed] = useState(false);
  // Ctrl+O 面板的翻页偏移与标签页
  const [panelScroll, setPanelScroll] = useState(0);
  const [panelTab, setPanelTab] = useState<PanelTab>('tools');
  // 输入历史
  const inputHistory = useRef<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  // 粘贴的图片数据：[image #N] 占位符 → N-1 索引
  const imagesRef = useRef<ClipboardImage[]>([]);

  /** 翻页步长：视口的 3/4，留几行上下文便于连续阅读 */
  const pageLines = () => Math.max(Math.floor(terminalRows() * 0.75), 3);

  useInput((_input, key) => {
    // Ctrl+C：有选择框/向导/文本输入 → 取消；执行中 → 双击才真正退出
    if (key.ctrl && _input === 'c') {
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

    // Ctrl+O：工具输出面板（面板自己处理 ↑↓ 翻页）
    if (ctrl.outputPanel) {
      if (key.tab) {
        setPanelTab((t) => (t === 'tools' ? 'logs' : 'tools'));
        setPanelScroll(0);
        return;
      }
      const step = key.pageUp || key.pageDown ? Math.max(terminalRows() - 12, 5) : 1;
      if (key.upArrow || key.pageUp) {
        setPanelScroll((s) =>
          Math.min(s + step, outputPanelMaxScroll(allToolOutputs(ctrl), panelTab, ctrl.logs)),
        );
        return;
      }
      if (key.downArrow || key.pageDown) {
        setPanelScroll((s) => Math.max(s - step, 0));
        return;
      }
      if (key.escape) {
        ctrl.toggleOutputPanel(false);
        return;
      }
    }
    if (key.ctrl && _input === 'o') {
      ctrl.toggleOutputPanel();
      setPanelScroll(0);
      return;
    }

    // Shift+Tab：循环切换模式
    if (key.tab && key.shift) {
      ctrl.cycleMode();
      onSetMode(ctrl.mode);
      return;
    }

    // ── 滚动（替代旧的 CPR 探测：视口是我们自己的，不必问终端） ──
    // ↑↓ 是"共享按键"：斜杠菜单/确认框/向导都要用，所以这些交互打开时必须让位
    // （它们各自有 useInput，这里提前 return 就不会拦截）。PgUp/PgDn 是滚动专用，随时可接管。
    const uiBusy = Boolean(
      ctrl.slashOpen || ctrl.askState || ctrl.askWizardState || ctrl.askTextState,
    );
    if (key.pageUp && !uiBusy) {
      setScroll(scrollUp(scrollRef.current, pageLines()));
      return;
    }
    if (key.pageDown && !uiBusy) {
      setScroll(scrollDown(scrollRef.current, pageLines()));
      return;
    }

    if (key.upArrow && !key.ctrl && !key.meta) {
      if (uiBusy) return; // 让给菜单/选择框
      // 已滚离底部 → ↑ 继续上滚（回看历史优先）
      if (!scrollRef.current.following) {
        setScroll(scrollUp(scrollRef.current, 1));
        return;
      }
      // 贴底态下 ↑ 走输入历史导航
      const hist = inputHistory.current;
      if (hist.length > 0 && historyIdx < hist.length - 1) {
        const newIdx = historyIdx + 1;
        setHistoryIdx(newIdx);
        setInput(hist[hist.length - 1 - newIdx] ?? '');
        setInputNonce((n) => n + 1);
      }
      return;
    }
    if (key.downArrow && !key.ctrl && !key.meta) {
      if (uiBusy) return; // 让给菜单/选择框
      // 已滚离底部 → ↓ 优先往下滚回来（回到底部即自动恢复跟随）
      if (!scrollRef.current.following) {
        setScroll(scrollDown(scrollRef.current, 1));
        return;
      }
      if (historyIdx > 0) {
        const newIdx = historyIdx - 1;
        setInput(inputHistory.current[inputHistory.current.length - 1 - newIdx] ?? '');
        setInputNonce((n) => n + 1);
      } else if (historyIdx === 0) {
        setHistoryIdx(-1);
        setInput('');
        setInputNonce((n) => n + 1);
      }
      return;
    }

    // Esc
    if (key.escape && ctrl.outputPanel) {
      ctrl.toggleOutputPanel(false);
      return;
    }
    if (key.escape && ctrl.askTextState) {
      ctrl.resolveAskText('', true);
      return;
    }
    if (key.escape && !ctrl.askState && !ctrl.askWizardState && ctrl.busy !== null) {
      onInterrupt();
    }
  });

  // ── 粘贴（ink 8 的 usePaste：括号粘贴，整段文本一次到达）──────
  // 取代旧的"自己读剪贴板文本 + 逐字符插入"。图片仍走 Ctrl+V
  // （剪贴板里是二进制，需要剪贴板 API 才读得到）。
  //
  // 注意：**不要**用 isActive 关掉它。ink 的 usePaste 在 isActive 变化时会
  // setRawMode(false)——那会把整个 ink 的 raw mode 关掉，之后所有 useInput
  // 都收不到按键（表现为"打开向导后键盘失灵"）。改为常驻挂载、在 handler 里
  // 判断是否该接收粘贴。
  usePaste((text) => {
    if (ctrl.askState || ctrl.askTextState || ctrl.askWizardState) return;
    if (ctrl.userTodoOpen || ctrl.capabilityPanel) return;
    setInput((v) => v + text);
  });

  const handleChange = (value: string) => {
    setInput(value);
    if (historyIdx !== -1) setHistoryIdx(-1);
    if (value.startsWith('/')) ctrl.openSlash(value.slice(1));
    else if (ctrl.slashOpen) ctrl.closeSlash();
  };

  /** Ctrl+V：只用来取图片（文本走 usePaste 的括号粘贴） */
  const handlePasteImage = (): string | null => {
    const clipboardImage = readClipboardImage();
    if (!clipboardImage) return null;
    const idx = imagesRef.current.length + 1;
    imagesRef.current.push(clipboardImage);
    return `[image #${idx}]`;
  };

  /** Tab 补全 */
  const handleComplete = (item: SlashItem) => {
    const completed = buildSlash(input, item.name);
    setInput(completed);
    setInputNonce((n) => n + 1);
    ctrl.openSlash(completed.slice(1));
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
    setInputNonce((n) => n + 1);
    imagesRef.current = [];
    ctrl.closeSlash();
    // 提交 = 用户要看新一轮输出 → 贴底跟随
    setScroll(scrollToBottom());

    if (usedImages.length > 0) onSubmit({ text: cleanText, images: usedImages });
    else onSubmit(trimmed);
  };

  const compact = isCompactTerminal();
  // 底部状态行只在贴底时显示（滚上去看历史时不打扰）
  const atBottom = isAtBottom(scroll.fromBottom);

  /**
   * 底栏容器：**必须 flexShrink={0}**。
   *
   * Yoga 里所有子节点默认 flexShrink=1，总高超出时按比例让**每个**子节点都缩。
   * 于是"视口 + 斜杠菜单"同时被压：视口缩几行无感（它本来就可滚动），但菜单被压掉
   * 顶部几行，用户就看不到第一项（实测 /help 撑满视口后 → 菜单只剩 7 项且行与行叠在一起）。
   *
   * 正确的模型：视口是唯一的弹性区（flexGrow=1 + flexShrink=1），底栏各块固定高度、
   * 绝不压缩。这样无论历史多长，菜单/面板总是完整展示。
   */
  return (
    <Box flexDirection="column" height={terminalRows()}>
      {/* 滚动视口：唯一可伸缩的区块 */}
      <ScrollView scroll={scroll} onScroll={setScroll}>
        <Transcript turns={ctrl.turns} output={ctrl.output} initialOutput={initialOutput} />
        {ctrl.busy && ctrl.busySince !== null && atBottom ? (
          <Box marginTop={1}>
            <BusyLine
              text={ctrl.busy}
              since={ctrl.busySince}
              thinking={ctrl.busyThinking}
              inputTokens={ctrl.busyInputTokens}
            />
          </Box>
        ) : null}
      </ScrollView>

      {/* ── 底栏：固定高度，绝不压缩（flexShrink=0） ──
          每一块都是"用户必须看全"的内容：菜单少了第一项就没法选，确认框截断就读不懂在问什么。
          把它们包进 flexShrink=0 的容器，让所有压缩都落在上面那个可滚动的视口上。 */}
      <Box flexDirection="column" flexShrink={0}>
        {/* 交互区（同时最多一种） */}
        {ctrl.askWizardState ? (
          <Wizard ask={ctrl.askWizardState} onResolve={(v) => ctrl.resolveAskWizard(v)} />
        ) : ctrl.askState ? (
          <Confirm ask={ctrl.askState} onResolve={(v) => ctrl.resolveAsk(v)} />
        ) : null}

        {ctrl.askTextState ? (
          <AskInput question={ctrl.askTextState.question} onSubmit={(v) => ctrl.resolveAskText(v)} />
        ) : null}

        {ctrl.slashOpen ? (
          <SlashMenu
            query={ctrl.slashQuery}
            items={ctrl.slashItems}
            onPick={(item) => handleSubmit(buildSubmitLine(input, item.name))}
            onSubmitRaw={() => handleSubmit(input)}
            onComplete={handleComplete}
            onClose={() => ctrl.closeSlash()}
          />
        ) : null}

        {ctrl.outputPanel ? (
          <OutputPanel tools={allToolOutputs(ctrl)} logs={ctrl.logs} tab={panelTab} scroll={panelScroll} />
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

        {quitArmed ? (
          <Box>
            <Text dimColor>(再按一次 Ctrl+C 退出)</Text>
          </Box>
        ) : null}

        <Box flexDirection="column" flexShrink={0}>
          <InputBox
            key={inputNonce}
            value={input}
            onChange={handleChange}
            onSubmit={handleSubmit}
            onPaste={handlePasteImage}
            disabled={
              !!ctrl.askState ||
              !!ctrl.askTextState ||
              !!ctrl.askWizardState ||
              ctrl.userTodoOpen ||
              !!ctrl.capabilityPanel
            }
            slashOpen={ctrl.slashOpen}
          />
          <ModeBar mode={ctrl.mode} updateInfo={ctrl.updateInfo} />
        </Box>
      </Box>
    </Box>
  );
}
