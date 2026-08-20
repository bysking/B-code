import React, { useEffect, useState } from "react";
import { Box, Static, Text, useInput } from "ink";
import type { AppController, SlashItem, ToolCallDisplay } from "./controller.js";

/** 汇总本轮会话全部工具调用（供 Ctrl+O 面板展示） */
function allToolOutputs(ctrl: AppController): ToolCallDisplay[] {
  return ctrl.turns.flatMap((t) => t.tools);
}
import { MessageList } from "./message-list.js";
import { Confirm } from "./confirm.js";
import { Wizard } from "./wizard.js";
import { SlashMenu } from "./slash-menu.js";
import { InputBox } from "./input-box.js";
import { OutputPanel } from "./output-panel.js";
import { TaskPanel } from "./task-panel.js";
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
  // 终端尺寸变化：重估流式防溢出预算（live 帧超终端行数会触发 Ink 整屏清屏，滚动位置被重置）
  useEffect(() => {
    const onResize = () => ctrl.handleResize();
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, [ctrl]);

  const [input, setInput] = useState("");
  // 补全时 ++ 强制 TextInput 重挂：让光标回到新文本末尾（"补全词 + 空格"之后）
  const [inputNonce, setInputNonce] = useState(0);
  // 双 Ctrl+C：第一次提示，第二次真正退出（2s 内有效）
  const [quitArmed, setQuitArmed] = useState(false);

  useInput((_input, key) => {
    // Ctrl+C：有选择框/向导/文本输入 → 取消；执行中 → 双击才真正退出
    if (key.ctrl && _input === "c") {
      if (ctrl.askState) {
        // Ctrl+C 取消审批 = 拒绝（Yes 已在第一项，不能用 options[0]）
        const deny = ctrl.askState.options.find((o) => o.value === "no");
        ctrl.resolveAsk(deny?.value ?? ctrl.askState.options[0]?.value ?? "");
        return;
      }
      if (ctrl.askWizardState) {
        ctrl.resolveAskWizard("__cancel__");
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
    // Esc：先关输出面板 / 取消文本输入；有向导/确认/文本输入时 Esc 由对应组件自处理
    if (key.escape && ctrl.outputPanel) {
      ctrl.toggleOutputPanel(false);
      return;
    }
    if (key.escape && ctrl.askTextState) {
      ctrl.resolveAskText("", true);
      return;
    }
    if (key.escape && !ctrl.askState && !ctrl.askWizardState && ctrl.busy !== null) {
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
        {/* 固定输出行走 <Static>：只追加不重渲染，避免 (resumed…)/(done) 及 /skills、/mcp
            等大段输出撑大 live 区触发 Ink 的 overflow 整屏清屏（连 scrollback 一起清）。 */}
        <Static
          items={[...(initialOutput ?? []).map((l, i) => ({ k: `i${i}`, text: l })), ...ctrl.output.map((l, i) => ({ k: `o${i}`, text: l }))]}
        >
          {({ k, text }) => (
            <Text key={k} dimColor>
              {text}
            </Text>
          )}
        </Static>
        <MessageList
          turns={ctrl.turns}
          busy={ctrl.busy}
          busySince={ctrl.busySince}
          busyThinking={ctrl.busyThinking}
          busyInputTokens={ctrl.busyInputTokens}
        />
      </Box>

      {ctrl.askWizardState ? (
        <Wizard ask={ctrl.askWizardState} onResolve={(v) => ctrl.resolveAskWizard(v)} />
      ) : ctrl.askState ? (
        <Confirm ask={ctrl.askState} onResolve={(v) => ctrl.resolveAsk(v)} />
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

      {ctrl.task ? <TaskPanel task={ctrl.task} /> : null}

      <InputBox
        key={inputNonce}
        value={input}
        onChange={handleChange}
        onSubmit={handleSubmit}
        disabled={!!ctrl.askState || !!ctrl.askTextState || !!ctrl.askWizardState}
      />
    </Box>
  );
}