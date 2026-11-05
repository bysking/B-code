import { test, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';
import { createRoot, useRenderer } from '@opentui/react';
import { SyntaxStyle } from '@opentui/core';

/**
 * Markdown 渲染测试（OpenTUI 原生 `<markdown>`）。
 *
 * ## 为什么整组共用一个渲染器
 *
 * OpenTUI 的 markdown 把 `SyntaxStyle` 绑在渲染器的原生资源上（`nativeScene`）。
 * 每个用例新建/销毁渲染器时，原生资源释放是**异步**的——下一个用例可能拿到
 * 已销毁的资源上下文，渲染出空白画面。
 *
 * 实测：单独跑每个用例都过，连续跑必有几个空白。改成"一个渲染器 + 多次 rerender"
 * 后全部稳定，也更接近真实使用（用户在一个会话里连续看到不同内容）。
 */

let setup: TestRendererSetup;
let root: ReturnType<typeof createRoot>;
let sharedStyle: SyntaxStyle;

beforeAll(async () => {
  setup = await createTestRenderer({ width: 80, height: 30 });
  root = createRoot(setup.renderer as never);
});

afterAll(async () => {
  await setup.dispose();
});

/** 渲染一段 markdown，返回纯文本 */
async function renderMd(content: string): Promise<string> {
  function M() {
    // 每次渲染复用同一个 style（绑定在同一个渲染器上，安全）
    return React.createElement('markdown', { content, syntaxStyle: sharedStyle });
  }
  function WithStyle() {
    const r = useRenderer() as unknown as { nativeScene: never };
    if (!sharedStyle) sharedStyle = SyntaxStyle.create(r.nativeScene);
    return React.createElement(M);
  }
  root.render(React.createElement(WithStyle));
  await setup.renderOnce();
  // markdown 是异步解析的（tree-sitter），首帧常为空，等它落地
  await new Promise((r) => setTimeout(r, 150));
  await setup.renderOnce();
  return setup.captureCharFrame();
}

test('Markdown：表格渲染为对齐表格（边框可见）', async () => {
  const out = await renderMd('| 组件 | 状态 |\n|---|---|\n| Markdown | 可用 |');
  assert.ok(out.includes('┌') || out.includes('│'), `应有表格边框：${out.slice(0, 200)}`);
  assert.ok(out.includes('Markdown'), '表格内容可见');
  assert.ok(out.includes('可用'));
});

test('Markdown：标题/列表/引用/行内样式的内容都在', async () => {
  const out = await renderMd('## 标题\n\n- a\n\n> 引用\n\n`code` **bold**');
  for (const needle of ['标题', 'a', '引用', 'code', 'bold']) {
    assert.ok(out.includes(needle), `应包含 ${needle}：${out.slice(0, 200)}`);
  }
});

test('Markdown：代码块内容完整，fence 标记不泄漏', async () => {
  const out = await renderMd('```js\nconst a = 1\n```');
  assert.ok(out.includes('const a = 1'), `代码内容可见：${out.slice(0, 200)}`);
  assert.ok(!out.includes('```'), '围栏标记不应原样显示');
});

test('Markdown：半截表格按原文降级，不吞字', async () => {
  const out = await renderMd('| 组件 | 状态\n| Markdown | 渲染中');
  assert.ok(out.includes('组件'), `内容不应丢失：${out.slice(0, 200)}`);
  assert.ok(out.includes('渲染中'));
});

test('Markdown：未闭合粗体按原文显示', async () => {
  const out = await renderMd('这句话有**未闭合的粗体');
  assert.ok(out.includes('未闭合的粗体'), `应按原文显示：${out.slice(0, 200)}`);
});

test('Markdown：空内容不渲染（返回 null）', async () => {
  const out = await renderMd('');
  assert.equal(out.trim(), '', '空内容不应留下任何字符');
});
