import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AskState } from "./controller.js";

/** 选项下标移动（全向键共用：↑↓←→ 与 vim j/k/h/l 都走这里） */
export function moveIndex(idx: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (idx + delta + length) % length;
}

/**
 * 交互选择（权限确认 / Plan 审批 / 未来任意 options 场景）。
 * 方向键 ↑↓←→ 与 vim j/k/h/l 都能轮转选中；Enter 确认，Esc = 安全默认（第一项）。
 */
export function Select({
  ask,
  onResolve,
}: {
  ask: AskState;
  onResolve: (value: string) => void;
}) {
  const [idx, setIdx] = useState(0);

  // ask 切换时回到第一项
  useEffect(() => setIdx(0), [ask.question]);

  useInput((_input, key) => {
    const delta =
      key.upArrow || key.downArrow || _input === "j" || _input === "k" ||
      key.leftArrow || key.rightArrow || _input === "h" || _input === "l"
        ? (key.upArrow || key.leftArrow || _input === "k" || _input === "h" ? -1 : 1)
        : 0;
    if (delta !== 0) {
      setIdx((i) => moveIndex(i, delta, ask.options.length));
    } else if (key.return) {
      onResolve(ask.options[clamp(idx, ask.options.length)]?.value ?? "");
    } else if (key.escape) {
      onResolve(ask.options[0]?.value ?? "");
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="yellow">? {ask.question}</Text>
      {ask.options.map((opt, i) => (
        <Text key={opt.value} color={i === idx ? "cyan" : undefined} bold={i === idx}>
          {"  "}
          {i === idx ? "❯ " : "  "}
          {opt.label}
        </Text>
      ))}
    </Box>
  );
}

function clamp(i: number, len: number): number {
  return len <= 0 ? 0 : Math.min(Math.max(i, 0), len - 1);
}