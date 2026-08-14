import type Anthropic from "@anthropic-ai/sdk";
import type { ModelInput, ModelOutput } from "./backend.js";
import type { Mode } from "./permissions.js";

/**
 * 统一注册表（施工图 §2.4.3 —— 架构可扩展性的核心）
 *
 * 一切能力（内置工具 / MCP工具 / 子 Agent / Plan 工具）都收敛为 MountPoint：
 *   name + description + inputSchema + handler + mode。
 * 内核（Agent 循环）对注册表**只读**，唯一入口就是 resolve()。
 * 新增能力 = 实现接口 + register 一行，循环代码一行不改。
 */

export type ToolMode = "read" | "write" | "shell" | "external";

export interface RuntimeContext {
  callModel: (input: ModelInput) => Promise<ModelOutput>;
  model: string;
  /** 供 plan 模式工具切换当前模式状态机 */
  setMode(mode: Mode): void;
}

export interface MountPoint {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(input: Record<string, any>, ctx: RuntimeContext): Promise<string> | string;
  kind?: "builtin" | "mcp" | "subagent";
  /** 权限层用：read 放行 / write·shell 需确认 / shell 走危险检测 / external 归类 */
  mode?: ToolMode;
  /** 默认不发给模型（省 token）；plan 模式等需要时放开 */
  deferred?: boolean;
  /** plan（只读）模式下仍允许执行（如 write_plan 写自己的计划文件） */
  allowInPlan?: boolean;
}

export class Registry {
  private mountPoints = new Map<string, MountPoint>();

  register(mp: MountPoint): void {
    this.mountPoints.set(mp.name, mp);
  }

  resolve(name: string): MountPoint | undefined {
    return this.mountPoints.get(name);
  }

  list(filter?: (mp: MountPoint) => boolean): MountPoint[] {
    const all = [...this.mountPoints.values()];
    return filter ? all.filter(filter) : all;
  }

  /** 模型可见的工具 schema（deferred 默认排除；includeDeferred 供 plan 等模式放开） */
  toolsSchema(includeDeferred = false): Anthropic.Tool[] {
    return this.list(
      (mp) => (mp.deferred ? includeDeferred : true),
    ).map((mp) => ({
      name: mp.name,
      description: mp.description,
      input_schema: mp.inputSchema as Anthropic.Tool.InputSchema,
    }));
  }
}