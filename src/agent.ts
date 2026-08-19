import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages.js";
import {
  callModel,
  defaultModel,
  estimateTokens,
  type ModelInput,
  type ModelOutput,
} from "./backend.js";
import { registerBuiltinTools } from "./tools.js";
import { registerPlanTools } from "./plan.js";
import { runSubAgent } from "./subagent.js";
import { FileStore } from "./file-store.js";
import { loadMcpServers } from "./mcp.js";
import { Registry, type RuntimeContext, type UserOption } from "./registry.js";
import { buildSystemPrompt, type SystemBlock } from "./prompt.js";
import { truncateResult, maybeCompact, renderCompaction, buildFileIndex, contextTokenBudget } from "./context.js";
import { classifyAction, evaluateGoal, renderTranscript } from "./autonomy.js";
import { allowlistKey, decideExecution, type Mode } from "./permissions.js";
import { recallMemories, registerMemoryTool } from "./memory.js";
import { registerAskUserTool } from "./ask-user.js";
import { buildSkillDescriptions } from "./skills.js";
import { Spinner, type SpinnerLike } from "./ui.js";
import { dirs } from "./utils/paths.js";
import { log } from "./utils/log.js";

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
  | { type: "tools_planned"; tools: { id: string; name: string; input: unknown }[] }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; name: string; output?: string }
  | { type: "thinking"; text: string | null }
  | { type: "stream_end" }
  /** 模型调用开始：busy 行进入 thinking 相位 */
  | { type: "busy_think" }
  /** busy 行 input token 回填：调用前为估算值，结束后真实值覆盖 */
  | { type: "busy_tokens"; input_tokens: number }
  /** 模型调用完成的真实 token 用量（落 turn 元信息） */
  | { type: "usage"; usage: { input_tokens: number; output_tokens: number } };

