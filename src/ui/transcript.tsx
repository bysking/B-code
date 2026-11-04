import React from 'react';
import { Box, Text } from 'ink';
import type { OutputLine, ToolCallDisplay, Turn } from './controller.js';
import { TOOL_SYMBOL, TOOL_COLOR } from './controller.js';
import { Markdown } from './markdown-view.js';

/**
 * 历史消息流渲染（滚动视口内）。
 *
 * 与旧 `message-list.tsx` 的根本区别：**不再用 `<Static>`**。
 *
 * 旧实现把落定内容交给 `<Static>` 永久打印进终端 scrollback，live 区只留尾部，
 * 换来一整套"live 帧必须矮于终端"的约束与补偿（CPR 探测、估算切片、分段提交、
 * 帧高回灌）。代价是窗口 resize 时 ink 按旧布局行数擦除新布局内容，历史必然花掉。
 *
 * 现在全部内容都画在 `<ScrollView>` 里：视口固定高度，超出部分裁剪后靠 offset 平移。
 * 没有"落定/未落定"之分，没有分段 chunks，渲染 = 按顺序列出全部 turn。
 */

/** token 数值格式化：<1k 原样；<10k 一位小数 k（整千去 .0）；更大整数 k */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) {
    const k = Math.round((n / 1000) * 10) / 10;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return `${Math.round(n / 1000)}k`;
}

/** 工具调用块：严格单行（折行会破坏滚动视口内的行数一致性） */
function ToolView({ tool }: { tool: ToolCallDisplay }) {
  return (
    <Text color={TOOL_COLOR[tool.status]} wrap="truncate-end">
      {TOOL_SYMBOL[tool.status]} {tool.name}
      {tool.input ? <Text dimColor> {tool.input}</Text> : null}
    </Text>
  );
}

/** 真实 token 用量行（模型调用完成回填） */
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
  const hasContent =
    turn.text.trim().length > 0 || turn.tools.length > 0 || (turn.thinking ?? '').trim().length > 0;
  if (!hasContent) return null;
  return (
    <Box flexDirection="column">
      <Text bold color="magenta">
        B Code
      </Text>
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

/** 底部状态行（耗时 / input token / thinking 相位） */
export function BusyLine({
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
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
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

/**
 * 完整的会话记录：启动输出 + 输出行 + 全部 turn，按 id 时序交织。
 *
 * 输出行（`(mode → plan)` 之类）与 turn 共用同一个 id 序列，按 id 升序合并，
 * 保证输出行落在它真实发生的那一刻（而不是永远堆在最前或最后）。
 */
export function Transcript({
  turns,
  output,
  initialOutput,
}: {
  turns: Turn[];
  output: OutputLine[];
  initialOutput?: string[];
}) {
  type Item =
    | { id: number; kind: 'output'; text: string }
    | { id: number; kind: 'turn'; turn: Turn };

  const items: Item[] = [
    ...output.map((o) => ({ id: o.id, kind: 'output' as const, text: o.text })),
    ...turns.map((t) => ({ id: t.id, kind: 'turn' as const, turn: t })),
  ].sort((a, b) => a.id - b.id);

  return (
    <Box flexDirection="column">
      {(initialOutput ?? []).map((text, i) => (
        <Text key={`i${i}`} dimColor>
          {text}
        </Text>
      ))}
      {items.map((it) =>
        it.kind === 'output' ? (
          <Text key={`o${it.id}`} dimColor>
            {it.text}
          </Text>
        ) : (
          <TurnView key={it.turn.id} turn={it.turn} />
        ),
      )}
    </Box>
  );
}
