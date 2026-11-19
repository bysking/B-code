import { test } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderOtui } from './helpers/otui-test.js';
import { App } from '../src/ui/app.js';
import { AppController } from '../src/ui/controller.js';
import type { ClipboardImage } from '../src/utils/clipboard.js';

/**
 * ↑ 撤回排队输入。
 *
 * 场景：模型还在跑，用户又敲了一条 → cli 把它放进 `PromptQueue`。此时按 ↑
 * 应该把排队中的文案**撤回到输入框**（并且从真队列里取走，避免"撤回后又发出
 * 去"），连按 ↑ 继续往前撤；队列撤空后 ↑ 回落到原来的输入历史逻辑。
 *
 * 这里用本地数组模拟 cli 的真队列：`onSubmit` 入队、`onRecallQueued` 出队，
 * 两者都同步 `ctrl.queuedPrompts`（与 cli 的 `syncQueue` 等价），从而在
 * 不启动 Agent 的情况下锁住 UI 这一侧的完整语义。
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function renderApp() {
  const ctrl = new AppController();
  /** 模拟 cli 里的真队列（FIFO，队尾 = 最近输入） */
  const queued: string[] = [];
  const sync = () => ctrl.setQueuedPrompts([...queued]);

  const frame = await renderOtui(
    React.createElement(App, {
      ctrl,
      // 忙碌期提交 = 入队（与 cli.handle 的忙碌分支一致）
      onSubmit: (t: string | { text: string; images?: ClipboardImage[] }) => {
        queued.push(typeof t === 'string' ? t : t.text);
        sync();
      },
      onInterrupt: () => {},
      // cli 的 onRecallQueued：从队尾取走一条并回灌 UI
      onRecallQueued: () => {
        const text = queued.pop() ?? null;
        if (text !== null) sync();
        return text;
      },
      onExit: () => {},
      onSetMode: () => {},
      initialOutput: undefined,
    }),
    { width: 100, height: 30 },
  );
  return { frame, ctrl, queued };
}

const press = async (
  frame: { press: (k: string) => Promise<void>; flush: () => Promise<void> },
  keys: string,
) => {
  await frame.press(keys);
  await wait(50);
  await frame.flush();
};

/** 输入框那一行（`> ` 开头）的纯文本 */
function inputLine(frame: { frame: () => string }): string {
  const line = frame
    .frame()
    .split('\n')
    .find((l) => l.trimStart().startsWith('>'));
  return (line ?? '').replace(/\s+$/, '').trim();
}

test('排队期间按 ↑：把刚排队的那条撤回输入框（队列提示同步消失）', async () => {
  const { frame, ctrl } = await renderApp();
  await press(frame, '排队中的指令');
  await press(frame, '\r');

  assert.equal(ctrl.queuedPrompts.length, 1, '提交后进入队列');
  assert.ok(frame.frame().includes('已排队'), '底部显示排队提示');

  await press(frame, '\x1b[A');
  assert.ok(inputLine(frame).includes('排队中的指令'), '↑ 把排队文案拉回输入框');
  assert.equal(ctrl.queuedPrompts.length, 0, '该条已从队列撤走（不会又被发出去）');
  assert.ok(!frame.frame().includes('已排队'), '队列清空后提示消失');

  await frame.cleanup();
});

test('连按 ↑ 逐条撤回，累积在输入框里且保持原先后顺序', async () => {
  const { frame, ctrl, queued } = await renderApp();
  await press(frame, '第一条');
  await press(frame, '\r');
  await press(frame, '第二条');
  await press(frame, '\r');
  assert.deepEqual(queued, ['第一条', '第二条']);

  // 第一次 ↑：最近输入的"第二条"
  await press(frame, '\x1b[A');
  assert.ok(inputLine(frame).includes('第二条'), '先撤回最近那条');
  assert.equal(queued.length, 1, '队列只剩第一条');

  // 第二次 ↑：继续往前撤"第一条"——落到草稿上方，顺序不变
  await press(frame, '\x1b[A');
  const text = frame.frame();
  assert.ok(text.includes('第一条'), '第二条 ↑ 也撤出');
  assert.ok(text.includes('第二条'), '先撤回的那条没有被挤掉（草稿只增不减）');
  const firstIdx = text.indexOf('第一条');
  const secondIdx = text.indexOf('第二条');
  assert.ok(firstIdx >= 0 && firstIdx < secondIdx, '草稿里保持原顺序：第一条在上，第二条在下');
  assert.equal(queued.length, 0, '队列已撤空');
  assert.equal(ctrl.queuedPrompts.length, 0);

  await frame.cleanup();
});

test('队列空时 ↑ 回到原来的历史逻辑', async () => {
  const { frame, ctrl, queued } = await renderApp();
  await press(frame, '历史里的内容');
  await press(frame, '\r');
  assert.equal(queued.length, 1);

  // 模拟本轮跑完、队列被排空（与 cli.runChat 的 finally 一致：真源与镜像同清）
  queued.length = 0;
  ctrl.setQueuedPrompts([]);
  await frame.flush();

  // 现在框空、队列空 → ↑ 必须是历史导航（而不是撤回队列）
  await press(frame, '\x1b[A');
  assert.ok(inputLine(frame).includes('历史里的内容'), '空队列时 ↑ 走历史');

  await frame.cleanup();
});

test('框里有草稿时 ↑ 不撤队列（草稿优先，交给 textarea 移光标）', async () => {
  const { frame, ctrl, queued } = await renderApp();
  await press(frame, '排队的');
  await press(frame, '\r');
  await press(frame, '正在编辑的草稿');

  await press(frame, '\x1b[A');
  assert.ok(inputLine(frame).includes('正在编辑的草稿'), '草稿保留');
  assert.equal(queued.length, 1, '队列没有被 ↑ 动过');
  assert.equal(ctrl.queuedPrompts.length, 1);
  assert.ok(frame.frame().includes('已排队'), '排队提示仍在');

  await frame.cleanup();
});

/**
 * 光标位置回归：外部写值后（历史导航/撤回队列），光标必须落在**文本最末**。
 *
 * `cursorOffset` 是显示单元格偏移，不是字符串下标——以前按 `value.length`
 * 直接赋值，含中文时（一字两格）光标会落在句子中间，接着打字字符就插进正文。
 */
test('撤回中文文案后光标在末尾：接着输入的字符追加到最后', async () => {
  const { frame } = await renderApp();
  await press(frame, '中文内容');
  await press(frame, '\r');

  await press(frame, '\x1b[A');
  assert.ok(inputLine(frame).includes('中文内容'), '撤回进输入框');

  await press(frame, 'x');
  assert.ok(inputLine(frame).includes('中文内容x'), `应追加到末尾，实际：${inputLine(frame)}`);

  await frame.cleanup();
});

test('历史里的中文同样把光标放到末尾', async () => {
  const { frame, ctrl, queued } = await renderApp();
  await press(frame, '历史中文');
  await press(frame, '\r');

  // 本轮结束、队列排空 → 空框按 ↑ 进入历史导航
  queued.length = 0;
  ctrl.setQueuedPrompts([]);
  await frame.flush();
  await press(frame, '\x1b[A');

  assert.ok(inputLine(frame).includes('历史中文'));
  await press(frame, 'x');
  assert.ok(inputLine(frame).includes('历史中文x'), `应追加到末尾，实际：${inputLine(frame)}`);

  await frame.cleanup();
});