/** 请求输入 token 估算（busy 行实时展示用，非精确）：system + tools + messages 文本估算求和 */
function estimateInputTokens(
  system: SystemBlock[],
  tools: Anthropic.Tool[],
  messages: MessageParam[],
): number {
  let n = 0;
  for (const s of system) n += estimateTokens(s.text ?? "");
  for (const t of tools) {
    n += estimateTokens(`${t.name} ${t.description ?? ""} ${JSON.stringify(t.input_schema ?? {})}`);
  }
  for (const m of messages) {
    n += estimateTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
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
  askGroupedInput?: (
    question: string,
    groups: { title: string; options: UserOption[] }[],
  ) => Promise<string>;
  /** 模型询问多步向导（Wizard 渲染）；缺省 headless：返回 "__cancel__"。
   * multi=true 时分步多选：每步可勾选多个选项。 */
  askWizardInput?: (
    question: string,
    steps: { title: string; question: string; options: UserOption[] }[],
    multi?: boolean,
  ) => Promise<string>;
  /** 初始模式：default / plan（只读）/ bypass（--yolo）/ auto */
  mode?: Mode;
}

export class Agent {
  /** 整个对话的唯一状态：消息数组 */
  private messages: MessageParam[] = [];
  public readonly model = defaultModel();
  /** 模式状态机：default / plan（只读）/ bypass（--yolo） */
  public mode: Mode = "default";
  private readonly call: (input: ModelInput) => Promise<ModelOutput>;
  private readonly print: (text: string) => void;
  private readonly spinner: SpinnerLike;
  private readonly askUser: (question: string) => Promise<boolean>;
  private readonly events?: (ev: AgentEvent) => void;
  /** 会话级白名单：确认过一次的 shell:<command> / 工具名不再问 */
  private readonly allowlist = new Set<string>();
  /** 统一注册表（P5 核心）：内置/子Agent/Plan/MCP 全挂这里，循环只认 resolve */
  public readonly registry = new Registry();
  private readonly ctx: RuntimeContext;
  private mcpLoaded = false;

  constructor(opts: AgentOptions = {}) {
    this.call = opts.callModel ?? callModel;
    this.print = opts.print ?? ((text) => process.stdout.write(text));
    this.spinner = opts.spinner ?? new Spinner();
    this.askUser = opts.askUser ?? (async () => false);
    this.events = opts.events;
    this.mode = opts.mode ?? "default";

    // 能力挂载：内置工具 → Plan 工具 → agent(子 Agent) 工具
    this.ctx = {
      callModel: this.call,
      model: this.model,
      setMode: (m) => this.setMode(m),
      // headless 缺省：选择取默认首项（安全），文本返回 null（无法获取）
      askUser:
        opts.askChoice ??
        (async (_q, options) => options[0]?.value ?? "no"),
      askUserText: opts.askTextInput ?? (async () => null),
      askGrouped: opts.askGroupedInput ?? (async (_q, groups) => `${groups[0]?.title ?? ""} / ${groups[0]?.options[0]?.label ?? ""}`),
      askWizard: opts.askWizardInput ?? (async () => "__cancel__"),
      // 会话级文件快照缓存：子 agent 用独立 store（subagent.ts 克隆 ctx 时覆盖）
      fileStore: new FileStore(),
    };
    registerBuiltinTools(this.registry);
    registerAskUserTool(this.registry);
    registerMemoryTool(this.registry);
    registerPlanTools(this.registry, {
      plansDir: dirs.plansDir(),
      // review_plan 派独立对抗性审查子 Agent：绑定本会话的 registry + ctx（handler 拿不到 registry）
      runSubAgent: (task, system) => runSubAgent(task, this.ctx, this.registry, system),
    });
    this.registry.register({
      name: "agent",
      description:
        "Fork a sub-agent to investigate a task read-only and return a concise summary. Use for parallelizable exploration.",
      inputSchema: {
        type: "object",
        properties: { task: { type: "string", description: "The sub-task to investigate" } },
        required: ["task"],
      },
      mode: "read",
      kind: "subagent",
      handler: (input) => runSubAgent(String(input.task ?? ""), this.ctx, this.registry),
    });
  }

  /** 启动时/首次使用前拉起 MCP 服务器（幂等；失败仅记日志） */
  async initMcp(cwd = process.cwd()): Promise<void> {
    if (this.mcpLoaded) return;
    this.mcpLoaded = true;
    await loadMcpServers(this.registry, cwd);
  }

  setMode(mode: Mode): void {
    this.mode = mode;
  }

  // ── 用户中断（Esc）──────────────────────────────────────
  private interrupted = false;
  private lastInterrupted = false;

  /** 请求中断当前 chat：在循环边界生效（等当前模型/工具步骤落袋后停，不再发起新一轮） */
  interrupt(): void {
    this.interrupted = true;
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
  async pursueGoal(condition: string, prompt: string, maxRounds = 5): Promise<void> {
    await this.chat(prompt);
    for (let round = 0; round < maxRounds; round++) {
      const verdict = await this.evaluateGoal(condition);
      if (verdict.met) {
        log.info(`✓ goal met: ${condition}`);
        return;
      }
      if (verdict.impossible) {
        log.warn(`goal impossible: ${verdict.reason}`);
        return;
      }
      log.info(`(goal not met — ${verdict.reason}; continuing)`);
      await this.chat(
        `The goal "${condition}" is not met yet: ${verdict.reason}. Keep working toward it.`,
      );
    }
    log.warn(`(gave up after ${maxRounds} iterations without meeting: ${condition})`);
  }

  private async evaluateGoal(condition: string): Promise<
    Awaited<ReturnType<typeof evaluateGoal>>
  > {
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

  /** 恢复历史（--resume 用；调用方负责校验是可序列化的合法消息） */
  loadHistory(messages: MessageParam[]): void {
    this.messages = messages;
  }

  clearHistory(): void {
    this.messages = [];
  }

  /** 处理一次用户输入，可能包含多轮工具调用 */
  async chat(userText: string): Promise<void> {
    this.lastInterrupted = false;
    this.messages.push({ role: "user", content: userText });

    // P4：以当前用户输入为 query 做记忆召回 + 技能描述，注入 system 动态块末尾
    // （近因效应让模型优先看到记忆；一次 chat 只召回一次，避免循环内重复 IO）
    const system = buildSystemPrompt({
      memory: recallMemories(userText),
      skills: buildSkillDescriptions(),
    });

    while (true) {
      // 用户中断（Esc）：等当前步骤落袋后在此停住，不发起新一轮（软中断）
      if (this.interrupted) {
        this.interrupted = false;
        this.lastInterrupted = true;
        this.events?.({ type: "stream_end" });
        break;
      }

      // 调用前估算 input token（实时值），结束后由真实 usage 覆盖
      const tools = this.registry.toolsSchema(this.mode === "plan");
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
      this.spinner.start("thinking…");
      this.events?.({ type: "busy_think" });
      this.events?.({ type: "busy_tokens", input_tokens: inputTokens });
      const reply = await this.call({
        model: this.model,
        system,
        // P5：tools 由注册表生成（plan 模式放开 deferred 的 plan 工具）
        tools,
        messages: this.messages,
        // 流式文本直接进 UI；busy 行保持（不在此 stop），调用结束统一清理
        onText: (delta) => this.print(delta),
        // 思考块增量 → thinking 事件（UI 以灰色斜体展示）；spinner 不动
        onThinking: (delta) => this.events?.({ type: "thinking", text: delta }),
      });
      // 真实 token 用量：落 turn 元信息 + 回填 busy 行（清空前瞬间显示真实值）
      if (reply.usage) {
        this.events?.({ type: "usage", usage: reply.usage });
        this.events?.({ type: "busy_tokens", input_tokens: reply.usage.input_tokens });
      }
      // 模型纯工具调用（无文本）时 onText 不触发，这里统一停表
      this.spinner.stop();
      this.events?.({ type: "stream_end" });

      // 记录模型完整回复（文本 + 工具调用）
      this.messages.push({ role: "assistant", content: reply.content });

      const toolUses = reply.content.filter(
        (b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use",
      );
      if (toolUses.length === 0) {
        // 正常完成但 Esc 已按下（如纯文本回复）→ 也标记为用户中断（本就不需要继续）
        if (this.interrupted) {
          this.interrupted = false;
          this.lastInterrupted = true;
          this.events?.({ type: "stream_end" });
        }
        break;
      }

      // 一次性宣布本批工具调用（UI 先全量列表展示，再逐个跑）
      this.events?.({
        type: "tools_planned",
        tools: toolUses.map((tu) => ({ id: tu.id, name: tu.name, input: tu.input })),
      });

      // 执行：read 类（无副作用、无确认门槛）并行；write/shell/external 串行
      // （避免并发副作用 + 多个确认框竞争；MCP 长任务也走串行，日志有序）。
      // 结果仍按原 toolUses 顺序收集，tool_result 与 tool_use 一一对应。
      const reads: { tu: Anthropic.ToolUseBlockParam; mp?: import("./registry.js").MountPoint; input: Record<string, any> }[] = [];
      const others: typeof reads = [];
      for (const tu of toolUses) {
        const mp = this.registry.resolve(tu.name);
        const input = (tu.input ?? {}) as Record<string, any>;
        (mp?.mode === "read" ? reads : others).push({ tu, mp, input });
      }

      const outputById = new Map<string, string>();
      const runOne = async (
        tu: Anthropic.ToolUseBlockParam,
        mp: import("./registry.js").MountPoint | undefined,
        input: Record<string, any>,
      ): Promise<void> => {
        // 工具调用的进度提示走 print 缝（与模型文本同一条 UI 通道）
        this.print(`  → ${tu.name}(${JSON.stringify(tu.input)})\n`);
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
          outputById.set(tu.id, decision.reason ?? "Denied");
          return;
        }
        // 确认通过 → 记入会话白名单，同操作不再问
        if (decision.remember) this.allowlist.add(allowlistKey(mp, input));
        outputById.set(tu.id, await this.execTool(tu.id, mp, input));
      };

      // 并行批：read 工具互不干扰，整体耗时 ≈ 最慢者
      await Promise.all(reads.map((r) => runOne(r.tu, r.mp, r.input)));
      // 串行批：逐个执行
      for (const r of others) await runOne(r.tu, r.mp, r.input);

      // 按原顺序组装 tool_result（必须关联到对应的 tool_use_id）
      const results: Anthropic.ToolResultBlockParam[] = toolUses.map((tu) => ({
        type: "tool_result",
        tool_use_id: tu.id,
        content: outputById.get(tu.id) ?? "(missing output)",
      }));

      // 工具执行结果作为 user 消息喂回 → 回到循环开头再调模型
      this.messages.push({ role: "user", content: results });
    }
  }

  /** 并发执行的活跃工具数：并行 read 时只有首个 start、最后一个 stop，busy 行不乱跳 */
  private activeTools = 0;

  /** 执行工具（spinner + 结果截断 Tier 0 + 异常兜底） */
  private async execTool(
    id: string,
    mp: import("./registry.js").MountPoint,
    input: Record<string, any>,
  ): Promise<string> {
    this.activeTools++;
    if (this.activeTools === 1) this.spinner.start(`running ${mp.name}…`);
    this.events?.({ type: "tool_start", id, name: mp.name, input });
    // 实时日志接线：长任务（run_shell 等）逐行转发到 print（"⤷" 前缀，与工具提示同通道）
    const prevOnToolOutput = this.ctx.onToolOutput;
    this.ctx.onToolOutput = (line: string) => this.print(`  ⤷ ${line}`);
    let output: string | undefined;
    try {
      const raw = await mp.handler(input, this.ctx);
      // 空输出统一标记：模型看到 "(empty output)" 知道工具执行完毕、只是没产出，
      // 不会误判为"没执行/还在跑"而重复调用
      output = raw == null || String(raw).trim() === "" ? "(empty output)" : String(raw);
      return truncateResult(output);
    } catch (err) {
      // handler 抛错（如 MCP server 掉线）不炸循环：转为结果喂回模型
      output = `Error: ${mp.name} failed: ${(err as Error).message}`;
      return output;
    } finally {
      this.ctx.onToolOutput = prevOnToolOutput;
      this.activeTools--;
      if (this.activeTools === 0) this.spinner.stop();
      // output 随事件透传给 UI（Ctrl+O 面板可回看）
      this.events?.({ type: "tool_end", id, name: mp.name, output });
    }
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
            type: "text",
            text: "Summarize the conversation so far in a few sentences, keeping key facts.",
          },
        ],
        tools: [],
        messages: [{ role: "user", content: transcript }],
      });
      const summary = out.content
        .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
        .map((b) => b.text)
        .join("");
      // 确定性追加已读文件索引：摘要模型自觉之外的双保险，模型据此知道可用的已读资源
      const index = this.ctx.fileStore ? buildFileIndex(this.ctx.fileStore) : "";
      log.info(`(compacted ${older.length} messages into a summary)`);
      return summary + index;
      },
      true, // force：调用方已按 token 预算决定，跳过条数兜底
    );
  }
}