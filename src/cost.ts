/**
 * 成本估算（/cost 展示）：把累积 token 用量换算成人可读的用量摘要 + 粗略美元估算。
 *
 * 估算口径刻意保守且标注"估算"：默认单价按 Claude Sonnet 档（$3/M 输入、$15/M 输出），
 * 命中前缀缓存的部分实际约 0.1×，故真实账单通常低于此估值。用户可覆盖单价。
 * 不追求精确计费（那是服务商账单的事），只给一个量级判断。
 */

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  calls: number;
}

/** 默认单价（美元/百万 token）：Sonnet 档 */
export const DEFAULT_PRICE = { inputPerM: 3, outputPerM: 15 };

/** 千分位 + token 缩写（<1k 原样；>=1k 用 k；>=1M 用 M） */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** 用量摘要文本（多行）；/cost 与控制台共用 */
export function formatCost(
  usage: UsageTotals,
  price: { inputPerM: number; outputPerM: number } = DEFAULT_PRICE,
): string {
  const cost = (usage.input_tokens / 1e6) * price.inputPerM + (usage.output_tokens / 1e6) * price.outputPerM;
  const lines = [
    '本次会话用量',
    `  模型调用: ${usage.calls} 次`,
    `  输入: ${formatTokens(usage.input_tokens)} tokens`,
    `  输出: ${formatTokens(usage.output_tokens)} tokens`,
    `  估算成本: $${cost.toFixed(4)} （按 $${price.inputPerM}/M 输入 · $${price.outputPerM}/M 输出；缓存命中实际更低）`,
  ];
  return lines.join('\n');
}
