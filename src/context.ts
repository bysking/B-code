/**
 * 上下文管理（施工图 P3 §7）
 *
 * 分级压缩流水线（从最轻到最重）：
 *   Tier 0: truncateResult —— 单次工具输出超 50K 字符截断（头尾各半）
 *   Tier 4: maybeCompact  —— 消息超阈值时用 LLM 把旧消息摘要成一段，保留最近 KEEP_RECENT 条
 *
 * 先实现这两级；Tier 1 预算截断 / Tier 2 裁剪 / Tier 3 空闲微压缩按需后置。
 */

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

export const COMPACT_THRESHOLD = 15; // 超过 15 条消息触发压缩
export const KEEP_RECENT = 5; // 保留最近 5 条不压缩

/**
 * 摘要压缩：旧消息 → summarize 回调（调用方提供"渲染+调模型"实现）→ 摘要替换。
 * 注意：tool_use/tool_result 跨消息的配对不能拆散，所以压缩的是整块旧消息，
 * 保留最近消息保证模型能记住最近的上下文。
 */
export async function maybeCompact<T extends { role: string; content: unknown }>(
  messages: T[],
  summarize: (older: { role: string; content: unknown }[]) => Promise<string>,
): Promise<T[]> {
  if (messages.length <= COMPACT_THRESHOLD) return messages;

  const older = messages.slice(0, messages.length - KEEP_RECENT);
  const recent = messages.slice(messages.length - KEEP_RECENT);

  const summary = (await summarize(older)).trim();
  if (!summary) return messages; // 摘要失败则保持原样，宁可爆窗也不丢上下文

  const summaryMessage = {
    role: "user",
    content: `[Summary of earlier conversation]\n${summary}`,
  } as unknown as T;

  return [summaryMessage, ...recent];
}