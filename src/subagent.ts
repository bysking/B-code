import type Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import type { Registry, RuntimeContext } from './registry.js';
import { FileStore } from './file-store.js';

/**
 * 子 Agent（施工图 §11）：一个独立的、只读的 Agent 循环。
 *
 * 与主 Agent 的区别：
 *   1. 自己的消息数组（干净上下文，读完即弃）
 *   2. 只给 read 权限的工具（写操作在工具面就断掉）
 *   3. 返回纯文本摘要（不附带中间过程）
 *   4. 进程内同步调用，不 fork 子进程
 *
 * 角色化：第 4 个参数 system 可覆盖默认 explore 提示词——plan 模式的
 * 对抗性审查（CRITIC_SYSTEM，见 plan.ts review_plan）复用同一循环，
 * 只换"人设"。
 *
 * 主循环通过注册的 "agent" 工具调用它——对主循环而言，子 Agent 就是一个
 * "超大参数的工具"。
 */

const SUBAGENT_SYSTEM =
  'You are an explore sub-agent. Investigate read-only and report back a concise summary.';

/** 对抗性审查角色（Plan critic）：对定稿前的计划/设计做独立攻击式审查，找漏洞而非捧场 */
export const CRITIC_SYSTEM = `You are an adversarial reviewer sub-agent (a "Plan critic").
Your job is to attack the given plan or technical design as an independent reviewer —
do NOT rubber-stamp it. Validate mechanism completeness and hunt for holes:

1. Missing pieces: unstated assumptions, unimplemented steps, dangling references.
2. Edge cases & failure modes: empty/null input, races, timeouts, partial failures, retries.
3. Security & safety: injection, privilege escalation, destructive commands, data leaks, permission bypasses.
4. Correctness: wrong order of operations, off-by-one, invalid state transitions, deadlocks.
5. Testability & verification: is each step verifiable? Are acceptance criteria concrete and measurable?
6. Cost & over-engineering: unnecessary complexity, wasted work.

Be specific: cite the offending step or clause, explain why it breaks, and propose a concrete fix.
End with a verdict line: APPROVE (sound) or REVISE (list must-fix issues ordered by severity).`;

export async function runSubAgent(
  task: string,
  ctx: RuntimeContext,
  registry: Registry,
  system: string = SUBAGENT_SYSTEM,
): Promise<string> {
  // 子 agent 用独立 fileStore：它读的文件不污染主模型的新鲜度判断
  // （否则主模型 file_content status_only 会误答 "unchanged"——它根本没读过）。
  // 其余 ctx 字段浅拷贝共享（callModel/askWizard 等只读）。
  const subCtx: RuntimeContext = { ...ctx, fileStore: new FileStore() };
  const messages: MessageParam[] = [{ role: 'user', content: task }];
  // 只给只读工具（模式门控，sub-agent 无权限层）
  const tools = registry.toolsSchema().filter((t) => registry.resolve(t.name)?.mode === 'read');

  while (true) {
    // 硬中断：父级取消（Esc）→ 子 Agent 立即停止，不再发起模型调用
    if (subCtx.signal?.aborted) return '(sub-agent interrupted by user)';
    const reply = await subCtx.callModel({
      model: subCtx.model,
      system: [{ type: 'text', text: system }],
      tools,
      messages,
      // 透传取消信号：在飞的模型请求随父级中断一起终止
      ...(subCtx.signal ? { signal: subCtx.signal } : {}),
    });
    messages.push({ role: 'assistant', content: reply.content });

    const toolUses = reply.content.filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use');
    if (toolUses.length === 0) {
      return reply.content
        .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
        .map((b) => b.text)
        .join('');
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const mp = registry.resolve(tu.name);
      const output =
        mp?.mode === 'read'
          ? await mp.handler((tu.input ?? {}) as Record<string, any>, subCtx)
          : `Denied: the sub-agent is read-only.`;
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: output });
    }
    messages.push({ role: 'user', content: results });
  }
}
