import { test } from "node:test";
import assert from "node:assert/strict";
import {
  maybeCompact,
  truncateResult,
  MAX_RESULT_CHARS,
  COMPACT_THRESHOLD,
  KEEP_RECENT,
} from "../src/context.js";

// ── truncateResult（Tier 0）───────────────────────────────────

test("小结果原样返回", () => {
  assert.equal(truncateResult("short"), "short");
});

test("恰好等于上限不改动", () => {
  const s = "x".repeat(MAX_RESULT_CHARS);
  assert.equal(truncateResult(s).length, MAX_RESULT_CHARS);
});

test("超上限：头尾各半保留 + 中间省略标记", () => {
  const big = `HEAD!${"x".repeat(MAX_RESULT_CHARS)}TAIL?`;
  const out = truncateResult(big);
  assert.ok(out.length < MAX_RESULT_CHARS, "截断后必须在窗口内");
  assert.ok(out.startsWith("HEAD!"), "保留头部");
  assert.ok(out.endsWith("TAIL?"), "保留尾部");
  assert.ok(out.includes("truncated"), "含省略说明");
});

// ── maybeCompact（Tier 4 摘要）───────────────────────────────

function messages(n: number): { role: string; content: string }[] {
  return Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `msg-${i}` }));
}

test("消息数未超阈值 → 不压缩、不调摘要", async () => {
  const list = messages(COMPACT_THRESHOLD);
  let called = false;
  const out = await maybeCompact(list, async () => {
    called = true;
    return "摘要";
  });
  assert.equal(called, false);
  assert.equal(out, list, "原数组引用不变");
});

test("超阈值 → 旧消息摘要替换，保留最近 KEEP_RECENT 条", async () => {
  const n = 20;
  const list = messages(n);
  const out = await maybeCompact(list, async (older) => {
    assert.equal(older.length, n - KEEP_RECENT, "摘要回调收到的是旧消息");
    // 刚越过压缩边界的那条（index 14，偶数 → user）
    assert.deepEqual(older.slice(-1), [{ role: "user", content: `msg-${n - KEEP_RECENT - 1}` }]);
    return "flyweight summary";
  });

  assert.equal(out.length, KEEP_RECENT + 1);
  assert.equal(out[0]?.content, "[Summary of earlier conversation]\nflyweight summary");
  assert.equal(out[0]?.role, "user");
  assert.deepEqual(
    out.slice(1).map((m) => m.content),
    Array.from({ length: KEEP_RECENT }, (_, i) => `msg-${n - KEEP_RECENT + i}`),
    "最近 5 条原样保留",
  );
});

test("摘要为空字符串 → 保持原样（宁可爆窗不丢上下文）", async () => {
  const list = messages(COMPACT_THRESHOLD + 1);
  const out = await maybeCompact(list, async () => "   ");
  assert.equal(out, list);
});

// 压缩不能拆散 tool_use/tool_result 配对：切点落在 tool_result 上时窗口前移一条
function toolPair(i: number): { role: string; content: unknown }[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: `call_${i}`, name: "t", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `call_${i}`, content: `out-${i}` }],
    },
  ];
}

test("切点落在 tool_result 上时，压缩前移窗口保住配对", async () => {
  // 1 条 user(text) + 8 轮工具 = 17 条（奇数，裸切长度-5 会切在 user(tool_result) 上）
  const list: { role: string; content: unknown }[] = [{ role: "user", content: "hello" }];
  for (let i = 0; i < 8; i++) list.push(...toolPair(i));
  assert.equal(list.length, 17);

  const out = await maybeCompact(list, async () => "summary");

  assert.equal(out.length, KEEP_RECENT + 1 + 1, "摘要 + 6 条（窗口前移带上 assistant）");
  const recent = out.slice(1);
  assert.equal(recent[0]?.role, "assistant", "保留窗口不能以 tool_result 开头");

  // 窗口内每个 tool_result 的 tool_use 必须在前一条消息里
  for (let i = 1; i < recent.length; i++) {
    const m = recent[i]!;
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content as { type: string; tool_use_id: string }[]) {
      if (b.type !== "tool_result") continue;
      const prev = recent[i - 1]!;
      const ids = (Array.isArray(prev.content) ? prev.content : [])
        .filter(
          (x): x is { type: string; id: string } =>
            typeof x === "object" && x !== null && (x as { type?: string }).type === "tool_use",
        )
        .map((x) => x.id);
      assert.ok(ids.includes(b.tool_use_id), `tool_result ${b.tool_use_id} 的 tool_use 必须在前一条消息`);
    }
  }
});