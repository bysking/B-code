import React from 'react';
import { Box, Text, type Color } from './ui/index.js';
import { clampByLines, isCompactTerminal } from './scroll-budget.js';

/** 待办状态符号与配色 */
const TODO_SYMBOL: Record<string, string> = { pending: '☐', in_progress: '◐', completed: '☑' };
const TODO_COLOR: Record<string, Color | undefined> = {
  pending: undefined,
  in_progress: 'yellow',
  completed: 'green',
};

/** 条数硬上限（兜底，防止极短文本时列太多） */
const MAX_VISIBLE = 10;
/**
 * 行数上限：面板撑超终端行数会触发 Ink 整屏清屏（ESC[3J 连 scrollback 一起清），
 * 用户向上回看的位置被重置。
 *
 * 只限条数是不够的——每项是自然语言描述，窄终端会折成 2~3 行，10 条能占 30 行。
 * 因此按**渲染行数**裁切。取 10：再大就挤占正文区，再小则一屏看不到几条上下文。
 */
export const TODO_MAX_LINES = 10;

/**
 * 矮终端下的行数上限：终端一屏本来就小，面板再占十几行，正文就没地方了。
 * 此时只保留 3 行待办——足够看出"在做什么"，细节可滚上去看。
 */
export const TODO_MAX_LINES_COMPACT = 3;

/** 面板固定占用（边框上下 + 标题行 + 省略提示行） */
const PANEL_CHROME_LINES = 4;

/** 当前终端下该用的行数上限 */
function maxLines(): number {
  return isCompactTerminal() ? TODO_MAX_LINES_COMPACT : TODO_MAX_LINES;
}

export interface TodoItem {
  content: string;
  status: string;
}

/** 一行待办的渲染文案（符号 + 内容），高度估算与渲染共用同一口径 */
function todoLine(t: TodoItem): string {
  return `${TODO_SYMBOL[t.status] ?? '☐'} ${t.content}`;
}

/**
 * 面板实际渲染高度（行）。供上层把底部面板占用从 live 预算里扣掉——
 * 否则正文按"chrome 只有固定 16 行"来分配，面板一变高整帧就溢出。
 */
export function todoPanelHeight(todos: TodoItem[]): number {
  if (todos.length === 0) return 0;
  const { visible, lines } = clampByLines(sliceCandidates(todos), todoLine, maxLines(), {
    reservedLines: PANEL_CHROME_LINES,
  });
  // lines 是已计入软换行的渲染行数（clampByLines 内部用 estimateLines）
  const omitted = todos.length - visible.length;
  return PANEL_CHROME_LINES + lines + (omitted > 0 ? 1 : 0);
}

/** 条数层面的候选集（行数层面再由 clampByLines 裁） */
function sliceCandidates(todos: TodoItem[]): TodoItem[] {
  return todos.slice(0, MAX_VISIBLE);
}

/**
 * 模型自管待办清单（todo_write 维护）。与 TaskPanel（从工具调用反推的"正在跑什么"）
 * 不同：这里展示"要做什么、做到哪了"，跨轮次存续。全部完成时仍展示（给人收尾视图），
 * 由 /clear 或新一轮 todo_write 更新。
 */
export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  if (todos.length === 0) return null;
  const { visible, hidden } = clampByLines(sliceCandidates(todos), todoLine, maxLines(), {
    reservedLines: PANEL_CHROME_LINES,
  });
  const omitted = todos.length - visible.length;
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} marginTop={1}>
      <Text bold color="blue">
        任务清单 {done}/{todos.length}
      </Text>
      {visible.map((t, i) => (
        <Box key={i}>
          <Text color={TODO_COLOR[t.status]}>{TODO_SYMBOL[t.status] ?? '☐'} </Text>
          <Text
            color={TODO_COLOR[t.status]}
            dimColor={t.status === 'completed'}
            strikethrough={t.status === 'completed'}
          >
            {t.content}
          </Text>
        </Box>
      ))}
      {omitted > 0 ? <Text dimColor> … 另有 {omitted} 项</Text> : null}
    </Box>
  );
}
