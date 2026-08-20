import React from 'react';
import { Box, Text } from 'ink';
import type { Mode } from '../permissions.js';

/** 模式展示名与配色 */
const MODE_META: Record<Mode, { label: string; color: string }> = {
  default: { label: 'default', color: 'cyan' },
  plan: { label: 'plan', color: 'yellow' },
  auto: { label: 'auto', color: 'green' },
  bypass: { label: 'bypass', color: 'red' },
};

/**
 * 底部模式状态栏：固定展示当前模式（plan / auto / bypass / default），
 * 提示 Shift+Tab 切换。
 */
export function ModeBar({ mode }: { mode: Mode }) {
  const meta = MODE_META[mode] ?? MODE_META.default;
  return (
    <Box>
      <Text dimColor>── </Text>
      <Text color={meta.color} bold>
        {meta.label}
      </Text>
      <Text dimColor> ── Shift+Tab 切换</Text>
    </Box>
  );
}

/** 模式列表（循环顺序，与 controller 的 MODE_CYCLE 保持同步） */
export const MODE_CYCLE: Mode[] = ['default', 'plan', 'auto', 'bypass'];
