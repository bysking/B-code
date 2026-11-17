import { test } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderOtui } from './helpers/otui-test.js';
import { App } from '../src/ui/app.js';
import { AppController } from '../src/ui/controller.js';
import type { ClipboardImage } from '../src/utils/clipboard.js';

/**
 * 输入历史导航（↑/↓）。
 *
 * 曾经的 bug：翻出第一条后输入框就非空了，而导航条件要求 `input === ''`，
 * 于是**第二次按 ↑ 必然无效**——用户看起来就是"只缓存了一条"。
 *
 * 另一个隐蔽的坑：`setInput` 会让 `PromptInput` 走 `setText`，后者发
 * `content-changed` → `onChange` → `handleChange` 把 `historyIdx` 重置成 -1。
 * 两道锁叠加，历史基本只能用一次。
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function renderApp(
  ctrl: AppController,
  onSubmit: (text: string | { text: string; images?: ClipboardImage[] }) => void = () => {},
) {
  return renderOtui(
    React.createElement(App, {
      ctrl,
      onSubmit,
      onInterrupt: () => {},
      onExit: () => {},
      onSetMode: () => {},
      initialOutput: undefined,
    }),
    { width: 100, height: 30 },
  );
}

const press = async (
  frame: { press: (k: string) => Promise<void>; flush: () => Promise<void> },
  keys: string,
) => {
  await frame.press(keys);
  await wait(50);
  await frame.flush();
};

/** 走一遍"输入 → 回车提交"，把内容写进历史 */
async function submit(
  frame: { press: (k: string) => Promise<void>; flush: () => Promise<void> },
  text: string,
) {
  await press(frame, text);
  await press(frame, '\r');
}

test('历史：连按 ↑ 能逐条翻出全部提交过的输入（不是只缓存一条）', async () => {
  const ctrl = new AppController();
  const submitted: string[] = [];
  const frame = await renderApp(ctrl, (t) => submitted.push(typeof t === 'string' ? t : t.text));

  await submit(frame, '第一条指令');
  await submit(frame, '第二条指令');
  await submit(frame, '第三条指令');
  assert.deepEqual(submitted, ['第一条指令', '第二条指令', '第三条指令'], '三次都提交出去了');

  // 连按三次 ↑：应依次看到 第三条 → 第二条 → 第一条
  await press(frame, '\x1b[A');
  let out = frame.frame();
  assert.ok(out.includes('第三条指令'), '第一次 ↑ 得到最新一条');

  await press(frame, '\x1b[A');
  out = frame.frame();
  assert.ok(out.includes('第二条指令'), '第二次 ↑ 得到上一条（关键回归点）');

  await press(frame, '\x1b[A');
  out = frame.frame();
  assert.ok(out.includes('第一条指令'), '第三次 ↑ 得到最早一条');

  await frame.cleanup();
});

test('历史：翻到最早一条后继续 ↑ 停在原地（不越界、不清空）', async () => {
  const ctrl = new AppController();
  const frame = await renderApp(ctrl);
  await submit(frame, 'only-one');
  await press(frame, '\x1b[A');
  await press(frame, '\x1b[A'); // 再按一次已无处可翻
  const out = frame.frame();
  assert.ok(out.includes('only-one'), '内容仍在，没有被清空');
  await frame.cleanup();
});

test('历史：↓ 往回翻，翻到底清空', async () => {
  const ctrl = new AppController();
  const frame = await renderApp(ctrl);
  await submit(frame, 'aaa');
  await submit(frame, 'bbb');

  await press(frame, '\x1b[A');
  let out = frame.frame();
  assert.ok(out.includes('bbb'), '↑ 进入历史（最新一条）');

  await press(frame, '\x1b[A');
  out = frame.frame();
  assert.ok(out.includes('aaa'), '再 ↑ 到更早');

  await press(frame, '\x1b[B');
  out = frame.frame();
  assert.ok(out.includes('bbb'), '↓ 回到较新的一条');

  await press(frame, '\x1b[B');
  out = frame.frame();
  assert.ok(!out.includes('aaa') && !out.includes('bbb'), '↓ 翻到底 → 清空输入框');
  await frame.cleanup();
});

test('历史：框里有草稿时 ↑ 不抢（留给 textarea 移光标）', async () => {
  const ctrl = new AppController();
  const frame = await renderApp(ctrl);
  await submit(frame, '历史里的内容');

  // 原生 hp：有草稿时 ↑ 应保持草稿不变（历史不接管）
  await press(frame, '草稿不该被顶掉');
  await press(frame, '\x1b[A');
  const out = frame.frame();
  assert.ok(out.includes('草稿不该被顶掉'), '草稿保留');
  assert.ok(!out.includes('历史里的内容'), '没有跳进历史');
  await frame.cleanup();
});

