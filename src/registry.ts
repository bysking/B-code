import type Anthropic from '@anthropic-ai/sdk';
import type { ModelInput, ModelOutput } from './backend.js';
import type { Mode } from './permissions.js';
import type { FileStore } from './file-store.js';

/**
 * 统一注册表（施工图 §2.4.3 —— 架构可扩展性的核心）
 *
 * 一切能力（内置工具 / MCP工具 / 子 Agent / Plan 工具）都收敛为 MountPoint：
 *   name + description + inputSchema + handler + mode。
 * 内核（Agent 循环）对注册表**只读**，唯一入口就是 resolve()。
 * 新增能力 = 实现接口 + register 一行，循环代码一行不改。
 */

export type ToolMode = 'read' | 'write' | 'shell' | 'external';

export interface UserOption {
  label: string;
  value: string;
}

export interface RuntimeContext {
  callModel: (input: ModelInput) => Promise<ModelOutput>;
  model: string;
  /** 供 plan 模式工具切换当前模式状态机 */
  setMode(mode: Mode): void;
  /** 询问用户选择（Select 渲染）；headless 环境提供默认拒答实现 */
  askUser?(question: string, options: UserOption[]): Promise<string>;
  /** 询问用户文本输入（AskInput 渲染）；headless 返回 null */
  askUserText?(question: string): Promise<string | null>;
  /** 询问用户分组两选（TabsSelect 渲染：←→切tab，↑↓选组内项）；headless 返回默认 `${tab} / ${label}` */
  askGrouped?(question: string, groups: { title: string; options: UserOption[] }[]): Promise<string>;
  /** 多步向导（Wizard 渲染）；headless 返回 "__cancel__"。
   * multi=true 时分步多选：每步可勾选多个选项，结果每步为逗号拼接文本。 */
  askWizard?(
    question: string,
    steps: { title: string; question: string; options: UserOption[] }[],
    multi?: boolean,
  ): Promise<string>;
  /** 会话级文件快照缓存（read_file/file_content/write/edit 读写）；测试可缺省 */
  fileStore?: FileStore;
  /** 工具执行期间的实时日志回调（run_shell/MCP 等长任务逐行转发；无则忽略） */
  onToolOutput?(line: string): void;
  /** 结构化待办变更回调（todo_write 写入后触发；UI 据此更新任务清单视图） */
  onTodos?(todos: import('./todo.js').TodoItem[]): void;
  /** 硬中断信号：用户取消时 abort——支持取消的工具（如 run_shell）监听它立即终止 */
  signal?: AbortSignal;
}

export interface MountPoint {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(input: Record<string, any>, ctx: RuntimeContext): Promise<string> | string;
  kind?: 'builtin' | 'mcp' | 'subagent';
  /** 权限层用：read 放行 / write·shell 需确认 / shell 走危险检测 / external 归类 */
  mode?: ToolMode;
  /** 默认不发给模型（省 token）；plan 模式等需要时放开 */
  deferred?: boolean;
  /** plan（只读）模式下仍允许执行（如 write_plan 写自己的计划文件） */
  allowInPlan?: boolean;
  /** 无条件放行（如 ask_user 这类"与用户对话"的工具，不该再触发一次权限确认） */
  selfGranted?: boolean;
}

export class Registry {
  private mountPoints = new Map<string, MountPoint>();
  /**
   * 被禁用的名字前缀（如 `mcp__github__`）。
   * 命中即在 `list` / `toolsSchema` 里隐身——模型看不到、也不花 token。
   * 用前缀而非整名，是因为 MCP 的禁用粒度是 **server**，而工具名是 `mcp__<server>__<tool>`。
   */
  private disabledPrefixes: string[] = [];

  register(mp: MountPoint): void {
    this.mountPoints.set(mp.name, mp);
  }

  /** 摘除一个挂载点（MCP 重连前清理旧工具，避免 handler 指向死进程） */
  unregister(name: string): void {
    this.mountPoints.delete(name);
  }

  /** 按前缀整体摘除（MCP 断开某 server 时一次性清掉它的全部工具） */
  unregisterByPrefix(prefix: string): string[] {
    const removed: string[] = [];
    for (const name of [...this.mountPoints.keys()]) {
      if (name.startsWith(prefix)) {
        this.mountPoints.delete(name);
        removed.push(name);
      }
    }
    return removed;
  }

  /**
   * 设置禁用前缀。**刻意不影响 resolve()**：
   * 被禁用的工具不会出现在 schema 里，模型无从调用；但历史消息里已经发出的
   * tool_use 仍要能执行——否则"工具突然消失"会让旧会话直接崩掉。
   */
  setDisabledPrefixes(prefixes: readonly string[]): void {
    this.disabledPrefixes = [...prefixes];
  }

  isDisabled(name: string): boolean {
    return this.disabledPrefixes.some((p) => p !== '' && name.startsWith(p));
  }

  resolve(name: string): MountPoint | undefined {
    return this.mountPoints.get(name);
  }

  /** 列出挂载点（禁用项默认排除；includeDisabled 供 /mcp /skills 这类管理视图使用） */
  list(filter?: (mp: MountPoint) => boolean, includeDisabled = false): MountPoint[] {
    let all = [...this.mountPoints.values()];
    if (!includeDisabled) all = all.filter((mp) => !this.isDisabled(mp.name));
    return filter ? all.filter(filter) : all;
  }

  /** 模型可见的工具 schema（deferred 默认排除；includeDeferred 供 plan 等模式放开） */
  toolsSchema(includeDeferred = false): Anthropic.Tool[] {
    return this.list((mp) => (mp.deferred ? includeDeferred : true)).map((mp) => ({
      name: mp.name,
      description: mp.description,
      input_schema: mp.inputSchema as Anthropic.Tool.InputSchema,
    }));
  }
}
