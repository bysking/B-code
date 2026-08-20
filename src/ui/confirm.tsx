import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AskState } from './controller.js';

/** 选项下标移动（全向键共用：↑↓←→ 与 vim j/k/h/l 都走这里） */
export function moveIndex(idx: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (idx + delta + length) % length;
}

/**
 * 系统权限确认（No/Yes 等）专用交互。
 * 与模型驱动的选择组件（Wizard）分离：这里只渲染 Agent 权限确认链路
 * （ctrl.ask → confirm），交互保持最小——方向键轮转、Enter 确认、Esc = 安全默认（第一项）。
 */
export function Confirm({ ask, onResolve }: { ask: AskState; onResolve: (value: string) => void }) {
  const [idx, setIdx] = useState(0);

  // ask 切换时回到第一项
  useEffect(() => setIdx(0), [ask.question]);

  useInput((_input, key) => {
    const delta =
      key.upArrow ||
      key.downArrow ||
      _input === 'j' ||
      _input === 'k' ||
      key.leftArrow ||
      key.rightArrow ||
      _input === 'h' ||
      _input === 'l'
        ? key.upArrow || key.leftArrow || _input === 'k' || _input === 'h'
          ? -1
          : 1
        : 0;
    if (delta !== 0) {
      setIdx((i) => moveIndex(i, delta, ask.options.length));
    } else if (key.return) {
      onResolve(ask.options[clamp(idx, ask.options.length)]?.value ?? '');
    } else if (key.escape) {
      // Esc 恒为拒绝：优先"no"选项（Yes 已上移，不能再用第一个选项当安全默认）
      const deny = ask.options.find((o) => o.value === 'no');
      onResolve(deny?.value ?? ask.options[0]?.value ?? '');
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="yellow">? {ask.question}</Text>
      {ask.options.map((opt, i) => (
        <Text key={opt.value} color={i === idx ? 'cyan' : undefined} bold={i === idx}>
          {'  '}
          {i === idx ? '❯ ' : '  '}
          {opt.label}
        </Text>
      ))}
      <Text dimColor>↑↓ 选择 · Enter 确认 · Esc 拒绝</Text>
    </Box>
  );
}

function clamp(i: number, len: number): number {
  return len <= 0 ? 0 : Math.min(Math.max(i, 0), len - 1);
}
