import { useEffect, useState } from 'react';
import type { OutputLine, ToolCallDisplay, Turn } from '../controller.js';
import { COLORS, TOOL_SYMBOL, TOOL_TONE, attrs, tone } from '../primitives/theme.js';
import { MarkdownText } from './markdown.js';
import { Welcome } from './welcome.js';
import { localVersion } from '../../version-check.js';

/**
 * 会话流渲染（OpenTUI 原生）。
 *
 * ## 与 ink 版的关键差异
 *
 * - **无虚拟滚动逻辑**：外层 `<scrollbox viewportCulling>` 负责只渲染可见部分，
 *   这里直接全量 map 即可——OpenTUI 会跳过不可见的子树。
 * - **无嵌套 Text 转换**：OpenTUI 的 `<text>` 里放 `<span>` 是原生支持的，
 *   直接写就行。
 * - **无 Static 分区**：内容全在一个可滚动容器里，滚动位置由 scrollbox 管。
 */

/** token 数值格式化：<1k 原样；<10k 一位小数 k；更大整数 k */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) {
    const k = Math.round((n / 1000) * 10) / 10;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return `${Math.round(n / 1000)}k`;
}

/** 工具调用块：严格单行，超长截断（不换行，避免撑高行数） */
function ToolLine({ tool }: { tool: ToolCallDisplay }) {
  const color = tone(TOOL_TONE[tool.status]);
  return (
    <text fg={color} wrapMode="none" selectable>
      {TOOL_SYMBOL[tool.status]} {tool.name}
      {tool.input ? <span fg={COLORS.muted}> {tool.input}</span> : null}
    </text>
  );
}

function UsageLine({ turn }: { turn: Turn }) {
  if (!turn.usage) return null;
  // 用量元信息用 statusText（#8C8C8C）而非 muted（#858889）：
  // VS Code 的状态栏文字就是这个亮度，比行号稍亮一档——原来偏暗，几乎看不清。
  return (
    <text fg={COLORS.statusText} selectable>
      (⏱ {Math.round((turn.elapsedMs ?? 0) / 1000)}s · ↓ {formatTokens(turn.usage.input_tokens)} · ↑{' '}
      {formatTokens(turn.usage.output_tokens)} tokens)
    </text>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  if (turn.role === 'user') {
    return (
      <box flexDirection="column" marginBottom={1}>
        <text fg={COLORS.user} attributes={attrs('bold')}>
          User
        </text>
        <text fg={COLORS.text} selectable>
        {turn.text}
      </text>
      </box>
    );
  }

  const hasContent =
    turn.text.trim().length > 0 || turn.tools.length > 0 || (turn.thinking ?? '').trim().length > 0;
  if (!hasContent) return null;

  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={COLORS.accent} attributes={attrs('bold')}>
        B Code
      </text>
      {turn.thinking?.trim() ? (
        <text fg={COLORS.muted} attributes={attrs('italic')}>
          {turn.thinking}
        </text>
      ) : null}
      {turn.tools.map((t) => (
        <ToolLine key={t.id} tool={t} />
      ))}
      {turn.text.trim() ? <MarkdownText content={turn.text} selectable /> : null}
      <UsageLine turn={turn} />
    </box>
  );
}

/** 底部状态行：耗时 / token / thinking 相位（每秒自刷新） */
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
    <text fg={COLORS.warning} attributes={attrs('italic')}>
      ✽ {text} ({parts.join(' · ')})
    </text>
  );
}

/**
 * 完整会话记录：启动输出 + 输出行 + 全部 turn，按 id 时序交织。
 *
 * 输出行（`(mode → plan)` 之类）与 turn 共用同一个 id 序列，按 id 升序合并，
 * 保证输出行落在它真实发生的那一刻。
 */
export function Transcript({
  turns,
  output,
  initialOutput,
  cols,
  version,
}: {
  turns: Turn[];
  output: OutputLine[];
  initialOutput?: string[];
  /** 终端列宽（欢迎横幅按它自适应宽/窄形态） */
  cols?: number;
  /** 当前版本号（横幅展示用） */
  version?: string;
}) {
  type Item = { id: number; kind: 'output'; text: string } | { id: number; kind: 'turn'; turn: Turn };

  const items: Item[] = [
    ...output.map((o) => ({ id: o.id, kind: 'output' as const, text: o.text })),
    ...turns.map((t) => ({ id: t.id, kind: 'turn' as const, turn: t })),
  ].sort((a, b) => a.id - b.id);

  /** 无历史时展示欢迎横幅——空屏不该是"什么都没有" */
  const empty = turns.length === 0 && (initialOutput ?? []).length === 0;

  return (
    <box flexDirection="column">
      {empty ? <Welcome cols={cols ?? 80} version={version ?? localVersion()} /> : null}
      {(initialOutput ?? []).map((line, i) => (
        <text key={`init-${i}`} fg={COLORS.muted}>
          {line}
        </text>
      ))}
      {items.map((item) =>
        item.kind === 'output' ? (
          <text key={`out-${item.id}`} fg={COLORS.muted}>
            {item.text}
          </text>
        ) : (
          <TurnView key={`turn-${item.turn.id}`} turn={item.turn} />
        ),
      )}
    </box>
  );
}
