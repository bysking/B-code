import { useMemo } from 'react';
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

/** 面板内容高度预算 */
function contentRows(termRows: number): number {
  return Math.max(termRows - PANEL_CHROME_ROWS, 4);
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
      <scrollbox style={{ flexGrow: 1 }} scrollY focusable={false}>
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
