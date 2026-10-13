import React from 'react';
import { Box, Text } from 'ink';

/** 待办状态符号与配色 */
const TODO_SYMBOL: Record<string, string> = { pending: '☐', in_progress: '◐', completed: '☑' };
const TODO_COLOR: Record<string, string | undefined> = {
  pending: undefined,
  in_progress: 'yellow',
  completed: 'green',
};

/** 展示数封顶：面板撑超终端行数会触发 Ink 整屏清屏（滚动位置被重置） */
const MAX_VISIBLE = 10;

/**
 * 模型自管待办清单（todo_write 维护）。与 TaskPanel（从工具调用反推的"正在跑什么"）
 * 不同：这里展示"要做什么、做到哪了"，跨轮次存续。全部完成时仍展示（给人收尾视图），
 * 由 /clear 或新一轮 todo_write 更新。
 */
export function TodoPanel({ todos }: { todos: { content: string; status: string }[] }) {
  if (todos.length === 0) return null;
  const visible = todos.slice(0, MAX_VISIBLE);
  const hidden = todos.length - visible.length;
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
      {hidden > 0 ? <Text dimColor> … 另有 {hidden} 项</Text> : null}
    </Box>
  );
}
