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
 *
 * 版本升级提示：启动异步检查到远程 npm 有新版时，在权限模式文案后面
 * 追加一行提示，附带升级命令（用户可一键复制）。
 */
export function ModeBar({ mode, updateInfo }: { mode: Mode; updateInfo?: { current: string; latest: string } | null }) {
  const meta = MODE_META[mode] ?? MODE_META.default;
  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>当前权限审批模式（Shift+Tab 切换）：── </Text>
        <Text color={meta.color} bold>
          {meta.label}
        </Text>
        <Text dimColor> ── </Text>
      </Box>
      {updateInfo ? (
        <Box>
          <Text color="yellow">
            ⬆️ 发现新版本 v{updateInfo.current} → v{updateInfo.latest}，运行{' '}
            <Text bold color="cyan">
              npm install -g @bysking/b-code
            </Text>{' '}
            升级
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** 模式列表（循环顺序，与 controller 的 MODE_CYCLE 保持同步） */
export const MODE_CYCLE: Mode[] = ['default', 'plan', 'auto', 'bypass'];
