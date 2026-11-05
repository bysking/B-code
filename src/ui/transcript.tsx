import React from 'react';
import { Box, Text } from 'ink';
import type { OutputLine, ToolCallDisplay, Turn } from './controller.js';
import { TOOL_SYMBOL, TOOL_COLOR } from './controller.js';
import { Markdown } from './markdown-view.js';
import { estimateLines } from './scroll-budget.js';

/**
 * 历史消息流渲染（滚动视口内）。
 *
 * 渲染模型：**恒定内容进 `<Static>`（终端 scrollback），变化内容留 live 区**。
 *
 * 这样用户可以用终端原生的鼠标滚轮 / 滚动条 / Shift+PgUp 回看历史，退出后历史
 * 也留在终端里——符合 CLI 的既有习惯。
 *
 * 曾经担心 resize 时 ink 按旧布局行数擦除新布局内容导致历史花屏，为此改用过
 * "应用内滚动视口"。实测 ink 8 已修复该问题（窗口变化后会重放 static 输出），
 * 所以回到了 `<Static>`。代价换来的是终端原生滚动能力。
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
 * 一条会话记录条目：输出行或 turn。输出行（`(mode → plan)` 之类）与 turn 共用
 * 同一个 id 序列，按 id 升序合并，保证输出行落在它真实发生的那一刻。
 */
export type TranscriptItem =
  | { id: number; kind: 'output'; text: string }
  | { id: number; kind: 'turn'; turn: Turn };

/** 把输出行与 turn 按时序合并成一个列表 */
export function buildTranscriptItems(turns: Turn[], output: OutputLine[]): TranscriptItem[] {
  return [
    ...output.map((o) => ({ id: o.id, kind: 'output' as const, text: o.text })),
    ...turns.map((t) => ({ id: t.id, kind: 'turn' as const, turn: t })),
  ].sort((a, b) => a.id - b.id);
}

/** 单条记录的渲染（Static 条目与 live 条目共用，保证视觉一致） */
export function TranscriptItemView({ item }: { item: TranscriptItem }) {
  return item.kind === 'output' ? (
    <Text dimColor>{item.text}</Text>
  ) : (
    <TurnView turn={item.turn} />
  );
}

/**
 * 估算单条目的渲染行数。
 *
 * 只用于"该渲染哪一段"的粗定位——估偏了顶多多渲染/少渲染几行，
 * 不参与精确布局（真正的行数由 ink/Yoga 算）。所以这里宁可**估大**：
 * 估小了会把该显示的条目裁掉，估大了只是多渲染一点（还有 overscan 兜着）。
 */
export function estimateItemHeight(item: TranscriptItem, cols: number): number {
  if (item.kind === 'output') return estimateLines(item.text, cols);
  const t = item.turn;
  let rows = 1; // 标题行（User / B Code）
  rows += estimateLines(t.text || '', cols);
  if (t.thinking?.trim()) rows += estimateLines(t.thinking, cols);
  rows += t.tools.length; // 工具块严格单行
  if (t.usage) rows += 1;
  return Math.max(rows, 1);
}

/**
 * 完整会话记录（**虚拟滚动**版）。
 *
 * 为什么需要虚拟滚动：早期实现把全部历史都渲染进树里，每次都让 Yoga 重新布局
 * 整棵子树——实测 60 轮对话单次重渲染 47ms、120 轮 63ms。滚轮事件密集到达时
 * 这就表现为"滚一下卡一下"。
 *
 * 现在只渲染视口附近（可见区 + 上下 overscan）的条目：
 *   - 首尾各留 `overscan` 行缓冲，滚动时不会露白
 *   - 未渲染的部分用占位 Box 撑出高度，保证滚动条位置正确
 *
 * 代价：被折叠的条目高度是**估算**的，与实际渲染可能有几行偏差。
 * 用较大的 overscan（默认 40 行）吸收掉这个偏差，用户感知不到。
 */
export function Transcript({
  turns,
  output,
  initialOutput,
  scrollTop,
  viewportRows,
  cols,
}: {
  turns: Turn[];
  output: OutputLine[];
  initialOutput?: string[];
  /** 视口顶部相对内容顶部的偏移（行）。省略 = 不做虚拟化，整块渲染 */
  scrollTop?: number;
  /** 视口高度（行）。与 scrollTop 一起启用虚拟化 */
  viewportRows?: number;
  /** 终端列宽（估算折行用） */
  cols?: number;
}) {
  const items = buildTranscriptItems(turns, output);
  const width = cols ?? 80;

  // 未提供滚动信息时退化为整块渲染（测试/导出等场景）
  const virtual = scrollTop !== undefined && viewportRows !== undefined;
  let visible = items;
  let padTop = 0;
  let padBottom = 0;

  if (virtual) {
    const OVERSCAN = 12; // 上下各留缓冲，吸收估算误差
    const from = Math.max(scrollTop! - OVERSCAN, 0);
    const to = scrollTop! + viewportRows! + OVERSCAN;

    // **单次遍历**同时算出：可见区间、上方占位高度、下方占位高度。
    //
    // 早期实现用 `items.slice(endIdx).reduce(...)` 单独算 padBottom，那是 O(n)——
    // 每次滚动（scrollTop 变化）都要对剩余全部条目跑一遍 estimateItemHeight
    // （内部 wrap-ansi，不便宜）。120 轮历史时一次滚动要算上百次，直接表现为卡死感。
    //
    // 现在一遍扫完，复杂度不变但常数小得多；且高度结果可复用。
    let acc = 0;
    // 用 -1 做哨兵：0 是合法下标，不能用 0 表示"未设置"（否则第一条会被跳过）
    let startIdx = -1;
    let endIdx = items.length;
    let topRows = 0;
    let totalRows = 0;

    for (let i = 0; i < items.length; i++) {
      const h = estimateItemHeight(items[i]!, width);
      totalRows += h;
      if (startIdx === -1 && acc + h > from) {
        // 第一次越过 from：确定可见区间起点
        startIdx = i;
        topRows = acc;
      }
      if (startIdx !== -1 && acc >= to && endIdx === items.length) {
        endIdx = i;
      }
      acc += h;
    }
    // 循环结束仍为 -1 → from 超出内容总高，视为滚过了末端
    if (startIdx === -1) startIdx = items.length;

    visible = items.slice(startIdx, endIdx);
    padTop = topRows;
    // 下方占位 = 总高 − 上方占位 − 可见部分高度（同一次遍历已得 totalRows）
    padBottom = Math.max(totalRows - topRows - sumHeights(items, startIdx, endIdx, width), 0);
  }

  return (
    <Box flexDirection="column">
      {(initialOutput ?? []).map((text, i) => (
        <Text key={`i${i}`} dimColor>
          {text}
        </Text>
      ))}
      {padTop > 0 ? <Box height={padTop} flexShrink={0} /> : null}
      {visible.map((it) => (
        <TranscriptItemView key={`${it.kind}${it.id}`} item={it} />
      ))}
      {padBottom > 0 ? <Box height={padBottom} flexShrink={0} /> : null}
    </Box>
  );
}

/** 求区间 [start, end) 的高度和（padBottom 用；区间通常很短，成本可忽略） */
function sumHeights(items: TranscriptItem[], start: number, end: number, cols: number): number {
  let n = 0;
  for (let i = start; i < end; i++) n += estimateItemHeight(items[i]!, cols);
  return n;
}
