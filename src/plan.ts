import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Registry } from "./registry.js";
import { safeName } from "./utils/paths.js";

/**
 * Plan Mode 工具（施工图 §10）：只读模式由 permissions 强制，这里提供三个 deferred 工具：
 *   enter_plan_mode / exit_plan_mode —— 运行时切换模式状态机
 *   write_plan —— 把计划写入 {plansDir}（plan 模式下唯一允许的"写"动作）
 *
 * deferred = 默认不发给模型（省 token）；--plan 启动时由 Agent 放开。
 */

export function registerPlanTools(registry: Registry, opts: { plansDir: string }): void {
  registry.register({
    name: "enter_plan_mode",
    description:
      "Enter plan mode to switch to a read-only planning phase. Use this before writing a plan.",
    inputSchema: { type: "object", properties: {} },
    mode: "external",
    kind: "builtin",
    deferred: true,
    handler: async (_input, ctx) => {
      ctx.setMode("plan");
      return "Now in plan mode (read-only). You may only read files and write the plan file.";
    },
  });

  registry.register({
    name: "exit_plan_mode",
    description: "Exit plan mode after writing your plan file.",
    inputSchema: { type: "object", properties: {} },
    mode: "external",
    kind: "builtin",
    deferred: true,
    handler: async (_input, ctx) => {
      ctx.setMode("default");
      return "Exited plan mode. You may now make changes, subject to permission checks.";
    },
  });

  registry.register({
    name: "write_plan",
    description: "Write the plan to a markdown file in the plans directory.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short plan title" },
        plan: { type: "string", description: "The full plan in markdown" },
      },
      required: ["title", "plan"],
    },
    mode: "write",
    allowInPlan: true, // plan 模式下唯一放行的写工具
    kind: "builtin",
    deferred: true,
    handler: async (input) => {
      const title = safeName(String(input.title ?? "plan"));
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = join(opts.plansDir, `${stamp}-${title}.md`);
      try {
        mkdirSync(opts.plansDir, { recursive: true });
        writeFileSync(file, `# ${input.title ?? "Plan"}\n\n${input.plan}\n`, "utf-8");
        return `Plan written to ${file}`;
      } catch (err) {
        return `Error writing plan: ${(err as Error).message}`;
      }
    },
  });
}