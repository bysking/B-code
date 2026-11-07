import { test, mock } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';

/**
 * Ctrl+V 粘贴图片（回归）。
 *
 * ## 这里防的是什么
 *
 * ink 时代这条路径挂在手写的 `SimpleTextInput` 里（`useInput` 里判断 ctrl+v）。
 * 换成 OpenTUI 的 `<textarea>` 后，`App` 仍然把 `handlePasteImage` 作为
 * `onImagePaste` prop 往下传，但 `PromptInput` **收下就再没用过**——prop 成了
 * 死代码，按 Ctrl+V 毫无反应，图片功能静默消失（文本粘贴照常，所以很难察觉）。
 *
 * 修复把按键处理挪进 `PromptInput`：`onKeyDown` 命中 Ctrl/Cmd+V 时调用
 * `onImagePaste()` 拿占位符，再 `insertText()` 插到**光标处**。
 *
 * ## 为什么要单独一个文件
 *
 * 剪贴板读取要 mock（CI 里没有真实截图）。`App` 在 `ui-input.test.tsx` 里
 * 已经加载过，模块缓存里的 `readClipboardImage` 绑定是旧的，同文件里 mock 完
 * 再 import 也拿不到新实现。**在 import App 之前** mock 才行——这就是独立文件
 * + 顶层 await 的原因。「无图片」分支则直接在 `PromptInput` 上测，不必再为
 * 换一个 mock 而重载整个模块。
 */

// 必须先 mock 再 import：App 一加载就把 readClipboardImage 绑过去了
const clipboard = await import('../src/utils/clipboard.js');
const FAKE_IMAGE: import('../src/utils/clipboard.js').ClipboardImage = {
  data: 'iVBORw0KGgo=',
  media_type: 'image/png',
};
mock.module('../src/utils/clipboard.js', () => ({
  ...clipboard,
  readClipboardImage: () => FAKE_IMAGE,
}));

const { renderOtui } = await import('./helpers/otui-test.js');
const { App } = await import('../src/ui/app.js');
const { AppController } = await import('../src/ui/controller.js');
const { PromptInput } = await import('../src/ui/views/input.js');
const { KeyCodes } = await import('@opentui/core/testing');

type Frame = Awaited<ReturnType<typeof renderOtui>>;

/** 按 Ctrl+V（`press` 不支持修饰键，直接走 mockInput） */
function pressCtrlV(frame: Frame): void {
  (frame.raw.mockInput as { pressKey: (k: string, m?: Record<string, boolean>) => void }).pressKey('v', {
    ctrl: true,
  });
}

async function mountApp() {
  const ctrl = new AppController();
  const submitted: (string | { text: string; images?: unknown[] })[] = [];
  const frame = await renderOtui(
    React.createElement(App, {
      ctrl,
      onSubmit: (t: string | { text: string; images?: unknown[] }) => submitted.push(t),
      onInterrupt: () => {},
      onExit: () => {},
      onSetMode: () => {},
    }),
    { width: 70, height: 24 },
  );
  return { ctrl, submitted, frame };
}

test('回归：Ctrl+V 插入 [image #1] 占位符', async () => {
  const { frame } = await mountApp();
  await frame.typeText('看图');
  await frame.flush();

  pressCtrlV(frame);
  await frame.flush();

  assert.ok(
    frame.frame().includes('看图[image #1]'),
    `占位符应插在光标处（草稿末尾）：\n${frame.frame().slice(-300)}`,
  );
  await frame.cleanup();
});

test('回归：连续 Ctrl+V 占位符编号递增', async () => {
  const { frame } = await mountApp();
  pressCtrlV(frame);
  await frame.flush();
  pressCtrlV(frame);
  await frame.flush();

  const out = frame.frame();
  assert.ok(out.includes('[image #1]'), `第一张：\n${out.slice(-300)}`);
  assert.ok(out.includes('[image #2]'), `第二张编号递增：\n${out.slice(-300)}`);
  await frame.cleanup();
});

