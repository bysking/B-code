import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from './ui/index.js';
import type { SlashItem } from './controller.js';
import { clampIndex, filterSlash, slashWindow } from './slash.js';

/**
 * 菜单最多展示的候选项数上限（超出滚动）。
 *
 * 这是**上界**而不是实际条数：实际展示数还要按终端高度收窄（见 visibleRows）。
 * 固定 12 条在 40 行终端里会撑爆底栏——Yoga 把菜单压小后，顶部几项被裁掉，
 * 于是出现"选中第 1 项却看到第 8 项"（用户以为第一项丢了）。
 */
const MAX_VISIBLE = 12;

/** 菜单自身除候选项外的固定占用：上下边框 2 + 滚动提示 1 + marginBottom 1 */
const MENU_CHROME_ROWS = 4;

/**
 * 菜单实际能展示几项。
 *
 * 给底栏其他部分留足空间（输入框 1 + 模式栏 1 + 余量 2），剩下的才归菜单。
 * 至少 3 项——再少就没有浏览意义了，此时宁可让视口让位。
 *
 * **刻意不用 `useBoxMetrics` 实测高度来自适应**：那会形成自指反馈环——
 * 测量值小 → 只渲染 1 行 → 测量值仍然小 → 永远 1 行（终端明明有 50 行也显示一行）。
 * 高度必须由"外部已知量"（终端行数）推出，不能由"自己渲染结果"反推。
 */
function visibleRows(termRows: number): number {
  const avail = termRows - MENU_CHROME_ROWS - 4;
  return Math.max(3, Math.min(avail, MAX_VISIBLE));
}

/**
 * / 斜杠快捷键提示菜单：输入以 / 开头时弹出，↑↓ 选择，Enter 执行，
 * Tab 把当前选中补全进输入，Esc 关闭。
 *
 * 两种展示模式：
 *   - **完整模式**（候选 ≤ 可用行数）：全部列出，无边框，不遮挡视线；
 *   - **滚动模式**：有边框（提示这是可滚列表并显示位置），只渲染窗口内的项，
 *     保证**选中项始终可见**——这是用户的直接诉求（第一项要能看到、要能选）。
 */
export function SlashMenu({
  query,
  items,
  onPick,
  onSubmitRaw,
  onComplete,
  onClose,
  termRows,
}: {
  query: string;
  items: SlashItem[];
  onPick: (item: SlashItem) => void;
  /** 无匹配候选时按 Enter：把输入原样提交（不吞键） */
  onSubmitRaw: () => void;
  onComplete: (item: SlashItem) => void;
  onClose: () => void;
  /**
   * 终端行数，**由 App 传入而不是自己调 useTerminalSize()**。
   *
   * 自己调 hook 会让组件订阅尺寸变化：菜单打开期间若有任何一次尺寸 state 抖动，
   * 组件重渲染、useInput 的 effect 重挂，飞行中的按键就丢了——表现是"↑ 按了没反应，
   * 菜单停在第一项"（实测复现）。
   *
   * 菜单不是尺寸的独立消费者，它只是被父层布局的一部分；把尺寸作为 prop 传下来，
   * 组件的订阅面最小，按键稳定性最好。
   */
  termRows: number;
}) {
  const [idx, setIdx] = useState(0);
  const filtered = filterSlash(query, items);
  const rows = visibleRows(termRows);

  useEffect(() => setIdx(0), [query]);

  useInput((_input, key) => {
    if (key.upArrow || _input === 'k') setIdx((i) => clampIndex(i - 1, filtered.length));
    else if (key.downArrow || _input === 'j') setIdx((i) => clampIndex(i + 1, filtered.length));
    else if (key.return) {
      const picked = filtered[clampIndex(idx, filtered.length)];
      // 无匹配：菜单无从选中，但用户的输入仍然有效（可能是没被索引到的命令，
      // 或想走普通对话）——必须放行，否则 Enter 被静默吞掉，界面毫无反应。
      if (picked) onPick(picked);
      else onSubmitRaw();
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
  // 候选装得下 → 全部展示（无边框，省两行且不遮挡）
  const fitsAll = filtered.length <= rows;
  const [start, end] = fitsAll
    ? [0, filtered.length]
    : slashWindow(activeIdx, filtered.length, rows);

  const body = (
    <>
      {filtered.slice(start, end).map((item, i) => {
        const active = start + i === activeIdx;
        return (
          <Text key={item.name} color={active ? 'cyan' : undefined} bold={active}>
            {active ? '❯ ' : '  '}/{item.name}
            {item.description ? <Text dimColor> — {item.description}</Text> : null}
          </Text>
        );
      })}
      {!fitsAll ? (
        <Text dimColor>
          … {activeIdx + 1}/{filtered.length}（↑↓ 滚动）
        </Text>
      ) : null}
    </>
  );

  // 完整模式：无边框（少占 2 行，且不像弹窗那样抢视线）
  if (fitsAll) {
    return (
      <Box flexDirection="column" marginBottom={1} flexShrink={0}>
        {body}
      </Box>
    );
  }
  // 滚动模式：有边框，明确提示"这是可滚列表"+ 位置指示
  return (
    <Box
      flexDirection="column"
      marginBottom={1}
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      flexShrink={0}
    >
      {body}
    </Box>
  );
}
