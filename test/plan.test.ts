import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry, type RuntimeContext } from "../src/registry.js";
import { registerBuiltinTools } from "../src/tools.js";
import { registerPlanTools } from "../src/plan.js";
import { dirs } from "../src/utils/paths.js";

const ctx = {} as RuntimeContext;

function registryWithPlan(runSubAgent?: (task: string, system?: string) => Promise<string>): Registry {
  const r = new Registry();
  registerBuiltinTools(r);
  registerPlanTools(r, { plansDir: dirs.plansDir(), runSubAgent });
  return r;
}

test("review_plan 注册：deferred read 工具，默认不发给模型、plan 模式放开", () => {
  const r = registryWithPlan();
  const mp = r.resolve("review_plan");
  assert.ok(mp, "review_plan 已注册");
  assert.equal(mp.mode, "read", "只读审查：plan 模式自动放行");
  assert.equal(mp.deferred, true, "deferred：子 Agent 工具面看不到 → 防递归");

  const normal = r.toolsSchema(false).map((t) => t.name);
  assert.ok(!normal.includes("review_plan"), "默认不发给模型");
  const withPlan = r.toolsSchema(true).map((t) => t.name);
  assert.ok(withPlan.includes("review_plan"), "plan 模式放开");
});

test("review_plan handler：注入 runSubAgent 时派发对抗性审查并透传报告", async () => {
  let receivedTask = "";
  let receivedSystem = "";
  const r = registryWithPlan(async (task, system) => {
    receivedTask = task;
    receivedSystem = system ?? "";
    return "REVISE: step 3 lacks rollback on partial failure";
  });

  const mp = r.resolve("review_plan")!;
  const plan = "1. migrate schema\n2. ship\n3. ???";
  const out = await mp.handler({ plan, focus: "migration" }, ctx);

  assert.ok(String(out).includes("REVISE"), "透传审查报告");
  assert.ok(receivedTask.includes(plan), "审查任务携带计划全文");
  assert.ok(receivedTask.includes("migration"), "focus 注入审查任务");
  assert.ok(receivedSystem.includes("adversarial reviewer"), "使用 Plan critic 人设");
});

test("review_plan handler：空 plan / 未注入 runner 时返回错误而非崩溃", async () => {
  // 未注入 runSubAgent（测试/降级场景）
  const r1 = registryWithPlan();
  const mp1 = r1.resolve("review_plan")!;
  const out1 = await mp1.handler({ plan: "do the thing" }, ctx);
  assert.ok(String(out1).includes("not wired up"));

  // 空 plan
  const r2 = registryWithPlan(async () => "n/a");
  const mp2 = r2.resolve("review_plan")!;
  const out2 = await mp2.handler({ plan: "   " }, ctx);
  assert.ok(String(out2).includes("non-empty 'plan'"));
});
