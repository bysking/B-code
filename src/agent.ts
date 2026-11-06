import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { callModel, defaultModel, estimateTokens, type ModelInput, type ModelOutput } from './backend.js';
import { formatDelay, withRetry, type Sleeper } from './retry.js';
import type { ClipboardImage } from './utils/clipboard.js';
import { registerBuiltinTools } from './tools.js';
import { registerPlanTools } from './plan.js';
import { registerTodoTool, loadTodos, type TodoItem } from './todo.js';
import { CheckpointStore, withCheckpoints } from './checkpoint.js';
import { runSubAgent, SUBAGENT_INTERRUPTED } from './subagent.js';
import { oneLine } from './utils/format.js';
import { FileStore } from './file-store.js';
import {
  loadMcpServers,
  reconnectMcpServer,
  type McpConnectResult,
  type McpHostCapabilities,
} from './mcp.js';
import { Registry, type RuntimeContext, type UserOption } from './registry.js';
import {
  loadDisabled,
  saveDisabled,
  toggleInList,
  mcpDisabledPrefixes,
  type DisabledState,
} from './toggles.js';
import { buildSystemPrompt, type SystemBlock } from './prompt.js';
import {
  truncateResult,
  maybeCompact,
  renderCompaction,
  buildFileIndex,
  contextTokenBudget,
} from './context.js';
import { classifyAction, evaluateGoal, renderTranscript } from './autonomy.js';
import {
  allowlistKey,
  decideExecution,
  loadAllowlist,
  persistAllowlist,
  persistedKey,
  type AllowlistStore,
  type Mode,
} from './permissions.js';
import { recallMemories, registerMemoryTool } from './memory.js';
import { registerAskUserTool } from './ask-user.js';
import { buildSkillDescriptions } from './skills.js';
import { runHooks, type HooksConfig } from './hooks.js';
import { Spinner, type SpinnerLike } from './ui.js';
import { dirs } from './utils/paths.js';
import { log } from './utils/log.js';

/**
 * Agent = 核心循环引擎（施工图 L2 内核，P1 最小版）
 *
 * while(true)：
 *   1. 消息发给模型
 *   2. 模型决定是否调用工具
 *   3. 调了 → 执行工具，结果喂回，回到 1
 *   4. 没调 → 任务完成，退出
 *
 * 决定循环转不转的是模型，不是代码。这就是 Agent 与聊天机器人的分界线。
 */

/** 结构化 UI 事件（TTY 渲染；非 TTY 不注入即不产生） */
export type AgentEvent =
  | { type: 'tools_planned'; tools: { id: string; name: string; input: unknown }[] }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_end'; id: string; name: string; output?: string }
  | { type: 'thinking'; text: string | null }
  | { type: 'stream_end' }
  /** 模型调用开始：busy 行进入 thinking 相位 */
  | { type: 'busy_think' }
  /** busy 行 input token 回填：调用前为估算值，结束后真实值覆盖 */
  | { type: 'busy_tokens'; input_tokens: number }
  /** 模型调用完成的真实 token 用量（落 turn 元信息） */
  | { type: 'usage'; usage: { input_tokens: number; output_tokens: number } }
  /**
   * 子 Agent（`agent` 工具 / review_plan 的对抗审查）的生命周期与逐步日志。
   * id 由 Agent 分配（sa1、sa2…），一个 id 内 start → log* → end 成对出现；
   * role 用来区分人设（explore / plan-critic）。UI 收进 Ctrl+O「子 Agent」页。
   */
  | { type: 'subagent_start'; id: string; role: string; task: string }
  | { type: 'subagent_log'; id: string; line: string }
  | { type: 'subagent_end'; id: string; status: 'done' | 'interrupted'; summary?: string };

/**
 * 该工具是否幂等（重复执行无副作用）——决定失败后能否自动重试。
 *
 * 白名单而非黑名单：新增工具默认不重试（安全侧），确认无副作用后再加进来。
 * - 内置 read 类（read_file / list_files / grep_search / file_content）纯读，安全；
 * - MCP 工具只有显式标了 mode:'read' 的才重试（external 可能带写副作用，不动）；
 * - 子 agent（kind:'subagent'）会跑完整循环、可能已产生写入，不重试；
 * - 写类与 shell（write_file / edit_file / run_shell）绝不自动重试。
 */
function isIdempotentTool(mp: import('./registry.js').MountPoint): boolean {
  if (mp.kind === 'subagent') return false;
  return mp.mode === 'read';
}

/**
 * 回显行里单个字符串参数的展示上限（字符）。
 * 取 80：超出一行（终端常见 80~120 列）就失去"扫一眼知道在干嘛"的价值，
 * 而多出来的内容只会把 live 帧撑高、逼 ink 整屏清屏。
 */
const ECHO_VALUE_MAX = 80;
/** 回显行总长上限：多个参数各 80 字符也可能拼出两三百字符，再兜一层 */
const ECHO_TOTAL_MAX = 200;

