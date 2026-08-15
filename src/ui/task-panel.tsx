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
 * 面板只在任务进行中存在 —— 全部完成后 controller 直接移除，这里恒为进行中。 */
export function TaskPanel({ task }: { task: TaskPanelState }) {
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
      {task.items.map((it) => (
        <Box key={it.id}>
          <Text color={TOOL_COLOR[it.status]}>
            {TOOL_SYMBOL[it.status]} {statusText(task.verb, it.status)}
          </Text>
          <Text dimColor> {it.label}</Text>
        </Box>
      ))}
    </Box>
  );
}
