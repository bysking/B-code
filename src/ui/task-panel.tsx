import React from "react";
import { Box, Text } from "ink";
import type { TaskPanelState } from "./controller.js";
import { TOOL_SYMBOL, TOOL_COLOR } from "./controller.js";

/** 子项状态文案：由 verb 派生（待读取 / 读取中 / 读取完成 …） */
function statusText(verb: string, status: TaskPanelState["items"][number]["status"]): string {
  switch (status) {
    case "queued":
      return `待${verb}`;
    case "running":
      return `${verb}中`;
    case "done":
      return `${verb}完成`;
  }
}

/** 底部固定任务面板：正在执行的一批工具调用（task + 子项 + 三态 + loading）。
 * 面板只在任务进行中存在 —— 全部完成后 controller 直接移除，这里恒为进行中。
 * 子项展示数封顶：面板撑超终端行数会触发 Ink 整屏清屏（滚动位置被重置）。 */
const MAX_VISIBLE_ITEMS = 8;

export function TaskPanel({ task }: { task: TaskPanelState }) {
  const visible = task.items.slice(0, MAX_VISIBLE_ITEMS);
  const hidden = task.items.length - visible.length;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      marginTop={1}
    >
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
      {hidden > 0 ? <Text dimColor> … 另有 {hidden} 项</Text> : null}
    </Box>
  );
}
