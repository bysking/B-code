import React from "react";
import { Box, Text } from "ink";
import type { ToolCallDisplay, Turn } from "./controller.js";
import { TOOL_SYMBOL, TOOL_COLOR } from "./controller.js";
import { Markdown } from "./markdown-view.js";

/** 工具调用块：┌ ○/⠒/✓ name(args) ┐ 带上做/完成状态 */
function ToolView({ tool }: { tool: ToolCallDisplay }) {
  return (
    <Box>
      <Text color={TOOL_COLOR[tool.status]}>
        {TOOL_SYMBOL[tool.status]} {tool.name}
      </Text>
      {tool.input ? <Text dimColor> {tool.input}</Text> : null}
    </Box>
  );
}

/** 单条消息（user / assistant），assistant 走 markdown 渲染 */
function TurnView({ turn }: { turn: Turn }) {
  if (turn.role === "user") {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">
          User
        </Text>
        <Text>{turn.text}</Text>
      </Box>
    );
  }
  const hasContent =
    turn.text.trim().length > 0 || turn.tools.length > 0 || (turn.thinking ?? "").length > 0;
  if (!hasContent) return null;
  return (
    <Box flexDirection="column">
      <Text bold color="magenta">
        B Code
      </Text>
      {turn.thinking ? (
        <Text color="gray" italic>
          {turn.thinking}
        </Text>
      ) : null}
      {turn.tools.map((t) => (
        <ToolView key={t.id} tool={t} />
      ))}
      {turn.text.trim() ? <Markdown text={turn.text} /> : null}
    </Box>
  );
}

/** 消息流列表 + 底部 busy/thinking 行 */
export function MessageList({
  turns,
  busy,
}: {
  turns: Turn[];
  busy: string | null;
}) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {turns.map((t) => (
        <TurnView key={t.id} turn={t} />
      ))}
      {busy ? (
        <Box marginTop={1}>
          <Text color="yellow" italic>
            {busy}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}