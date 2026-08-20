import React from "react";
import { Box, Text } from "ink";
import type { ToolCallDisplay } from "./controller.js";
import { estimateLines, terminalRows } from "./scroll-budget.js";

/** 面板中单条输出展示上限（避免长输出撑爆屏幕） */
const MAX_OUTPUT = 2000;

/**
 * Ctrl+O 工具输出面板：展示本轮会话全部工具/子 agent 的真实输出。
 *
 * 面板总高度受终端行数约束：撑超终端行数会触发 Ink 整屏清屏（ESC[3J 连 scrollback
 * 一起清），用户向上滚动的视图会被弹回顶部——超出预算的较早输出直接省略并提示。
 */
export function OutputPanel({ tools }: { tools: ToolCallDisplay[] }) {
  const withOutput = tools.filter((t) => t.status === "done");
  const budget = Math.max(terminalRows() - 12, 8);
  const shown: typeof withOutput = [];
  let used = 3; // 边框 + 标题行
  for (const t of withOutput) {
    const out = t.output ? t.output.slice(0, MAX_OUTPUT) : "";
    const lines = 1 + estimateLines(out || "(no captured output)");
    if (used + lines > budget && shown.length > 0) break;
    shown.push(t);
    used += lines;
  }
  const omitted = withOutput.length - shown.length;
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
      {shown.length === 0 ? (
        <Text dimColor>（暂无已完成的工具调用）</Text>
      ) : (
        shown.map((t) => (
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
      {omitted > 0 ? <Text dimColor>…（另有 {omitted} 个工具输出因屏幕高度限制未展示）</Text> : null}
    </Box>
  );
}
