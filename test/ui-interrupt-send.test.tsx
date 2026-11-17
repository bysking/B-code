import { test } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderOtui } from './helpers/otui-test.js';
import { App } from '../src/ui/app.js';
import { AppController } from '../src/ui/controller.js';

/**
 * Ctrl+Enter 强插（忙碌期"我说的话比你现在做的事更要紧"）。
 *
 * 需要覆盖三条语义：
 *   1. 忙碌时 → 走 `onInterruptAndSend`（不是普通 onSubmit，也不是 Esc 的中断）
 *   2. 空闲时 → 退化为普通提交（不为发一句话记两套键）
 *   3. 空框 / 有交互面板时 → 什么都不做（别把用户的确认框顶掉）
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 终端里 Ctrl+Enter 的线缆形态。
 *
 * 用 `xterm modifyOtherKeys` 的 CSI 27;5;13~（= Ctrl+回车），而不是
 * `pressKey('\r', { ctrl: true })`：后者在传统键盘模式下会被当成裸回车
 * （`ctrl=false`），测出来的是"普通提交"而不是强插。
 */
const CTRL_ENTER = '\x1b[27;5;13~';

async function ctrlEnter(frame: {
  raw: { mockInput: { pressKey: (k: string) => void } };
  flush: () => Promise<void>;
}) {
  frame.raw.mockInput.pressKey(CTRL_ENTER);
  await wait(60);
  await frame.flush();
}

function mount(opts: {
  onSubmit?: (t: string | { text: string; images?: unknown[] }) => void;
  onInterruptAndSend?: (t: string) => void;
  onInterrupt?: () => void;
}) {
  const ctrl = new AppController();
  const frameP = renderOtui(
    React.createElement(App, {
      ctrl,
      onSubmit: opts.onSubmit ?? (() => {}),
      onInterrupt: opts.onInterrupt ?? (() => {}),
      ...(opts.onInterruptAndSend ? { onInterruptAndSend: opts.onInterruptAndSend } : {}),
      onExit: () => {},
      onSetMode: () => {},
      initialOutput: undefined,
    }),
    { width: 100, height: 30 },
  );
  return { ctrl, frameP };
}

test('忙碌期 Ctrl+Enter：走 onInterruptAndSend 并清空输入框', async () => {
  const interrupted: string[] = [];
  const submitted: string[] = [];
  const { ctrl, frameP } = mount({
    onSubmit: (t) => submitted.push(typeof t === 'string' ? t : t.text),
    onInterruptAndSend: (t) => interrupted.push(t),
  });
  const frame = await frameP;
  ctrl.setBusy('thinking…');

  await frame.press('插队的新指令');
  await wait(60);
  await frame.flush();
  await ctrlEnter(frame);

  assert.deepEqual(interrupted, ['插队的新指令'], '强插回调拿到原文');
  assert.deepEqual(submitted, [], '不走普通提交');
  const out = frame.frame();
  assert.ok(!out.includes('插队的新指令'), '提交后输入框已清空');
  await frame.cleanup();
});

test('空闲时 Ctrl+Enter：退化为普通提交', async () => {
  const interrupted: string[] = [];
  const submitted: string[] = [];
  const { frameP } = mount({
    onSubmit: (t) => submitted.push(typeof t === 'string' ? t : t.text),
    onInterruptAndSend: (t) => interrupted.push(t),
  });
  const frame = await frameP; // 没有 setBusy → 空闲

  await frame.press('普通发送');
  await wait(60);
  await frame.flush();
  await ctrlEnter(frame);

  assert.deepEqual(submitted, ['普通发送'], '走普通提交');
  assert.deepEqual(interrupted, [], '不触发强插');
  await frame.cleanup();
});

test('空框 Ctrl+Enter：什么都不发生（不提交空串）', async () => {
  const interrupted: string[] = [];
  const submitted: string[] = [];
  const { ctrl, frameP } = mount({
    onSubmit: (t) => submitted.push(typeof t === 'string' ? t : t.text),
    onInterruptAndSend: (t) => interrupted.push(t),
  });
  const frame = await frameP;
  ctrl.setBusy('thinking…');
  await ctrlEnter(frame);
  assert.deepEqual(submitted, []);
  assert.deepEqual(interrupted, []);
  await frame.cleanup();
});

test('有交互面板（权限确认）时 Ctrl+Enter 不抢按键', async () => {
  const interrupted: string[] = [];
  const { ctrl, frameP } = mount({ onInterruptAndSend: (t) => interrupted.push(t) });
  const frame = await frameP;
  ctrl.setBusy('running write_file…');
  const p = ctrl.ask('Allow write_file?', [
    { label: 'No', value: 'no' },
    { label: 'Yes', value: 'yes' },
  ]);
  await wait(40);
  await frame.flush();

  await frame.press('不该被发出去');
  await wait(40);
  await frame.flush();
  await ctrlEnter(frame);

  assert.deepEqual(interrupted, [], '确认框存在时不强插');
  ctrl.resolveAsk('no');
  await p;
  await frame.cleanup();
});

test('队列提示：ctrl.queuedPrompts 非空时底栏显示条数与 Ctrl+Enter 用法', async () => {
  const { ctrl, frameP } = mount({});
  const frame = await frameP;
  ctrl.setQueuedPrompts(['第一条', '第二条']);
  await wait(40);
  await frame.flush();
  const out = frame.frame();
  assert.ok(out.includes('已排队 2 条'), '显示排队条数');
  assert.ok(out.includes('Ctrl+Enter'), '顺带告诉用户强插键');

  ctrl.setQueuedPrompts([]);
  await wait(40);
  await frame.flush();
  assert.ok(!frame.frame().includes('已排队'), '排空后提示消失');
  await frame.cleanup();
});
