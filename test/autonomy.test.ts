import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGoal, classifyAction, renderTranscript } from "../src/autonomy.js";
import { Agent } from "../src/agent.js";
import type { ModelInput, ModelOutput } from "../src/backend.js";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages/messages.js";

function textReply(text: string): ModelOutput {
  return { content: [{ type: "text", text }] };
}

/** 按"收到什么就答什么"的假后端 */
function makeAutonomyBackend(
  reply: (input: ModelInput, callIndex: number) => ModelOutput,
) {
  const calls: ModelInput[] = [];
  const fn = async (input: ModelInput): Promise<ModelOutput> => {
    calls.push({ ...input, messages: [...input.messages] });
    return reply(input, calls.length - 1);
  };
  return { fn, calls };
}

// ── evaluateGoal 三态解析 ─────────────────────────────────────

test("evaluateGoal：MET → 达成", async () => {
  const { fn, calls } = makeAutonomyBackend(() => textReply("MET"));
  const r = await evaluateGoal("x exists", "transcript", "m", fn);
  assert.deepEqual(r, { met: true, reason: "", impossible: false });
  assert.equal(String(calls[0]?.messages[0]?.content).includes("Condition: x exists"), true);
  assert.equal(calls[0]?.tools.length, 0, "评估器不给工具");
});

test("evaluateGoal：NOT_MET 带原因", async () => {
  const { fn } = makeAutonomyBackend(() => textReply("NOT_MET: file missing"));
  const r = await evaluateGoal("x", "t", "m", fn);
  assert.equal(r.met, false);
  assert.equal(r.impossible, false);
  assert.equal(r.reason, "file missing");
});

test("evaluateGoal：NOT_MET impossible 刹车", async () => {
  const { fn } = makeAutonomyBackend(() =>
    textReply("NOT_MET impossible: goal requires human action"),
  );
  const r = await evaluateGoal("x", "t", "m", fn);
  assert.equal(r.met, false);
  assert.equal(r.impossible, true);
});

// ── classifyAction ────────────────────────────────────────────

test("classifyAction：ALLOW / BLOCK", async () => {
  let mode = "ALLOW";
  const { fn, calls } = makeAutonomyBackend(() => textReply(mode));
  assert.deepEqual(await classifyAction("write_file", { file_path: "a" }, "t", "m", fn), {
    allow: true,
    reason: "",
  });
  mode = "BLOCK: looks destructive";
  assert.deepEqual(await classifyAction("run_shell", { command: "x" }, "t", "m", fn), {
    allow: false,
    reason: "looks destructive",
  });
  assert.ok(String(calls[1]?.messages[0]?.content).includes("Tool: run_shell"), "分类器看到工具调用");
});

// ── renderTranscript 脱敏 ─────────────────────────────────────

test("renderTranscript：tool 块不展开细节（脱敏）", () => {
  const text = renderTranscript([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "1", name: "read_file", input: { file_path: "/etc/passwd" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "1", content: "root:x:0:0" }],
    },
  ]);
  assert.ok(text.includes("user: hi"));
  assert.ok(text.includes("[tool call / result]"));
  assert.ok(!text.includes("/etc/passwd"), "参数细节不泄漏");
  assert.ok(!text.includes("root:x:0:0"), "结果内容不泄漏");
});

// ── pursueGoal：评估→回灌→再执行，MET 收尾 ───────────────────

test("pursueGoal：未达成原因回灌，达成即停", async () => {
  let callIdx = 0;
  const { fn, calls } = makeAutonomyBackend((input, idx) => {
    const firstMsg = String(input.messages[0]?.content ?? "");
    if (firstMsg.startsWith("Condition:")) {
      // 评估器路径：前两次未达成，第三次达成
      callIdx++;
      return callIdx <= 2 ? textReply("NOT_MET: file not created yet") : textReply("MET");
    }
    return textReply("ok did my best");
  });

  const agent = new Agent({ callModel: fn, print: () => {} });
  await agent.pursueGoal("test.txt exists", "create test.txt if missing", 5);

  // 主对话 3 次 dispatch（初始 + 2 回灌）+ 评估 3 次 = 部分 call
  const conditionCalls = calls.filter((c) => String(c.messages[0]?.content).startsWith("Condition:"));
  assert.equal(conditionCalls.length, 3, "评估 3 次（2 未达成 + 1 达成）");
  const reFeed = calls.find((c) =>
    String(c.messages[0]?.content).includes("Keep working toward it"),
  );
  assert.ok(reFeed, "原因以新用户消息回灌给主模型");
  assert.ok(String(reFeed?.messages[0]?.content).includes("file not created yet"), "原因原文入回灌");
});

test("pursueGoal：impossible 立即刹车", async () => {
  const { fn } = makeAutonomyBackend((input) => {
    if (String(input.messages[0]?.content).startsWith("Condition:"))
      return textReply("NOT_MET impossible: needs human");
    return textReply("done");
  });
  const agent = new Agent({ callModel: fn, print: () => {} });
  await agent.pursueGoal("x", "do it", 5); // 不抛、及早返回（单轮即止损）
});

// ── auto 模式分类拦截 ─────────────────────────────────────────

test("auto 模式：分类器 BLOCK → 不执行；ALLOW → 执行", async () => {
  const target = new URL("file:///tmp/b-code-auto-test.txt").pathname;
  let classifier = "ALLOW";
  const { fn, calls } = makeAutonomyBackend((input) => {
    const firstMsg = String(input.messages[0]?.content ?? "");
    if (firstMsg.startsWith("Tool: write_file")) return textReply(classifier); // 分类器路径
    const last = input.messages[input.messages.length - 1];
    // 主对话：首次（末条是字符串用户消息）→ 请求写文件；之后（末条是 tool_result 喂回）→ 收尾
    if (typeof last?.content === "string") {
      return {
        content: [
          { type: "tool_use", id: "a-1", name: "write_file", input: { file_path: target, content: "x" } },
        ],
      };
    }
    return textReply("ack");
  });

  const agent = new Agent({ callModel: fn, print: () => {}, mode: "auto" });
  await agent.chat("write it");
  // BLOCK 路径
  classifier = "BLOCK: unexpected write";
  const agent2 = new Agent({ callModel: fn, print: () => {}, mode: "auto" });
  await agent2.chat("write it again");

  const blockedMsg = agent2.history()[2] as unknown as { content: ContentBlockParam[] };
  const blocked = blockedMsg.content[0] as unknown as { content: string };
  assert.ok(blocked.content.includes("Blocked by auto-mode monitor"), blocked.content);
  assert.ok(blocked.content.includes("unexpected write"), "分类器原因透传");
  void calls;
});