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
  ctrl.toolStart("read_file", { file_path: "x.ts" });
  await wait(30);
  assert.ok((frame.lastFrame() ?? "").includes("read_file"));
  ctrl.toolEnd("read_file");
  await wait(30);
  assert.ok((frame.lastFrame() ?? "").includes("read_file"));
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

test("渲染：斜杠菜单打开显示候选", async () => {
  const ctrl = new AppController();
  const submitted: string[] = [];
  const frame = renderApp(ctrl, (t) => submitted.push(t));
  ctrl.setSlashItems([
    ...(await import("../src/ui/slash.js")).BUILTIN_SLASH_ITEMS,
    { name: "commit", description: "git commit" },
  ]);
  ctrl.openSlash("co");
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
  ctrl.toolStart("read_file", { file_path: "x.ts" });
  ctrl.toolEnd("read_file", "export const x = 1;\nline2\nline3\n");
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