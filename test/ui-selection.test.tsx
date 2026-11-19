import { test, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import {
  createTestRenderer,
  createMockMouse,
  MouseButtons,
  type TestRendererSetup,
} from '@opentui/core/testing';
import { createRoot, type Root } from '@opentui/react';
import { App } from '../src/ui/app.js';
import { AppController } from '../src/ui/controller.js';
import { patchMarkdownSelection } from '../src/ui/markdown-selection.js';

/**
 * 鼠标选中 / 右键复制后的状态机。
 *
 * ## 锁住的问题
 *
 * 「终端里选中文本 → 右键复制 → 之后再也选不中、光标也没了」。
 *
 * 根因不在本仓库，而在 OpenTUI 0.8.2 的手势状态机：
 *
 *   1. 终端右键会弹**终端自己的**上下文菜单，左键的 release（SGR `m`）随之被
 *      终端吃掉，应用收不到 `up`；
 *   2. 0.8.2 里 `currentSelection.isDragging` 因此永远停在 `true`，下一次左键
 *      **按下**走不进 `startSelection`（那条分支要求 `!isDragging`），于是新选中
 *      起不来——用户看到的就是"选不中"；
 *   3. 同一时期的 pointer-only 帧（只有鼠标指针形状变化、没有单元格变化）会
 *      空跑一帧；起帧会隐藏光标，而那一帧的光标步骤已判定"无需恢复"，文本框
 *      光标于是一直藏着，直到下一次有单元格变化的帧——"光标消失"。
 *
 * 0.9.x 修掉了这两点（上游 issue #2065「end the old gesture on a left press」
 * 与 #1939「keep the cursor visible on a pointer-only frame」）。这些用例把行为
 * 钉在应用层：升级/回退 OpenTUI 时，一旦又出现"右键之后选不动"，这里会红。
 */

let setup: TestRendererSetup;
let root: Root;
let mouse: ReturnType<typeof createMockMouse>;

beforeAll(async () => {
  // 真实挂载路径（mountTtyApp）会打 markdown 选中补丁；测试直接挂 App，
  // 得自己补上，否则"空行起选"那条用例测的是未打补丁的基线。
  patchMarkdownSelection();
  setup = await createTestRenderer({ width: 100, height: 30 });
  root = createRoot(setup.renderer as never);
  mouse = createMockMouse(setup.renderer);
});

afterAll(async () => {
  await setup.dispose();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 挂一棵真实的 App（选中行为依赖真实的 Transcript / 输入框布局）。
 *
 * 内容刻意排成：用户行 → 空行 → 「B Code」标签 → 第二段 → 空行 → 第三段，
 * 让用例既能测"段落行起选"，也能测"空行起选"（后者只有 markdown 补丁放行）。
 */
async function mountApp(): Promise<void> {
  const ctrl = new AppController();
  ctrl.pushUser('第一行文本 first line');
  ctrl.streamText('第二段落 second paragraph\n\n第三段落 third paragraph');
  ctrl.finishStream();
  root.render(
    React.createElement(App, {
      ctrl,
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
      onSetMode: () => {},
    }),
  );
  await setup.renderOnce();
  // markdown 异步解析：等它落地再开始点
  await sleep(200);
  await setup.renderOnce();
}

/** 当前画面上含 `needle` 的行号（没找到返回 -1） */
function rowOf(needle: string): number {
  return setup
    .captureCharFrame()
    .split('\n')
    .findIndex((line) => line.includes(needle));
}

/** 渲染器上的选中文本（无选中 → ''） */
function selectedText(): string {
  return setup.renderer.getSelection()?.getSelectedText() ?? '';
}

/** 文本框光标是否可见（"光标消失"的直接观测量） */
function cursorVisible(): boolean {
  return setup.renderer.getCursorState().visible;
}

/** 在 `needle` 所在行从第 1 列拖到第 24 列 */
async function dragAlongRow(needle: string): Promise<void> {
  const y = rowOf(needle);
  assert.notEqual(y, -1, `前置：画面上应能看到「${needle}」`);
  await mouse.drag(1, y, 24, y, MouseButtons.LEFT);
  await setup.renderOnce();
}

test('左键拖选：能选中文本，且光标保持可见', async () => {
  await mountApp();

  await dragAlongRow('第一行文本');

  assert.ok(
    selectedText().includes('第一行文本'),
    `应选中首行文本，实际：${JSON.stringify(selectedText())}`,
  );
  assert.equal(cursorVisible(), true, '拖选后输入框光标不该消失');
});

test('右键之后仍能重新选中（左键 release 被终端菜单吃掉的情形）', async () => {
  await mountApp();

  const firstRow = rowOf('第一行文本');
  const secondRow = rowOf('第二段落');
  assert.notEqual(firstRow, -1, '前置：用户行可见');
  assert.notEqual(secondRow, -1, '前置：助手回复可见');

  // ① 拖选，但**不发 up**：模拟 release 被终端右键菜单吞掉
  await mouse.emitMouseEvent('down', 1, firstRow, MouseButtons.LEFT);
  await mouse.emitMouseEvent('drag', 24, firstRow, MouseButtons.LEFT);
  await setup.renderOnce();
  assert.ok(selectedText().includes('第一行文本'), '前置：第一次选中成立');

  // ② 右键（终端弹自己的复制菜单）
  await mouse.emitMouseEvent('down', 10, secondRow, MouseButtons.RIGHT);
  await setup.renderOnce();

  // ③ 用户想改选另一段：按下 → 拖动 → 抬起
  await mouse.emitMouseEvent('down', 1, secondRow, MouseButtons.LEFT);
  await mouse.emitMouseEvent('drag', 26, secondRow, MouseButtons.LEFT);
  await mouse.emitMouseEvent('up', 26, secondRow, MouseButtons.LEFT);
  await setup.renderOnce();

  const after = selectedText();
  assert.notEqual(after, '', '右键之后必须还能起新的选中（0.8.2 在这里会彻底选不中）');
  assert.ok(after.includes('第二段落'), `新选中应落在第二段，实际：${JSON.stringify(after)}`);
  assert.equal(cursorVisible(), true, '右键之后输入框光标不该消失');
});

test('clearSelection 之后能重新选中（Ctrl+Shift+C 复制的收尾路径）', async () => {
  await mountApp();

  await dragAlongRow('第一行文本');
  assert.ok(selectedText().length > 0, '前置：选中成立');

  // app.tsx 的复制流程：取文本 → 写剪贴板 → clearSelection
  setup.renderer.clearSelection();
  await setup.renderOnce();
  assert.equal(selectedText(), '', '清选中后不应再有选中文本');

  await dragAlongRow('第三段落');
  assert.ok(
    selectedText().includes('第三段落'),
    `清选中后应能重新选中，实际：${JSON.stringify(selectedText())}`,
  );
});

test('markdown 空行起选：补丁仍在生效（能从空行拖到正文）', async () => {
  await mountApp();

  // 第二段与第三段之间的空行：命中 MarkdownRenderable 本身，
  // 只有 src/ui/render.ts 的补丁允许它起选
  const thirdRow = rowOf('第三段落');
  assert.notEqual(thirdRow, -1, '前置：第三段可见');
  const blankRow = thirdRow - 1;
  const blank = setup.captureCharFrame().split('\n')[blankRow] ?? '';
  assert.equal(blank.trim(), '', '前置：目标行确实是空行');

  await mouse.drag(1, blankRow, 24, thirdRow, MouseButtons.LEFT);
  await setup.renderOnce();

  assert.ok(
    selectedText().includes('第三段落'),
    `空行起选应能带出下一段文字，实际：${JSON.stringify(selectedText())}`,
  );
});
