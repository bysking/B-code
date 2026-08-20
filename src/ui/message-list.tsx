import React, { useEffect, useState } from 'react';
import { Box, Static, Text } from 'ink';
import type { ToolCallDisplay, Turn } from './controller.js';
import { TOOL_SYMBOL, TOOL_COLOR } from './controller.js';
import { Markdown } from './markdown-view.js';

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
  if (thinking) parts.push('thinking');
  return (
    <Text color="yellow" italic>
      ✽ {text} ({parts.join(' · ')})
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

/** assistant turn 标题（整 turn 与首个提交片段共用，保证只出现一次） */
function AssistantHeader() {
  return (
    <Text bold color="magenta">
      B Code
    </Text>
  );
}

/** 真实 token 用量行（模型调用完成回填；busy 行清空后仍可见） */
function UsageLine({ turn }: { turn: Turn }) {
  if (!turn.usage) return null;
  return (
    <Text dimColor>
      (⏱ {Math.round((turn.elapsedMs ?? 0) / 1000)}s · ↓ {formatTokens(turn.usage.input_tokens)} · ↑{' '}
      {formatTokens(turn.usage.output_tokens)} tokens)
    </Text>
  );
}

/** 单条消息（user / assistant），assistant 走 markdown 渲染 */
function TurnView({ turn }: { turn: Turn }) {
  if (turn.role === 'user') {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">
          User
        </Text>
        <Text>{turn.text}</Text>
      </Box>
    );
  }
  const hasContent = turn.text.trim().length > 0 || turn.tools.length > 0 || (turn.thinking ?? '').length > 0;
  if (!hasContent) return null;
  return (
    <Box flexDirection="column">
      <AssistantHeader />
      {turn.thinking ? (
        <Text color="gray" italic>
          {turn.thinking}
        </Text>
      ) : null}
      {turn.tools.map((t) => (
        <ToolView key={t.id} tool={t} />
      ))}
      {turn.text.trim() ? <Markdown text={turn.text} /> : null}
      <UsageLine turn={turn} />
    </Box>
  );
}

/**
 * 被分段提交过的 turn 的"余量"视图（无标题——标题已随首个片段进 <Static>）：
 * thinking 余量 + 工具块 + text 余量 + 用量。
 * 两种用法：流式中的 live 尾部；turn 落定后进 <Static> 的收尾条目（rest）。
 */
function TurnRemainder({ turn }: { turn: Turn }) {
  const hasContent =
    turn.text.trim().length > 0 ||
    turn.tools.length > 0 ||
    (turn.thinking ?? '').trim().length > 0 ||
    turn.usage !== undefined;
  if (!hasContent) return null;
  return (
    <Box flexDirection="column">
      {turn.thinking && turn.thinking.trim() ? (
        <Text color="gray" italic>
          {turn.thinking}
        </Text>
      ) : null}
      {turn.tools.map((t) => (
        <ToolView key={t.id} tool={t} />
      ))}
      {turn.text.trim() ? <Markdown text={turn.text} /> : null}
      <UsageLine turn={turn} />
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
  if (turn.role === 'user') return true;
  if (turn.streaming) return false;
  if (turn.tools.some((t) => t.status !== 'done')) return false;
  // 最后一条已完成的 assistant turn 在模型调用进行中仍可能回填 usage → 暂留 live
  if (isLast && turn.usage === undefined && busy !== null) return false;
  return true;
}

/** <Static> 条目：整 turn（未分段）| 流式期提交的片段 | 分段 turn 落定后的余量收尾 */
type StaticEntry =
  | { kind: 'turn'; key: string; turn: Turn }
  | { kind: 'chunk'; key: string; text: string; thinking: boolean; firstOfTurn: boolean }
  | { kind: 'rest'; key: string; turn: Turn };

function hasChunks(t: Turn): boolean {
  return t.chunks.length > 0 || t.thinkingChunks.length > 0;
}

/**
 * 消息流列表 + 底部状态行（耗时/token/相位实时跳动）。
 *
 * 滚动稳定性（两层防线，目标都是 live 帧高度恒小于终端行数——否则 Ink 触发整屏清屏
 * ESC[2J+3J+H，ESC[3J 连 scrollback 一起清，用户向上滚动的历史视图会被弹回顶部）：
 * 1. 已落定的历史 turn 走 <Static>（只打印一次、只追加新行），live 区不留历史；
 * 2. 正在流式的 turn 超预算时，controller 把前缀分段提交进 chunks（也走 <Static>），
 *    live 区只保留尾部——长回复/长工具日志也不会撑爆 live 帧（见 scroll-budget.ts）。
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
  // 组装 <Static> 条目：按 turns 顺序，已提交片段（chunks）总是先入 Static；
  // 落定 turn 追加整 turn / rest 收尾条目；未落定的留在 live 区。
  // 注意条目数组每次都是新建的：ctrl.turns 是原地 push 的可变数组，若引用不变，
  // Ink <Static> 的 useMemo(items.slice(index), [items, index]) 会命中缓存导致新条目不渲染。
  const entries: StaticEntry[] = [];
  const live: Turn[] = [];
  turns.forEach((t, i) => {
    let firstOfTurn = true;
    const pushChunk = (text: string, thinking: boolean, idx: number) => {
      entries.push({
        kind: 'chunk',
        key: `t${t.id}-${thinking ? 'h' : 'c'}${idx}`,
        text,
        thinking,
        firstOfTurn,
      });
      firstOfTurn = false;
    };
    t.thinkingChunks.forEach((c, ci) => pushChunk(c, true, ci));
    t.chunks.forEach((c, ci) => pushChunk(c, false, ci));
    if (isCommittable(t, i === turns.length - 1, busy)) {
      entries.push(
        firstOfTurn
          ? { kind: 'turn', key: `t${t.id}`, turn: t }
          : { kind: 'rest', key: `t${t.id}-r`, turn: t },
      );
    } else {
      live.push(t);
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Static items={entries}>
        {(e) => {
          switch (e.kind) {
            case 'turn':
              return <TurnView key={e.key} turn={e.turn} />;
            case 'rest':
              return <TurnRemainder key={e.key} turn={e.turn} />;
            case 'chunk':
              return (
                <Box key={e.key} flexDirection="column">
                  {e.firstOfTurn ? <AssistantHeader /> : null}
                  {e.thinking ? (
                    <Text color="gray" italic>
                      {e.text}
                    </Text>
                  ) : (
                    <Markdown text={e.text} />
                  )}
                </Box>
              );
          }
        }}
      </Static>
      <Box flexDirection="column">
        {live.map((t) =>
          hasChunks(t) ? <TurnRemainder key={t.id} turn={t} /> : <TurnView key={t.id} turn={t} />,
        )}
        {busy && busySince !== null ? (
          <Box marginTop={1}>
            <BusyLine text={busy} since={busySince} thinking={busyThinking} inputTokens={busyInputTokens} />
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
