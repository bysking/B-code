import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/app.js';
import { AppController, type CapabilityItem, type CapabilityKind } from '../src/ui/controller.js';
import { capabilityPanelHeight } from '../src/ui/capability-panel.js';

/**
 * 能力面板（/skills、/mcp）交互测试：空格启停 · R 重连 · Esc 关闭。
 *
 * 用 ink-testing-library 直接喂按键，断言回调收到正确的 name。
 * 数据源由测试注入（不碰真实 skills 目录/真实 MCP 子进程）。
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (out: string): string => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function renderApp(
  ctrl: AppController,
  hooks: {
    onToggleCapability?: (name: string) => void;
    onReconnectCapability?: (name: string) => void;
    refreshCapability?: () => void;
  } = {},
) {
  return render(
    React.createElement(App, {
      ctrl,
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
      onSetMode: () => {},
      onToggleCapability: hooks.onToggleCapability,
      onReconnectCapability: hooks.onReconnectCapability,
      refreshCapability: hooks.refreshCapability,
      initialOutput: undefined,
    }),
  );
}

const press = async (frame: { stdin: { write: (s: string) => void } }, keys: string) => {
  frame.stdin.write(keys);
  await wait(20);
};

const SKILLS: CapabilityItem[] = [
  { name: 'commit', enabled: true, detail: '生成 commit 信息' },
  { name: 'red-line-check', enabled: false, detail: '红线检查' },
];

const MCPS: CapabilityItem[] = [
  { name: 'github', enabled: true, detail: 'node server.js · 12 工具', connected: true },
  { name: 'jira', enabled: false, detail: 'node jira.js · 未连接', connected: false },
];

test('面板渲染：逐项展示启用状态与描述', async () => {
  const ctrl = new AppController();
  ctrl.openCapability('skill', SKILLS);
  const frame = renderApp(ctrl);
  await wait(40);
  const out = stripAnsi(frame.lastFrame() ?? '');
  assert.ok(out.includes('🔧 技能'), '标题');
  assert.ok(out.includes('1 启用 / 2'), '启用计数');
  assert.ok(out.includes('commit'), '第一项');
  assert.ok(out.includes('☑'), '启用勾选框');
  assert.ok(out.includes('☐'), '禁用空框');
  assert.ok(out.includes('red-line-check'), '第二项');
  assert.ok(out.includes('空格 启停'), '键位提示');
  frame.cleanup();
});

test('空格：切换当前选中项的启停', async () => {
  const ctrl = new AppController();
  const toggled: string[] = [];
  ctrl.openCapability('skill', SKILLS);
  const frame = renderApp(ctrl, { onToggleCapability: (n) => toggled.push(n) });
  await wait(40);

  await press(frame, ' '); // 第一项 commit
  assert.deepEqual(toggled, ['commit']);

  await press(frame, '\u001B[B'); // ↓
  await press(frame, ' ');
  assert.deepEqual(toggled, ['commit', 'red-line-check'], '下移后切换第二项');
  frame.cleanup();
});

test('↓↑ 循环移动选择，j/k 等价', async () => {
  const ctrl = new AppController();
  const toggled: string[] = [];
  ctrl.openCapability('skill', SKILLS);
  const frame = renderApp(ctrl, { onToggleCapability: (n) => toggled.push(n) });
  await wait(40);

  await press(frame, 'j'); // 下移到 red-line-check
  await press(frame, 'k'); // 回到 commit
  await press(frame, ' ');
  assert.deepEqual(toggled, ['commit'], 'k/j 与方向键同义');
  frame.cleanup();
});

test('MCP 面板：R 键触发重连，且带行内提示', async () => {
  const ctrl = new AppController();
  const reconnected: string[] = [];
  ctrl.openCapability('mcp', MCPS);
  const frame = renderApp(ctrl, {
    onReconnectCapability: (n) => {
      reconnected.push(n);
      ctrl.setCapabilityNotice(n, '重连中…');
    },
  });
  await wait(40);

  await press(frame, 'r');
  assert.deepEqual(reconnected, ['github'], 'R 重连当前项');
  await wait(30);
  assert.ok(stripAnsi(frame.lastFrame() ?? '').includes('重连中…'), '行内提示可见');
  frame.cleanup();
});

test('技能面板：R 键无作用（技能没有连接概念）', async () => {
  const ctrl = new AppController();
  const reconnected: string[] = [];
  ctrl.openCapability('skill', SKILLS);
  const frame = renderApp(ctrl, { onReconnectCapability: (n) => reconnected.push(n) });
  await wait(40);

  await press(frame, 'r');
  assert.deepEqual(reconnected, [], 'kind=skill 时 R 不触发回调');
  frame.cleanup();
});

test('Esc：关闭面板，输入框恢复可用', async () => {
  const ctrl = new AppController();
  ctrl.openCapability('mcp', MCPS);
  const frame = renderApp(ctrl);
  await wait(40);
  assert.ok(ctrl.capabilityPanel, '已打开');

  await press(frame, '\u001B'); // Esc
  await wait(30);
  assert.equal(ctrl.capabilityPanel, null, 'Esc 关闭面板');
  frame.cleanup();
});

test('空列表给出提示，不渲染空框', async () => {
  const ctrl = new AppController();
  ctrl.openCapability('skill', []);
  const frame = renderApp(ctrl);
  await wait(40);
  const out = stripAnsi(frame.lastFrame() ?? '');
  assert.ok(out.includes('没有可用技能'), '空态提示');
  assert.ok(out.includes('0 启用 / 0'), '计数为 0');
  frame.cleanup();
});

test('setCapabilityNotice：只改指定行，其余行不变', () => {
  const ctrl = new AppController();
  ctrl.openCapability('mcp', MCPS);
  ctrl.setCapabilityNotice('github', '✓ 已重连（12 工具）');
  const items = ctrl.capabilityPanel!.items;
  assert.equal(items[0]!.notice, '✓ 已重连（12 工具）');
  assert.equal(items[1]!.notice, undefined, '其他行不受影响');
});

test('setCapabilityItems：覆盖后保持面板打开（刷新数据不闪退）', () => {
  const ctrl = new AppController();
  ctrl.openCapability('skill', SKILLS);
  ctrl.setCapabilityItems([{ name: 'commit', enabled: false, detail: 'd' }]);
  assert.equal(ctrl.capabilityPanel?.kind, 'skill');
  assert.equal(ctrl.capabilityPanel?.items.length, 1);
  assert.equal(ctrl.capabilityPanel?.items[0]?.enabled, false);
});

test('能力面板打开时 App 让出键盘（Ctrl+C 不退出）', async () => {
  const ctrl = new AppController();
  let exited = false;
  ctrl.openCapability('skill', SKILLS);
  const frame = render(
    React.createElement(App, {
      ctrl,
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {
        exited = true;
      },
      onSetMode: () => {},
      initialOutput: undefined,
    }),
  );
  await wait(40);
  await press(frame, '\u0003'); // Ctrl+C
  await wait(30);
  assert.equal(exited, false, '面板打开时 Ctrl+C 由 App 忽略（不退出）');
  frame.cleanup();
});

// ── 面板高度（live 预算口径）────────────────────────────────
test('capabilityPanelHeight：随条目增长，且不随无限条目无限膨胀', () => {
  const few = capabilityPanelHeight([SKILLS[0]!], { cols: 100 });
  const many = capabilityPanelHeight(SKILLS, { cols: 100 });
  assert.ok(many > few, '条目多则更高');

  const huge = Array.from({ length: 100 }, (_, i) => ({
    name: `s${i}`,
    enabled: true,
    detail: 'd',
  }));
  const capped = capabilityPanelHeight(huge, { cols: 100 });
  assert.ok(capped <= 16 + 5 + 1, '受 MAX_PANEL_LINES 封顶，不会撑爆终端');
  assert.ok(capped > 0);
});

test('capabilityPanelHeight：矮终端上限更低', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ name: `s${i}`, enabled: true }));
  const normal = capabilityPanelHeight(items, { cols: 100, compact: false });
  const compact = capabilityPanelHeight(items, { cols: 100, compact: true });
  assert.ok(compact < normal, '矮终端上面板更矮（正文优先）');
});

test('kind 类型约束：只有 skill / mcp 两种', () => {
  const kinds: CapabilityKind[] = ['skill', 'mcp'];
  assert.equal(kinds.length, 2);
});
