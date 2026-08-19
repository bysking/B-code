import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { ToolCallDisplay, Turn } from "./controller.js";
import { TOOL_SYMBOL, TOOL_COLOR } from "./controller.js";
import { Markdown } from "./markdown-view.js";

/** token 数值格式化：<1k 原样；<10k 一位小数 k（整千去 .0）；更大整数 k */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) {
    const k = Math.round((n / 1000) * 10) / 10;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return `${Math.round(n / 1000)}k`;
}

/**
 * 底部状态行（参考 Claude Code 的 ✽ Channelling… (34s · ↓ 1.2k tokens · thinking)）：
 * 本地 1s 自 tick 渲染实时耗时 + input token + thinking 相位标签。
 */
function BusyLine({
  text,
  since,
  thinking,
  inputTokens,
}: {
  text: string;
  since: number;
  thinking: boolean;
  inputTokens: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - since) / 1000));
  const parts = [`${elapsed}s`];
  if (inputTokens > 0) parts.push(`↓ ${formatTokens(inputTokens)} tokens`);
  if (thinking) parts.push("thinking");
  return (
    <Text color="yellow" italic>
      ✽ {text} ({parts.join(" · ")})
    </Text>
  );
}

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
      {/* 真实 token 用量（模型调用完成回填；busy 行清空后仍可见） */}
      {turn.usage ? (
        <Text dimColor>
          (⏱ {Math.round((turn.elapsedMs ?? 0) / 1000)}s · ↓ {formatTokens(turn.usage.input_tokens)} · ↑{" "}
          {formatTokens(turn.usage.output_tokens)} tokens)
        </Text>
      ) : null}
    </Box>
  );
}

/** 消息流列表 + 底部状态行（耗时/token/相位实时跳动） */
export function MessageList({
  turns,
  busy,
  busySince,
  busyThinking,
  busyInputTokens,
}: {
  turns: Turn[];
  busy: string | null;
  busySince: number | null;
  busyThinking: boolean;
  busyInputTokens: number;
}) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {turns.map((t) => (
        <TurnView key={t.id} turn={t} />
      ))}
      {busy && busySince !== null ? (
        <Box marginTop={1}>
          <BusyLine
            text={busy}
            since={busySince}
            thinking={busyThinking}
            inputTokens={busyInputTokens}
          />
        </Box>
      ) : null}
    </Box>
  );
}