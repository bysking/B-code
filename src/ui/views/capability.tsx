import { useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { CapabilityItem, CapabilityKind } from '../controller.js';
import { COLORS, attrs } from '../primitives/theme.js';
import { scrollWindow } from '../scroll-budget.js';

/**
 * 能力面板（/skills、/mcp）：可交互的启停开关。
 *
 * 保持自有实现而非 `<select>`：
 *   - 每项要显示勾选框、名称、描述、行内提示（重连中/成功/失败）
 *   - 需要空格切换（`<select>` 的 Enter 是"选中并关闭"，语义不同）
 *   - 需要 R 重连这类额外按键
 */

const MAX_VISIBLE = 12;
/** 面板除条目外的固定占用：边框 2 + 标题 1 + 滚动提示 1 + 键位提示 1 + margin 1 */
const CHROME = 6;

function maxVisibleRows(termRows: number): number {
  return Math.max(1, Math.min(MAX_VISIBLE, termRows - CHROME - 3));
}

export function CapabilityPanel({
  kind,
  items,
  onToggle,
  onReconnect,
  onClose,
  onRefresh,
  termRows = 40,
}: {
  kind: CapabilityKind;
  items: CapabilityItem[];
  onToggle: (name: string) => void;
  onReconnect?: (name: string) => void;
  onClose: () => void;
  onRefresh?: () => void;
  termRows?: number;
}) {
  const [idx, setIdx] = useState(0);
  const rows = maxVisibleRows(termRows);

  const enabledCount = items.filter((i) => i.enabled).length;
  const title = kind === 'skill' ? '🔧 技能' : '🔌 MCP Server';

  const active = items.length === 0 ? 0 : Math.min(idx, items.length - 1);
  const [start, end] = scrollWindow(active, items.length, rows);
  const visible = items.slice(start, end);
  const move = (d: number) => {
    if (items.length === 0) return;
    setIdx((i) => {
      const cur = Math.min(i, items.length - 1);
      return (cur + d + items.length) % items.length;
    });
  };

  useKeyboard((e) => {
    if (e.name === 'escape') {
      onClose();
      return;
    }
    if (e.name === 'up' || e.name === 'k') {
      move(-1);
      return;
    }
    if (e.name === 'down' || e.name === 'j') {
      move(1);
      return;
    }
    if (e.name === 'space') {
      const cur = items[active];
      if (cur) {
        onToggle(cur.name);
        onRefresh?.();
      }
      return;
    }
    if ((e.name === 'r' || e.name === 'R') && kind === 'mcp') {
      const cur = items[active];
      if (cur) {
        onReconnect?.(cur.name);
        onRefresh?.();
      }
    }
  });

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={COLORS.accent}
      paddingX={1}
      marginTop={1}
      flexShrink={0}
    >
      <text fg={COLORS.accent} attributes={attrs('bold')}>
        {title} · {enabledCount} 启用 / {items.length}
      </text>

      {items.length === 0 ? (
        <text fg={COLORS.muted}>
          （{kind === 'skill' ? '没有可用技能' : '没有配置 MCP server'}）
        </text>
      ) : (
        visible.map((it, i) => {
          const isActive = start + i === active;
          return (
            <text key={it.name} fg={isActive ? COLORS.accent : undefined} wrapMode="none">
              {isActive ? '❯ ' : '  '}
              <span fg={it.enabled ? COLORS.success : COLORS.muted}>
                {it.enabled ? '☑' : '☐'}
              </span>{' '}
              <span attributes={it.enabled ? 0 : attrs('strikethrough')}>{it.name}</span>
              {it.detail ? <span fg={COLORS.muted}> {it.detail}</span> : null}
              {it.notice ? <span fg={COLORS.warning}> {it.notice}</span> : null}
            </text>
          );
        })
      )}

      {start > 0 || end < items.length ? (
        <text fg={COLORS.muted} attributes={attrs('dim')}>
          {start > 0 ? `↑ ${start} ` : ''}
          {active + 1}/{items.length}
          {end < items.length ? ` ↓ ${items.length - end}` : ''}
        </text>
      ) : null}

      <text fg={COLORS.muted} attributes={attrs('dim')}>
        {kind === 'mcp'
          ? '↑↓ 选择 · 空格 启停 · R 重连 · Esc 关闭'
          : '↑↓ 选择 · 空格 启停 · Esc 关闭'}
      </text>
    </box>
  );
}
