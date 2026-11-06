import type Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import type { MountPoint, Registry, RuntimeContext } from './registry.js';
import { FileStore } from './file-store.js';
import { oneLine, prettyInput } from './utils/format.js';

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

/**
 * 子 Agent 工具面是否可用：只读 + 排除 subagent 类工具。
 *
 * 必须排除 `agent`（kind:'subagent'、mode:'read'）——否则子 Agent 会拿到
 * fork 子 Agent 的能力，模型一旦调用即无限递归套娃。不能靠 deferred 修：
 * deferred 对主 Agent 的 default 模式同样生效，会把 agent 工具从主循环也摘掉。
 */
function subagentUsable(mp: MountPoint | undefined): boolean {
  return mp?.mode === 'read' && mp.kind !== 'subagent';
}

/**
 * 中断哨兵：父级 Esc 后子 Agent 的**正常返回值**（不是抛异常）。
 * 导出成常量是因为调用方要据此判定"这次是跑完了还是被打断"——
 * 写成两处字面量迟早会不同步。
 */
export const SUBAGENT_INTERRUPTED = '(sub-agent interrupted by user)';

/**
 * 逐行播报回调：每完成一步调一次（TUI 收进 Ctrl+O「子 Agent」页；
 * headless/CI 不传即零开销静默）。
 */
export type SubAgentStep = (line: string) => void;

/**
 * 工具结果压成一行摘要——日志每步一行，不搬全文。
 *
 * 按内置工具的返回形态取"一眼最有用的那个数"：
 *   read_file/file_content → 指针行里现成的 `N 行`（最准，不用自己数）
 *   grep_search            → N 处命中 / 无命中
 *   list_files/glob        → N 项
 *   其余（MCP 工具等）      → 首行截断
 */
export function summarizeResult(name: string, output: string): string {
  const pointer = output.match(/📄[^(]*\((\d+) 行/);
  if (pointer) return `${pointer[1]} 行`;
  const body = output.trim();
  if (body === '(no matches)') return name === 'grep_search' ? '无命中' : '无匹配';
  const lines = body === '' ? 0 : body.split('\n').length;
  if (name === 'grep_search') return `${lines} 处命中`;
  if (name === 'list_files' || name === 'glob') return `${lines} 项`;
  // 其余（含 MCP 工具）：取首行——正文首行通常是那句结论/报错，比压平一整段更有用
  const first = body.split('\n').find((l) => l.trim()) ?? '';
  return oneLine(first, 80) || '(空)';
}

export async function runSubAgent(
  task: string,
  ctx: RuntimeContext,
  registry: Registry,
  system: string = SUBAGENT_SYSTEM,
  onStep?: SubAgentStep,
): Promise<string> {
  // 子 agent 用独立 fileStore：它读的文件不污染主模型的新鲜度判断
  // （否则主模型 file_content status_only 会误答 "unchanged"——它根本没读过）。
  // 其余 ctx 字段浅拷贝共享（callModel/askWizard 等只读）。
  const subCtx: RuntimeContext = { ...ctx, fileStore: new FileStore() };
  const messages: MessageParam[] = [{ role: 'user', content: task }];
  // 只给只读工具，且排除 subagent 工具（防子 Agent 再派子 Agent 的无限递归）
  const tools = registry.toolsSchema().filter((t) => subagentUsable(registry.resolve(t.name)));

  while (true) {
    // 硬中断：父级取消（Esc）→ 子 Agent 立即停止，不再发起模型调用
    if (subCtx.signal?.aborted) {
      onStep?.('中断   用户取消（Esc）');
      return SUBAGENT_INTERRUPTED;
    }
    const reply = await subCtx.callModel({
      model: subCtx.model,
      system: [{ type: 'text', text: system }],
      tools,
      messages,
      // 透传取消信号：在飞的模型请求随父级中断一起终止
      ...(subCtx.signal ? { signal: subCtx.signal } : {}),
    });
    messages.push({ role: 'assistant', content: reply.content });

    const textOut = reply.content
      .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const toolUses = reply.content.filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use');
    if (toolUses.length === 0) {
      // 最后一轮：这里的话就是返回值本身，只发 done 行——再发一条 text 行
      // 会让面板把同一句话显示两遍
      onStep?.(`done   ${oneLine(textOut, 100) || '(无输出)'}`);
      return textOut;
    }
    // 中间轮的模型文本：压成一行并截断。全文在最终返回值里交给主模型，
    // 面板要的是"它在往哪个方向想"，不是把转录搬一份
    if (textOut.trim()) onStep?.(`text   ${oneLine(textOut, 100)}`);

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const mp = registry.resolve(tu.name);
      const args = prettyInput(tu.input);
      onStep?.(`tool   ${tu.name}${args ? ` ${args}` : ''}`);
      // 执行路径同样门控：防模型幻觉调用未在工具面出现的 agent/写工具（无权限层，fail-closed）
      const output = subagentUsable(mp)
        ? await mp!.handler((tu.input ?? {}) as Record<string, any>, subCtx)
        : `Denied: the sub-agent is read-only (no writing and no nested sub-agents).`;
      onStep?.(`←      ${summarizeResult(tu.name, output)}`);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: output });
    }
    messages.push({ role: 'user', content: results });
  }
}
