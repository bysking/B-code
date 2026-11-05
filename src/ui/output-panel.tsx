import React from 'react';
import { Box, Text } from 'ink';
import type { ToolCallDisplay } from './controller.js';
import { estimateLines, useTerminalSize } from './scroll-budget.js';

/**
 * 单条输出在展开态下的展示上限。取得很大（而不是原来的 2000 字符）是为了
 * "Ctrl+O 能看到完整日志"——真正的可视范围由窗口/翻页控制，而不是粗暴截断。
 */
const MAX_OUTPUT = 200_000;

/**
 * 面板外固定占用的行数：输入行(1) + 模式栏(1~2) + 面板边框(2) + 标题行(1) + 位置提示行(1)。
 * 多留 1 行余量，确保整帧高度**严格小于**终端行数——等于也会触发 ink 的清屏分支。
 */
const PANEL_CHROME_ROWS = 7;

/**
 * 工具输出正文：对 edit_file 的 diff 片段做行级着色（- 删除行红 / + 新增行绿 / 上下文置灰），
 * 其余输出保持默认灰。着色只发生在 UI 层——模型上下文里的 tool_result 与会话历史始终是纯文本。
 */
function OutputBody({ text }: { text: string }) {
  const body = text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (truncated)` : text;
  const lines = body.split('\n');
  return (
    <Text>
      {lines.map((line, i) => {
        const color = line.startsWith('- ') ? 'red' : line.startsWith('+ ') ? 'green' : undefined;
        return (
          <Text key={i} color={color} dimColor={color === undefined}>
            {i === 0 ? '' : '\n'}
            {line}
          </Text>
        );
      })}
    </Text>
  );
}

/**
 * 扁平化后的一条可渲染项：要么是工具标题行，要么是它的一段输出正文。
 * height = 该行在终端里实际占用的行数（已含软换行），分页预算按它累加。
 */
type Row = {
  kind: 'header' | 'body';
  tool: ToolCallDisplay;
  text: string;
  height: number;
};

/**
 * 把"工具列表 + 各自输出"摊平成固定粒度的行序列。
 *
 * 为什么按行而不是按工具做分页：单个工具的输出可能就几百行，若按工具分页，
 * 一个长 run_shell 就会占满整屏、无法看到它的中段。按行摊平后，滚动/翻页
 * 的粒度与终端行对齐，长输出也能逐屏看完。
 *
 * height 用 estimateLines（内部 wrap-ansi）估算：日志里常见超长单行（JSON、路径），
 * 按 \n 计数会严重低估——一条 300 字符的行在 80 列终端要占 4 行，低估就会
 * 撑爆预算、触发 ink 整屏清屏。
 */
function flatten(tools: ToolCallDisplay[]): Row[] {
  const rows: Row[] = [];
  for (const t of tools) {
    const head = `✓ ${t.name}${t.input ? ` ${t.input}` : ''}`;
    rows.push({ kind: 'header', tool: t, text: head, height: estimateLines(head) });
    const out = t.output ?? '(no captured output)';
    const body = out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n… (truncated)` : out;
    for (const line of body.split('\n')) {
      rows.push({ kind: 'body', tool: t, text: line, height: estimateLines(line) });
    }
  }
  return rows;
}

/**
 * 从 rows[end-1] 往前取，直到累计高度触及 budget，返回起点下标。
 * 单行本身超过 budget（极长的一行）时也会保留它——否则会卡住无法前进。
 */
function windowStart(rows: Row[], end: number, budget: number): number {
  let used = 0;
  let i = end;
  while (i > 0) {
    const h = rows[i - 1]!.height;
    if (used + h > budget && used > 0) break;
    used += h;
    i--;
  }
  return i;
}

/** 全量内容在给定预算下最多能向上翻多少"渲染行" */
function maxScrollRows(rows: Row[], budget: number): number {
  const total = rows.reduce((n, r) => n + r.height, 0);
  return Math.max(total - budget, 0);
}

/** 由"距底部 offset 个渲染行"求视窗结束下标（end），offset=0 即贴底 */
function endIndexForRows(rows: Row[], offset: number): number {
  let used = 0;
  let i = rows.length;
  while (i > 0 && used < offset) {
    used += rows[i - 1]!.height;
    i--;
  }
  return i;
}

/** 面板的两个标签页 */
export type PanelTab = 'tools' | 'logs';

/** 把系统日志行摊平成 Row（无归属工具，单表单色） */
function flattenLogs(logs: string[]): Row[] {
  return logs.map((text) => ({
    kind: 'body' as const,
    tool: { id: 'log', name: 'log', input: '', status: 'done' as const },
    text,
    height: estimateLines(text),
  }));
}

/**
 * Ctrl+O 面板：两个标签页——工具输出（tools）/ 系统日志（logs）。
 *
 * 高度约束：帧高超过终端行数会触发 Ink 整屏清屏（ESC[3J 连 scrollback 一起清）。
 * 因此只渲染"窗口内"的若干行，完整内容通过翻页查看。
 */
