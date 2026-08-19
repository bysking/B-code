import React, { useEffect, useState } from "react";
import { Box, Static, Text } from "ink";
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

/**
 * 一个 turn 是否已"落定"（不会再变化），可安全提交进 <Static>：
 * - user turn 从 push 起就是定稿；
 * - assistant turn 需不再流式、工具全部完成；且若它仍是最后一条，还要等 busy 结束或
 *   usage 已回填——因为 usage 事件在 stream_end 之前到达，最后一条 turn 可能晚一步拿到用量。
 * 已提交的 turn 会被 Ink 永久打印、不再重渲染——提交条件保守，宁可晚提交。
 */
function isCommittable(turn: Turn, isLast: boolean, busy: string | null): boolean {
  if (turn.role === "user") return true;
  if (turn.streaming) return false;
  if (turn.tools.some((t) => t.status !== "done")) return false;
  // 最后一条已完成的 assistant turn 在模型调用进行中仍可能回填 usage → 暂留 live
  if (isLast && turn.usage === undefined && busy !== null) return false;
  return true;
}

/**
 * 消息流列表 + 底部状态行（耗时/token/相位实时跳动）。
 *
 * 滚动稳定性：已落定的历史 turn 走 <Static>（只打印一次、只追加新行），live 区只保留
 * 当前流式 turn + busy 行。这样 live 输出高度不会随会话增长超过终端行数，Ink 的
 * overflow 整屏清屏（ESC[3J 连 scrollback 一起清）不会触发——向上滚动不再被清空跳顶。
 */
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
  // 从第一个不可提交的 turn 处切开：之前全部进 Static（只追加），之后（流式/未完成）留在 live。
  // 用 findIndex 而非 filter，保证 committed/live 合起来仍严格保持 turns 的顺序。
  const splitAt = turns.findIndex((t, i) => !isCommittable(t, i === turns.length - 1, busy));
  const committed = splitAt === -1 ? turns : turns.slice(0, splitAt);
  const live = splitAt === -1 ? [] : turns.slice(splitAt);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Static items={committed}>
        {(turn) => <TurnView key={turn.id} turn={turn} />}
      </Static>
      <Box flexDirection="column">
        {live.map((t) => (
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
    </Box>
  );
}
