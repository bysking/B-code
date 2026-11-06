import { test } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderOtui } from './helpers/otui-test.js';
import { App } from '../src/ui/app.js';
import { AppController } from '../src/ui/controller.js';

/**
 * Ctrl+O 面板「子 Agent」页（第三页）。
 *
 * 用户诉求是"切换查看某个子 Agent 在干什么"，所以这里锁四件事：
 *   1. Tab 能在三页之间轮换
 *   2. 子 Agent 页显示"第几个/共几个 + 人设 + 逐步日志"
 *   3. ←/→ 切换具体看哪个
 *   4. 新子 Agent 出现时不抢用户正在看的那一页（黏性跟随）
 */

async function mount() {
  const ctrl = new AppController();
  const frame = await renderOtui(
    React.createElement(App, {
      ctrl,
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
      onSetMode: () => {},
    }),
    { width: 90, height: 30 },
  );
  const key = async (k: string, mods?: Record<string, boolean>) => {
    if (mods) {
      (frame.raw.mockInput as { pressKey: (k: string, m?: Record<string, boolean>) => void }).pressKey(
        k,
        mods,
      );
    } else {
      await frame.press(k);
    }
    await frame.flush();
  };
  return { ctrl, frame, key };
}

/** 造两个子 Agent（直接驱动 controller，不走真模型） */
function seedTwo(ctrl: AppController) {
  ctrl.startSubAgent('sa1', 'explore', '看看输入框怎么实现的');
  ctrl.pushSubAgentStep('sa1', 'tool   read_file src/ui/views/input.tsx');
  ctrl.pushSubAgentStep('sa1', '←      71 行');
  ctrl.endSubAgent('sa1', 'done', '结论：应该换成 textarea');
  ctrl.startSubAgent('sa2', 'plan-critic', '审查迁移计划');
  ctrl.pushSubAgentStep('sa2', 'text   第 2 步没有回滚方案');
}

test('Ctrl+O：Tab 在三页之间轮换（工具输出 → 系统日志 → 子 Agent → 工具输出）', async () => {
  const { frame, key } = await mount();
  await key('o', { ctrl: true });
  assert.ok(frame.frame().includes('工具输出'), '默认第一页');

  await key('\t');
  assert.ok(frame.frame().includes('系统日志'), 'Tab → 第二页');

  await key('\t');
  assert.ok(frame.frame().includes('子 Agent'), 'Tab → 第三页');

  await key('\t');
  const out = frame.frame();
  assert.ok(out.includes('工具输出'), `Tab → 回到第一页：\n${out.slice(-400)}`);
  await frame.cleanup();
});

test('子 Agent 页：显示"第几个/共几个 · 人设"与逐步日志', async () => {
  const { ctrl, frame, key } = await mount();
  ctrl.toggleOutputPanel(true); // 打开面板 → 后续步骤实时刷新
  seedTwo(ctrl);
  await frame.flush();
  await key('\t');
  await key('\t');

  const out = frame.frame();
  assert.ok(out.includes('子 Agent 2/2 · plan-critic'), `头部标出位置与人设：\n${out.slice(-500)}`);
  assert.ok(out.includes('审查迁移计划'), '任务行');
  assert.ok(out.includes('第 2 步没有回滚方案'), '步骤行');
  await frame.cleanup();
});

test('子 Agent 页：←/→ 切换看哪个（含越界回绕）', async () => {
  const { ctrl, frame, key } = await mount();
  ctrl.toggleOutputPanel(true);
  seedTwo(ctrl);
  await frame.flush();
  await key('\t');
  await key('\t');

  // 默认停在最新的 sa2 → ← 回到 sa1
  await key('\x1b[D'); // ←
  let out = frame.frame();
  assert.ok(out.includes('子 Agent 1/2 · explore'), `← 应切到第 1 个：\n${out.slice(-500)}`);
  assert.ok(out.includes('read_file src/ui/views/input.tsx'), '显示第 1 个的步骤');
  assert.ok(!out.includes('第 2 步没有回滚方案'), '不再显示第 2 个的内容');

  // 再 ← 回绕到最后一个
  await key('\x1b[D');
  out = frame.frame();
  assert.ok(out.includes('子 Agent 2/2 · plan-critic'), '越界回绕到末尾');

  // → 从末尾回绕到首个
  await key('\x1b[C');
  out = frame.frame();
  assert.ok(out.includes('子 Agent 1/2 · explore'), '→ 越界回绕到开头');
  await frame.cleanup();
});

test('子 Agent 页：无子 Agent 时给出占位说明而不是空白', async () => {
  const { frame, key } = await mount();
  await key('o', { ctrl: true });
  await key('\t');
  await key('\t');
  const out = frame.frame();
  assert.ok(out.includes('暂无子 Agent'), `应有占位文案：\n${out.slice(-400)}`);
  await frame.cleanup();
});

test('黏性跟随：停在最后一个时跟着新的走；正在翻旧的则不被打扰', async () => {
  const { ctrl, frame, key } = await mount();
  ctrl.toggleOutputPanel(true);
  ctrl.startSubAgent('sa1', 'explore', 'first');
  ctrl.pushSubAgentStep('sa1', 'tool   a');
  ctrl.startSubAgent('sa2', 'explore', 'second');
  await frame.flush();
  await key('\t');
  await key('\t');
  assert.ok(frame.frame().includes('子 Agent 2/2'), '默认看最新的');

  // 用户翻回第 1 个
  await key('\x1b[D');
  assert.ok(frame.frame().includes('子 Agent 1/2'));

  // 新的子 Agent 出现：不该把视线抢走
  ctrl.startSubAgent('sa3', 'explore', 'third');
  await frame.flush();
  assert.ok(frame.frame().includes('子 Agent 1/3'), `正在看旧的时不被抢走：\n${frame.frame().slice(-400)}`);

  // 回到最后一个后，再来新的就该跟了
  await key('\x1b[C');
  await key('\x1b[C');
  assert.ok(frame.frame().includes('子 Agent 3/3'), '→ 到末尾');
  ctrl.startSubAgent('sa4', 'explore', 'fourth');
  await frame.flush();
  assert.ok(frame.frame().includes('子 Agent 4/4'), `停在末尾时跟随新的：\n${frame.frame().slice(-400)}`);
  await frame.cleanup();
});
