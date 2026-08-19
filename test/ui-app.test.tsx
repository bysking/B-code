import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/ui/app.js";
import { AppController } from "../src/ui/controller.js";

function renderApp(
  ctrl: AppController,
  onSubmit: (text: string) => void = () => {},
  onExit: () => void = () => {},
) {
  const frame = render(
    React.createElement(App, {
      ctrl,
      onSubmit,
      onInterrupt: () => {},
      onExit,
      initialOutput: undefined,
    }),
  );
  return frame;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("渲染：用户消息 + assistant markdown 流式文本", async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  ctrl.pushUser("你好");
  ctrl.streamText("收到 **加粗** 与 `code`");
  await wait(30);
  const out = frame.lastFrame() ?? "";
  assert.ok(out.includes("你好"), "用户消息渲染");
  assert.ok(out.includes("加粗"), "bold 文案渲染（样式由 ink 处理，文本在）");
  assert.ok(out.includes("code"));
  ctrl.finishStream();
  frame.cleanup();
});

test("渲染：工具调用块出现且标记完成", async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  ctrl.streamText("");
  ctrl.planTools([{ id: "t1", name: "read_file", input: { file_path: "x.ts" } }]);
  ctrl.toolStart("t1", "read_file", { file_path: "x.ts" }); // 首个工具开始 → 整批落地展示
  await wait(30);
  assert.ok((frame.lastFrame() ?? "").includes("read_file"));
  ctrl.toolEnd("t1");
  await wait(30);
  assert.ok((frame.lastFrame() ?? "").includes("read_file"));
  frame.cleanup();
});

test("渲染：底部固定任务面板展示标题、三态与 loading，随事件推进", async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  ctrl.planTools([
    { id: "a", name: "read_file", input: { file_path: "src/a.ts" } },
    { id: "b", name: "read_file", input: { file_path: "src/b.ts" } },
  ]);
  await wait(30);
  let out = frame.lastFrame() ?? "";
  assert.ok(out.includes("正在读取 2 个文件"), "loading 态标题");
  assert.ok(out.includes("待读取"), "queued → 待读取");
  assert.ok(out.includes("src/a.ts"), "子项标签（文件路径）");

  ctrl.toolStart("a", "read_file", { file_path: "src/a.ts" });
  await wait(30);
  out = frame.lastFrame() ?? "";
  assert.ok(out.includes("读取中"), "running → 读取中");

  ctrl.toolEnd("a");
  ctrl.toolStart("b", "read_file", { file_path: "src/b.ts" });
  ctrl.toolEnd("b");
  await wait(30);
  out = frame.lastFrame() ?? "";
  assert.ok(!out.includes("正在读取 2 个文件"), "全部完成 → 面板消失");
  assert.ok(!out.includes("读取中"), "面板消失不再展示状态");
  frame.cleanup();
});

test("渲染：busy 行展示 thinking 文案", async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  ctrl.setBusy("thinking…");
  await wait(30);
  assert.ok((frame.lastFrame() ?? "").includes("thinking…"));
  ctrl.setBusy(null);
  frame.cleanup();
});

test("渲染：busy 状态行展示 ✽ 前缀、耗时、token 与 thinking 标签", async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  ctrl.setBusy("thinking…");
  ctrl.setBusyThinking(true);
  ctrl.setBusyTokens(1234);
  await wait(30);
  const out = frame.lastFrame() ?? "";
  // elapsed 由挂载时刻决定（跨秒边界时为 1s），断言形态而非精确秒数
  assert.match(out, /✽ thinking… \(\d+s · ↓ 1\.2k tokens · thinking\)/, "完整状态行");
  ctrl.setBusy(null);
  frame.cleanup();
});

test("渲染：模型调用完成后显示真实用量元信息行", async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  ctrl.pushUser("hi");
  ctrl.streamText("done");
  // 生产顺序：usage 事件先于 stream_end（agent.ts），用量行须在 finishStream 前回填
  ctrl.setTurnUsage({ input_tokens: 1000, output_tokens: 200 }, 3400);
  ctrl.finishStream();
  await wait(30);
  const out = frame.lastFrame() ?? "";
  assert.ok(out.includes("(⏱ 3s · ↓ 1k · ↑ 200 tokens)"), "真实用量行（耗时 3s，整千去 .0）");
  frame.cleanup();
});

test("渲染：斜杠菜单打开显示候选", async () => {
  const ctrl = new AppController();
  const submitted: string[] = [];
  const frame = renderApp(ctrl, (t) => submitted.push(t));
  ctrl.setSlashItems([
    ...(await import("../src/ui/slash.js")).BUILTIN_SLASH_ITEMS,
    { name: "commit", description: "git commit" },
  ]);
  ctrl.openSlash(""); // 空查询：显示全量候选
  await wait(30);
  const out = frame.lastFrame() ?? "";
  assert.ok(out.includes("commit"), "斜杠菜单含技能");
  assert.ok(out.includes("/clear"), "斜杠菜单含内置命令");
  frame.cleanup();
});

