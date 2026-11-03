import React, { useEffect, useRef, useState } from 'react';
import { Box, Static, Text } from 'ink';
import type { OutputLine, ToolCallDisplay, Turn } from './controller.js';
import { TOOL_SYMBOL, TOOL_COLOR } from './controller.js';
import { Markdown } from './markdown-view.js';
import { LIVE_TOOL_ROWS_MAX } from './scroll-budget.js';

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
 *
 * frozen=true（用户滚离底部，画面冻结中）时停止自 tick：否则每秒一次重渲染会让
 * ink 写出新帧、把视口拽回底部，回看被打断。
 */
function BusyLine({
  text,
  since,
  thinking,
  inputTokens,
  frozen,
}: {
  text: string;
  since: number;
  thinking: boolean;
  inputTokens: number;
  frozen: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (frozen) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [frozen]);
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
 * 工具调用块：`⠒ name 参数摘要`，**严格单行**。
 *
 * 单行很关键：这条渲染在 live 区，折成两行就意味着高度翻倍。一批工具全在跑时
 * （都不 done → 整批留在 live），折行足以把帧撑过终端高度，触发 ink 整屏清屏。
 * 因此名与参数都用 wrap="truncate-end"，宁可截断也不换行。
 */
function ToolView({ tool }: { tool: ToolCallDisplay }) {
  // 单个 Text + truncate-end：相邻两个 Text 各自截断时无法共享剩余宽度，
  // 合起来仍可能溢出换行。合成一条文本才能可靠地"一行内截断"。
  return (
    <Text color={TOOL_COLOR[tool.status]} wrap="truncate-end">
      {TOOL_SYMBOL[tool.status]} {tool.name}
      {tool.input ? <Text dimColor> {tool.input}</Text> : null}
    </Text>
  );
}

/** 渲染一批工具，超过上限时折叠尾部为一行汇总 */
function ToolList({ tools }: { tools: ToolCallDisplay[] }) {
  const visible = tools.slice(0, LIVE_TOOL_ROWS_MAX);
  const hidden = tools.length - visible.length;
  return (
    <>
      {visible.map((t) => (
        <ToolView key={t.id} tool={t} />
      ))}
      {hidden > 0 ? <Text dimColor> … 另有 {hidden} 个工具（Ctrl+O 查看）</Text> : null}
    </>
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
      <ToolList tools={turn.tools} />
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
      <ToolList tools={turn.tools} />
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

/** <Static> 条目：整 turn（未分段）| 流式期提交的片段 | 分段 turn 落定后的余量收尾 | 已完成的工具块 | 固定输出行 */
type StaticEntry =
  | { kind: 'turn'; key: string; turn: Turn }
  | { kind: 'chunk'; key: string; text: string; thinking: boolean; firstOfTurn: boolean }
  | { kind: 'rest'; key: string; turn: Turn }
  /** turn 未落定、但其中某个工具已完成：工具块单独提前提交，避免堆积在 live 区 */
  | { kind: 'tool'; key: string; tool: ToolCallDisplay; firstOfTurn: boolean }
  | { kind: 'output'; key: string; text: string };

/** 一条输出行的渲染（dimColor 灰字，与消息流区分） */
function OutputView({ text }: { text: string }) {
  return <Text dimColor>{text}</Text>;
}

function hasChunks(t: Turn): boolean {
  return t.chunks.length > 0 || t.thinkingChunks.length > 0;
}

/**
 * 深拷贝消息流（冻结快照用）。只复制会被 controller 原地改动的字段：
 * tools 数组与每个工具对象、chunks/thinkingChunks 数组、usage 对象。
 * 渲染只读这些字段，浅拷贝其余原语即可。
 */
function cloneTurns(turns: Turn[]): Turn[] {
  return turns.map((t) => ({
    ...t,
    tools: t.tools.map((tool) => ({ ...tool })),
    chunks: [...t.chunks],
    thinkingChunks: [...t.thinkingChunks],
    usage: t.usage ? { ...t.usage } : undefined,
  }));
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
  turns: turnsProp,
  output: outputProp,
  initialOutput,
  busy: busyProp,
  busySince,
  busyThinking: busyThinkingProp,
  busyInputTokens: busyInputTokensProp,
  follow,
}: {
  turns: Turn[];
  output: OutputLine[];
  initialOutput?: string[];
  busy: string | null;
  busySince: number | null;
  busyThinking: boolean;
  busyInputTokens: number;
  /** 是否跟随到底部。false = 用户已滚离，画面冻结让用户回看（输出本身照常生成）。 */
  follow: boolean;
}) {
  // ── 冻结快照 ───────────────────────────────────────────────
  // controller 原地修改 turn/task 对象，只"不重渲染"挡不住内容变化：必须克隆出
  // 一份冻结时刻的快照，冻结期间始终渲染它。输出逐字节不变 → ink 判定无变化 →
  // 零写入 → 视口停在用户滚动的位置，不再被拽回底部。
  const renderedRef = useRef(false);
  const snapshotRef = useRef<{
    turns: Turn[];
    output: OutputLine[];
    busy: string | null;
    busySince: number | null;
    busyThinking: boolean;
    busyInputTokens: number;
  } | null>(null);

  if (follow) {
    // 强制重新渲染。见下方注释：ctrl.turns 是原地 push 的可变数组，引用不变会命中
    // ink <Static> 的 useMemo 缓存导致新条目不渲染；切回跟随必须换新引用。
    snapshotRef.current = null;
  } else if (!snapshotRef.current) {
    // 只在本组件已渲染过一次之后才建快照：首次挂载时若已处于冻结态（启动即滚离），
    // 用空状态建快照会把整屏冻成空白。这一次先渲染当前内容，下次渲染起才真正冻结。
    if (renderedRef.current) {
      snapshotRef.current = {
        turns: cloneTurns(turnsProp),
        output: [...outputProp],
        busy: busyProp,
        busySince,
        busyThinking: busyThinkingProp,
        busyInputTokens: busyInputTokensProp,
      };
    }
  }
  renderedRef.current = true;

  const snap = snapshotRef.current;
  const turns = snap ? snap.turns : turnsProp;
  const output = snap ? snap.output : outputProp;
  // busySince 冻结：快照时刻 = 冻结那一刻，耗时随之停住（BusyLine 也停止自 tick）。
  // 必须连同 since 一起冻结：只冻结文案不够——agent 每批工具都 spinner.stop()/start()，
  // busy 文案在 "thinking…"/"running X…" 之间来回切换，若 since 跟着实时更新，
  // 冻结的文案配实时起点，一重渲染就整屏重绘（视口被拽回底部）。
  const busy = snap ? snap.busy : busyProp;
  const since = snap ? snap.busySince : busySince;
  const busyThinking = snap ? snap.busyThinking : busyThinkingProp;
  const busyInputTokens = snap ? snap.busyInputTokens : busyInputTokensProp;

  // 组装 <Static> 条目：output 行与 turn 共用同一 id 序列 → 统一按 id 升序合并，
  // 输出行落在它发生的那一刻（例如 (mode → plan) 出现在切换前后的两条消息之间）。
  // （initialOutput 是启动期输出，无 id，恒排在最前。）
  //
  // 注意 entries 数组每次都是新建的：ctrl.turns 是原地 push 的可变数组，若引用不变，
  // Ink <Static> 的 useMemo(items.slice(index), [items, index]) 会命中缓存导致新条目不渲染。
  const entries: StaticEntry[] = [];
  const live: Turn[] = [];
  const liveOutput: OutputLine[] = [];

  // 输出行：能提交的进 entries（按 id 与 turn 交织），未落定的留在 live 区底部。
  // 这里的"落定"与 turn 判据无关——输出行一经 push 即定稿，唯一约束是保持时序：
  // 若某输出行 id 小于仍处 live 的 turn，则它也留在 live（否则会显示在历史之后）。
  const outputById = [...output].sort((a, b) => a.id - b.id);

  const isCommittableTurn = (t: Turn, i: number) => isCommittable(t, i === turns.length - 1, busy);

  // 标记每个 turn 是否可提交，并找出 live 区最小 id（输出行需 ≥ 它才能进 Static）
  const committable = turns.map((t, i) => isCommittableTurn(t, i));
  const firstLiveTurnId = turns.findIndex((_, i) => !committable[i]);
  const liveBoundary = firstLiveTurnId === -1 ? Infinity : turns[firstLiveTurnId]!.id;

  type SeqItem =
    { id: number; kind: 'output'; text: string } | { id: number; kind: 'turn'; turn: Turn; index: number };
  const seq: SeqItem[] = [];
  for (const o of outputById) seq.push({ id: o.id, kind: 'output', text: o.text });
  turns.forEach((t, i) => seq.push({ id: t.id, kind: 'turn', turn: t, index: i }));
  seq.sort((a, b) => a.id - b.id);

  for (const it of seq) {
    if (it.kind === 'output') {
      if (it.id < liveBoundary) entries.push({ kind: 'output', key: `o${it.id}`, text: it.text });
      else liveOutput.push({ id: it.id, text: it.text });
      continue;
    }
    const t = it.turn;
    // 已提交片段（chunks）无论 turn 是否落定都要进 Static（流式中已提交的前缀不再重渲染）
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

    if (!committable[it.index]) {
      // turn 还没落定，但其中已完成的工具块可以先行提交（toolsCommitted 是连续前缀计数）。
      // 这样 live 区只剩"尚未完成"的工具，一批 30 个工具也不会把帧撑爆。
      const committed = t.toolsCommitted ?? 0;
      for (let ti = 0; ti < committed; ti++) {
        entries.push({
          kind: 'tool',
          key: `t${t.id}-tl${ti}`,
          tool: t.tools[ti]!,
          firstOfTurn,
        });
        firstOfTurn = false;
      }
      live.push({ ...t, tools: t.tools.slice(committed) });
      continue;
    }
    // 落定：余量作 rest 收尾（chunks 已先入 Static）；未分段则整 turn 一条
    entries.push(
      firstOfTurn ? { kind: 'turn', key: `t${t.id}`, turn: t } : { kind: 'rest', key: `t${t.id}-r`, turn: t },
    );
  }

  // initialOutput（启动期输出）恒排在最前
  const leading: StaticEntry[] = (initialOutput ?? []).map((text, i) => ({
    kind: 'output',
    key: `i${i}`,
    text,
  }));
  const staticEntries = [...leading, ...entries];

  // live 区：仍在途的输出行与未落定的 turn 也须按 id 排序，保证底部时序正确
  type LiveItem = { id: number; kind: 'output'; text: string } | { id: number; kind: 'turn'; turn: Turn };
  const liveItems: LiveItem[] = [
    ...liveOutput.map((o) => ({ id: o.id, kind: 'output' as const, text: o.text })),
    ...live.map((t) => ({ id: t.id, kind: 'turn' as const, turn: t })),
  ].sort((a, b) => a.id - b.id);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Static items={staticEntries}>
        {(e) => {
          switch (e.kind) {
            case 'turn':
              return <TurnView key={e.key} turn={e.turn} />;
            case 'rest':
              return <TurnRemainder key={e.key} turn={e.turn} />;
            case 'output':
              return <OutputView key={e.key} text={e.text} />;
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
            case 'tool':
              return (
                <Box key={e.key} flexDirection="column">
                  {e.firstOfTurn ? <AssistantHeader /> : null}
                  <ToolView tool={e.tool} />
                </Box>
              );
          }
        }}
      </Static>
      <Box flexDirection="column">
        {liveItems.map((it) =>
          it.kind === 'output' ? (
            <OutputView key={`lo${it.id}`} text={it.text} />
          ) : hasChunks(it.turn) ? (
            <TurnRemainder key={it.turn.id} turn={it.turn} />
          ) : (
            <TurnView key={it.turn.id} turn={it.turn} />
          ),
        )}
        {busy && since !== null ? (
          <Box marginTop={1}>
            <BusyLine
              text={busy}
              since={since}
              thinking={busyThinking}
              inputTokens={busyInputTokens}
              frozen={!follow}
            />
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
