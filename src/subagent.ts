import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages.js";
import type { Registry, RuntimeContext } from "./registry.js";

/**
 * 子 Agent（施工图 §11）：一个独立的、只读的 Agent 循环。
 *
 * 与主 Agent 的区别：
 *   1. 自己的消息数组（干净上下文，读完即弃）
 *   2. 只给 read 权限的工具（写操作在工具面就断掉）
 *   3. 返回纯文本摘要（不附带中间过程）
 *   4. 进程内同步调用，不 fork 子进程
 *
 * 主循环通过注册的 "agent" 工具调用它——对主循环而言，子 Agent 就是一个
 * "超大参数的工具"。
 */

const SUBAGENT_SYSTEM =
  "You are an explore sub-agent. Investigate read-only and report back a concise summary.";

export async function runSubAgent(
  task: string,
  ctx: RuntimeContext,
  registry: Registry,
): Promise<string> {
  const messages: MessageParam[] = [{ role: "user", content: task }];
  // 只给只读工具（模式门控，sub-agent 无权限层）
  const tools = registry.toolsSchema().filter((t) => registry.resolve(t.name)?.mode === "read");

  while (true) {
    const reply = await ctx.callModel({
      model: ctx.model,
      system: [{ type: "text", text: SUBAGENT_SYSTEM }],
      tools,
      messages,
    });
    messages.push({ role: "assistant", content: reply.content });

    const toolUses = reply.content.filter(
      (b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use",
    );
    if (toolUses.length === 0) {
      return reply.content
        .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
        .map((b) => b.text)
        .join("");
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const mp = registry.resolve(tu.name);
      const output =
        mp?.mode === "read"
          ? await mp.handler((tu.input ?? {}) as Record<string, any>, ctx)
          : `Denied: the sub-agent is read-only.`;
      results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }
}