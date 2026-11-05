import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import type { AppController, SlashItem, ToolCallDisplay, Turn } from './controller.js';
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
import { isCompactTerminal, useTerminalSize } from './scroll-budget.js';
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
 *   1. 历史走 `<Static>` 永久打印进终端 scrollback —— 用户可用终端原生的
 *      鼠标滚轮 / 滚动条 / Shift+PgUp 回看，退出后历史也留在终端里。
 *      （ink 8 已修复 resize 时 static 输出被擦错的问题，实测多轮尺寸变化不失真。）
 *   2. live 区只放"还在变"的内容（最后一条 turn + busy 行），每帧重绘不影响历史。
 *   3. 尺寸统一从 `useTerminalSize()` 取（读 ink 的渲染流，而非 process.stdout）——
 *      读错对象会让帧高与终端高度不一致，触发 ink 整屏清屏、历史全丢。
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

  /**
   * 终端尺寸必须从 ink 的渲染上下文取（useWindowSize），不能读 process.stdout.rows。
   *
   * 踩过的坑：根盒子用 process.stdout.rows 算高度（测试/非默认流下兜底成 40），
   * 而 ink 实际渲染流只有 30 行 → 帧比终端高 → ink 整屏清屏 → 历史被清掉且滚不动。
   * 用户看到的就是"对话后历史看不全、无法向上滚动"。
   */
  const { rows: termRows, columns: termCols } = useTerminalSize();

  // 滚动状态：距底部行数 + 是否跟随（新内容到来时自动贴底）。
  // 这是固定视口方案的核心——位置由我们自己管，不依赖终端。
  const [scroll, setScrollState] = useState<ScrollState>(INITIAL_SCROLL);
  const scrollRef = useRef(scroll);
  scrollRef.current = scroll;

  /**
   * 滚轮事件累积器。
   *
   * 触摸板一次轻扫会产生几十个滚轮事件，密集到达（惯性滚动）。必须**攒起来一次性提交**，
   * 不能每个事件都 setState：
   *   - 每个事件都 setState → React 批处理会把它们合并，但因为我们同时读 `scrollRef.current`
   *     做基准，后到的事件会基于陈旧值计算 → 大量事件被吃掉（实测：10 个事件应滚 30 行，
   *     实际只滚 15 行，恰好丢一半）。
   *   - 攒一帧再提交 → 一帧内的所有事件按位移总和累加，不丢不重。
   *
   * 用 `requestAnimationFrame` 对齐渲染节奏：一帧最多提交一次，既保证精度也避免狂重渲染。
   */
  const wheelAccum = useRef(0);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushWheel = useCallback(() => {
    wheelTimer.current = null;
    const delta = wheelAccum.current;
    wheelAccum.current = 0;
    if (delta === 0) return;
    setScrollState((prev) => {
      const next = delta > 0 ? scrollUp(prev, delta) : scrollDown(prev, -delta);
      scrollRef.current = next;
      return next;
    });
  }, []);

  const queueWheel = useCallback(
    (delta: number) => {
      wheelAccum.current += delta;
      if (wheelTimer.current === null) {
        // 用 **0ms**（下一个宏任务）而不是 16ms：
        // 目标只是把"同一 tick 涌入的多个事件"合并成一次 setState，
        // 不需要等一整帧——等 16ms 等于给每次滚动凭空加 16ms 延迟（用户能感觉到迟滞）。
        // 0ms 让同 tick 的事件先全部入账，下一个宏任务立即提交。
        wheelTimer.current = setTimeout(flushWheel, 0);
      }
    },
    [flushWheel],
  );

  // 卸载时把未提交的位移补上，避免丢失
  useEffect(() => {
    return () => {
      if (wheelTimer.current !== null) {
        clearTimeout(wheelTimer.current);
        wheelTimer.current = null;
      }
    };
  }, []);

  // 把滚动位置回写到 controller（供测试/调试观察）。
  // 直接赋值而非 useEffect：effect 会在每次渲染后多跑一轮，
  // 滚动是高频操作，能省一次就省一次。
  ctrl.scrollFromBottom = scroll.fromBottom;

  /** 键盘等即时路径：函数式更新，立即生效 */
  const scrollBy = useCallback((fn: (prev: ScrollState) => ScrollState) => {
    setScrollState((prev) => {
      const next = fn(prev);
      scrollRef.current = next;
      return next;
    });
  }, []);

  /** 需要"立刻拿到最新值"的场景（键盘同帧连按）直接改 ref + state */
  const setScroll = useCallback((next: ScrollState) => {
    if (next === scrollRef.current) return;
    scrollRef.current = next;
    setScrollState(next);
  }, []);

  // 鼠标滚轮 → 视口滚动。
  // 事件来自 render 层的 stdin 过滤流（ink 会丢弃鼠标控制序列，拿不到），
  // 经 controller 中转到这里。用 ref 读最新滚动状态，避免闭包捕获旧值。
  useEffect(() => {
    return ctrl.onMouseWheel((delta) => {
      // 累积后一帧统一提交：触摸板惯性滚动会连发几十个事件（见 queueWheel 注释）
      queueWheel(delta);
    });
  }, [ctrl, queueWheel]);

  // 需要用户当场作答的交互（确认/向导/文本提问）必须可见 → 强制回到底部
  const needsAnswer = Boolean(ctrl.askState || ctrl.askWizardState || ctrl.askTextState);
  useEffect(() => {
    // 需要作答时确保内容可见：交给终端滚到底（Static 内容已在 scrollback 里）
    if (needsAnswer) force((v) => v + 1);
  }, [needsAnswer]);

  // 终端 resize：触发一次重渲染，让依赖终端尺寸的面板（菜单/能力面板/输出面板）
  // 重新计算可见条数。历史本身在 scrollback 里，由终端自己重排。
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
      const step = key.pageUp || key.pageDown ? Math.max(termRows - 12, 5) : 1;
      if (key.upArrow || key.pageUp) {
        setPanelScroll((s) =>
          Math.min(s + step, outputPanelMaxScroll(allToolOutputs(ctrl), panelTab, ctrl.logs, termRows)),
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

    // 历史滚动交给终端原生处理（内容在 scrollback 里，鼠标滚轮/滚动条/Shift+PgUp 都可用）。
    // 这里只保留"共享按键"的让位判断：↑↓ 属于菜单/确认框/向导。
    const uiBusy = Boolean(
      ctrl.slashOpen || ctrl.askState || ctrl.askWizardState || ctrl.askTextState,
    );

    // ── 滚动（视口是我们自己的，不必问终端） ──
    // PgUp/PgDn 是滚动专用键，随时可接管；↑↓ 是"共享按键"，菜单/确认框打开时让位。
    const pageLines = () => Math.max(Math.floor(termRows * 0.75), 3);
    if (key.pageUp && !uiBusy) {
      scrollBy((prev) => scrollUp(prev, pageLines()));
      return;
    }
    if (key.pageDown && !uiBusy) {
      scrollBy((prev) => scrollDown(prev, pageLines()));
      return;
    }

    if (key.upArrow && !key.ctrl && !key.meta) {
      if (uiBusy) return; // 让给菜单/选择框
      // 已滚离底部 → ↑ 继续上滚（回看历史优先）
      if (!scrollRef.current.following) {
        scrollBy((prev) => scrollUp(prev, 1));
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
      // 已滚离底部 → ↓ 优先往下滚回来（回到底部自动恢复跟随）
      if (!scrollRef.current.following) {
        scrollBy((prev) => scrollDown(prev, 1));
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
  // ── 固定窗口滚动视口 ──────────────────────────────────────
  //
  // 历史全部画在应用内的滚动视口里（ink 8 的 contentOffsetY + overflow），
  // 滚动位置是我们自己的状态。相比 <Static> 交给终端 scrollback：
  //   - 窗口 resize 时重排的是**同一帧**，不存在"按旧布局擦除新内容"的风险
  //   - 流式输出再长也只是滚动，不会出现擦除行数对不上导致的内容重复
  // 代价是历史不进终端 scrollback，用视口自己的滚动（键盘 + 鼠标滚轮）回看。
  return (
    <Box flexDirection="column" height={termRows}>
      {/* 视口：唯一可伸缩区。高度由 flexGrow 让 Yoga 算，不猜底栏占几行 */}
      <ScrollView scroll={scroll} onScroll={setScroll}>
        {({ scrollTop, viewportRows }: { scrollTop: number; viewportRows: number }) => (
          <>
            {/* 虚拟滚动：只渲染视口附近的条目。全量渲染时 Yoga 要重排整棵树，
                实测 60 轮对话单次 47ms、120 轮 63ms——滚轮密集到达时就是"卡顿"。 */}
            <Transcript
              turns={ctrl.turns}
              output={ctrl.output}
              initialOutput={initialOutput}
              scrollTop={scrollTop}
              viewportRows={viewportRows}
              cols={termCols}
            />
            {ctrl.busy && ctrl.busySince !== null ? (
              <Box marginTop={1}>
                <BusyLine
                  text={ctrl.busy}
                  since={ctrl.busySince}
                  thinking={ctrl.busyThinking}
                  inputTokens={ctrl.busyInputTokens}
                />
              </Box>
            ) : null}
          </>
        )}
      </ScrollView>

      {/* ── 底栏：固定高度，绝不压缩（flexShrink=0） ──
          每一块都是"用户必须看全"的内容：菜单少了第一项就没法选，确认框截断就读不懂在问什么。 */}
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
            termRows={termRows}
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
