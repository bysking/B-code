import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { OutputPanel, outputPanelMaxScroll, outputPanelScrollable } from '../src/ui/output-panel.js';
import { terminalRows } from '../src/ui/scroll-budget.js';
import type { ToolCallDisplay } from '../src/ui/controller.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tool(id: string, lines: number, extra: (i: number) => string = (i) => `line ${i}`): ToolCallDisplay {
  return {
    id,
    name: `tool_${id}`,
    input: `{"id":"${id}"}`,
    status: 'done',
    output: Array.from({ length: lines }, (_, i) => extra(i)).join('\n'),
  };
}

const frameHeight = (s: string) => s.split('\n').length - 1; // lastFrame 末尾带换行

// ── 完整日志可见性：这是 Ctrl+O 存在的意义 ──────────────────────

test('面板：输出很多时贴底显示的是**最新**内容（旧实现从最旧的开始填，永远看不到最新）', async () => {
  const tools = Array.from({ length: 5 }, (_, i) => tool(`t${i}`, 40));
  const f = render(React.createElement(OutputPanel, { tools, scroll: 0 }));
  await wait(120);
  const frame = f.lastFrame() ?? '';

  assert.ok(frame.includes('line 39'), '贴底必须能看到最后一行输出');
  // 窗口落在最后一个工具的长输出中段，标题行在窗口外 → 归属靠位置提示交代
  assert.ok(frame.includes('当前：tool_t4'), '位置提示须标明当前日志属于哪个工具');
  f.cleanup();
});

const PANEL_TEST_ROWS = 40;

test('面板：翻页后能看到最早的内容（完整日志可达）', async () => {
  const tools = Array.from({ length: 5 }, (_, i) => tool(`t${i}`, 40));
  // 显式给 termRows：组件内 useWindowSize 取的是 ink 渲染流尺寸（测试里可能与
  // 纯函数的默认 40 不同），两边必须用同一口径算 max，否则 scroll 会越界被夹掉
  const max = outputPanelMaxScroll(tools, 'tools', [], PANEL_TEST_ROWS);
  assert.ok(max > 0, '内容超一屏 → 可翻页');

  const f = render(React.createElement(OutputPanel, { tools, scroll: max, termRows: PANEL_TEST_ROWS }));
  await wait(120);
  const frame = f.lastFrame() ?? '';
  assert.ok(frame.includes('tool_t0'), '翻到最上能看到最早的工具');
  assert.ok(frame.includes('line 0'), '翻到最上能看到第一行');
  f.cleanup();
});

test('面板：单条超长输出不被截断成 2000 字符（旧上限会让日志看不全）', async () => {
  const long = 'x'.repeat(5000);
  const tools: ToolCallDisplay[] = [
    { id: 't', name: 'run_shell', input: '{}', status: 'done', output: long },
  ];
  const f = render(React.createElement(OutputPanel, { tools, scroll: 0 }));
  await wait(120);
  const frame = f.lastFrame() ?? '';

  const rendered = frame.replace(/[│╭╮╰╯─\s]/g, '').length;
  assert.ok(rendered > 2000, `超长输出应基本完整可见（实际渲染约 ${rendered} 字符）`);
  f.cleanup();
});

// ── 高度安全：撑爆终端会触发 ink 整屏清屏（连 scrollback 一起清） ──

test('面板：帧高始终小于终端行数（否则 ESC[3J 会把用户回看的历史一起清掉）', async () => {
  const tools = Array.from({ length: 6 }, (_, i) => tool(`t${i}`, 50));
  const f = render(React.createElement(OutputPanel, { tools, scroll: 0 }));
  await wait(120);
  const h = frameHeight(f.lastFrame() ?? '');
  assert.ok(h < terminalRows(), `帧高 ${h} 必须小于终端 ${terminalRows()} 行`);
  f.cleanup();
});

test('面板：超长单行（软换行）也计入高度预算', async () => {
  // 一条 300 字符的行在 80 列终端会折成约 4 行；若按 \n 计数就会低估、撑爆预算
  const tools = [tool('a', 20, (i) => (i === 5 ? 'X'.repeat(300) : `line ${i}`))];
  const f = render(React.createElement(OutputPanel, { tools, scroll: 0 }));
  await wait(120);
  const h = frameHeight(f.lastFrame() ?? '');
  assert.ok(h < terminalRows(), `含超长行时帧高 ${h} 仍须小于 ${terminalRows()}`);
  f.cleanup();
});

