import type { Registry, RuntimeContext, UserOption } from "./registry.js";

/** tabs 分组（供 ctx.askGrouped 与 handler 共用） */
export interface AskGroups {
  title: string;
  options: UserOption[];
}

/**
 * ask_user 工具：让模型在"需要用户输入"时主动询问。
 * 选择 → Select 渲染（全向键）；文本 → AskInput 渲染；答案作为 tool_result 回灌模型继续。
 * selfGranted：这是工具与用户对话本身，不该再触发一次权限确认。
 * headless（非 TTY / 未注入 UI）：fail-closed 返回"无法询问"，让模型自行权衡。
 */
export function registerAskUserTool(registry: Registry): void {
  registry.register({
    name: "ask_user",
    description:
      "Present an interactive choice or a short text question to the user. " +
      "Use kind='choice' whenever you want the user to PICK from a set of options: " +
      "quizzing them, letting them decide between approaches, or confirming a direction. " +
      "The UI renders the options as a selectable list (and a text input for kind='text'), " +
      "then returns the user's answer so you can continue. " +
      "Prefer this over printing options as plain text when the next step depends on their selection.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask the user" },
        kind: {
          type: "string",
          enum: ["choice", "text", "tabs", "wizard", "wizard_multi"],
          description:
            "choice = pick one option; text = type a value; tabs = tabbed categories; " +
            "wizard = multi-step form, one option per step, with a progress bar and submit review; " +
            "wizard_multi = multi-step form where EACH step allows picking MULTIPLE options (toggle with Enter/Space) (default: choice)",
        },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Step title shown on the progress bar" },
              question: { type: "string", description: "Step question" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    value: { type: "string" },
                    description: { type: "string" },
                  },
                },
              },
            },
          },
          description: "Required when kind=wizard: ordered steps, each with title/question/options",
        },
        groups: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Tab title" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    value: { type: "string" },
                  },
                },
              },
            },
          },
          description: "Required when kind=tabs: groups of options, one tab per group",
        },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Display text" },
              value: { type: "string", description: "Machine value" },
            },
          },
          description: "Required when kind=choice",
        },
      },
      required: ["question"],
    },
    mode: "external",
    selfGranted: true,
    kind: "builtin",
    handler: async (input, ctx: RuntimeContext) => {
      const q = String(input.question ?? "请确认");

      // wizard / wizard_multi：多步向导（进度条 + 每步选择 + Review 提交）
      // wizard_multi 为分步多选：每步可勾选多个选项，结果每步逗号拼接
      if (input.kind === "wizard" || input.kind === "wizard_multi") {
        const multi = input.kind === "wizard_multi";
        const steps = Array.isArray(input.steps)
          ? input.steps.map((s: any) => ({
              title: String(s?.title ?? "步骤"),
              question: String(s?.question ?? s?.title ?? ""),
              options: (Array.isArray(s?.options) ? s.options : []).map((o: any) => ({
                label: String(o?.label ?? o?.value ?? ""),
                value: String(o?.value ?? o?.label ?? ""),
                description: o?.description ? String(o.description) : undefined,
              })),
            }))
          : [];
        if (steps.length === 0) {
          return `（ask_user: kind=${input.kind} 缺少 steps）请提供 steps，或改用 kind=choice。`;
        }
        const result = (await ctx.askWizard?.(q, steps, multi)) ?? "__cancel__";
        if (result === "__cancel__") {
          return "用户取消了向导（未做决定）。请说明情况或重新询问。";
        }
        if (result.startsWith("__chat__")) {
          return `用户没有填写向导，而是补充说明：${result.slice("__chat__".length).trim()}。请据此继续（必要时可再次 ask_user）。`;
        }
        return `用户在向导中的回答：\n${result}`;
      }

      // tabs：分组两级选择（←→ 切 tab，↑↓ 选组内项）
      if (input.kind === "tabs" || input.kind === "grouped") {
        const groups = Array.isArray(input.groups)
          ? input.groups.map((g: any) => ({
              title: String(g?.title ?? ""),
              options: (Array.isArray(g?.options)
                ? g.options
                : []
              ).map((o: any) => ({
                label: String(o?.label ?? o?.value ?? ""),
                value: String(o?.value ?? o?.label ?? ""),
              })),
            }))
          : [];
        if (groups.length === 0) {
          return "（ask_user: kind=tabs 缺少 groups）请提供 groups，或改用 kind=choice 单层选项。";
        }
        const picked = (await ctx.askGrouped?.(q, groups)) ??
          `${groups[0]?.title ?? ""} / ${groups[0]?.options[0]?.label ?? ""}`;
        if (picked === "__cancel__") {
          return "用户取消了本次选择（未做决定）。请向用户简要说明情况，或重新询问。";
        }
        if (picked.startsWith("__chat__")) {
          return `用户没有直接选择，而是补充说明：${picked.slice("__chat__".length).trim()}。请据此继续（必要时可再次 ask_user）。`;
        }
        return `用户选择: ${picked}`;
      }

      if (input.kind === "text" || input.kind === "input") {
        const v = await ctx.askUserText?.(q);
        return v === null || v === undefined
          ? "（无法询问用户：当前环境未提供交互输入，或用户取消了。）请基于已有信息继续；仍缺关键信息时，把缺什么说清楚。"
          : `用户输入: ${v}`;
      }

      const opts =
        Array.isArray(input.options) && input.options.length > 0
          ? input.options.map((o: any) => ({
              label: String(o?.label ?? o?.value ?? ""),
              value: String(o?.value ?? o?.label ?? ""),
            }))
          : [
              { label: "No", value: "no" },
              { label: "Yes", value: "yes" },
            ];
      const chosen = (await ctx.askUser?.(q, opts)) ?? opts[0]?.value ?? "no";
      const picked = opts.find((o) => o.value === chosen);
      // 若被 headless 拒答（返回默认首项）也如实带出，让模型知道未必是真选择
      return `用户选择: ${picked?.label ?? chosen} (${chosen})`;
    },
  });
}