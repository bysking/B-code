import { useEffect, useMemo, useRef } from 'react';
import type { ScrollBoxRenderable } from '@opentui/core';
import type { SubAgentView, ToolCallDisplay } from '../controller.js';
import { COLORS, TOOL_SYMBOL, TOOL_TONE, attrs, tone } from '../primitives/theme.js';

/**
 * Ctrl+O 面板（工具输出 / 系统日志 / 子 Agent 三页，Tab 轮换）。
 *
 * 用 `<scrollbox>` 原生滚动，不再手算行数与偏移——这是我们之前
 * 花了一百多行做高度估算才解决的事，现在交给渲染器。
 *
 * 「子 Agent」页一页只显示一个子 Agent（←/→ 切换具体哪个）：子 Agent 数量
 * 不固定，摊平成 Tab 会让轮换链越来越长，而 ←/→ 在面板里本来就没被占用。
 */

export type PanelTab = 'tools' | 'logs' | 'subagents';

/** Tab 轮换顺序（UI 与测试共用一处定义，别再各写一份数组） */
export const PANEL_TABS: PanelTab[] = ['tools', 'logs', 'subagents'];

const TAB_LABEL: Record<PanelTab, string> = {
  tools: '工具输出',
  logs: '系统日志',
  subagents: '子 Agent',
};

/** 面板除内容外的固定占用：边框 2 + 标题 1 + 提示 1 */
const PANEL_CHROME_ROWS = 4;

/** 面板内容高度预算（= 面板总高度，边框也算在内） */
function contentRows(termRows: number): number {
  return Math.max(termRows - PANEL_CHROME_ROWS, 4);
}

/**
 * 滚动区高度：面板总高度减去边框、标题、提示。
 *
 * **必须是显式数字，不能靠 `flexGrow` 撑。** 文字内容一多，flex 布局就会把
 * 剩余空间全给滚动区——它先长到内容全高，再连标题、提示一起把外层 `height`
 * 撑爆，于是标题被挤出屏幕顶部（日志几千行时 100% 复现，用户看到的第一行
 * 直接是日志正文）。给了显式高度后滚动区自带裁剪，标题与提示永远留在原位。
 *
 * 减的必须是 PANEL_CHROME_ROWS（含边框 2）而不是"标题+提示 2"：外层给了
 * `height` 之后，边框是从这个高度里扣掉的，漏掉边框就还是多占 2 行。
 */
function scrollRows(termRows: number): number {
  return Math.max(contentRows(termRows) - PANEL_CHROME_ROWS, 1);
}

/** 把工具输出拆成可滚动的内容（一段标题 + 多行正文） */
function ToolRows({ tools }: { tools: ToolCallDisplay[] }) {
  const done = tools.filter((t) => t.status === 'done');
  if (done.length === 0) {
    return <text fg={COLORS.muted}>（暂无已完成的工具调用）</text>;
  }
  return (
    <box flexDirection="column">
      {done.map((t) => (
        <box key={t.id} flexDirection="column" marginBottom={1}>
          <text fg={tone(TOOL_TONE[t.status] ?? 'muted')} attributes={attrs('bold')}>
            {TOOL_SYMBOL[t.status]} {t.name}
            {t.input ? <span fg={COLORS.muted}> {t.input}</span> : null}
          </text>
          {t.output
            ? t.output.split('\n').map((line, i) => (
                <text key={i} fg={COLORS.text}>
                  {line || ' '}
                </text>
              ))
            : null}
        </box>
      ))}
    </box>
  );
}

/** 日志页 */
function LogRows({ logs }: { logs: string[] }) {
  if (logs.length === 0) {
    return <text fg={COLORS.muted}>（暂无日志）</text>;
  }
  return (
    <box flexDirection="column">
      {logs.map((line, i) => (
        <text key={i} fg={COLORS.muted}>
          {line}
        </text>
      ))}
    </box>
  );
}

/**
 * 子 Agent 页：一次看一个子 Agent 的逐步日志。
 *
 * 步骤行的前缀（`tool` / `←` / `done`）由 subagent.ts 拼进文本，这里只按
 * 前缀给点颜色——把结构化字段一路搬到 UI 不值当，行本来就是给人读的。
 */
function SubAgentRows({ sa }: { sa: SubAgentView | undefined }) {
  if (!sa) return <text fg={COLORS.muted}>（暂无子 Agent —— 模型调用 agent 工具或 review_plan 后出现）</text>;
  return (
    <box flexDirection="column">
      <text fg={COLORS.text} attributes={attrs('bold')}>
        {sa.status === 'running' ? '⠒' : sa.status === 'done' ? '✓' : '■'} {sa.role} · {sa.task}
      </text>
      {sa.lines.length === 0 ? (
        // 刚派出去、第一次模型调用还没回来：别让正文空着（用户会以为坏了）
        <text fg={COLORS.muted} attributes={attrs('italic')}>
          （等待模型返回第一步…）
        </text>
      ) : (
        sa.lines.map((line, i) => (
          <text key={i} fg={line.startsWith('←') ? COLORS.muted : COLORS.text}>
            {line}
          </text>
        ))
      )}
    </box>
  );
}

