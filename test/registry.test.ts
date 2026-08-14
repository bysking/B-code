import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Registry, type RuntimeContext } from "../src/registry.js";
import { registerBuiltinTools } from "../src/tools.js";
import { registerPlanTools } from "../src/plan.js";
import { dirs } from "../src/utils/paths.js";

const ctx = {} as RuntimeContext;

test("register/resolve/list 基本行为", () => {
  const r = new Registry();
  r.register({ name: "a", description: "d", inputSchema: {}, handler: () => "A" });
  r.register({ name: "b", description: "d", inputSchema: {}, handler: () => "B" });
  assert.equal(r.resolve("a")?.name, "a");
  assert.equal(r.resolve("nope"), undefined);
  assert.equal(r.list().length, 2);
});

test("内置工具经注册表可见齐备（6 个）", () => {
  const r = new Registry();
  registerBuiltinTools(r);
  assert.equal(r.list().length, 6);
  assert.equal(r.resolve("read_file")?.mode, "read");
  assert.equal(r.resolve("run_shell")?.mode, "shell");
  assert.equal(r.resolve("write_file")?.mode, "write");
});

test("toolsSchema：deferred 默认排除，includeDeferred 放开", () => {
  const r = new Registry();
  registerBuiltinTools(r);
  registerPlanTools(r, { plansDir: dirs.plansDir() });
  const normal = r.toolsSchema(false).map((t) => t.name);
  assert.ok(!normal.includes("write_plan"), "deferred 工具不发给模型");
  assert.ok(normal.includes("read_file"));

  const withPlan = r.toolsSchema(true).map((t) => t.name);
  assert.ok(withPlan.includes("write_plan"), "plan 模式放开 deferred");
});

test("handler 经注册表可执行（read_file 完整路径）", async () => {
  const r = new Registry();
  registerBuiltinTools(r);
  const mp = r.resolve("read_file");
  assert.ok(mp);
  const here = fileURLToPath(import.meta.url);
  const out = await mp.handler({ file_path: here }, ctx);
  assert.ok(String(out).includes("register/resolve/list"));
});