test("渲染：askText 文本输入提问渲染，交付后关闭", async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  const p = ctrl.askText("请输入分支名:");
  await wait(30);
  const open = frame.lastFrame() ?? "";
  assert.ok(open.includes("请输入分支名:"), "问题渲染");
  ctrl.resolveAskText("feature/x");
  assert.equal(await p, "feature/x");
  assert.equal(ctrl.askTextState, null);
  frame.cleanup();
});

test("渲染：Ctrl+O 面板打开展示工具真实输出，关闭后消失", async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  ctrl.streamText("");
  ctrl.planTools([{ id: "t1", name: "read_file", input: { file_path: "x.ts" } }]);
  ctrl.toolStart("t1", "read_file", { file_path: "x.ts" });
  ctrl.toolEnd("t1", "export const x = 1;\nline2\nline3\n");
  await wait(30);
  // 未打开面板时不显示输出
  assert.ok(!(frame.lastFrame() ?? "").includes("line2"));

  ctrl.toggleOutputPanel(true);
  await wait(30);
  const open = frame.lastFrame() ?? "";
  assert.ok(open.includes("工具输出"), "面板标题");
  assert.ok(open.includes("line2"), "真实输出渲染");
  assert.ok(open.includes("read_file"));

  ctrl.toggleOutputPanel(false);
  await wait(30);
  assert.ok(!(frame.lastFrame() ?? "").includes("line2"), "关闭后回主视图");
  frame.cleanup();
});

test("渲染：权限确认（ask）显示选项", async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  const p = ctrl.ask("Allow write_file?", [
    { label: "No", value: "no" },
    { label: "Yes", value: "yes" },
  ]);
  await wait(30);
  const out = frame.lastFrame() ?? "";
  assert.ok(out.includes("Allow write_file?"), "问题渲染");
  assert.ok(out.includes("Yes") && out.includes("No"), "选项渲染");
  ctrl.resolveAsk("no");
  assert.equal(await p, "no");
  frame.cleanup();
});

test("回归：向导打开时 Esc 不触发 onInterrupt（提交后模型才能继续）", async () => {
  const ctrl = new AppController();
  let interrupted = 0;
  const frame = render(
    React.createElement(App, {
      ctrl,
      onSubmit: () => {},
      onInterrupt: () => interrupted++,
      onExit: () => {},
      initialOutput: undefined,
    }),
  );
  // 模拟执行中（execTool 设 busy）：向导打开期间 busy 非空
  ctrl.setBusy("running ask_user…");
  const p = ctrl.askWizard("选方案?", [
    { title: "方案", question: "用哪个?", options: [{ label: "React", value: "react" }] },
  ]);
  await wait(30);
  // 向导未处于输入态时按 Esc：由 Wizard 自行取消，不应再软中断 agent
  frame.stdin.write("\x1b");
  await wait(30);
  assert.equal(interrupted, 0, "向导打开时 Esc 不应触发 agent 软中断");
  assert.equal(await p, "__cancel__", "Esc 由 Wizard 交付取消");
  assert.equal(ctrl.askWizardState, null);
  frame.cleanup();
});

test("回归：向导输入态按 Esc 返回选项不中断 agent，Ctrl+C 可取消向导", async () => {
  const ctrl = new AppController();
  let interrupted = 0;
  const frame = render(
    React.createElement(App, {
      ctrl,
      onSubmit: () => {},
      onInterrupt: () => interrupted++,
      onExit: () => {},
      initialOutput: undefined,
    }),
  );
  ctrl.setBusy("running ask_user…");
  const p = ctrl.askWizard("选方案?", [
    { title: "方案", question: "用哪个?", options: [{ label: "React", value: "react" }] },
  ]);
  await wait(30);
  // 移到自定义项进入输入态，Esc"返回选项"
  frame.stdin.write("\x1b[B");
  await wait(15);
  frame.stdin.write("\r");
  await wait(30);
  assert.ok((frame.lastFrame() ?? "").includes("输入你的答案"), "进入输入态");
  frame.stdin.write("\x1b");
  await wait(30);
  assert.equal(interrupted, 0, "输入态按 Esc 返回选项不应触发软中断");
  assert.ok(ctrl.askWizardState, "向导保持打开");
  // Ctrl+C 取消向导
  frame.stdin.write("\x03");
  await wait(30);
  assert.equal(ctrl.askWizardState, null, "Ctrl+C 应取消向导");
  assert.equal(await p, "__cancel__");
  frame.cleanup();
});