export function OutputPanel({
  tools,
  logs = [],
  subAgents = [],
  subAgentIdx = 0,
  tab = 'tools',
  termRows = 40,
}: {
  tools: ToolCallDisplay[];
  logs?: string[];
  /** 全部子 Agent（按派发顺序）；本页只显示 subAgentIdx 指定的那个 */
  subAgents?: SubAgentView[];
  subAgentIdx?: number;
  tab?: PanelTab;
  /** 已废弃：滚动由 <scrollbox> 自己管。保留参数仅为兼容调用方签名 */
  scroll?: number;
  termRows?: number;
}) {
  const height = contentRows(termRows);
  const current = subAgents[subAgentIdx];
  const body = useMemo(() => {
    if (tab === 'logs') return <LogRows logs={logs} />;
    if (tab === 'subagents') return <SubAgentRows sa={current} />;
    return <ToolRows tools={tools} />;
  }, [tab, tools, logs, current]);

  /**
   * 打开面板（以及切页/切子 Agent）时**默认贴底**。
   *
   * `<scrollbox stickyScroll>` 的粘性只在"已经在底部"时跟随新内容；初次挂载
   * 时它停在顶部，于是打开面板看到的是最早那条日志——而用户按 Ctrl+O 想看的
   * 永远是**最新**发生了什么（尤其模型还在跑的时候）。
   *
   * 调用方给面板挂了 `key`（随 tab / subAgentIdx 变化），所以切页会整块重挂，
   * 这个 effect 自然也会再跑一次，三个页面各自贴底。
   *
   * `scrollTo(Infinity)` 而不是 `scrollHeight`：内容还在布局时前者由原生
   * "回投到有效范围"的语义兜住，后者会拿到 0。
   */
  const scrollerRef = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    const sb = scrollerRef.current;
    if (!sb) return;
    const toBottom = () => {
      try {
        sb.scrollTo(Infinity);
      } catch {
        // 面板已卸载/原生拒绝，忽略
      }
    };
    // 先立即试一次（内容已在时立刻生效），再交给 afterLayout 保证
    // 「本帧布局算完之后」再落一次——首帧 scrollHeight 还是 0，
    // 只靠 setTimeout 在测试渲染器（无真实帧循环）里永远等不到。
    toBottom();
    try {
      sb.afterLayout(toBottom);
    } catch {
      // 老版本/已销毁：忽略
    }
  }, [tab, subAgentIdx, current?.lines.length, tools.length, logs.length]);

  /** 标题：子 Agent 页额外标出"第几个/共几个"，否则用户不知道还有没有别的 */
  const title =
    tab === 'subagents'
      ? `子 Agent${subAgents.length ? ` ${subAgentIdx + 1}/${subAgents.length}` : ''}${
          current ? ` · ${current.role}` : ''
        }`
      : `${TAB_LABEL[tab]}（${tools.filter((t) => t.status === 'done').length} 工具 / ${logs.length} 日志）`;

  return (
    <box
      flexDirection="column"
      height={height}
      borderStyle="rounded"
      borderColor={COLORS.border}
      paddingX={1}
      flexShrink={0}
    >
      <text fg={COLORS.accent} attributes={attrs('bold')}>
        {title}
      </text>
      {/* 显式高度：靠 flexGrow 会被内容撑爆，把标题/提示挤出屏幕（见 scrollRows） */}
      <scrollbox
        ref={scrollerRef}
        style={{ height: scrollRows(termRows), flexShrink: 0 }}
        scrollY
        focusable={false}
      >
        {body}
      </scrollbox>
      <text fg={COLORS.muted} attributes={attrs('dim')}>
        Tab 切换页
        {tab === 'subagents' && subAgents.length > 1 ? ' · ←/→ 切换子 Agent' : ''} · Esc 关闭 · 滚轮/↑↓ 滚动
      </text>
    </box>
  );
}

/** 面板可滚动最大偏移（保留给调用方判断是否需要接方向键） */
export function outputPanelMaxScroll(
  tools: ToolCallDisplay[],
  tab: PanelTab = 'tools',
  logs: string[] = [],
  subAgents: SubAgentView[] = [],
  subAgentIdx = 0,
  termRows = 40,
): number {
  // 滚动已交给 scrollbox，这里只需告诉调用方"是否有内容可滚"
  const count =
    tab === 'logs'
      ? logs.length
      : tab === 'subagents'
        ? (subAgents[subAgentIdx]?.lines.length ?? 0)
        : tools.filter((t) => t.status === 'done').length;
  return Math.max(count - contentRows(termRows), 0);
}

export function outputPanelScrollable(
  tools: ToolCallDisplay[],
  tab: PanelTab = 'tools',
  logs: string[] = [],
  subAgents: SubAgentView[] = [],
  subAgentIdx = 0,
  termRows = 40,
): boolean {
  return outputPanelMaxScroll(tools, tab, logs, subAgents, subAgentIdx, termRows) > 0;
}
