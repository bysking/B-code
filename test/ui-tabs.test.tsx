import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/ui/app.js";
import { AppController } from "../src/ui/controller.js";
import { moveTab, moveTabItem } from "../src/ui/tabs-select.js";
import { Agent } from "../src/agent.js";
import type { ModelInput, ModelOutput } from "../src/backend.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 纯导航逻辑 ──────────────────────────────────────────────
test("moveTab / moveTabItem：循环与边界", () => {
  assert.equal(moveTab(0, 1, 3), 1);
  assert.equal(moveTab(2, 1, 3), 0, "末尾右移环绕");
  assert.equal(moveTab(0, -1, 3), 2);
  assert.equal(moveTabItem(0, 1, 0), 0, "空组不越界");
  assert.equal(moveTabItem(2, -1, 3), 1);
});

// ── 组件渲染：tab 行 + 当前组选项 ────────────────────────────
test("渲染：TabsSelect 显示 tab 与当前组选项", async () => {
  const ctrl = new AppController();
  const frame = render(
    React.createElement(App, {
      ctrl,
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
      initialOutput: undefined,
    }),
  );
  const p = ctrl.askGrouped("选择工具栈?", [
    { title: "前端", options: [{ label: "React", value: "react" }, { label: "Vue", value: "vue" }] },
    { title: "后端", options: [{ label: "Node", value: "node" }, { label: "Go", value: "go" }] },
  ]);
  await wait(30);
  const out = frame.lastFrame() ?? "";
  assert.ok(out.includes("前端"), "tab 行");
  assert.ok(out.includes("后端"));
  assert.ok(out.includes("React") && out.includes("Vue"), "当前 tab 选项");
  // 未切 tab 时不渲染第二组内部选项
  assert.ok(!out.includes("Node"));
  ctrl.resolveAskGroup("前端 / React");
  assert.equal(await p, "前端 / React");
  frame.cleanup();
});

// ── ask_user kind=tabs 端到端：入参→询问→答案回灌 ──────────
test("ask_user kind=tabs：groups 传入并回灌 'tab / label'", async () => {
  const seen: string[] = [];
  const agent = new Agent({
    callModel: makeScripted([
      {
        tools: [
          {
            name: "ask_user",
            input: {
              question: "选前端方案?",
              kind: "tabs",
              groups: [
                { title: "框架", options: [{ label: "React", value: "react" }] },
                { title: "构建", options: [{ label: "Vite", value: "vite" }, { label: "Webpack", value: "wp" }] },
              ],
            },
          },
        ],
      },
      { text: "好，用这个继续" },
    ]),
    print: () => {},
    askGroupedInput: async (_q, groups) => {
      seen.push(groups.map((g) => g.title).join(","));
      return "构建 / Webpack";
    },
  });
  await agent.chat("向导");
  assert.equal(seen[0], "框架,构建");

  const fedBack = agent.history()[2] as unknown as { content: { content: string }[] };
  const res = fedBack.content[0] as unknown as { content: string };
  assert.ok(res.content.includes("用户选择: 构建 / Webpack"), `回灌: ${res.content}`);
});

function makeScripted(
  script: Array<{ tools: Array<{ name: string; input: Record<string, any> }> } | { text: string }>,
) {
  let step = 0;
  return async (input: ModelInput): Promise<ModelOutput> => {
    const s = script[step] ?? { text: "done" };
    step++;
    if ("text" in s) return { content: [{ type: "text", text: s.text }] };
    return {
      content: s.tools.map((t, i) => ({
        type: "tool_use" as const,
        id: `tu-${step}-${i}`,
        name: t.name,
        input: t.input,
      })),
    };
  };
}