/**
 * 把工具 input 压成**单行短摘要**，供 `→ tool(...)` 回显使用。
 *
 * 为什么必须压缩：write_file / edit_file 的 input 里带着整篇文件内容，
 * 直接 `JSON.stringify` 会把几千字符压成一行；终端按宽度折行后可能占几十行，
 * 使 live 帧超过终端行数 → ink 走整屏清屏分支（ESC[2J+3J+H，3J 连 scrollback
 * 一起清），用户向上回看的位置被重置，表现为"突然跳到最底部"。
 *
 * 压缩策略（保留辨识度，丢掉体积）：
 *   - 长字符串 → `"前缀…(+N)"`，能看出是哪个文件/哪段内容，但不占屏；
 *   - 多行文本（含 \n）→ 额外标注行数，比裸截断更有信息量；
 *   - 整体仍超长 → 硬截断，保证绝不会撑爆一屏。
 */
export function compactToolEcho(input: unknown): string {
  const value = input as Record<string, unknown> | null | undefined;
  if (!value || typeof value !== 'object') return '';

  const parts: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    parts.push(`${k}: ${compactValue(v)}`);
  }
  const line = parts.join(', ');
  return line.length > ECHO_TOTAL_MAX
    ? `${line.slice(0, ECHO_TOTAL_MAX)}…(+${line.length - ECHO_TOTAL_MAX})`
    : line;
}

/**
 * 单个参数值的压缩展示。
 *
 * 关键：体积标注（行数/字符数）放在**前缀之前**。若放在后面，超长内容的前缀
 * 会先把整个回显行撑到 ECHO_TOTAL_MAX、把标注挤掉——那段标注恰恰是最有用的
 * 信息（"这是个 400 行文件"比"前 80 字符长啥样"更能判断在干什么）。
 */
function compactValue(v: unknown): string {
  if (typeof v !== 'string') return JSON.stringify(v) ?? String(v);
  // 多行内容（write_file 的 content、edit_file 的 old/new_string）
  const lines = v.split('\n').length;
  if (v.length <= ECHO_VALUE_MAX && lines <= 1) return JSON.stringify(v);
  const prefix = v.slice(0, ECHO_VALUE_MAX).replace(/\n/g, '\\n');
  const unit = lines > 1 ? `${lines} 行 / ${v.length} 字符` : `${v.length} 字符`;
  // 标注在前：即使外层 ECHO_TOTAL_MAX 硬截断，体积信息也一定能留下
  return `<${unit}> "${prefix}…"`;
}

/** 请求输入 token 估算（busy 行实时展示用，非精确）：system + tools + messages 文本估算求和 */
function estimateInputTokens(
  system: SystemBlock[],
  tools: Anthropic.Tool[],
  messages: MessageParam[],
): number {
  let n = 0;
  for (const s of system) n += estimateTokens(s.text ?? '');
  for (const t of tools) {
    n += estimateTokens(`${t.name} ${t.description ?? ''} ${JSON.stringify(t.input_schema ?? {})}`);
  }
  for (const m of messages) {
    if (typeof m.content === 'string') {
      n += estimateTokens(m.content);
    } else {
      for (const b of m.content) {
        if (b.type === 'text') {
          n += estimateTokens(b.text);
        } else if (b.type === 'image') {
          // 图片 token 估算：Anthropic 按像素计费，简化估算 800 token/图
          n += 800;
        } else if (b.type === 'tool_use' || b.type === 'tool_result') {
          n += estimateTokens(JSON.stringify(b));
        }
      }
    }
  }
  return n;
}

export interface AgentOptions {
  /** 覆盖模型调用（测试注入假后端；也服务于 P2 的 Backend 策略化） */
  callModel?: (input: ModelInput) => Promise<ModelOutput>;
  /** 模型文本的输出口（UI 层注入；默认直写，SSE 来一块打一块）。测试注入 no-op 避免裸写 stdout 干扰 TAP */
  print?: (text: string) => void;
  /** loading 指示器；默认真 Spinner（非 TTY 自动静默），测试注入记录型替身 */
  spinner?: SpinnerLike;
  /** confirm 权限询问的回调；默认拒绝（fail-closed：未注入确认能力的调用方不自动放行） */
  askUser?: (question: string) => Promise<boolean>;
  /** 结构化 UI 事件（工具调用 / 流结束 / thinking） */
  events?: (ev: AgentEvent) => void;
  /** 模型询问用户选择（Select 渲染）；缺省 headless：返回默认首项 */
  askChoice?: (question: string, options: UserOption[]) => Promise<string>;
  /** 模型询问用户文本输入（AskInput 渲染）；缺省 headless：返回 null */
  askTextInput?: (question: string) => Promise<string | null>;
  /** 模型询问用户分组两选（TabsSelect 渲染）；缺省 headless：返回默认 "tab / 首项" */
  askGroupedInput?: (question: string, groups: { title: string; options: UserOption[] }[]) => Promise<string>;
  /** 模型询问多步向导（Wizard 渲染）；缺省 headless：返回 "__cancel__"。
   * multi=true 时分步多选：每步可勾选多个选项。 */
  askWizardInput?: (
    question: string,
    steps: { title: string; question: string; options: UserOption[] }[],
    multi?: boolean,
  ) => Promise<string>;
  /** 初始模式：default / plan（只读）/ bypass（--yolo）/ auto */
  mode?: Mode;
  /** 幂等工具重试的退避等待实现（测试注入即时等待，避免真等 10s~2min）；缺省真实 sleep */
  retrySleep?: Sleeper;
  /** 持久化白名单存储（可选）：注入则"记住不再问"跨会话生效；缺省不持久化 */
  allowlistStore?: AllowlistStore;
  /** 结构化待办变更回调（UI 更新任务清单视图） */
  onTodos?: (todos: TodoItem[]) => void;
  /** Hooks 配置（UserPromptSubmit / PreToolUse / PostToolUse）；缺省无 hook */
  hooks?: HooksConfig;
  /** 技能/MCP 启停状态的落盘文件（测试注入临时路径；缺省 settings.json） */
  disabledFile?: string;
}

