import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.js";
import { BASE_PATH_ENV } from "../src/utils/paths.js";
import { memoryDir, registerMemoryTool } from "../src/memory.js";
import { Registry, type RuntimeContext } from "../src/registry.js";
import { STATIC_CORE } from "../src/prompt.js";
import type { ModelInput, ModelOutput } from "../src/backend.js";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages/messages.js";

const saved = process.env[BASE_PATH_ENV];
let home: string;

before(async () => {
  home = await mkdtemp(join(tmpdir(), "b-code-savemem-"));
  process.env[BASE_PATH_ENV] = home;
});
after(async () => {
  if (saved === undefined) delete process.env[BASE_PATH_ENV];
  else process.env[BASE_PATH_ENV] = saved;
  await rm(home, { recursive: true, force: true });
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

test("save_memory 注册：mode=write（写需确认）、toolsSchema 可见", () => {
  const r = new Registry();
  registerMemoryTool(r);
  const mp = r.resolve("save_memory");
  assert.ok(mp);
  assert.equal(mp?.mode, "write");
  assert.ok(r.toolsSchema(false).some((t) => t.name === "save_memory"));
});

test("save_memory handler：经注册表落盘并返回保存路径", async () => {
  const r = new Registry();
  registerMemoryTool(r);
  const mp = r.resolve("save_memory")!;
  const out = await mp.handler({ name: "staging url", content: "https://staging.example.com" }, {} as RuntimeContext);
  assert.ok(String(out).includes("Saved to memory"));
  const file = join(memoryDir(), "staging_url.md");
  assert.ok(existsSync(file), "记忆文件落盘");
  assert.ok(readFileSync(file, "utf-8").includes("https://staging.example.com"));
});

test("agent 集成：模型调 save_memory → confirm 后落盘；拒绝则不落盘", async () => {
  // 路径 A：用户确认（askUser → true）
  const agentA = new Agent({
    callModel: makeScripted([
      { tools: [{ name: "save_memory", input: { name: "deploy rule", content: "never push to main" } }] },
      { text: "done" },
    ]),
    print: () => {},
    askUser: async () => true,
  });
  await agentA.chat("记住这个");
  assert.ok(existsSync(join(memoryDir(), "deploy_rule.md")), "确认后落盘");

  // 路径 B：用户拒绝 → 不落盘、喂回 user rejected
  const target2 = "never push to prod";
  const agentB = new Agent({
    callModel: makeScripted([
      { tools: [{ name: "save_memory", input: { name: "denied rule", content: target2 } }] },
    ]),
    print: () => {},
    askUser: async () => false,
  });
  await agentB.chat("记一条");
  assert.ok(!existsSync(join(memoryDir(), "denied_rule.md")), "拒绝则不落盘");
  const fedBack = agentB.history()[2] as unknown as {
    content: ContentBlockParam[];
  };
  const res = fedBack.content[0] as unknown as { content: string };
  assert.ok(res.content.includes("user rejected"), `实际: ${res.content}`);
});

test("STATIC_CORE 含记忆沉淀行为准则", async () => {
  assert.ok(STATIC_CORE.includes("save_memory"), "system 引导模型主动调用 save_memory");
  assert.ok(STATIC_CORE.includes("one fact per memory"));
});