import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent.js";
import { registerAskUserTool } from "../src/ask-user.js";
import { Registry } from "../src/registry.js";
import { checkPermission } from "../src/permissions.js";
import { STATIC_CORE } from "../src/prompt.js";
import type { ModelInput, ModelOutput } from "../src/backend.js";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages/messages.js";

test("ask_user 注册：toolsSchema 可见、selfGranted 无条件放行", () => {
  const r = new Registry();
  registerAskUserTool(r);
  const mp = r.resolve("ask_user")!;
  assert.ok(mp.selfGranted);
  assert.equal(checkPermission(mp, {}, "default"), "allow", "不再二次确认");
  assert.equal(checkPermission(mp, {}, "plan"), "allow", "plan 下也允许（本质是对话）");
  assert.ok(r.toolsSchema(false).some((t) => t.name === "ask_user"));
});

test("ask_user choice：注入的 askChoice 收到选项，答案回灌", async () => {
  const asked: string[] = [];
  await registerAskUserTool(new Registry()); // 仅确保可重复注册不炸
  const agent = new Agent({
    callModel: makeScripted([
      { tools: [{ name: "ask_user", input: { question: "部署环境?", kind: "choice", options: [{ label: "Dev", value: "dev" }, { label: "Prod", value: "prod" }] } }] },
      { text: "ok 用选中的环境继续" },
    ]),
    print: () => {},
    askChoice: async (q, options) => {
      asked.push(`${q}|${options.map((o) => o.value).join(",")}`);
      return "prod";
    },
  });
  await agent.chat("部署到哪?");

  assert.equal(asked.length, 1, "ask Choice 被调用");
  assert.equal(asked[0], "部署环境?|dev,prod");
  const fedBack = agent.history()[2] as unknown as { content: ContentBlockParam[] };
  const res = fedBack.content[0] as unknown as { content: string };
  assert.ok(res.content.includes("用户选择: Prod (prod)"), `回灌: ${res.content}`);
});

test("ask_user text：注入 askTextInput，输入回灌；取消则提示无法获取", async () => {
  const agent = new Agent({
    callModel: makeScripted([
      { tools: [{ name: "ask_user", input: { question: "分支名?", kind: "text" } }] },
    ]),
    print: () => {},
    askTextInput: async () => "feature/x",
  });
  await agent.chat("问分支");
  const fedBack = agent.history()[2] as unknown as { content: ContentBlockParam[] };
  const res = fedBack.content[0] as unknown as { content: string };
  assert.ok(res.content.includes("用户输入: feature/x"));

  // headless（无注入）：text → 提示无法询问
  const agentH = new Agent({
    callModel: makeScripted([{ tools: [{ name: "ask_user", input: { question: "分支名?", kind: "text" } }] }]),
    print: () => {},
  });
  await agentH.chat("问");
  const resH = agentH.history()[2] as unknown as { content: ContentBlockParam[] };
  assert.ok(String((resH.content[0] as unknown as { content: string }).content).includes("无法询问用户"));
});

test("多阶段：连续两次 ask_user 依次弹选、第二问独立", async () => {
  const asked: string[] = [];
  const agent = new Agent({
    callModel: makeScripted([
      {
        tools: [
          { name: "ask_user", input: { question: "[1/2] 部署环境?", kind: "choice", options: [{ label: "dev", value: "dev" }] } },
        ],
      },
      {
        tools: [
          { name: "ask_user", input: { question: "[2/2] 回滚方式?", kind: "choice", options: [{ label: "自动", value: "auto" }, { label: "手动", value: "manual" }] } },
        ],
      },
      { text: "向导完成" },
    ]),
    print: () => {},
    askChoice: async (q, options) => {
      asked.push(q);
      return options[0]?.value ?? "";
    },
  });
  await agent.chat("向导");
  assert.deepEqual(asked, ["[1/2] 部署环境?", "[2/2] 回滚方式?"], "两步依次被询问");
  // 两次答案都回灌（各自轮次）
  const rounds = agent.history().filter((m) => m.role === "user" && Array.isArray(m.content)).length;
  assert.equal(rounds, 2, "两步 tool_result 各一次");
});

test("ask_user tabs：Chat 与 Cancel 的标记回灌措辞", async () => {
  const groups = { title: "框架", options: [{ label: "React", value: "react" }] };

  const agentChat = new Agent({
    callModel: makeScripted([
      { tools: [{ name: "ask_user", input: { question: "选啥", kind: "tabs", groups: [groups] } }] },
    ]),
    print: () => {},
    askGroupedInput: async () => "__chat__ 讲下区别",
  });
  await agentChat.chat("问");
  const resChat = agentChat.history()[2] as unknown as { content: { content: string }[] };
  assert.ok(String(resChat.content[0]?.content).includes("用户没有直接选择，而是补充说明：讲下区别"));

  const agentCancel = new Agent({
    callModel: makeScripted([
      { tools: [{ name: "ask_user", input: { question: "选啥", kind: "tabs", groups: [groups] } }] },
    ]),
    print: () => {},
    askGroupedInput: async () => "__cancel__",
  });
  await agentCancel.chat("问");
  const resCancel = agentCancel.history()[2] as unknown as { content: { content: string }[] };
  assert.ok(String(resCancel.content[0]?.content).includes("用户取消了本次选择"));
});

test("STATIC_CORE 含问用户准则（模型依据它判断何时 ask_user）", () => {
  assert.ok(STATIC_CORE.includes("call ask_user"));
  assert.ok(STATIC_CORE.includes("prefer reading files, searching"), "准则强调能自己解决就别问");
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