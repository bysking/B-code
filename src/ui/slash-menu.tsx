import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SlashItem } from './controller.js';
import { clampIndex, filterSlash, slashWindow } from './slash.js';

/** 菜单最多展示的候选项数（超出滚动；撑超终端行数会触发 Ink 整屏清屏） */
const MAX_VISIBLE = 12;

/**
 * / 斜杠快捷键提示菜单：输入以 / 开头时弹出，↑↓ 选择，Enter 执行，
 * Tab 把当前选中补全进输入，Esc 关闭。
 */

export function SlashMenu({
  query,
  items,
  onPick,
  onComplete,
  onClose,
}: {
  query: string;
  items: SlashItem[];
  onPick: (item: SlashItem) => void;
  onComplete: (item: SlashItem) => void;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const filtered = filterSlash(query, items);

  useEffect(() => setIdx(0), [query]);

  useInput((_input, key) => {
    if (key.upArrow || _input === 'k') setIdx((i) => clampIndex(i - 1, filtered.length));
    else if (key.downArrow || _input === 'j') setIdx((i) => clampIndex(i + 1, filtered.length));
    else if (key.return) {
      const picked = filtered[clampIndex(idx, filtered.length)];
      if (picked) onPick(picked);
    } else if (key.tab) {
      const picked = filtered[clampIndex(idx, filtered.length)];
      if (picked) onComplete(picked);
    } else if (key.escape) onClose();
  });

  if (filtered.length === 0) {
    return (
      <Box marginBottom={1}>
        <Text dimColor>(no matching slash command)</Text>
      </Box>
    );
  }

  const activeIdx = clampIndex(idx, filtered.length);
  const [start, end] = slashWindow(activeIdx, filtered.length, MAX_VISIBLE);

  return (
    <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      {filtered.slice(start, end).map((item, i) => {
        const active = start + i === activeIdx;
        return (
          <Text key={item.name} color={active ? 'cyan' : undefined} bold={active}>
            {active ? '❯ ' : '  '}/{item.name}
            {item.description ? <Text dimColor> — {item.description}</Text> : null}
          </Text>
        );
      })}
      {end - start < filtered.length ? (
        <Text dimColor>
          … {activeIdx + 1}/{filtered.length}（↑↓ 滚动）
        </Text>
      ) : null}
    </Box>
  );
}
