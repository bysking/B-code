import React from "react";
import { Box, Text } from "ink";
import type { ToolCallDisplay } from "./controller.js";

/** 面板中单条输出展示上限（避免长输出撑爆屏幕） */
const MAX_OUTPUT = 2000;

/** Ctrl+O 工具输出面板：展示本轮会话全部工具/子 agent 的真实输出 */
export function OutputPanel({ tools }: { tools: ToolCallDisplay[] }) {
  const withOutput = tools.filter((t) => t.status === "done");
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      flexGrow={1}
    >
      <Text bold color="magenta">
        ⚙ 工具输出（Ctrl+O / Esc 关闭）
      </Text>
      {withOutput.length === 0 ? (
        <Text dimColor>（暂无已完成的工具调用）</Text>
      ) : (
        withOutput.map((t) => (
          <Box key={t.id} flexDirection="column">
            <Text bold color="green">
              ✓ {t.name}
              {t.input ? <Text dimColor> {t.input}</Text> : null}
            </Text>
            <Text dimColor>
              {t.output
                ? t.output.length > MAX_OUTPUT
                  ? `${t.output.slice(0, MAX_OUTPUT)}\n… (truncated)`
                  : t.output
                : "(no captured output)"}
            </Text>
          </Box>
        ))
      )}
    </Box>
  );
}