export function OutputPanel({
  tools,
  logs = [],
  tab = 'tools',
  scroll,
  termRows: termRowsOverride,
}: {
  tools: ToolCallDisplay[];
  /** 系统日志（log.info/warn/error 被接管后收在这里） */
  logs?: string[];
  tab?: PanelTab;
  /** 距底部的行偏移：0 = 贴底（最新），正数 = 向上翻 */
  scroll?: number;
  /** 覆盖终端行数（测试用：保证与 outputPanelMaxScroll 算 max 时同一口径） */
  termRows?: number;
}) {
  const { rows: measuredRows } = useTerminalSize();
  const termRows = termRowsOverride ?? measuredRows;
  const withOutput = tools.filter((t) => t.status === 'done');
  const allRows = tab === 'logs' ? flattenLogs(logs) : flatten(withOutput);
  /**
   * 面板自身可用行数 = 终端行数 − 面板外的固定 chrome（输入行 / 模式栏 / 边框 / 标题 / 位置提示）。
   * chrome 灯常驻约 6 行；再留 1 行余量给输入框换行，避免帧高顶到终端行数
   * 触发 ink 整屏清屏（ESC[3J 会连 scrollback 一起清，用户回看的历史全丢）。
   */
  const budget = Math.max(termRows - PANEL_CHROME_ROWS, 4);

  // 视窗：以"距底部 offset 个可见行"定位。offset 按**渲染高度**换算成下标，
  // 这样 ↑↓ 一行的效果始终是"画面上移一行"，不会因为长行占 3 行而跳 3 行。
  const maxOffset = maxScrollRows(allRows, budget);
  const offset = Math.min(Math.max(scroll ?? 0, 0), maxOffset);
  const end = endIndexForRows(allRows, offset);
  const start = windowStart(allRows, end, budget);
  const visible = allRows.slice(start, end);

  const above = start;
  const below = allRows.length - end;
  // 窗口底部所在行归属的工具：窗口常落在长输出中段，标题行不在窗口内。
  // 日志标签页没有"工具"概念，不展示归属（否则会显示无意义的 "当前：log"）。
  const currentTool = tab === 'tools' && end > 0 ? allRows[end - 1]?.tool : undefined;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Box>
        <Text bold color={tab === 'tools' ? 'magenta' : undefined} dimColor={tab !== 'tools'}>
          ⚙ 工具输出（{withOutput.length} 个）
        </Text>
        <Text dimColor> │ </Text>
        <Text bold color={tab === 'logs' ? 'magenta' : undefined} dimColor={tab !== 'logs'}>
          日志（{logs.length}）
        </Text>
        <Text dimColor> Tab 切换 · Ctrl+O/Esc 关闭 · ↑↓ 翻页</Text>
      </Box>
      {tab === 'logs' && logs.length === 0 ? (
        <Text dimColor>（暂无系统日志）</Text>
      ) : tab === 'tools' && withOutput.length === 0 ? (
        <Text dimColor>（暂无已完成的工具调用）</Text>
      ) : (
        visible.map((r, i) =>
          r.kind === 'header' ? (
            <Text key={`h${start + i}-${r.tool.id}`} bold color="green">
              {r.text}
            </Text>
          ) : (
            <Text
              key={`b${start + i}`}
              color={r.text.startsWith('- ') ? 'red' : r.text.startsWith('+ ') ? 'green' : undefined}
              dimColor={!r.text.startsWith('- ') && !r.text.startsWith('+ ')}
            >
              {r.text}
            </Text>
          ),
        )
      )}
      {/* 位置提示：总行数 + 当前窗口 + 归属工具。
          归属很关键——窗口常常落在某个长输出的**中段**，此时它的标题行在窗口外，
          光看内容不知道这堆日志是哪个工具产生的。 */}
      <Text dimColor>
        {above > 0 ? `↑ 上方还有 ${above} 行 · ` : ''}第 {start + 1}-{end} / {allRows.length} 行
        {below > 0 ? ` · ↓ 下方还有 ${below} 行` : ''}
        {currentTool ? ` · 当前：${currentTool.name}` : ''}
        {maxOffset > 0 ? ` · ↑↓ 翻页` : ''}
      </Text>
    </Box>
  );
}

/** 当前标签页对应的行序列（按键处理与渲染共用同一口径，避免上限不一致） */
function rowsFor(tab: PanelTab, tools: ToolCallDisplay[], logs: string[]): Row[] {
  return tab === 'logs' ? flattenLogs(logs) : flatten(tools.filter((t) => t.status === 'done'));
}

/** 面板是否需要拦截方向键（当前标签页内容超过一屏） */
export function outputPanelScrollable(
  tools: ToolCallDisplay[],
  tab: PanelTab = 'tools',
  logs: string[] = [],
  termRows = 40,
): boolean {
  return maxScrollRows(rowsFor(tab, tools, logs), Math.max(termRows - PANEL_CHROME_ROWS, 4)) > 0;
}

/** 面板可滚动的最大偏移量（供按键处理把 scroll 夹在合法区间） */
export function outputPanelMaxScroll(
  tools: ToolCallDisplay[],
  tab: PanelTab = 'tools',
  logs: string[] = [],
  termRows = 40,
): number {
  return maxScrollRows(rowsFor(tab, tools, logs), Math.max(termRows - PANEL_CHROME_ROWS, 4));
}