// ── 边界 ────────────────────────────────────────────────────────

test('面板：没有已完成的工具时显示占位提示，且不可滚', async () => {
  const tools: ToolCallDisplay[] = [{ id: 'x', name: 'running_tool', input: '{}', status: 'running' }];
  assert.equal(outputPanelScrollable(tools), false);
  assert.equal(outputPanelMaxScroll(tools), 0);

  const f = render(React.createElement(OutputPanel, { tools, scroll: 0 }));
  await wait(80);
  assert.ok((f.lastFrame() ?? '').includes('暂无已完成的工具调用'));
  f.cleanup();
});

test('面板：内容不足一屏时不可滚，且没有翻页提示', async () => {
  const tools = [tool('a', 2)];
  assert.equal(outputPanelScrollable(tools), false);
  const f = render(React.createElement(OutputPanel, { tools, scroll: 0 }));
  await wait(80);
  const frame = f.lastFrame() ?? '';
  assert.ok(!frame.includes('可用 ↑↓ 翻页'), '一屏放得下就不该提示翻页');
  f.cleanup();
});

test('面板：scroll 超出范围时自动夹紧（不会渲染成空白）', async () => {
  const tools = Array.from({ length: 3 }, (_, i) => tool(`t${i}`, 20));
  const f = render(React.createElement(OutputPanel, { tools, scroll: 99999 }));
  await wait(120);
  const frame = f.lastFrame() ?? '';
  assert.ok(frame.includes('tool_t0'), '越界仍应钳到最上端，而不是空白');
  f.cleanup();
});

// ── 日志页：log.info/warn/error 被接管后在这里可见 ──────────────

test('面板：日志标签页展示系统日志，工具页不混入', async () => {
  const tools = [tool('a', 2)];
  const logs = ['[INFO] mcp connected: tavily', '[WARN] hook exited 1: cmd'];

  const toolsFrame = render(React.createElement(OutputPanel, { tools, logs, tab: 'tools', scroll: 0 }));
  await wait(100);
  const tf = toolsFrame.lastFrame() ?? '';
  assert.ok(!tf.includes('mcp connected'), '工具页不应混入日志');
  assert.ok(tf.includes('日志（2）'), '标题显示日志条数，便于发现');
  toolsFrame.cleanup();

  const logsFrame = render(React.createElement(OutputPanel, { tools, logs, tab: 'logs', scroll: 0 }));
  await wait(100);
  const lf = logsFrame.lastFrame() ?? '';
  assert.ok(lf.includes('mcp connected: tavily'), '日志页能看到 INFO');
  assert.ok(lf.includes('hook exited 1'), '日志页能看到 WARN');
  assert.ok(!lf.includes('当前：'), '日志页不应显示工具归属');
  logsFrame.cleanup();
});

test('面板：日志很多时同样受高度预算约束，并可翻页', async () => {
  const tools: ToolCallDisplay[] = [];
  const logs = Array.from({ length: 300 }, (_, i) => `[INFO] log line ${i}`);
  assert.ok(outputPanelMaxScroll(tools, 'logs', logs) > 0, '日志超一屏 → 可翻页');

  const f = render(React.createElement(OutputPanel, { tools, logs, tab: 'logs', scroll: 0 }));
  await wait(120);
  const h = frameHeight(f.lastFrame() ?? '');
  assert.ok(h < terminalRows(), `日志页帧高 ${h} 也须小于终端 ${terminalRows()} 行`);
  assert.ok((f.lastFrame() ?? '').includes('log line 299'), '贴底看最新日志');
  f.cleanup();
});

test('面板：日志页空态提示', async () => {
  const f = render(React.createElement(OutputPanel, { tools: [], logs: [], tab: 'logs', scroll: 0 }));
  await wait(80);
  assert.ok((f.lastFrame() ?? '').includes('暂无系统日志'));
  f.cleanup();
});
