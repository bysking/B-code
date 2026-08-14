import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AskGroupState } from "./controller.js";

/** tab 下标移动（水平循环） */
export function moveTab(idx: number, delta: number, len: number): number {
  if (len <= 0) return 0;
  return (idx + delta + len) % len;
}

/** tab 内选项下标移动（垂直循环） */
export function moveTabItem(idx: number, delta: number, len: number): number {
  if (len <= 0) return 0;
  return (idx + delta + len) % len;
}

/**
 * 两级选择（类似 tab + 列表）：
 *   ←/→ 或 h/l 切换 tab（顶部一行）；↑/↓ 或 j/k 在当前 tab 内移动；Enter 确认；Esc 默认第一项。
 * 确认值格式："{tab} / {label}"（与 ask 的 resolve 协议一致，回灌给模型）。
 */
export function TabsSelect({
  ask,
  onResolve,
}: {
  ask: AskGroupState;
  onResolve: (value: string) => void;
}) {
  const [tab, setTab] = useState(0);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    setTab(0);
    setIdx(0);
  }, [ask.question]);

  const currentGroup = ask.groups[tab];
  const itemLen = currentGroup?.options.length ?? 0;

  useInput((_input, key) => {
    if (key.leftArrow || key.rightArrow || _input === "h" || _input === "l") {
      const delta = key.leftArrow || _input === "h" ? -1 : 1;
      setTab((t) => {
        const nt = moveTab(t, delta, ask.groups.length);
        setIdx(0);
        return nt;
      });
    } else if (key.upArrow || key.downArrow || _input === "j" || _input === "k") {
      const delta = key.upArrow || _input === "k" ? -1 : 1;
      setIdx((i) => moveTabItem(i, delta, itemLen));
    } else if (key.return) {
      const item = currentGroup?.options[Math.min(idx, Math.max(itemLen - 1, 0))];
      if (item) onResolve(`${currentGroup?.title ?? ""} / ${item.label}`);
    } else if (key.escape) {
      const first = ask.groups[0]?.options[0];
      if (first) onResolve(`${ask.groups[0]?.title ?? ""} / ${first.label}`);
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="yellow">? {ask.question}</Text>
      {/* tab 行 */}
      <Box>
        {ask.groups.map((g, i) => {
          const active = i === tab;
          return (
            <Text key={g.title} color={active ? "cyan" : "gray"} bold={active} inverse={active}>
              {active ? " ⟪" : "  "}
              {g.title}
              {active ? "⟫ " : "  "}
            </Text>
          );
        })}
      </Box>
      {/* 当前 tab 的选项 */}
      <Box flexDirection="column">
        {(currentGroup?.options ?? []).map((opt, i) => (
          <Text key={opt.value} color={i === idx ? "cyan" : undefined} bold={i === idx}>
            {"  "}
            {i === idx ? "❯ " : "  "}
            {opt.label}
          </Text>
        ))}
      </Box>
    </Box>
  );
}