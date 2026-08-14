import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AskState } from "./controller.js";

/**
 * 交互选择（权限确认 / 未来 Plan 审批）。
 * ↑↓ 或 j/k 移动，Enter 确认，Esc = 安全默认（第一个选项通常为"否/拒绝"）。
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
    const up = key.upArrow || _input === "k";
    const down = key.downArrow || _input === "j";
    if (up) setIdx((i) => (i + ask.options.length - 1) % ask.options.length);
    else if (down) setIdx((i) => (i + 1) % ask.options.length);
    else if (key.return) onResolve(ask.options[idx]?.value ?? "");
    else if (key.escape) onResolve(ask.options[0]?.value ?? "");
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