export class Agent {
  /** 整个对话的唯一状态：消息数组 */
  private messages: MessageParam[] = [];
  /** 当前模型（/model 可在运行时切换） */
  public model = defaultModel();
  /** 模式状态机：default / plan（只读）/ bypass（--yolo） */
  public mode: Mode = 'default';
  private readonly call: (input: ModelInput) => Promise<ModelOutput>;
  private readonly print: (text: string) => void;
  private readonly spinner: SpinnerLike;
  private readonly askUser: (question: string) => Promise<boolean>;
  /** 幂等工具重试的退避等待（缺省真实 sleep；测试注入即时返回） */
  private readonly retrySleep?: Sleeper;
  private readonly events?: (ev: AgentEvent) => void;
  /** 会话级白名单：确认过一次的 shell:<command> / 工具名不再问 */
  private readonly allowlist = new Set<string>();
  /** 持久化白名单存储（可选注入）：CLI 传 settings.json 实现；缺省 null = 不持久化（测试/内嵌安全） */
  private readonly allowlistStore?: AllowlistStore;
  /** 结构化待办（模型自管；启动从项目目录载入，todo_write 更新） */
  private todos: TodoItem[] = [];
  /** 累积 token 用量（跨轮次，供 /cost 展示；usage 事件各轮独立，这里求和） */
  private totalUsage = { input_tokens: 0, output_tokens: 0 };
  /** 模型调用次数（/cost 展示，估算成本用） */
  private modelCallCount = 0;
  /** Hooks 配置（生命周期钩子；缺省空 = 无 hook） */
  private readonly hooks: HooksConfig;
  /** 文件检查点（/rewind 回退 write/edit 前的文件内容） */
  private readonly checkpoints = new CheckpointStore();
  /** 统一注册表（P5 核心）：内置/子Agent/Plan/MCP 全挂这里，循环只认 resolve */
  public readonly registry = new Registry();
  private readonly ctx: RuntimeContext;
  private mcpLoaded = false;
  /** 技能/MCP 启停状态（settings.json 的 disabled 字段；全局持久） */
  private disabled: DisabledState = { skills: [], mcpServers: [] };
  /** 禁用状态落盘位置（可注入便于测试隔离；缺省 settings.json） */
  private readonly disabledFile?: string;

  constructor(opts: AgentOptions = {}) {
    this.call = opts.callModel ?? callModel;
    this.print = opts.print ?? ((text) => process.stdout.write(text));
    this.spinner = opts.spinner ?? new Spinner();
    this.askUser = opts.askUser ?? (async () => false);
    this.retrySleep = opts.retrySleep;
    this.events = opts.events;
    this.mode = opts.mode ?? 'default';
    this.allowlistStore = opts.allowlistStore;
    this.hooks = opts.hooks ?? {};
    this.disabledFile = opts.disabledFile;

    // 载入持久化白名单（settings.json permissions.allow）→ 上次"记住不再问"的授权本次生效
    if (this.allowlistStore) loadAllowlist(this.allowlistStore, this.allowlist);
    // 载入技能/MCP 启停状态 → 上次禁用的本次依然隐身（全局生效）
    this.disabled = loadDisabled(this.disabledFile);
    this.registry.setDisabledPrefixes(mcpDisabledPrefixes(this.disabled));
    // 载入本项目待办清单（跨会话存续）
    this.todos = loadTodos();

    // 能力挂载：内置工具 → Plan 工具 → agent(子 Agent) 工具
    this.ctx = {
      callModel: this.call,
      model: this.model,
      setMode: (m) => this.setMode(m),
      // headless 缺省：选择取默认首项（安全），文本返回 null（无法获取）
      askUser: opts.askChoice ?? (async (_q, options) => options[0]?.value ?? 'no'),
      askUserText: opts.askTextInput ?? (async () => null),
      askGrouped:
        opts.askGroupedInput ??
        (async (_q, groups) => `${groups[0]?.title ?? ''} / ${groups[0]?.options[0]?.label ?? ''}`),
      askWizard: opts.askWizardInput ?? (async () => '__cancel__'),
      // 会话级文件快照缓存：子 agent 用独立 store（subagent.ts 克隆 ctx 时覆盖）
      fileStore: new FileStore(),
    };
    registerBuiltinTools(this.registry);
    registerAskUserTool(this.registry);
    registerMemoryTool(this.registry);
    // 文件检查点接线：write_file / edit_file 执行前记录前像（/rewind 用）
    withCheckpoints(this.registry, this.checkpoints);
    registerTodoTool(this.registry, {
      onTodos: (todos) => {
        this.todos = todos;
        opts.onTodos?.(todos);
      },
    });
    registerPlanTools(this.registry, {
      plansDir: dirs.plansDir(),
      // review_plan 派独立对抗性审查子 Agent：绑定本会话的 registry + ctx（handler 拿不到 registry）
      runSubAgent: (task, system) => this.runTrackedSubAgent('plan-critic', task, system),
    });
    this.registry.register({
      name: 'agent',
      description:
        'Fork a sub-agent to investigate a task read-only and return a concise summary. Use for parallelizable exploration.',
      inputSchema: {
        type: 'object',
        properties: { task: { type: 'string', description: 'The sub-task to investigate' } },
        required: ['task'],
      },
      mode: 'read',
      kind: 'subagent',
      handler: (input) => this.runTrackedSubAgent('explore', String(input.task ?? '')),
    });
  }

