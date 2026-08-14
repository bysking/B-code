import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages.js";
import { callModel, defaultModel, type ModelInput, type ModelOutput } from "./backend.js";
import { registerBuiltinTools } from "./tools.js";
import { registerPlanTools } from "./plan.js";
import { runSubAgent } from "./subagent.js";
import { loadMcpServers } from "./mcp.js";
import { Registry, type RuntimeContext } from "./registry.js";
import { buildSystemPrompt } from "./prompt.js";
import { truncateResult, maybeCompact } from "./context.js";
import { allowlistKey, checkPermission, type Mode } from "./permissions.js";
import { recallMemories } from "./memory.js";
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

export interface AgentOptions {
  /** 覆盖模型调用（测试注入假后端；也服务于 P2 的 Backend 策略化） */
  callModel?: (input: ModelInput) => Promise<ModelOutput>;
  /** 模型文本的输出口（UI 层注入；默认直写，SSE 来一块打一块）。测试注入 no-op 避免裸写 stdout 干扰 TAP */
  print?: (text: string) => void;
  /** loading 指示器；默认真 Spinner（非 TTY 自动静默），测试注入记录型替身 */
  spinner?: SpinnerLike;
  /** confirm 权限询问的回调；默认拒绝（fail-closed：未注入确认能力的调用方不自动放行） */
  askUser?: (question: string) => Promise<boolean>;
  /** 初始模式：default / plan（只读）/ bypass（--yolo） */
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
    this.mode = opts.mode ?? "default";

    // 能力挂载：内置工具 → Plan 工具 → agent(子 Agent) 工具
    this.ctx = {
      callModel: this.call,
      model: this.model,
      setMode: (m) => this.setMode(m),
    };
    registerBuiltinTools(this.registry);
    registerPlanTools(this.registry, { plansDir: dirs.plansDir() });
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
    this.messages.push({ role: "user", content: userText });

    // P4：以当前用户输入为 query 做记忆召回 + 技能描述，注入 system 动态块末尾
    // （近因效应让模型优先看到记忆；一次 chat 只召回一次，避免循环内重复 IO）
    const system = buildSystemPrompt({
      memory: recallMemories(userText),
      skills: buildSkillDescriptions(),
    });

    while (true) {
      // 上下文管理：消息超阈值先 LLM 摘要压缩（内部一次独立模型调用）
      this.messages = await this.compactIfNeeded();

      // 模型思考期：转起来；首个文本 token 到达即停（看下面 onText）
      this.spinner.start("thinking…");
      const reply = await this.call({
        model: this.model,
        system,
        // P5：tools 由注册表生成（plan 模式放开 deferred 的 plan 工具）
        tools: this.registry.toolsSchema(this.mode === "plan"),
        messages: this.messages,
        // 流式文本直接进 UI；首个 delta 到达意味着模型已出字，停 spinner
        onText: (delta) => {
          this.spinner.stop();
          this.print(delta);
        },
      });
      // 模型纯工具调用（无文本）时 onText 不触发，这里兜底停表
      this.spinner.stop();

      // 记录模型完整回复（文本 + 工具调用）
      this.messages.push({ role: "assistant", content: reply.content });

      const toolUses = reply.content.filter(
        (b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use",
      );
      if (toolUses.length === 0) break;

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        // 工具调用的进度提示走 print 缝（与模型文本同一条 UI 通道）
        this.print(`  → ${tu.name}(${JSON.stringify(tu.input)})\n`);
        const input = (tu.input ?? {}) as Record<string, any>;

        // P5：循环唯一入口 = registry.resolve；未注册工具 fail-closed 拒绝
        const mp = this.registry.resolve(tu.name);
        let output: string;

        if (!mp) {
          output = `Unknown tool: ${tu.name}`;
        } else {
          // ⑥ 权限检查：deny → 拦截；confirm → 问用户（bypass 跳过）
          const permission = checkPermission(mp, input, this.mode);

          if (permission === "deny") {
            output = `Denied: ${tu.name} was blocked by the permission system.`;
          } else if (permission === "confirm" && this.mode !== "bypass") {
            const key = allowlistKey(mp, input);
            if (this.allowlist.has(key)) {
              output = await this.execTool(mp, input);
            } else {
              this.spinner.stop(); // 确认前停表，别转着问
              const label = mp.mode === "shell" ? String(input.command ?? "") : mp.name;
              const ok = await this.askUser(`Allow ${label}? (y/n)`);
              if (ok) {
                this.allowlist.add(key);
                output = await this.execTool(mp, input);
              } else {
                output = `Denied: user rejected ${mp.name}.`;
              }
            }
          } else {
            output = await this.execTool(mp, input);
          }
        }

        // tool_result 必须关联到对应的 tool_use_id
        results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
      }

      // 工具执行结果作为 user 消息喂回 → 回到循环开头再调模型
      this.messages.push({ role: "user", content: results });
    }
  }

  /** 执行工具（spinner + 结果截断 Tier 0 + 异常兜底） */
  private async execTool(
    mp: import("./registry.js").MountPoint,
    input: Record<string, any>,
  ): Promise<string> {
    this.spinner.start(`running ${mp.name}…`);
    try {
      const raw = await mp.handler(input, this.ctx);
      // 空输出统一标记：模型看到 "(empty output)" 知道工具执行完毕、只是没产出，
      // 不会误判为"没执行/还在跑"而重复调用
      const text = raw == null || String(raw).trim() === "" ? "(empty output)" : String(raw);
      return truncateResult(text);
    } catch (err) {
      // handler 抛错（如 MCP server 掉线）不炸循环：转为结果喂回模型
      return `Error: ${mp.name} failed: ${(err as Error).message}`;
    } finally {
      this.spinner.stop();
    }
  }

  /** 上下文压缩（Tier 4 摘要）：超阈值把旧消息摘要替换，保留最近 KEEP_RECENT 条 */
  private async compactIfNeeded(): Promise<MessageParam[]> {
    return maybeCompact(this.messages, async (older) => {
      const transcript = older
        .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : "[tool call / result]"}`)
        .join("\n");
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
      log.info(`(compacted ${older.length} messages into a summary)`);
      return summary;
    });
  }
}