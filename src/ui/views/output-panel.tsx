import { useMemo } from 'react';
import type { ToolCallDisplay } from '../controller.js';
import { COLORS, TOOL_SYMBOL, TOOL_TONE, attrs, tone } from '../primitives/theme.js';

/**
 * Ctrl+O 工具输出面板（工具输出 / 系统日志两页）。
 *
 * 用 `<scrollbox>` 原生滚动，不再手算行数与偏移——这是我们之前
 * 花了一百多行做高度估算才解决的事，现在交给渲染器。
 */

export type PanelTab = 'tools' | 'logs';

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

export function OutputPanel({
  tools,
  logs = [],
  tab = 'tools',
  termRows = 40,
}: {
  tools: ToolCallDisplay[];
  logs?: string[];
  tab?: PanelTab;
  /** 已废弃：滚动由 <scrollbox> 自己管。保留参数仅为兼容调用方签名 */
  scroll?: number;
  termRows?: number;
}) {
  const height = contentRows(termRows);
  const body = useMemo(
    () => (tab === 'logs' ? <LogRows logs={logs} /> : <ToolRows tools={tools} />),
    [tab, tools, logs],
  );

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
        {tab === 'logs' ? '系统日志' : '工具输出'}（{tools.filter((t) => t.status === 'done').length}{' '}
        工具 / {logs.length} 日志）
      </text>
      <scrollbox style={{ flexGrow: 1 }} scrollY focusable={false}>
        {body}
      </scrollbox>
      <text fg={COLORS.muted} attributes={attrs('dim')}>
        Tab 切换页 · Esc 关闭 · 滚轮/↑↓ 滚动
      </text>
    </box>
  );
}

/** 面板可滚动最大偏移（保留给调用方判断是否需要接方向键） */
export function outputPanelMaxScroll(
  tools: ToolCallDisplay[],
  tab: PanelTab = 'tools',
  logs: string[] = [],
  termRows = 40,
): number {
  // 滚动已交给 scrollbox，这里只需告诉调用方"是否有内容可滚"
  const count = tab === 'logs' ? logs.length : tools.filter((t) => t.status === 'done').length;
  return Math.max(count - contentRows(termRows), 0);
}

export function outputPanelScrollable(
  tools: ToolCallDisplay[],
  tab: PanelTab = 'tools',
  logs: string[] = [],
  termRows = 40,
): boolean {
  return outputPanelMaxScroll(tools, tab, logs, termRows) > 0;
}