  /** 子 Agent 序号：id 形如 sa1、sa2…（UI 按 id 把 start/log/end 归到同一条） */
  private subAgentSeq = 0;

  /**
   * 派子 Agent 并把它内层的每一步转成 UI 事件。
   *
   * 为什么要包一层：`runSubAgent` 是纯内核（不依赖 UI），它只认一个 `onStep(line)`
   * 回调；把它翻成带 id 的结构化事件、并在首尾补 start/end，是 Agent（事件拥有者）
   * 的职责。start 必须在**调用之前**发——否则面板里要等第一次模型调用返回才有条目，
   * 而那一等可能就是十几秒。
   */
  private async runTrackedSubAgent(role: string, task: string, system?: string): Promise<string> {
    const id = `sa${++this.subAgentSeq}`;
    this.events?.({ type: 'subagent_start', id, role, task: oneLine(task, 80) });
    try {
      const summary = await runSubAgent(task, this.ctx, this.registry, system, (line) =>
        this.events?.({ type: 'subagent_log', id, line }),
      );
      // 中断是**正常返回**（哨兵字符串）而不是抛错——状态得据此判，不能靠 catch
      const interrupted = summary.trim() === SUBAGENT_INTERRUPTED;
      this.events?.({
        type: 'subagent_end',
        id,
        status: interrupted ? 'interrupted' : 'done',
        ...(interrupted ? {} : { summary: oneLine(summary, 100) }),
      });
      return summary;
    } catch (err) {
      // 抛错（模型调用失败等）：面板里也得收口，不能让条目永远停在 running
      this.events?.({ type: 'subagent_end', id, status: 'interrupted' });
      throw err;
    }
  }

  /**
   * 宿主侧能力（反向调用：server → client）。
   *
   * 只声明我们真能做的两件事：
   *   - roots：告诉 server 工作区在哪（它就这点信息需求，给工作目录即可）
   *   - sampling：让 server 借用我们的模型跑补全（server 通常没有 LLM 凭证）
   *
   * 刻意**不声明 elicitation**：那是"server 弹窗问用户"，而我们的 UI 已经有一套
   * 完整的交互形态（Wizard/AskInput），让 server 绕过它直接弹表单会绕过权限确认，
   * 也容易打断用户正在做的事。等有明确需求再开。
   */
  private hostCapabilities(cwd: string): McpHostCapabilities {
    return {
      roots: () => [{ uri: `file://${cwd}`, name: cwd.split('/').pop() || cwd }],
      sample: async ({ messages, maxTokens, systemPrompt }) => {
        // 复用本 agent 的模型调用通道（含重试/超时策略），但**不写入会话历史**——
        // 这是 server 借用的旁路调用，混进对话会让上下文莫名其妙。
        const sys: SystemBlock[] = systemPrompt
          ? [{ type: 'text', text: systemPrompt }]
          : buildSystemPrompt({});
        const reply = await this.call({
          model: this.model,
          system: sys,
          messages: messages.map((m) => ({
            role: m.role,
            content:
              typeof m.content === 'string'
                ? m.content
                : ((m.content as any[]).map((b) => (b?.type === 'text' ? b.text : '')).join('') ?? ''),
          })) as MessageParam[],
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
        } as ModelInput);
        return reply.content
          .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
      },
    };
  }

  /** 启动时/首次使用前拉起 MCP 服务器（幂等；失败仅记日志） */
  async initMcp(cwd = process.cwd()): Promise<void> {
    if (this.mcpLoaded) return;
    this.mcpLoaded = true;
    await loadMcpServers(this.registry, cwd, this.hostCapabilities(cwd));
  }

  // ── 能力启停（技能 / MCP）──────────────────────────────────
  //
  // 唯一真源在这里：UI 面板每次重渲染都从 Agent 拉快照，避免两处状态漂移。
  // 变更立即落盘 settings.json（全局生效，跨项目持久）。

  /** 当前禁用状态快照（只读副本，外部改动不影响内部） */
  disabledSnapshot(): DisabledState {
    return { skills: [...this.disabled.skills], mcpServers: [...this.disabled.mcpServers] };
  }

