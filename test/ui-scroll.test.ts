import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { estimateLines, findStreamSplit, liveLineBudget } from "../src/ui/scroll-budget.js";
import { AppController } from "../src/ui/controller.js";
import { App } from "../src/ui/app.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** n 行短文本（每行一行，行尾含换行） */
function lines(n: number, prefix = "line"): string {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i}`).join("\n");
}

// ── findStreamSplit：切分边界选择 ─────────────────────────────────

test("findStreamSplit：优先在空行（段落界）切分，且不带围栏标记", () => {
  // 3 个段落，预算只够保留最后一段
  const text = `${lines(10, "a")}\n\n${lines(10, "b")}\n\n${lines(5, "c")}`;
  const sp = findStreamSplit(text, 6, { cols: 80 });
  assert.ok(sp, "超出预算应可切分");
  const prefix = text.slice(0, sp!.cut);
  const rest = text.slice(sp!.cut);
  // 切点落在倒数第二段（b）之后、最后一段（c）之前——即紧邻段落间空行前
  assert.ok(prefix.endsWith("b-9\n"), "切点落在段落间空行前（保留空行给尾部做段落分隔）");
  assert.ok(rest.startsWith("\nc-0"), "余量以空行开头，段落分隔正确");
  assert.ok(prefix.includes("a-0") && prefix.includes("b-0"), "前两段进前缀");
  assert.ok(rest.trim().startsWith("c-0"), "最后一段留在 live 余量（含前导空行）");
  assert.equal(sp!.closeFence, null);
  assert.equal(sp!.openFence, null);
});

test("findStreamSplit：整个目标区间都在大代码块内时，闭合再重开同语种围栏", () => {
  const text = "```ts\n" + lines(40, "code") + "\n```";
  const sp = findStreamSplit(text, 5, { cols: 80 });
  assert.ok(sp, "大代码块也应可切分（否则 live 帧会撑爆终端）");
  assert.equal(sp!.closeFence, "```", "前缀末尾补闭合围栏");
  assert.equal(sp!.openFence, "```ts\n", "余量开头重开同语种围栏");
  const prefix = text.slice(0, sp!.cut) + sp!.closeFence;
  const rest = sp!.openFence + text.slice(sp!.cut);
  assert.ok(prefix.startsWith("```ts\n") && prefix.endsWith("```"), "前缀是自闭合代码块");
  assert.ok(rest.startsWith("```ts\n") && rest.endsWith("```"), "余量也是自闭合代码块");
});

test("findStreamSplit：未超预算返回 null；围栏外的普通边界优先于围栏内", () => {
  assert.equal(findStreamSplit(lines(5), 10, { cols: 80 }), null, "不超不切");
  // 围栏前有空行边界：即使围栏内空间更大，也应切在围栏外
  const text = `${lines(5, "a")}\n\n\`\`\`\n${lines(20, "code")}\n\`\`\`\n${lines(3, "z")}`;
  const sp = findStreamSplit(text, 4, { cols: 80 });
  assert.ok(sp);
  assert.equal(sp!.closeFence, null, "选中围栏外边界，无需补围栏");
});

// ── controller：流式分段提交 ─────────────────────────────────────

test("streamText：超长流式文本分段提交进 chunks，live 余量受预算约束", () => {
  const c = new AppController();
  const original = lines(80);
  c.streamText(original);
  const t = c.turns.at(-1)!;
  assert.ok(t.chunks.length >= 1, "超预算 → 至少提交一段");
  assert.ok(estimateLines(t.text) <= liveLineBudget(), "余量不超过 live 预算");
  assert.equal(t.chunks.join("") + t.text, original, "分段只切不丢：拼接还原原文");
  assert.equal(t.streaming, true);
});

test("streamText：多段流式追加分段后仍能拼接还原（含继续追加）", () => {
  const c = new AppController();
  c.streamText(lines(60, "a") + "\n\n");
  c.streamText(lines(30, "b"));
  const t = c.turns.at(-1)!;
  assert.ok(t.chunks.length >= 1);
  assert.equal(t.chunks.join("") + t.text, lines(60, "a") + "\n\n" + lines(30, "b"));
});

test("streamText：代码块内部切分时补闭合/重开围栏，拼接仍还原", () => {
  const c = new AppController();
  const original = "```js\n" + lines(60, "code") + "\n```";
  c.streamText(original);
  const t = c.turns.at(-1)!;
  assert.ok(t.chunks.length >= 1, "大代码块必须切（否则撑爆 live 帧）");
  assert.ok(t.chunks[0]!.endsWith("```"), "提交段以闭合围栏结尾");
  assert.ok(t.text.startsWith("```js\n"), "余量以同语种围栏重开");
  // 去掉补的围栏后可还原
  const joined = t.chunks.join("") + t.text;
  assert.equal(joined.split("```").length >= 3, true, "补入的围栏成对出现");
});

test("streamThinking：超长 thinking 提交进 thinkingChunks（纯文本无围栏）", () => {
  const c = new AppController();
  const original = lines(80, "think");
  c.streamThinking(original);
  const t = c.turns.at(-1)!;
  assert.ok(t.thinkingChunks.length >= 1);
  assert.equal(t.thinkingChunks.join("") + (t.thinking ?? ""), original);
  assert.ok(t.chunks.length === 0, "thinking 不进 text chunks");
});

test("短回复不触发分段（常见路径不受影响）", () => {
  const c = new AppController();
  c.streamText("收到 **加粗**");
  const t = c.turns.at(-1)!;
  assert.equal(t.chunks.length, 0);
  assert.equal(t.text, "收到 **加粗**");
});

// ── 渲染集成：分段 turn 只打一次标题，片段进 Static ──────────────

test("渲染：分段提交的 turn 全程只出现一个 B Code 标题，首段内容可见", async () => {
  const ctrl = new AppController();
  const frame = render(
    React.createElement(App, {
      ctrl,
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
      onSetMode: () => {},
      initialOutput: undefined,
    }),
  );
  ctrl.streamText(lines(80));
  await wait(30);
  const out = frame.lastFrame() ?? "";
  const headerCount = out.split("B Code").length - 1;
  assert.equal(headerCount, 1, "标题只出现一次（首个 Static 片段携带）");
  assert.ok(out.includes("line-0"), "首个提交片段已渲染");
  ctrl.finishStream();
  await wait(30);
  const after = frame.lastFrame() ?? "";
  assert.equal(after.split("B Code").length - 1, 1, "落定后仍只有一个标题");
  assert.ok(after.includes("line-79"), "余量尾部也在");
  frame.cleanup();
});
