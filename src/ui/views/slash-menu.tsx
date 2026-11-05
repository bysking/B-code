import { useEffect, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { SlashItem } from '../controller.js';
import { COLORS, attrs } from '../primitives/theme.js';
import { clampIndex, filterSlash, slashWindow } from '../slash.js';

/**
 * 斜杠命令菜单。
 *
 * 保留自有实现而非用 `<select>`：`<select>` 的选项只支持纯文本，
 * 而我们要显示"命令 + 描述"、还要处理"无匹配时 Enter 提交原始输入"这些
 * 业务语义。用 `useKeyboard` + 原生 `<box>/<text>` 更直接。
 */

/** 菜单最多展示的候选项数上限（实际条数还要按终端高度收窄） */
const MAX_VISIBLE = 12;
/** 菜单自身除候选项外的固定占用：边框 2 + 滚动提示 1 + margin 1 */
const MENU_CHROME_ROWS = 4;

function visibleRows(termRows: number): number {
  return Math.max(3, Math.min(termRows - MENU_CHROME_ROWS - 4, MAX_VISIBLE));
}

export function SlashMenu({
  query,
  items,
  onPick,
  onComplete,
  onClose,
  termRows,
}: {
  query: string;
  items: SlashItem[];
  onPick: (item: SlashItem) => void;
  onSubmitRaw?: () => void;
  onComplete: (item: SlashItem) => void;
  onClose: () => void;
  termRows: number;
}) {
  const [idx, setIdx] = useState(0);
  const filtered = filterSlash(query, items);
  const rows = visibleRows(termRows);

  useEffect(() => setIdx(0), [query]);

  useKeyboard((e) => {
    if (e.name === 'up' || e.name === 'k') {
      setIdx((i) => clampIndex(i - 1, filtered.length));
      return;
    }
    if (e.name === 'down' || e.name === 'j') {
      setIdx((i) => clampIndex(i + 1, filtered.length));
      return;
    }
    if (e.name === 'return') {
      const picked = filtered[clampIndex(idx, filtered.length)];
      // 有候选 → 菜单消费（选中并提交该命令）
      if (picked) onPick(picked);
      // 无候选 → 不消费，交给输入框按普通输入提交
      return;
    }
    if (e.name === 'tab') {
      const picked = filtered[clampIndex(idx, filtered.length)];
      if (picked) onComplete(picked);
      return;
    }
    if (e.name === 'escape') onClose();
  });

  if (filtered.length === 0) {
    return (
      <box marginBottom={1} flexShrink={0}>
        <text fg={COLORS.muted}>(没有匹配的命令)</text>
      </box>
    );
  }

  const activeIdx = clampIndex(idx, filtered.length);
  const fitsAll = filtered.length <= rows;
  const [start, end] = fitsAll ? [0, filtered.length] : slashWindow(activeIdx, filtered.length, rows);
  const visible = filtered.slice(start, end);

  return (
    <box
      flexDirection="column"
      marginBottom={1}
      borderStyle={fitsAll ? undefined : 'rounded'}
      borderColor={COLORS.border}
      paddingX={1}
      flexShrink={0}
    >
      {visible.map((item, i) => {
        const active = start + i === activeIdx;
        return (
          <text key={item.name} fg={active ? COLORS.accent : COLORS.text} wrapMode="none">
            {active ? '❯ ' : '  '}/{item.name}
            {item.description ? <span fg={COLORS.muted}> — {item.description}</span> : null}
          </text>
        );
      })}
      {!fitsAll ? (
        <text fg={COLORS.muted} attributes={attrs('dim')}>
          … {activeIdx + 1}/{filtered.length}（↑↓ 滚动）
        </text>
      ) : null}
    </box>
  );
}
