import { test } from "node:test";
import assert from "node:assert/strict";
import { AppController } from "../src/ui/controller.js";

test("streamText：首个 delta 开 assistant turn，后续追加，finishStream 停流", () => {
  const c = new AppController();
  c.pushUser("hi");
  c.streamText("你");
  c.streamText("好");
  assert.equal(c.turns.length, 2);
  const t = c.turns[1]!;
  assert.equal(t.role, "assistant");
  assert.equal(t.streaming, true);
  assert.equal(t.text, "你好");
  c.finishStream();
  assert.equal(c.turns[1]?.streaming, false);
});

test("toolStart/toolEnd：挂到当前 assistant turn，输入截断显示", () => {
  const c = new AppController();
  c.toolStart("read_file", { file_path: "a".repeat(200) });
  const t = c.turns.at(-1)!;
  assert.equal(t.role, "assistant");
  assert.equal(t.tools[0]?.name, "read_file");
  assert.equal(t.tools[0]?.done, false);
  assert.ok((t.tools[0]?.input?.length ?? 0) <= 80, "长输入被截断");
  c.toolEnd("read_file");
  assert.equal(t.tools[0]?.done, true);
});

test("ask/resolveAsk：promise 交付答案并清空状态", async () => {
  const c = new AppController();
  const p = c.ask("Allow?", [{ label: "No", value: "no" }, { label: "Yes", value: "yes" }]);
  assert.ok(c.askState);
  c.resolveAsk("yes");
  assert.equal(await p, "yes");
  assert.equal(c.askState, null);
});

test("slash 开合与查询", () => {
  const c = new AppController();
  c.openSlash("com");
  assert.equal(c.slashOpen, true);
  assert.equal(c.slashQuery, "com");
  c.closeSlash();
  assert.equal(c.slashOpen, false);
  assert.equal(c.slashQuery, "");
});

test("clearAll 重置对话与输出，busy 归零", () => {
  const c = new AppController();
  c.pushUser("x");
  c.streamText("y");
  c.pushOutput("(resumed 2)");
  c.setBusy("thinking…");
  c.clearAll();
  assert.equal(c.turns.length, 0);
  assert.equal(c.output.length, 0);
  assert.equal(c.busy, null);
});

test("subscribe：每次变更触发一次，返回退订可用", () => {
  const c = new AppController();
  let count = 0;
  const off = c.subscribe(() => count++);
  c.pushUser("a");
  off();
  c.pushUser("b");
  assert.equal(count, 1);
});