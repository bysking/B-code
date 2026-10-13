import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRICE, formatCost, formatTokens } from '../src/cost.js';

test('formatTokens：<1k 原样，k / M 分级', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1000), '1.0k');
  assert.equal(formatTokens(1234), '1.2k');
  assert.equal(formatTokens(1_000_000), '1.00M');
  assert.equal(formatTokens(2_500_000), '2.50M');
});

test('formatCost：用量摘要 + 估算美元', () => {
  const text = formatCost({ input_tokens: 1_000_000, output_tokens: 1_000_000, calls: 3 });
  assert.ok(text.includes('模型调用: 3 次'));
  assert.ok(text.includes('输入: 1.00M tokens'));
  assert.ok(text.includes('输出: 1.00M tokens'));
  // 1M 输入 * $3 + 1M 输出 * $15 = $18
  assert.ok(text.includes('$18.0000'), `估算应为 $18：${text}`);
});

test('formatCost：默认采用 Sonnet 档单价', () => {
  assert.equal(DEFAULT_PRICE.inputPerM, 3);
  assert.equal(DEFAULT_PRICE.outputPerM, 15);
});
