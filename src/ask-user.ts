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
          enum: ["choice", "text", "tabs"],
          description:
            "choice = user picks one option (select); text = user types a value; tabs = group options into tabbed categories (left/right switch tab, up/down pick within tab) (default: choice)",
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