  /** 切换技能启停，返回切换后的 enabled 状态；副作用：落盘 + 不注入后续 prompt */
  toggleSkill(name: string): boolean {
    this.disabled.skills = toggleInList(this.disabled.skills, name);
    this.persistDisabled();
    return !this.disabled.skills.includes(name);
  }

  /**
   * 切换 MCP server 启停，返回切换后的 enabled 状态。
   * 禁用只摘掉 toolsSchema 里的工具，**不杀子进程**（重新启用瞬时生效）。
   */
  toggleMcpServer(name: string): boolean {
    this.disabled.mcpServers = toggleInList(this.disabled.mcpServers, name);
    this.persistDisabled();
    this.applyDisabledToRegistry();
    return !this.disabled.mcpServers.includes(name);
  }

  /** 重连指定 MCP server（面板 R 键）；与启停正交，禁用状态下也能重连 */
  async reconnectMcp(name: string, cwd = process.cwd()): Promise<McpConnectResult> {
    const result = await reconnectMcpServer(this.registry, name, cwd);
    this.applyDisabledToRegistry(); // 重连会重新注册工具，禁用前缀需重新生效
    return result;
  }

  /** 把禁用前缀同步给 registry（工具隐身），并保证禁用项不进入后续 toolsSchema */
  private applyDisabledToRegistry(): void {
    this.registry.setDisabledPrefixes(mcpDisabledPrefixes(this.disabled));
  }

  private persistDisabled(): void {
    saveDisabled(this.disabled, this.disabledFile);
  }

  setMode(mode: Mode): void {
    this.mode = mode;
  }

  /** 运行时切换模型（/model）；同步 ctx.model，子 Agent 等共享方一并生效 */
  setModel(model: string): void {
    if (!model.trim()) return;
    this.model = model.trim();
    this.ctx.model = this.model;
  }

  /** 立即压缩上下文（/compact）：把旧消息摘要替换，保留最近若干条；返回是否发生压缩 */
  async compactNow(): Promise<boolean> {
    const before = this.messages.length;
    this.messages = await this.compactIfNeeded();
    return this.messages.length < before;
  }

  // ── 用户中断（Esc）──────────────────────────────────────
  private interrupted = false;
  private lastInterrupted = false;
  /** 当前 chat 的取消控制器：硬中断时 abort（在飞模型请求/可取消工具立即终止） */
  private abortController: AbortController | null = null;

  /** 请求中断当前 chat：硬中断——立即取消在飞的模型请求与可取消工具（如 run_shell），
   * 同时置边界标记，保证当前步骤落袋后不再发起新一轮 */
  interrupt(): void {
    this.interrupted = true;
    this.abortController?.abort();
  }

  /** chat 结束清理：释放 ctx.signal 与控制器（各出口统一调用） */
  private cleanupAbort(): void {
    this.ctx.signal = undefined;
    this.abortController = null;
  }

  /** AbortError / abort reason → 用户取消：不作为普通接口错误上抛 */
  private isAbortError(err: unknown): boolean {
    if (this.abortController?.signal.aborted) return true;
    return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
  }

  /** 最近一次 chat 是否因用户中断而（提前）结束 */
  get interruptedByUser(): boolean {
    return this.lastInterrupted;
  }

  /** 面向 eval/classify 的脱敏对话记录（tool 细节不展开） */
  transcriptText(): string {
    return renderTranscript(this.messages);
  }

  /**
   * 追逐目标（施工图 §13.3）：执行 → 评估 → 未达成则原因回灌 → 再执行，最多 5 轮。
   * 评估器是独立模型调用（不带工具），原因回灌给主模型继续干活。
   */
  /**
   * 追目标直到达成/判定不可能/轮次耗尽。
   *
   * @returns 是否达成。返回布尔而不仅是 void 的原因：调用方（one-shot 的 --goal）
   * 需要在退出码与终端提示里体现结果——UI 画在备用屏里，退出后用户只看得到
   * 补打的那几行，必须把"成没成"写进去。
   */
  async pursueGoal(condition: string, prompt: string, maxRounds = 5): Promise<boolean> {
    await this.chat(prompt);
    for (let round = 0; round < maxRounds; round++) {
      const verdict = await this.evaluateGoal(condition);
      if (verdict.met) {
        log.info(`✓ goal met: ${condition}`);
        return true;
      }
      if (verdict.impossible) {
        log.warn(`goal impossible: ${verdict.reason}`);
        return false;
      }
      log.info(`(goal not met — ${verdict.reason}; continuing)`);
      await this.chat(`The goal "${condition}" is not met yet: ${verdict.reason}. Keep working toward it.`);
    }
    log.warn(`(gave up after ${maxRounds} iterations without meeting: ${condition})`);
    return false;
  }

  private async evaluateGoal(condition: string): Promise<Awaited<ReturnType<typeof evaluateGoal>>> {
    return evaluateGoal(condition, this.transcriptText(), this.model, this.call);
  }

  /** auto 模式动作分类器（写/编辑/shell 放行决策） */
  private async classify(
    name: string,
    input: Record<string, any>,
  ): Promise<Awaited<ReturnType<typeof classifyAction>>> {
    return classifyAction(name, input, this.transcriptText(), this.model, this.call);
  }

