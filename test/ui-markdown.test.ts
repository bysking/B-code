import { test } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { Markdown } from '../src/ui/markdown-view.js';
import { renderOtui } from './helpers/otui-test.js';

/**
 * Markdown 渲染测试。
 *
 * 从 ink-testing-library 迁到 OpenTUI 测试渲染器（见 helpers/otui-test.ts）：
 * OpenTUI 的原生 FFI 只能在 Bun 下加载，所以整个套件跑 `bun test`。
 *
 * 渲染是异步的（`renderOtui` 返回 Promise），因此每条测试改成 async。
 */

async function renderMd(text: string): Promise<string> {
  const frame = await renderOtui(React.createElement(Markdown, { text }), {
    width: 80,
    height: 30,
  });
  const out = frame.frame();
  await frame.cleanup();
  return out;
}

test('表格：GFM 表格渲染为对齐表格（cli-table3 边框）', async () => {
  const out = await renderMd('| 组件 | 状态 |\n|---|---|\n| Markdown | 可用 |\n');
  assert.ok(out.includes('┌'), '表头左上边框');
  assert.ok(out.includes('│'), '列分隔线');
  assert.ok(out.includes('Markdown'));
  assert.ok(out.includes('可用'));
});

test('流式容错：半截表格（未到分隔行）按文本降级不吞字', async () => {
  const out = await renderMd('| 组件 | 状态\n| Markdown | 渲染中');
  assert.ok(out.includes('| 组件 | 状态'));
  assert.ok(out.includes('渲染中'));
});

test('流式容错：未闭合代码块按代码渲染到结尾，fence 不泄漏', async () => {
  const out = await renderMd('```js\nconst a = 1\n');
  assert.ok(out.includes('const a = 1'));
  assert.ok(!out.includes('```'), 'fence 标记不原样泄漏');
});

test('流式容错：未闭合粗体按原文显示', async () => {
  const out = await renderMd('这句话有**未闭合的粗体');
  assert.ok(out.includes('**未闭合的粗体'));
});

test('标题 / 列表 / 引用 / 行内基础渲染', async () => {
  const out = await renderMd('## 标题\n\n- a\n- b\n\n> 引用\n\n行内 `code` 与 **bold**');
  assert.ok(out.includes('标题'));
  assert.ok(out.includes('a'));
  assert.ok(out.includes('引用'));
  assert.ok(out.includes('code'));
  assert.ok(out.includes('bold'));
});
