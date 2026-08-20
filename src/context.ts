import { resolve } from 'node:path';
import type { ContextPolicy } from './types.js';
import type { FileSnapshot } from './file-store.js';

/**
 * 上下文管理（施工图 P3 §7）
 *
 * 分级压缩流水线（从最轻到最重）：
 *   Tier 0: truncateResult —— 单次工具输出超 50K 字符截断（头尾各半）
 *   Tier 4: maybeCompact  —— 消息超阈值时用 LLM 把旧消息摘要成一段，保留最近 KEEP_RECENT 条
 *
 * 先实现这两级；Tier 1 预算截断 / Tier 2 裁剪 / Tier 3 空闲微压缩按需后置。
 */

/** 截断策略实现（P7 策略化；未来可加 BudgetContext / SnipContext） */
export class TruncateContext implements ContextPolicy {
  truncate(result: string): string {
    return truncateResult(result);
  }
}

export const MAX_RESULT_CHARS = 50_000;

/** 工具结果截断：保留头尾各半，中间标省略（第一道防线） */
export function truncateResult(result: string): string {
  if (result.length <= MAX_RESULT_CHARS) return result;
  const keepEach = Math.floor((MAX_RESULT_CHARS - 60) / 2);
  return (
    result.slice(0, keepEach) +
    `\n\n[... truncated ${result.length - keepEach * 2} chars ...]\n\n` +
    result.slice(-keepEach)
  );
}

export const COMPACT_THRESHOLD = 45; // 条数触发（兜底）：超过 45 条消息触发压缩
export const KEEP_RECENT = 5; // 保留最近 5 条不压缩

/** 模型上下文窗口（token，env 可配：B_CODE_CONTEXT_WINDOW；默认 100 万） */
export const CONTEXT_WINDOW_TOKENS = Number(process.env.B_CODE_CONTEXT_WINDOW ?? '1000000');
/** 估算输入达窗口比例的触发线。40% 留出余量：字符估算偏低 + 压缩摘要调用要读旧消息 */
export const COMPACT_BUDGET_RATIO = 0.4;

/** token 预算触发线 = 窗口 × 比例（1M 窗口 → 40 万 token） */
export function contextTokenBudget(): number {
  return Math.floor(CONTEXT_WINDOW_TOKENS * COMPACT_BUDGET_RATIO);
}

/** 压缩专用渲染所需的最小 store 视图（注入真实 FileStore 或假 store 便于单测） */
export interface CompactionStore {
  get(path: string): FileSnapshot | undefined;
  entries(): [string, FileSnapshot][];
}

/**
 * 压缩时把旧消息渲染给摘要模型（替换 renderTranscript 的压缩用途）。
 *
 * 关键：read_file 的 tool_result 渲染成**指针行**（不泄漏全文），摘要模型
 * 由此知道"读过哪些文件 + hash"，但看不到内容——文件字节不进摘要输入。
 * 按 tool_use_id 配对（tool_use 与 tool_result 必然相邻，maybeCompact 的
 * 切点不变量依赖此），不读内容、不碰内容，零误伤。其余块继承脱敏语义。
 * renderTranscript 本身不动（它是 evaluateGoal/classifyAction 的脱敏层）。
 */
export function renderCompaction(
  messages: { role: string; content: unknown }[],
  store?: CompactionStore,
): string {
  const toolUses = new Map<string, { name: string; filePath?: string }>();
  const lines: string[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      lines.push(`${m.role}: ${m.content}`);
      continue;
    }
    const blocks = m.content as Array<Record<string, any>>;
    const parts: string[] = [];
    for (const b of blocks) {
      if (b?.type === 'tool_use') {
        toolUses.set(b.id, { name: b.name, filePath: b.input?.file_path });
        parts.push(`[tool call ${b.name}]`);
      } else if (b?.type === 'tool_result') {
        const tu = toolUses.get(b.tool_use_id);
        const path = tu?.filePath;
        const snap = path && store ? store.get(resolve(path)) : undefined;
        if (tu?.name === 'read_file' && snap) {
          parts.push(`read ${path} (${snap.content.split('\n').length} 行, hash ${snap.hash})`);
        } else {
          parts.push('[tool result]');
        }
      }
    }
    lines.push(`${m.role}: ${parts.join(' | ')}`);
  }
  return lines.join('\n');
}

/** 确定性"已读文件索引"：追加到摘要末尾，让模型知道可用的已读资源（不依赖摘要模型自觉） */
export function buildFileIndex(store: CompactionStore): string {
  const rows = store.entries().map(([path, snap]) => {
    const lines = snap.content.split('\n').length;
    const state = snap.dirty ? ' (changed since read, re-verify with file_content)' : '';
    return `- ${path}: ${lines} 行, hash ${snap.hash}${state}`;
  });
  return rows.length ? `\n\n# Read files this session\n${rows.join('\n')}` : '';
}

/** user 消息是否为 tool_result 块（其配对 tool_use 必须在前一条 assistant 消息里） */
function isToolResultMessage(m: { role: string; content: unknown }): boolean {
  return (
    m.role === 'user' &&
    Array.isArray(m.content) &&
    m.content.some(
      (b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result',
    )
  );
}

/**
 * 摘要压缩：旧消息 → summarize 回调（调用方提供"渲染+调模型"实现）→ 摘要替换。
 * 注意：tool_use/tool_result 跨消息的配对不能拆散，所以压缩的是整块旧消息，
 * 保留最近消息保证模型能记住最近的上下文。
 *
 * 保留窗口不能以 tool_result 消息开头：它的配对 tool_use 在窗口外，一旦被摘要掉，
 * API 会以 "tool_result block must have a corresponding tool_use in the previous message"
 * 拒绝请求。切点恰好落在 tool_result 上时，把窗口前移一条，把配对的 assistant 一起保留。
 */
export async function maybeCompact<T extends { role: string; content: unknown }>(
  messages: T[],
  summarize: (older: { role: string; content: unknown }[]) => Promise<string>,
  force = false,
): Promise<T[]> {
  // 条数触发（兜底）；force=true 时跳过——由调用方按 token 预算决定压缩
  if (!force && messages.length <= COMPACT_THRESHOLD) return messages;

  let keep = KEEP_RECENT;
  // 循环守卫 keep < messages.length，索引必然有效
  while (keep < messages.length && isToolResultMessage(messages[messages.length - keep]!)) {
    keep += 1; // 切点前移，带上配对的 assistant(tool_use)
  }

  // 消息不足以压缩（全部落在保留窗口，含 force 触发的少消息场景）→ 原样返回
  if (messages.length - keep <= 0) return messages;

  const older = messages.slice(0, messages.length - keep);
  const recent = messages.slice(messages.length - keep);

  const summary = (await summarize(older)).trim();
  if (!summary) return messages; // 摘要失败则保持原样，宁可爆窗也不丢上下文

  const summaryMessage = {
    role: 'user',
    content: `[Summary of earlier conversation]\n${summary}`,
  } as unknown as T;

  return [summaryMessage, ...recent];
}