  /** 会话历史（P2 会话持久化直接序列化它） */
  history(): MessageParam[] {
    return this.messages;
  }

  /** 累积 token 用量 + 调用次数（/cost 展示） */
  usageTotals(): { input_tokens: number; output_tokens: number; calls: number } {
    return { ...this.totalUsage, calls: this.modelCallCount };
  }

  /** 当前待办清单（只读快照；UI / /todos 展示） */
  todoList(): TodoItem[] {
    return this.todos;
  }

  /** 已记录的文件检查点数（/rewind 前可判断有无可回退内容） */
  checkpointCount(): number {
    return this.checkpoints.size();
  }

  /** 回退本次会话已改动的文件（/rewind）：逆序还原到改动前，返回结果供展示 */
  rewind(): { restored: string[]; deleted: string[] } {
    return this.checkpoints.rewind();
  }

  /** 恢复历史（--resume 用；调用方负责校验是可序列化的合法消息） */
  loadHistory(messages: MessageParam[]): void {
    this.messages = messages;
  }

  clearHistory(): void {
    this.messages = [];
  }

  /** 处理一次用户输入，可能包含多轮工具调用 */
  async chat(userText: string | { text: string; images?: ClipboardImage[] }): Promise<void> {
    this.lastInterrupted = false;
    // 硬中断：本次 chat 的取消控制器（模型请求/可取消工具共享同一 signal）
    this.abortController = new AbortController();
    this.ctx.signal = this.abortController.signal;

    // 构建消息内容：纯文本 → content 字符串；带图片 → content 数组（text + image blocks）
    let text = typeof userText === 'string' ? userText : userText.text;
    const images = typeof userText === 'object' ? userText.images : undefined;

    // UserPromptSubmit hook：发给模型之前。拦截（exit 2）时把原因追加进 prompt，让模型知情；
    // 放行时 stdout 作为附加上下文一并注入。
    if (this.hooks.UserPromptSubmit?.length) {
      const outcome = await runHooks(this.hooks, 'UserPromptSubmit', {
        cwd: process.cwd(),
        prompt: text,
      });
      if (outcome.blocked) {
        text = `${text}\n\n[hook notice: ${outcome.reason}]`;
      } else if (outcome.stdout) {
        text = `${text}\n\n[hook context]\n${outcome.stdout}`;
      }
    }
    if (images && images.length > 0) {
      const content: ContentBlockParam[] = [
        { type: 'text', text },
        ...images.map((img) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: img.media_type, data: img.data },
        })),
      ];
      this.messages.push({ role: 'user', content });
    } else {
      this.messages.push({ role: 'user', content: text });
    }

    // P4：以当前用户输入为 query 做记忆召回 + 技能描述，注入 system 动态块末尾
    // （近因效应让模型优先看到记忆；一次 chat 只召回一次，避免循环内重复 IO）
    const system = buildSystemPrompt({
      memory: recallMemories(text),
      // 被禁用的技能不进上下文（省 token，模型也不会主动推荐）
      skills: buildSkillDescriptions(process.cwd(), new Set(this.disabled.skills)),
    });

    while (true) {
      // 用户中断（Esc）：等当前步骤落袋后在此停住，不发起新一轮（软中断兜底）
      if (this.interrupted) {
        this.interrupted = false;
        this.lastInterrupted = true;
        this.events?.({ type: 'stream_end' });
        this.cleanupAbort();
        break;
      }

      // 调用前估算 input token（实时值），结束后由真实 usage 覆盖
      const tools = this.registry.toolsSchema(this.mode === 'plan');
      let inputTokens = estimateInputTokens(system, tools, this.messages);

      // 上下文管理：估算输入（system+tools+messages）超 token 预算才 LLM 摘要压缩。
      // 以 token 而非条数为触发——1M 窗口下条数无意义（一次大 read 就几十万 token）。
      // 条数触发保留在 maybeCompact 内部作 force=false 兜底。
      if (inputTokens > contextTokenBudget()) {
        this.messages = await this.compactIfNeeded();
        inputTokens = estimateInputTokens(system, tools, this.messages); // 压缩后重估
      }

      // 模型思考期：转起来并贯穿整个调用（含流式输出阶段），调用结束才停——
      // 状态行借此实时展示耗时与 token（参考 Claude Code 的 ✽ Channelling…）
      this.spinner.start('thinking…');
      this.events?.({ type: 'busy_think' });
      this.events?.({ type: 'busy_tokens', input_tokens: inputTokens });
      let reply: ModelOutput;
      try {
        reply = await this.call({
          model: this.model,
          system,
          // P5：tools 由注册表生成（plan 模式放开 deferred 的 plan 工具）
          tools,
          messages: this.messages,
          // 硬中断：用户取消时透传，后端中止在飞请求与流式读取
          signal: this.abortController?.signal,
          // 流式文本直接进 UI；busy 行保持（不在此 stop），调用结束统一清理
          onText: (delta) => this.print(delta),
          // 思考块增量 → thinking 事件（UI 以灰色斜体展示）；spinner 不动
          onThinking: (delta) => this.events?.({ type: 'thinking', text: delta }),
          // 可恢复错误重试：状态行改为提示等待，避免长退避期间看起来像卡死
          onRetry: ({ attempt, delayMs }) =>
            this.spinner.start(`接口异常，${formatDelay(delayMs)}后重试（第 ${attempt} 次）…`),
        });
      } catch (err) {
        this.spinner.stop();
        this.events?.({ type: 'stream_end' });
        // 用户取消（Esc）：不作为普通接口错误上抛，按中断收尾
        if (this.isAbortError(err)) {
          this.interrupted = false;
          this.lastInterrupted = true;
          this.cleanupAbort();
          return;
        }
        this.cleanupAbort();
        throw err;
      }
      // 真实 token 用量：落 turn 元信息 + 回填 busy 行（清空前瞬间显示真实值）
      if (reply.usage) {
        this.events?.({ type: 'usage', usage: reply.usage });
        this.events?.({ type: 'busy_tokens', input_tokens: reply.usage.input_tokens });
        // 累积会话总量（/cost 展示）；usage 事件各轮独立，这里求和
        this.totalUsage.input_tokens += reply.usage.input_tokens;
        this.totalUsage.output_tokens += reply.usage.output_tokens;
        this.modelCallCount++;
      }
      // 模型纯工具调用（无文本）时 onText 不触发，这里统一停表
      this.spinner.stop();
      this.events?.({ type: 'stream_end' });

      // 记录模型完整回复（文本 + 工具调用）
      this.messages.push({ role: 'assistant', content: reply.content });

      const toolUses = reply.content.filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use');
      if (toolUses.length === 0) {
        // 正常完成但 Esc 已按下（如纯文本回复）→ 也标记为用户中断（本就不需要继续）
        if (this.interrupted) {
          this.interrupted = false;
          this.lastInterrupted = true;
          this.events?.({ type: 'stream_end' });
        }
        this.cleanupAbort();
        break;
      }

      // 一次性宣布本批工具调用（UI 先全量列表展示，再逐个跑）
      this.events?.({
        type: 'tools_planned',
        tools: toolUses.map((tu) => ({ id: tu.id, name: tu.name, input: tu.input })),
      });

      // 执行：read 类（无副作用、无确认门槛）并行；write/shell/external 串行
      // （避免并发副作用 + 多个确认框竞争；MCP 长任务也走串行，日志有序）。
      // 结果仍按原 toolUses 顺序收集，tool_result 与 tool_use 一一对应。
      const reads: {
        tu: Anthropic.ToolUseBlockParam;
        mp?: import('./registry.js').MountPoint;
        input: Record<string, any>;
      }[] = [];
      const others: typeof reads = [];
      for (const tu of toolUses) {
        const mp = this.registry.resolve(tu.name);
        const input = (tu.input ?? {}) as Record<string, any>;
        (mp?.mode === 'read' ? reads : others).push({ tu, mp, input });
      }

      const outputById = new Map<string, string>();
      const runOne = async (
        tu: Anthropic.ToolUseBlockParam,
        mp: import('./registry.js').MountPoint | undefined,
        input: Record<string, any>,
      ): Promise<void> => {
        // 工具调用的进度提示走 print 缝（与模型文本同一条 UI 通道）。
        // 必须截断：write_file/edit_file 的 input 里带着**整篇文件内容**，
        // 原样打印会变成一行几千字符的长文本，按终端宽度折成几十行 →
        // live 帧超过终端行数 → ink 整屏清屏（ESC[3J 连 scrollback 一起清），
        // 用户向上回看的位置被直接重置。见 compactToolEcho。
        this.print(`  → ${tu.name}(${compactToolEcho(tu.input)})\n`);
        if (!mp) {
          // P5：循环唯一入口 = registry.resolve；未注册工具 fail-closed 拒绝
          outputById.set(tu.id, `Unknown tool: ${tu.name}`);
          return;
        }
        const decision = await decideExecution(mp, input, {
          mode: this.mode,
          allowlist: this.allowlist,
          classify: (n, i) => this.classify(n, i),
          askUser: (q) => {
            this.spinner.stop(); // 确认前停表，别转着问
            return this.askUser(q);
          },
        });
        if (!decision.allow) {
          outputById.set(tu.id, decision.reason ?? 'Denied');
          return;
        }
        // 确认通过 → 记入会话白名单（本次立即免问）+ 持久化白名单（下次启动仍免问）
        if (decision.remember) {
          this.allowlist.add(allowlistKey(mp, input));
          if (this.allowlistStore) {
            persistAllowlist(this.allowlistStore, persistedKey(mp, input));
          }
        }
        // PreToolUse hook：权限通过后、执行前最后一道闸（可拦截）。拦截则结果回给模型。
        if (this.hooks.PreToolUse?.length) {
          const outcome = await runHooks(
            this.hooks,
            'PreToolUse',
            { cwd: process.cwd(), tool_name: mp.name, tool_input: input },
            mp.name,
          );
          if (outcome.blocked) {
            outputById.set(tu.id, `Blocked by PreToolUse hook: ${outcome.reason}`);
            return;
          }
        }
        outputById.set(tu.id, await this.execTool(tu.id, mp, input));
      };

      // 并行批：read 工具互不干扰，整体耗时 ≈ 最慢者
      await Promise.all(reads.map((r) => runOne(r.tu, r.mp, r.input)));
      // 串行批：逐个执行
      for (const r of others) await runOne(r.tu, r.mp, r.input);

      // 按原顺序组装 tool_result（必须关联到对应的 tool_use_id）
      const results: Anthropic.ToolResultBlockParam[] = toolUses.map((tu) => ({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: outputById.get(tu.id) ?? '(missing output)',
      }));

      // 工具执行结果作为 user 消息喂回 → 回到循环开头再调模型
      this.messages.push({ role: 'user', content: results });
    }
  }

  /** 并发执行的活跃工具数：并行 read 时只有首个 start、最后一个 stop，busy 行不乱跳 */
  private activeTools = 0;

  /** 执行工具（spinner + 结果截断 Tier 0 + 异常兜底） */
  private async execTool(
    id: string,
    mp: import('./registry.js').MountPoint,
    input: Record<string, any>,
  ): Promise<string> {
    this.activeTools++;
    if (this.activeTools === 1) this.spinner.start(`running ${mp.name}…`);
    this.events?.({ type: 'tool_start', id, name: mp.name, input });
    // 实时日志接线：长任务（run_shell 等）逐行转发到 print（"⤷" 前缀，与工具提示同通道）
    const prevOnToolOutput = this.ctx.onToolOutput;
    this.ctx.onToolOutput = (line: string) => this.print(`  ⤷ ${line}`);
    let output: string;
    try {
      // 幂等工具失败才自动重试：读文件/搜索/列目录/MCP 读资源重复执行无副作用。
      // 写文件/改文件/run_shell 不重试——请求可能已生效但响应丢失，重跑会写两遍/执行两遍。
      const raw = isIdempotentTool(mp)
        ? await withRetry(() => Promise.resolve(mp.handler(input, this.ctx)), {
            signal: this.ctx.signal,
            ...(this.retrySleep ? { sleep: this.retrySleep } : {}),
            onRetry: ({ delayMs }) => this.print(`  ⤷ ${mp.name} 失败，${formatDelay(delayMs)}后重试\n`),
          })
        : await mp.handler(input, this.ctx);
      // 空输出统一标记：模型看到 "(empty output)" 知道工具执行完毕、只是没产出，
      // 不会误判为"没执行/还在跑"而重复调用
      output = raw == null || String(raw).trim() === '' ? '(empty output)' : String(raw);
    } catch (err) {
      // handler 抛错（如 MCP server 掉线）不炸循环：转为结果喂回模型
      output = `Error: ${mp.name} failed: ${(err as Error).message}`;
    } finally {
      this.ctx.onToolOutput = prevOnToolOutput;
      this.activeTools--;
      if (this.activeTools === 0) this.spinner.stop();
    }

    // PostToolUse hook：工具执行后。stdout 作为附加上下文追加到工具结果（不拦截，仅增强）。
    if (this.hooks.PostToolUse?.length) {
      const outcome = await runHooks(
        this.hooks,
        'PostToolUse',
        { cwd: process.cwd(), tool_name: mp.name, tool_input: input, tool_output: output },
        mp.name,
      );
      if (outcome.stdout) output = `${output}\n\n[PostToolUse hook]\n${outcome.stdout}`;
    }

    // output 随事件透传给 UI（Ctrl+O 面板可回看）；返回给模型的是截断后的结果
    const truncated = truncateResult(output);
    this.events?.({ type: 'tool_end', id, name: mp.name, output: truncated });
    return truncated;
  }

  /** 上下文压缩（Tier 4 摘要）：超阈值把旧消息摘要替换，保留最近 KEEP_RECENT 条。
   * 由调用方按 token 预算决定是否压缩，这里 force=true 跳过条数兜底。 */
  private async compactIfNeeded(): Promise<MessageParam[]> {
    return maybeCompact(
      this.messages,
      async (older) => {
        // 压缩专用渲染：read_file 全文裁剪为指针行（文件字节不进摘要输入，
        // 不靠 renderTranscript 的占位符丢弃），再喂 LLM 摘要
        const transcript = renderCompaction(older, this.ctx.fileStore);
        const out = await this.call({
          model: this.model,
          system: [
            {
              type: 'text',
              text: 'Summarize the conversation so far in a few sentences, keeping key facts.',
            },
          ],
          tools: [],
          messages: [{ role: 'user', content: transcript }],
          // 压缩同样走重试：必须能响应 Esc，否则退避期间（最长约 3 分钟）无法中断
          signal: this.abortController?.signal,
        });
        const summary = out.content
          .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
          .map((b) => b.text)
          .join('');
        // 确定性追加已读文件索引：摘要模型自觉之外的双保险，模型据此知道可用的已读资源
        const index = this.ctx.fileStore ? buildFileIndex(this.ctx.fileStore) : '';
        log.info(`(compacted ${older.length} messages into a summary)`);
        return summary + index;
      },
      true, // force：调用方已按 token 预算决定，跳过条数兜底
    );
  }
}
