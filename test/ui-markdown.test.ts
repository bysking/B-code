import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { Markdown } from '../src/ui/markdown-view.js';

function renderMd(text: string): string {
  const frame = render(React.createElement(Markdown, { text }));
  const out = frame.lastFrame() ?? '';
  frame.cleanup();
  return out;
}

test('表格：GFM 表格渲染为对齐表格（cli-table3 边框）', () => {
  const out = renderMd('| 组件 | 状态 |\n|---|---|\n| Markdown | 可用 |\n');
  assert.ok(out.includes('┌'), '表头左上边框');
  assert.ok(out.includes('│'), '列分隔线');
  assert.ok(out.includes('Markdown'));
  assert.ok(out.includes('可用'));
});

test('流式容错：半截表格（未到分隔行）按文本降级不吞字', () => {
  const out = renderMd('| 组件 | 状态\n| Markdown | 渲染中');
  assert.ok(out.includes('| 组件 | 状态'));
  assert.ok(out.includes('渲染中'));
});

test('流式容错：未闭合代码块按代码渲染到结尾，fence 不泄漏', () => {
  const out = renderMd('```js\nconst a = 1\n');
  assert.ok(out.includes('const a = 1'));
  assert.ok(!out.includes('```'), 'fence 标记不原样泄漏');
});

test('流式容错：未闭合粗体按原文显示', () => {
  const out = renderMd('这句话有**未闭合的粗体');
  assert.ok(out.includes('**未闭合的粗体'));
});

test('标题 / 列表 / 引用 / 行内基础渲染', () => {
  const out = renderMd('## 标题\n\n- a\n- b\n\n> 引用\n\n行内 `code` 与 **bold**');
  assert.ok(out.includes('标题'));
  assert.ok(out.includes('a'));
  assert.ok(out.includes('引用'));
  assert.ok(out.includes('code'));
  assert.ok(out.includes('bold'));
});
