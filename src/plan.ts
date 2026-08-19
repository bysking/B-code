import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Registry } from "./registry.js";
import { safeName } from "./utils/paths.js";
import { CRITIC_SYSTEM } from "./subagent.js";

/**
 * Plan Mode 工具（施工图 §10）：只读模式由 permissions 强制，这里提供四个 deferred 工具：
 *   enter_plan_mode / exit_plan_mode —— 运行时切换模式状态机
 *   write_plan —— 把计划写入 {plansDir}（plan 模式下唯一允许的"写"动作）
 *   review_plan —— 派一个独立对抗性审查子 Agent（Plan critic）攻击式审查计划/设计草稿
 *
 * deferred = 默认不发给模型（省 token）；--plan 启动时由 Agent 放开。
 * review_plan 同样 deferred：子 Agent 的工具面（toolsSchema 不带 deferred）看不到它，
 * 天然杜绝"子 Agent 再派子 Agent"的递归。
 */

export interface PlanToolsOptions {
  plansDir: string;
  /** 派发子 Agent 的绑定（内核注入：复用 registry + ctx，handler 拿不到 registry）。
   * review_plan 用它做独立对抗性审查；未注入时工具返回错误而非崩溃。 */
  runSubAgent?: (task: string, system?: string) => Promise<string>;
}

export function registerPlanTools(registry: Registry, opts: PlanToolsOptions): void {
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

  registry.register({
    name: "review_plan",
    description:
      "Dispatch an independent adversarial-review sub-agent (Plan critic) to attack the drafted plan or technical design: " +
      "validate mechanism completeness and hunt for holes (missing steps, edge cases, security, ordering, testability). " +
      "Use when the design is near-final, before committing to implementation. " +
      "Revise the plan according to the report and review again if needed.",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "The plan or technical design to review (markdown text)" },
        focus: {
          type: "string",
          description: "Optional: aspects to stress, e.g. 'security', 'edge cases', 'migration'",
        },
      },
      required: ["plan"],
    },
    mode: "read", // 只读（子 Agent 本身只读）：plan 模式下自动放行
    kind: "builtin",
    deferred: true, // 只放开给主 Agent（plan 模式）；子 Agent 工具面看不到 → 防递归
    handler: async (input) => {
      const plan = String(input.plan ?? "");
      if (!plan.trim()) {
        return "Error: review_plan requires a non-empty 'plan' argument (pass the plan or design text).";
      }
      const critic = opts.runSubAgent;
      if (!critic) {
        return "Error: review_plan is not wired up — no sub-agent runner configured.";
      }
      const focus = input.focus ? String(input.focus) : "";
      const task = [
        focus ? `Adversarial review — focus areas to stress: ${focus}.` : "Adversarial review of the plan below.",
        plan,
      ].join("\n\n");
      return critic(task, CRITIC_SYSTEM);
    },
  });
}