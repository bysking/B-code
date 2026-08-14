import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AppController, SlashItem } from "./controller.js";
import { MessageList } from "./message-list.js";
import { Select } from "./select.js";
import { SlashMenu } from "./slash-menu.js";
import { InputBox } from "./input-box.js";
import { buildSlash } from "./slash.js";

/**
 * ink 根组件：控制器状态 → 渲染树。
 * 输入文本（受控）在 App：/ 触发菜单、Tab 补全写回输入框、Enter 提交分发。
 * Ctrl-C：有等待的选择先 Esc，否则退出进程。
 */

export function App({
  ctrl,
  onSubmit,
  onExit,
  initialOutput,
}: {
  ctrl: AppController;
  onSubmit: (text: string) => void;
  onExit: () => void;
  initialOutput?: string[];
}) {
  const [, force] = useState(0);
  useEffect(() => ctrl.subscribe(() => force((v) => v + 1)), [ctrl]);

  const [input, setInput] = useState("");
  // 补全时 ++ 强制 TextInput 重挂：让光标回到新文本末尾（"补全词 + 空格"之后）
  const [inputNonce, setInputNonce] = useState(0);

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") onExit();
  });

  const handleChange = (value: string) => {
    setInput(value);
    if (value.startsWith("/")) ctrl.openSlash(value.slice(1));
    else if (ctrl.slashOpen) ctrl.closeSlash();
  };

  // Tab 补全：把候选命令名写回输入框（可继续输入参数），保持菜单打开
  const handleComplete = (item: SlashItem) => {
    const completed = buildSlash(input, item.name);
    setInput(completed);
    setInputNonce((n) => n + 1);
    ctrl.openSlash(completed.slice(1));
  };

  const handleSubmit = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    setInput("");
    ctrl.closeSlash();
    onSubmit(trimmed);
  };

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" flexGrow={1}>
        {initialOutput?.map((l, i) => (
          <Text key={i} dimColor>
            {l}
          </Text>
        ))}
        {ctrl.output.map((l, i) => (
          <Text key={`o${i}`} dimColor>
            {l}
          </Text>
        ))}
        <MessageList turns={ctrl.turns} busy={ctrl.busy} />
      </Box>

      {ctrl.askState ? (
        <Select ask={ctrl.askState} onResolve={(v) => ctrl.resolveAsk(v)} />
      ) : null}

      {ctrl.slashOpen ? (
        <SlashMenu
          query={ctrl.slashQuery}
          items={ctrl.slashItems}
          onPick={(item) => handleSubmit(`/${item.name}`)}
          onComplete={handleComplete}
          onClose={() => ctrl.closeSlash()}
        />
      ) : null}

      <InputBox
        key={inputNonce}
        value={input}
        onChange={handleChange}
        onSubmit={handleSubmit}
        disabled={!!ctrl.askState}
      />
    </Box>
  );
}