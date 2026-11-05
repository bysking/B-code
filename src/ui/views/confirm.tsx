import { useEffect, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { AskState } from '../controller.js';
import { COLORS, attrs } from '../primitives/theme.js';

/** 选项下标移动（环绕） */
export function moveIndex(idx: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (idx + delta + length) % length;
}

const MAX_VISIBLE = 8;

/**
 * 系统权限确认（No/Yes 等）。
 *
 * 与模型驱动的选择（Wizard）刻意分离：这里只服务 Agent 权限链路
 * （ctrl.ask → confirm），交互保持最小——↑↓ 轮转、Enter 确认、Esc = 安全默认。
 *
 * 直接用 `useKeyboard`（OpenTUI 原生），不再经过适配层的 KeyLike 归一化。
 */
export function Confirm({ ask, onResolve }: { ask: AskState; onResolve: (value: string) => void }) {
  const [idx, setIdx] = useState(0);

  // ask 切换时回到第一项
  useEffect(() => setIdx(0), [ask.question]);

  useKeyboard((e) => {
    const down = e.name === 'down' || e.name === 'j' || e.name === 'right' || e.name === 'l';
    const up = e.name === 'up' || e.name === 'k' || e.name === 'left' || e.name === 'h';
    if (down) {
      setIdx((i) => moveIndex(i, 1, ask.options.length));
      return;
    }
    if (up) {
      setIdx((i) => moveIndex(i, -1, ask.options.length));
      return;
    }
    if (e.name === 'return') {
      const picked = ask.options[idx] ?? ask.options[0];
      onResolve(picked?.value ?? 'no');
      return;
    }
    if (e.name === 'escape') {
      // Esc = 安全默认（拒绝）
      const deny = ask.options.find((o) => o.value === 'no');
      onResolve(deny?.value ?? 'no');
    }
  });

  const start = Math.max(0, Math.min(idx - Math.floor(MAX_VISIBLE / 2), ask.options.length - MAX_VISIBLE));
  const visible = ask.options.slice(start, start + MAX_VISIBLE);

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={COLORS.warning}
      paddingX={1}
      flexShrink={0}
    >
      <text fg={COLORS.warning} attributes={attrs('bold')}>
        ? {ask.question}
      </text>
      {visible.map((opt, i) => {
        const active = start + i === idx;
        return (
          <text key={opt.value} fg={active ? COLORS.accent : COLORS.text}>
            {active ? '❯ ' : '  '}
            {start + i + 1}. {opt.label}
          </text>
        );
      })}
      <text fg={COLORS.muted}>↑↓ 选择 · Enter 确认 · Esc 取消</text>
    </box>
  );
}
