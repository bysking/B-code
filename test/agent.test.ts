import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.js";
import type { ModelInput, ModelOutput } from "../src/backend.js";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages/messages.js";

/**
 * 脚本化假后端：按预写剧本依次回复
 * @param script 每步的工具调用数（-1 = 直接文本收尾）
 */
function makeScriptedBackend(script: number[], readFilePath: string) {
  const calls: ModelInput[] = [];
  let step = 0;
  const fn = async (input: ModelInput): Promise<ModelOutput> => {
    // 快照消息数组：循环运行时会原地修改 this.messages，按引用记录会看到最终态
    calls.push({ ...input, messages: [...input.messages] });
    const toolCount = script[step] ?? -1;
    step++;
    if (toolCount === -1) {
      return { content: [{ type: "text", text: "all done" }] };
    }
    const content: ContentBlockParam[] = [];
    for (let i = 0; i < toolCount; i++) {
      content.push({
        type: "tool_use",
        id: `tu-${step}-${i}`,
        name: "read_file",
        input: { file_path: readFilePath },
      });
    }
    return { content };
  };
  return { fn, calls };
}

let dir: string;
let filePath: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "b-code-agent-"));
  filePath = join(dir, "target.txt");
  await writeFile(filePath, "hello world");
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("循环：工具执行 → tool_result 关联 id 喂回 → 文本收尾", async () => {
  const { fn, calls } = makeScriptedBackend([1, -1], filePath);
  const agent = new Agent({ callModel: fn, print: () => {} });
  await agent.chat("read it");

  assert.equal(calls.length, 2, "一次工具调用 + 一次文本收尾 = 2 次模型调用");

  // 第一轮：只有用户消息
  assert.deepEqual(calls[0]?.messages, [{ role: "user", content: "read it" }]);

  // 第二轮：历史包含 用户 + assistant(tool_use) + user(tool_result)
  const history = calls[1]!.messages;
  assert.equal(history.length, 3);
  const assistant = history[1]!;
  assert.equal(assistant.role, "assistant");
  const toolUse = (assistant.content as ContentBlockParam[]).find(
    (b) => b.type === "tool_use",
  );
  assert.equal(toolUse?.type, "tool_use");

  const fedBack = history[2]!;
  assert.equal(fedBack.role, "user");
  const results = fedBack.content as ContentBlockParam[];
  // tool_use_id 必须和模型给的 id 严格一致（断开这一步模型会报错）
  assert.equal((results[0] as { tool_use_id: string }).tool_use_id, "tu-1-0");
  // 工具执行的真实内容被喂回
  assert.ok(String((results[0] as { content: string }).content).includes("hello world"));

  // 最终历史：user, assistant(tool_use), user(tool_result), assistant(text)
  const final = agent.history();
  assert.equal(final.length, 4);
  const last = final[3]!;
  assert.equal(last.role, "assistant");
  assert.ok(
    (last.content as ContentBlockParam[]).some((b) => b.type === "text"),
    "文本收尾应进入历史",
  );
});

test("循环：模型一次返回多个 tool_use，全部执行并逐一喂回", async () => {
  const { fn, calls } = makeScriptedBackend([2, -1], filePath);
  const agent = new Agent({ callModel: fn, print: () => {} });
  await agent.chat("read twice");

  // 第一轮就返回 2 个 tool_use
  const secondCall = calls[1]!.messages;
  const results = (secondCall[2] as { content: ContentBlockParam[] }).content;
  assert.equal(results.length, 2);
  assert.equal((results[0] as { tool_use_id: string }).tool_use_id, "tu-1-0");
  assert.equal((results[1] as { tool_use_id: string }).tool_use_id, "tu-1-1");
});

test("循环：模型直接给文本（无工具）→ 一轮即止", async () => {
  const { fn, calls } = makeScriptedBackend([-1], filePath);
  const agent = new Agent({ callModel: fn, print: () => {} });
  await agent.chat("just answer");

  assert.equal(calls.length, 1);
  assert.equal(agent.history().length, 2); // user + assistant(text)
});

test("循环：模型状态失忆时的兜底（下一轮直接文本）", async () => {
  // 剧本只有一次工具，但循环要求模型返回工具；假后端在越界时返回文本 → 安全退出不卡死
  const { fn, calls } = makeScriptedBackend([1], filePath);
  const agent = new Agent({ callModel: fn, print: () => {} });
  await agent.chat("run");

  // 第二轮越界 → 文本收尾，循环必终止（防死循环护栏）
  assert.equal(calls.length, 2);
});