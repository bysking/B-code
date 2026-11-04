import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_SCROLL,
  adjustForResize,
  clamp,
  isAtBottom,
  maxScrollTop,
  scrollDown,
  scrollToBottom,
  scrollTopFor,
  scrollUp,
} from '../src/ui/viewport/viewport.js';

/**
 * 滚动视口的纯逻辑测试。
 *
 * 这套逻辑取代了旧的 CPR 探测（问终端光标在哪）+ 高度估算切片，
 * 所以断言重点是两条不变量：
 *   1. offset 永远落在 [0, max] 内（否则视口滚过内容末端露白）；
 *   2. 距底部行数的语义在 resize 前后一致（用户看的内容不跳）。
 */

test('maxScrollTop：内容比视口矮时为 0（不能出现负偏移）', () => {
  assert.equal(maxScrollTop(10, 20), 0);
  assert.equal(maxScrollTop(20, 20), 0, '正好等高也不可滚');
  assert.equal(maxScrollTop(30, 20), 10);
});

test('scrollTopFor：距底 0 → 贴底；距底越大越靠上', () => {
  assert.equal(scrollTopFor(0, 100, 20), 80, '贴底 = 最大偏移');
  assert.equal(scrollTopFor(10, 100, 20), 70);
  assert.equal(scrollTopFor(80, 100, 20), 0, '滚到顶');
});

test('scrollTopFor：越界的距底行数被 clamp（内容变短/终端变高后不越界）', () => {
  assert.equal(scrollTopFor(999, 100, 20), 0, '超过总高度 → 顶');
  assert.equal(scrollTopFor(-5, 100, 20), 80, '负数 → 底');
  assert.equal(scrollTopFor(0, 10, 20), 0, '内容比视口矮 → 0');
});

test('scrollUp：上滚即停止跟随（用户要看历史了）', () => {
  const s = scrollUp(INITIAL_SCROLL, 3);
  assert.equal(s.fromBottom, 3);
  assert.equal(s.following, false);
});

test('scrollDown：滚到底自动恢复跟随', () => {
  const up = scrollUp(INITIAL_SCROLL, 5);
  const down = scrollDown(up, 5);
  assert.equal(down.fromBottom, 0);
  assert.equal(down.following, true, '回到底部即恢复跟随');
});

test('scrollDown：不会滚成负值', () => {
  const s = scrollDown(INITIAL_SCROLL, 99);
  assert.equal(s.fromBottom, 0);
});

test('scrollToBottom：恒贴底 + 跟随', () => {
  assert.deepEqual(scrollToBottom(), { fromBottom: 0, following: true });
});

test('isAtBottom：容差吸收布局抖动', () => {
  assert.equal(isAtBottom(0), true);
  assert.equal(isAtBottom(1), false);
  assert.equal(isAtBottom(1, 2), true, '容差内算贴底');
});

test('adjustForResize：视口变高 → 距底行数等量减少，保持视觉位置', () => {
  const scrolled = scrollUp(INITIAL_SCROLL, 10);
  // 视口变高 4 行：同样内容占的行更少，距底应减 4
  const next = adjustForResize(scrolled, 4);
  assert.equal(next.fromBottom, 6, '保持用户看到的内容不跳');
});

test('adjustForResize：视口变矮 → 距底行数增加', () => {
  const scrolled = scrollUp(INITIAL_SCROLL, 10);
  const next = adjustForResize(scrolled, -4);
  assert.equal(next.fromBottom, 14);
});

test('adjustForResize：跟随态不受影响（本来就会自动贴底）', () => {
  const following = { fromBottom: 0, following: true };
  assert.equal(adjustForResize(following, 5), following, '同引用 = 无需更新');
});

test('adjustForResize：缩小到 0 以内自动回到底部并恢复跟随', () => {
  const nearBottom = scrollUp(INITIAL_SCROLL, 2);
  const next = adjustForResize(nearBottom, 10);
  assert.equal(next.fromBottom, 0);
  assert.equal(next.following, true, '已经看到底了，自然恢复跟随');
});

test('adjustForResize：高度没变则不动', () => {
  const s = scrollUp(INITIAL_SCROLL, 3);
  assert.equal(adjustForResize(s, 0), s, '同引用');
});

test('clamp', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});

test('不变量：任意操作序列后 offset 都在合法范围内', () => {
  // 模拟真实场景：滚动 → resize → 内容变短 → 再滚动
  let state = INITIAL_SCROLL;
  let contentHeight = 100;
  let viewportH = 20;

  const assertInRange = () => {
    const max = maxScrollTop(contentHeight, viewportH);
    const top = scrollTopFor(state.fromBottom, contentHeight, viewportH);
    assert.ok(top >= 0 && top <= max, `offset ${top} 应在 [0, ${max}]`);
  };

  state = scrollUp(state, 50);
  assertInRange();
  state = adjustForResize(state, -5);
  assertInRange();
  contentHeight = 30; // 内容突然变短（/clear）
  assertInRange();
  viewportH = 25; // 终端变大
  assertInRange();
  state = scrollDown(state, 999);
  assertInRange();
  assert.deepEqual(state, scrollToBottom(), '滚到底 = 跟随态');
});
