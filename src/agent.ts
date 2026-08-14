import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages.js";
import { callModel, defaultModel, type ModelInput, type ModelOutput } from "./backend.js";
import { executeTool, toolDefinitions } from "./tools.js";
import { buildSystemPrompt } from "./prompt.js";
import { Spinner, type SpinnerLike } from "./ui.js";

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
}

export class Agent {
  /** 整个对话的唯一状态：消息数组 */
  private messages: MessageParam[] = [];
  public readonly model = defaultModel();
  private readonly call: (input: ModelInput) => Promise<ModelOutput>;
  private readonly print: (text: string) => void;
  private readonly spinner: SpinnerLike;

  constructor(opts: AgentOptions = {}) {
    this.call = opts.callModel ?? callModel;
    this.print = opts.print ?? ((text) => process.stdout.write(text));
    this.spinner = opts.spinner ?? new Spinner();
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
    // 动态上下文（cwd/git/CLAUDE.md）在一次 chat 内固定，避免逐轮重复 exec
    const system = buildSystemPrompt();

    while (true) {
      // 模型思考期：转起来；首个文本 token 到达即停（看下面 onText）
      this.spinner.start("thinking…");
      const reply = await this.call({
        model: this.model,
        system,
        tools: toolDefinitions,
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
        // 工具执行期：继续转
        this.spinner.start(`running ${tu.name}…`);
        let output: string;
        try {
          output = await executeTool(tu.name, (tu.input ?? {}) as Record<string, any>);
        } finally {
          this.spinner.stop();
        }
        // tool_result 必须关联到对应的 tool_use_id
        results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
      }

      // 工具执行结果作为 user 消息喂回 → 回到循环开头再调模型
      this.messages.push({ role: "user", content: results });
    }
  }
}