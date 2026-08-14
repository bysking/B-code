import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AppController, SlashItem, ToolCallDisplay } from "./controller.js";

/** 汇总本轮会话全部工具调用（供 Ctrl+O 面板展示） */
function allToolOutputs(ctrl: AppController): ToolCallDisplay[] {
  return ctrl.turns.flatMap((t) => t.tools);
}
import { MessageList } from "./message-list.js";
import { Select } from "./select.js";
import { TabsSelect } from "./tabs-select.js";
import { SlashMenu } from "./slash-menu.js";
import { InputBox } from "./input-box.js";
import { OutputPanel } from "./output-panel.js";
import { AskInput } from "./ask-input.js";
import { buildSlash } from "./slash.js";

/**
 * ink 根组件：控制器状态 → 渲染树。
 * 输入文本（受控）在 App：/ 触发菜单、Tab 补全写回输入框、Enter 提交分发。
 * Ctrl-C：有等待的选择先 Esc，否则退出进程。
 */

export function App({
  ctrl,
  onSubmit,
  onInterrupt,
  onExit,
  initialOutput,
}: {
  ctrl: AppController;
  onSubmit: (text: string) => void;
  onInterrupt: () => void;
  onExit: () => void;
  initialOutput?: string[];
}) {
  const [, force] = useState(0);
  useEffect(() => ctrl.subscribe(() => force((v) => v + 1)), [ctrl]);

  const [input, setInput] = useState("");
  // 补全时 ++ 强制 TextInput 重挂：让光标回到新文本末尾（"补全词 + 空格"之后）
  const [inputNonce, setInputNonce] = useState(0);
  // 双 Ctrl+C：第一次提示，第二次真正退出（2s 内有效）
  const [quitArmed, setQuitArmed] = useState(false);

  useInput((_input, key) => {
    // Ctrl+C：有选择框 → 取消；有文本输入 → 取消；执行中 → 双击才真正退出
    if (key.ctrl && _input === "c") {
      if (ctrl.askState) {
        ctrl.resolveAsk(ctrl.askState.options[0]?.value ?? "");
        return;
      }
      if (ctrl.askTextState) {
        ctrl.resolveAskText("", true);
        return;
      }
      if (quitArmed) {
        onExit();
        return;
      }
      setQuitArmed(true);
      ctrl.pushOutput("(再按一次 Ctrl+C 退出)");
      setTimeout(() => setQuitArmed(false), 2000);
      return;
    }
    // Ctrl+O：切换工具输出面板（再次按下或 Esc 关闭）
    if (key.ctrl && _input === "o") {
      ctrl.toggleOutputPanel();
      return;
    }
    // Esc：先关输出面板 / 取消文本输入；执行中再是软中断
    if (key.escape && ctrl.outputPanel) {
      ctrl.toggleOutputPanel(false);
      return;
    }
    if (key.escape && ctrl.askTextState) {
      ctrl.resolveAskText("", true);
      return;
    }
    if (key.escape && !ctrl.askState && ctrl.busy !== null) {
      onInterrupt();
    }
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

      {ctrl.askGroup ? (
        <TabsSelect ask={ctrl.askGroup} onResolve={(v) => ctrl.resolveAskGroup(v)} />
      ) : ctrl.askState ? (
        <Select ask={ctrl.askState} onResolve={(v) => ctrl.resolveAsk(v)} />
      ) : null}

      {ctrl.askTextState ? (
        <AskInput
          question={ctrl.askTextState.question}
          onSubmit={(v) => ctrl.resolveAskText(v)}
        />
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

      {ctrl.outputPanel ? <OutputPanel tools={allToolOutputs(ctrl)} /> : null}

      <InputBox
        key={inputNonce}
        value={input}
        onChange={handleChange}
        onSubmit={handleSubmit}
        disabled={!!ctrl.askState || !!ctrl.askTextState}
      />
    </Box>
  );
}