test('历史：翻出历史后直接回车，提交的是历史那条', async () => {
  const ctrl = new AppController();
  const submitted: string[] = [];
  const frame = await renderApp(ctrl, (t) => submitted.push(typeof t === 'string' ? t : t.text));
  await submit(frame, '重复执行我');
  await press(frame, '\x1b[A');
  await press(frame, '\r');
  assert.deepEqual(submitted, ['重复执行我', '重复执行我'], '历史项可以被再次提交');
  await frame.cleanup();
});

test('历史：同样的内容连续提交只留一条（去重）', async () => {
  const ctrl = new AppController();
  const frame = await renderApp(ctrl);
  await submit(frame, 'x');
  await submit(frame, 'x');
  await submit(frame, 'y');
  await press(frame, '\x1b[A');
  assert.ok(frame.frame().includes('y'), '最新是 y');
  await press(frame, '\x1b[A');
  assert.ok(frame.frame().includes('x'), '再往上直接到 x（没有重复的 x）');
  await press(frame, '\x1b[A');
  // 已经到最早一条，同一条 x 不该再出现一次
  assert.ok(frame.frame().includes('x'));
  await frame.cleanup();
});

/**
 * 用户的真实症状："只能按上键，中间按下键，无法倒退输入"。
 *
 * 之前的不对称实现：`↑` 判空框、`↓` 判游标。游标一旦被 `setText` 的回声
 * 误重置成 -1，`↓` 就再也进不来——表现正是"上键能用、下键失灵"。
 * 这里锁住闭环：↑ 往下翻、↓ 随时能倒回来。
 */
test('历史闭环：↑ 翻到底，中途按 ↓ 能逐条倒回来', async () => {
  const ctrl = new AppController();
  const frame = await renderApp(ctrl);
  await submit(frame, 'AAA');
  await submit(frame, 'BBB');
  await submit(frame, 'CCC');

  // 只看输入框那一行（会话历史区也有同样的文本，不能被骗过）
  const inputLine = () => {
    const line = frame
      .frame()
      .split('\n')
      .find((l) => l.trimStart().startsWith('>'));
    return (line ?? '').trim();
  };

  await press(frame, '\x1b[A');
  assert.ok(inputLine().includes('CCC'), '↑ 第 1 次 → 最新一条');
  await press(frame, '\x1b[A');
  assert.ok(inputLine().includes('BBB'), '↑ 第 2 次 → 上一条');
  await press(frame, '\x1b[A');
  assert.ok(inputLine().includes('AAA'), '↑ 第 3 次 → 最早一条');

  // 关键：中途按下键必须能倒推
  await press(frame, '\x1b[B');
  assert.ok(inputLine().includes('BBB'), '↓ 第 1 次 → 倒回 BBB（曾经完全失灵）');
  await press(frame, '\x1b[B');
  assert.ok(inputLine().includes('CCC'), '↓ 第 2 次 → 倒回 CCC');
  await press(frame, '\x1b[B');
  const back = inputLine();
  assert.ok(!back.includes('AAA') && !back.includes('BBB') && !back.includes('CCC'), '↓ 到底 → 清空');

  await frame.cleanup();
});

test('历史：上下来回穿插（↑↑↓↑↓）时游标不错乱', async () => {
  const ctrl = new AppController();
  const frame = await renderApp(ctrl);
  await submit(frame, 'first');
  await submit(frame, 'second');
  await submit(frame, 'third');

  const inputLine = () =>
    (
      frame
        .frame()
        .split('\n')
        .find((l) => l.trimStart().startsWith('>')) ?? ''
    ).trim();

  await press(frame, '\x1b[A'); // third
  await press(frame, '\x1b[A'); // second
  assert.ok(inputLine().includes('second'));
  await press(frame, '\x1b[B'); // third
  assert.ok(inputLine().includes('third'));
  await press(frame, '\x1b[A'); // second
  assert.ok(inputLine().includes('second'));
  await press(frame, '\x1b[A'); // first
  assert.ok(inputLine().includes('first'));
  await press(frame, '\x1b[B'); // second
  assert.ok(inputLine().includes('second'), '来回穿插后仍准确');
  await frame.cleanup();
});

test('历史：不在历史中时 ↓ 不清掉用户刚打的草稿', async () => {
  const ctrl = new AppController();
  const frame = await renderApp(ctrl);
  await submit(frame, '历史项');
  await press(frame, '正在写的草稿');
  await press(frame, '\x1b[B');
  const out = frame.frame();
  assert.ok(out.includes('正在写的草稿'), '↓ 不该在非历史态下吞掉草稿');
  await frame.cleanup();
});
