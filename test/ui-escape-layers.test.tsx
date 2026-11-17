import { test } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderOtui } from './helpers/otui-test.js';
import { App } from '../src/ui/app.js';
import { AppController } from '../src/ui/controller.js';

/**
 * Esc 的调度顺序：**先关面板，没有面板才中断模型**。
 *
 * 曾经的 bug：Esc 分支只拦了输出面板与文本提问，`/skills`、`/mcp` 的能力面板
 * 和 `/todo` 编辑器漏在外面。用户在面板里按 Esc 想关掉它，结果连带把正在
 * 推理的模型也中断了——一按就前功尽弃。
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount() {
  const ctrl = new AppController();
  let interrupted = 0;
  const frame = await renderOtui(
    React.createElement(App, {
      ctrl,
      onSubmit: () => {},
      onInterrupt: () => interrupted++,
      onExit: () => {},
      onSetMode: () => {},
      initialOutput: undefined,
    }),
    { width: 100, height: 30 },
  );
  return { ctrl, frame, interrupted: () => interrupted };
}

async function pressEsc(frame: { press: (k: string) => Promise<void>; flush: () => Promise<void> }) {
  await frame.press('\x1b');
  await wait(60);
  await frame.flush();
}

test('Esc：/skills 能力面板打开时只关面板，不中断模型', async () => {
  const { ctrl, frame, interrupted } = await mount();
  ctrl.setBusy('thinking…'); // 模型正在推理
  ctrl.openCapability('skill', [{ name: 'commit', enabled: true, detail: 'git commit' }]);
  await wait(40);
  await frame.flush();

  await pressEsc(frame);

  assert.equal(interrupted(), 0, '**不该**中断模型');
  assert.equal(ctrl.capabilityPanel, null, '面板被关掉');
  assert.notEqual(ctrl.busy, null, '模型仍在推理（busy 未被清）');
  await frame.cleanup();
});

test('Esc：/mcp 能力面板同理', async () => {
  const { ctrl, frame, interrupted } = await mount();
  ctrl.setBusy('thinking…');
  ctrl.openCapability('mcp', [{ name: 'docs', enabled: true, detail: 'npx …', connected: true }]);
  await wait(40);
  await frame.flush();

  await pressEsc(frame);

  assert.equal(interrupted(), 0, '**不该**中断模型');
  assert.equal(ctrl.capabilityPanel, null, '面板被关掉');
  await frame.cleanup();
});

test('Esc：Ctrl+O 输出面板打开时只关面板，不中断模型', async () => {
  const { ctrl, frame, interrupted } = await mount();
  ctrl.setBusy('thinking…');
  ctrl.toggleOutputPanel(true);
  await wait(40);
  await frame.flush();

  await pressEsc(frame);

  assert.equal(interrupted(), 0, '**不该**中断模型');
  assert.equal(ctrl.outputPanel, false, '面板被关掉');
  await frame.cleanup();
});

test('Esc：/todo 编辑器打开时只关编辑器，不中断模型', async () => {
  const { ctrl, frame, interrupted } = await mount();
  ctrl.setBusy('thinking…');
  ctrl.setUserTodoOpen(true);
  await wait(40);
  await frame.flush();

  await pressEsc(frame);

  assert.equal(interrupted(), 0, '**不该**中断模型');
  assert.equal(ctrl.userTodoOpen, false, '编辑器被关掉');
  await frame.cleanup();
});

test('Esc：没有任何面板时才中断模型（原行为不能丢）', async () => {
  const { ctrl, frame, interrupted } = await mount();
  ctrl.setBusy('thinking…');
  await wait(40);
  await frame.flush();

  await pressEsc(frame);

  assert.equal(interrupted(), 1, '没有面板 → Esc 中断模型');
  await frame.cleanup();
});

test('Esc：面板关掉后再按一次，才轮到中断模型', async () => {
  const { ctrl, frame, interrupted } = await mount();
  ctrl.setBusy('thinking…');
  ctrl.openCapability('skill', [{ name: 'x', enabled: true }]);
  await wait(40);
  await frame.flush();

  await pressEsc(frame); // 第一次：只关面板
  assert.equal(interrupted(), 0);
  assert.equal(ctrl.capabilityPanel, null);

  await pressEsc(frame); // 第二次：面板没了，轮到中断
  assert.equal(interrupted(), 1, '再按一次才中断');
  await frame.cleanup();
});

test('Esc：空闲（无 busy）且无面板时什么都不做', async () => {
  const { ctrl, frame, interrupted } = await mount();
  await wait(40);
  await frame.flush();
  await pressEsc(frame);
  assert.equal(interrupted(), 0, '没有在跑的任务，不调用中断');
  assert.equal(ctrl.busy, null);
  await frame.cleanup();
});