test('回归：带图片的草稿提交后，正文剥掉占位符、图片数据随消息带出', async () => {
  const { submitted, frame } = await mountApp();
  await frame.typeText('看图');
  await frame.flush();
  pressCtrlV(frame);
  await frame.flush();

  await frame.press(KeyCodes.RETURN);
  await frame.flush();

  assert.equal(submitted.length, 1, '带图片的草稿应能提交');
  const payload = submitted[0] as { text: string; images?: { media_type: string }[] };
  assert.equal(payload.text, '看图', '占位符从正文里剥掉');
  assert.equal(payload.images?.length, 1, '图片数据随消息带出');
  assert.equal(payload.images?.[0]?.media_type, 'image/png');
  await frame.cleanup();
});

test('无图片：onImagePaste 返回 null 时 Ctrl+V 不插入任何东西', async () => {
  // 直接测 PromptInput：换 mock 要重载 App 模块，而这条分支的判定就在组件内
  const frame = await renderOtui(
    React.createElement(PromptInput, {
      value: '原文',
      onChange: () => {},
      onSubmit: () => {},
      onImagePaste: () => null,
    }),
    { width: 70, height: 10 },
  );

  pressCtrlV(frame);
  await frame.flush();

  const out = frame.frame();
  assert.ok(!out.includes('[image #'), `不该出现占位符：\n${out.slice(-300)}`);
  assert.ok(out.includes('原文'), '原草稿不受影响');
  await frame.cleanup();
});

test('占位符插在光标处而不是草稿末尾', async () => {
  const { frame } = await mountApp();
  await frame.typeText('ABCD');
  await frame.flush();
  // 光标左移两格 → 应当插在 AB 与 CD 之间
  await frame.press(KeyCodes.ARROW_LEFT);
  await frame.press(KeyCodes.ARROW_LEFT);
  await frame.flush();

  pressCtrlV(frame);
  await frame.flush();

  assert.ok(
    frame.frame().includes('AB[image #1]CD'),
    `应插在光标处：\n${frame.frame().slice(-300)}`,
  );
  await frame.cleanup();
});

/**
 * Windows 关键路径：**空粘贴事件** → 读剪贴板图片。
 *
 * Windows Terminal 默认把 Ctrl+V 绑成自己的"粘贴"动作，按键传不到应用。
 * 剪贴板是文本时它合成 paste 事件发过来（正常流程）；是**图片**时没文本可发，
 * 事件是空的。不处理空粘贴，Windows 上按 Ctrl+V 就是彻底没反应。
 */
test('Windows 路径：空粘贴事件会去读剪贴板图片并插入占位符', async () => {
  const { frame } = await mountApp();
  await frame.typeText('截图');
  await frame.flush();

  // 空括号粘贴 = 终端发来的「有粘贴动作但没有文本」，正是图片场景
  await frame.raw.mockInput.pasteBracketedText('');
  await frame.flush();

  assert.ok(
    frame.frame().includes('截图[image #1]'),
    `空粘贴应转成图片占位符：\n${frame.frame().slice(-300)}`,
  );
  await frame.cleanup();
});

test('Windows 路径：带文本的粘贴仍然只贴文本，不去读图片', async () => {
  const { frame } = await mountApp();
  await frame.raw.mockInput.pasteBracketedText('纯文本');
  await frame.flush();

  const out = frame.frame();
  assert.ok(out.includes('纯文本'), `文本粘贴正常：\n${out.slice(-300)}`);
  assert.ok(!out.includes('[image #'), `有文本时不该插入图片占位符：\n${out.slice(-300)}`);
  await frame.cleanup();
});

test('一次粘贴只插入一张图（App 与 PromptInput 不重复处理）', async () => {
  const { frame } = await mountApp();
  // 同一次空粘贴：App 的 usePaste 和 PromptInput 的 onPaste 都会收到。
  // 职责分离后只有组件侧处理图片，插入次数必须是 1。
  await frame.raw.mockInput.pasteBracketedText('');
  await frame.flush();

  const out = frame.frame();
  assert.equal(out.split('[image #1]').length - 1, 1, `只应插入一次：\n${out.slice(-300)}`);
  assert.ok(!out.includes('[image #2]'), `不该有第二张：\n${out.slice(-300)}`);
  await frame.cleanup();
});
