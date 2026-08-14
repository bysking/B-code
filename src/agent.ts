import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages.js";
import { callModel, defaultModel, type ModelInput, type ModelOutput } from "./backend.js";
import { executeTool, toolDefinitions } from "./tools.js";

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

const SYSTEM_CORE = `You are B Code, a small coding assistant CLI.
You help with software engineering tasks using the tools available to you.

# Doing tasks
- Do not propose changes to code you haven't read. Read files first.
- Do not create files unless necessary. Prefer editing existing files.
- Avoid over-engineering. Only make changes that were requested.
- Keep responses short and concise. Lead with the answer.`;

export interface AgentOptions {
  /** 覆盖模型调用（测试注入假后端；也服务于 P2 的 Backend 策略化） */
  callModel?: (input: ModelInput) => Promise<ModelOutput>;
  /** 模型文本的输出口（UI 层注入；测试注入 no-op 避免裸写 stdout 干扰 TAP 协议） */
  print?: (text: string) => void;
}

export class Agent {
  /** 整个对话的唯一状态：消息数组 */
  private messages: MessageParam[] = [];
  public readonly model = defaultModel();
  private readonly call: (input: ModelInput) => Promise<ModelOutput>;
  private readonly print: (text: string) => void;

  constructor(opts: AgentOptions = {}) {
    this.call = opts.callModel ?? callModel;
    this.print = opts.print ?? ((text) => process.stdout.write(text));
  }

  /** 会话历史（P2 会话持久化直接序列化它） */
  history(): MessageParam[] {
    return this.messages;
  }

  /** 处理一次用户输入，可能包含多轮工具调用 */
  async chat(userText: string): Promise<void> {
    this.messages.push({ role: "user", content: userText });

    while (true) {
      const reply = await this.call({
        model: this.model,
        system: SYSTEM_CORE,
        tools: toolDefinitions,
        messages: this.messages,
      });

      // 记录模型完整回复（文本 + 工具调用）
      this.messages.push({ role: "assistant", content: reply.content });

      // 逐块输出模型的文本（接 print 回调，P2 会升级为流式逐字输出）
      for (const b of reply.content) {
        if (b.type === "text" && b.text) this.print(b.text);
      }

      const toolUses = reply.content.filter(
        (b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use",
      );
      if (toolUses.length === 0) break;

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        // 工具调用的进度提示走 print 缝（与模型文本同一条 UI 通道）
        this.print(`  → ${tu.name}(${JSON.stringify(tu.input)})\n`);
        const output = await executeTool(tu.name, (tu.input ?? {}) as Record<string, any>);
        // tool_result 必须关联到对应的 tool_use_id
        results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
      }

      // 工具执行结果作为 user 消息喂回 → 回到循环开头再调模型
      this.messages.push({ role: "user", content: results });
    }
  }
}