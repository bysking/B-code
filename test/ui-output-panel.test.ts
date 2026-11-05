import { test } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderOtui } from './helpers/otui-test.js';
import { OutputPanel } from '../src/ui/views/output-panel.js';
import type { ToolCallDisplay } from '../src/ui/controller.js';

/**
 * 工具输出面板（Ctrl+O）。
 *
 * ## 重写说明
 *
 * 旧版测试验证"手算行数 + 手动偏移滚动"那套机制（`outputPanelMaxScroll` 的精确值、
 * `scroll` 参数的效果、按行数裁剪的边界）。那套代码切到 OpenTUI 后已删除——
 * 滚动交给原生 `<scrollbox>`，应用层不再需要算行数。
 *
 * 现在验证面板的**语义**：两页不串、空态有提示、长内容不丢、高度受约束。
 */

function tool(
  id: string,
  lines: number,
  extra: (i: number) => string = (i) => `line ${i}`,
): ToolCallDisplay {
  return {
    id,
    name: `tool_${id}`,
    input: `{"id":"${id}"}`,
    status: 'done',
    output: Array.from({ length: lines }, (_, i) => extra(i)).join('\n'),
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function renderPanel(
  props: Parameters<typeof OutputPanel>[0],
  size = { width: 100, height: 30 },
) {
  const frame = await renderOtui(React.createElement(OutputPanel, props), size);
  await wait(50);
  await frame.flush();
  return frame;
}

test('面板：工具页展示工具名与输出内容', async () => {
  const f = await renderPanel({ tools: [tool('a', 3)], termRows: 30 });
  const out = f.frame();
  assert.ok(out.includes('tool_a'), '工具名可见');
  assert.ok(out.includes('line 0'), '输出内容可见');
  await f.cleanup();
});

test('面板：日志页展示系统日志，工具页不混入', async () => {
  const tools = [tool('a', 2)];
  const logs = ['[INFO] mcp connected: tavily', '[WARN] hook exited 1'];

  const toolsFrame = await renderPanel({ tools, logs, tab: 'tools', termRows: 30 });
  const toolsText = toolsFrame.frame();
  assert.ok(!toolsText.includes('mcp connected'), '工具页不混入日志');
  assert.ok(toolsText.includes('2 日志'), '标题显示日志条数便于发现');
  await toolsFrame.cleanup();

  const logsFrame = await renderPanel({ tools, logs, tab: 'logs', termRows: 30 });
  const logsText = logsFrame.frame();
  assert.ok(logsText.includes('mcp connected: tavily'), '日志页能看到 INFO');
  assert.ok(logsText.includes('hook exited 1'), '日志页能看到 WARN');
  await logsFrame.cleanup();
});

test('面板：两个页面的空态各有提示', async () => {
  const t = await renderPanel({ tools: [], logs: [], tab: 'tools', termRows: 30 });
  assert.ok(t.frame().includes('暂无已完成的工具调用'));
  await t.cleanup();

  const l = await renderPanel({ tools: [], logs: [], tab: 'logs', termRows: 30 });
  assert.ok(l.frame().includes('暂无日志'));
  await l.cleanup();
});

test('面板：超长单行完整保留（不被截断成固定字符数）', async () => {
  // 旧实现有 2000 字符上限，会让长日志看不全
  const long = 'x'.repeat(5000);
  const tools: ToolCallDisplay[] = [
    { id: 't', name: 'run_shell', input: '{}', status: 'done', output: long },
  ];
  const f = await renderPanel({ tools, termRows: 40 }, { width: 120, height: 40 });
  const rendered = f.frame().replace(/[\s│╭╮╰╯─]/g, '').length;
  assert.ok(rendered > 2000, `超长输出应基本完整可见（实际约 ${rendered} 字符）`);
  await f.cleanup();
});

test('面板：高度受 termRows 约束，不会撑满整屏', async () => {
  const tools = Array.from({ length: 20 }, (_, i) => tool(`t${i}`, 40));
  const termRows = 30;
  const f = await renderPanel({ tools, termRows }, { width: 100, height: 60 });
  const lines = f.frame().split('\n').filter((l) => l.trim().length > 0);
  assert.ok(lines.length <= termRows, `面板帧高 ${lines.length} 应 ≤ termRows ${termRows}`);
  await f.cleanup();
});

test('面板：大量内容不崩，首条可见', async () => {
  const tools = Array.from({ length: 10 }, (_, i) => tool(`t${i}`, 30));
  const f = await renderPanel({ tools, termRows: 30 });
  assert.ok(f.frame().includes('tool_t0'), '首条工具可见');
  await f.cleanup();
});
