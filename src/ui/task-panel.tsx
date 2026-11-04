import React from 'react';
import { Box, Text } from 'ink';
import type { TaskPanelState } from './controller.js';
import { TOOL_SYMBOL, TOOL_COLOR } from './controller.js';
import { clampByLines, isCompactTerminal } from './scroll-budget.js';

/** 子项状态文案：由 verb 派生（待读取 / 读取中 / 读取完成 …） */
function statusText(verb: string, status: TaskPanelState['items'][number]['status']): string {
  switch (status) {
    case 'queued':
      return `待${verb}`;
    case 'running':
      return `${verb}中`;
    case 'done':
      return `${verb}完成`;
  }
}

/** 条数硬上限（兜底） */
const MAX_VISIBLE_ITEMS = 8;
/**
 * 行数上限：面板撑超终端行数会触发 Ink 整屏清屏（ESC[3J 连 scrollback 一起清）。
 *
 * 限条数不够——展示名常是完整文件路径/命令行，窄终端一条就折成 2~3 行。
 * 按渲染行数裁切才能给出确定高度。取 8：任务面板是"正在跑什么"的即时视图，
 * 不需要全量；完整输出走 Ctrl+O。
 */
export const TASK_MAX_LINES = 8;
/** 矮终端下的行数上限：给正文让位（任务面板是即时视图，细节走 Ctrl+O） */
export const TASK_MAX_LINES_COMPACT = 2;

/** 当前终端下该用的行数上限 */
function maxLines(): number {
  return isCompactTerminal() ? TASK_MAX_LINES_COMPACT : TASK_MAX_LINES;
}

/** 面板固定占用（边框上下 + 标题行 + 省略提示行） */
const PANEL_CHROME_LINES = 4;

/** 子项单行文案（状态 + 展示名），高度估算与渲染共用 */
function itemLine(verb: string, it: TaskPanelState['items'][number]): string {
  return `${TOOL_SYMBOL[it.status]} ${statusText(verb, it.status)} ${it.label}`;
}

function candidates(task: TaskPanelState): TaskPanelState['items'] {
  return task.items.slice(0, MAX_VISIBLE_ITEMS);
}

/** 面板实际渲染高度（行）：供上层从 live 预算里扣掉真实占用 */
export function taskPanelHeight(task: TaskPanelState | null): number {
  if (!task) return 0;
  const { visible, lines } = clampByLines(candidates(task), (it) => itemLine(task.verb, it), maxLines(), {
    reservedLines: PANEL_CHROME_LINES,
  });
  const omitted = task.items.length - visible.length;
  // marginTop={1} 也占一行
  return 1 + PANEL_CHROME_LINES + lines + (omitted > 0 ? 1 : 0);
}

/**
 * 底部固定任务面板：正在执行的一批工具调用（task + 子项 + 三态 + loading）。
 * 面板只在任务进行中存在 —— 全部完成后 controller 直接移除，这里恒为进行中。
 */
export function TaskPanel({ task }: { task: TaskPanelState }) {
  const { visible } = clampByLines(candidates(task), (it) => itemLine(task.verb, it), maxLines(), {
    reservedLines: PANEL_CHROME_LINES,
  });
  const omitted = task.items.length - visible.length;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1}>
      <Text bold color="yellow">
        ⠒ 正在{task.title}
      </Text>
      {visible.map((it) => (
        <Box key={it.id}>
          <Text color={TOOL_COLOR[it.status]}>
            {TOOL_SYMBOL[it.status]} {statusText(task.verb, it.status)}
          </Text>
          <Text dimColor> {it.label}</Text>
        </Box>
      ))}
      {omitted > 0 ? <Text dimColor> … 另有 {omitted} 项</Text> : null}
    </Box>
  );
}
