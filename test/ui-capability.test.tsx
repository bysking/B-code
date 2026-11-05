import { test } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderOtui } from './helpers/otui-test.js';
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

async function renderApp(
  ctrl: AppController,
  hooks: {
    onToggleCapability?: (name: string) => void;
    onReconnectCapability?: (name: string) => void;
    refreshCapability?: () => void;
  } = {},
) {
  return renderOtui(
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
    { width: 100, height: 40 },
  );
}

const press = async (frame: { press: (k: string) => Promise<void>; flush: () => Promise<void> }, keys: string) => {
  await frame.press(keys);
  await wait(20);
  await frame.flush();
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
  const frame = await renderApp(ctrl);
  await wait(40);
  await frame.flush();
  const out = stripAnsi(frame.frame());
  assert.ok(out.includes('🔧 技能'), '标题');
  assert.ok(out.includes('1 启用 / 2'), '启用计数');
  assert.ok(out.includes('commit'), '第一项');
  assert.ok(out.includes('☑'), '启用勾选框');
  assert.ok(out.includes('☐'), '禁用空框');
  assert.ok(out.includes('red-line-check'), '第二项');
  assert.ok(out.includes('空格 启停'), '键位提示');
  await frame.cleanup();
});

test('空格：切换当前选中项的启停', async () => {
  const ctrl = new AppController();
  const toggled: string[] = [];
  ctrl.openCapability('skill', SKILLS);
  const frame = await renderApp(ctrl, { onToggleCapability: (n) => toggled.push(n) });
  await wait(40);
  await frame.flush();

  await press(frame, ' '); // 第一项 commit
  assert.deepEqual(toggled, ['commit']);

  await press(frame, '\u001B[B'); // ↓
  await press(frame, ' ');
  assert.deepEqual(toggled, ['commit', 'red-line-check'], '下移后切换第二项');
  await frame.cleanup();
});

test('↓↑ 循环移动选择，j/k 等价', async () => {
  const ctrl = new AppController();
  const toggled: string[] = [];
  ctrl.openCapability('skill', SKILLS);
  const frame = await renderApp(ctrl, { onToggleCapability: (n) => toggled.push(n) });
  await wait(40);
  await frame.flush();

  await press(frame, 'j'); // 下移到 red-line-check
  await press(frame, 'k'); // 回到 commit
  await press(frame, ' ');
  assert.deepEqual(toggled, ['commit'], 'k/j 与方向键同义');
  await frame.cleanup();
});

test('MCP 面板：R 键触发重连，且带行内提示', async () => {
  const ctrl = new AppController();
  const reconnected: string[] = [];
  ctrl.openCapability('mcp', MCPS);
  const frame = await renderApp(ctrl, {
    onReconnectCapability: (n) => {
      reconnected.push(n);
      ctrl.setCapabilityNotice(n, '重连中…');
    },
  });
  await wait(40);
  await frame.flush();

  await press(frame, 'r');
  assert.deepEqual(reconnected, ['github'], 'R 重连当前项');
  await wait(30);
  await frame.flush();
  assert.ok(stripAnsi(frame.frame()).includes('重连中…'), '行内提示可见');
  await frame.cleanup();
});

test('技能面板：R 键无作用（技能没有连接概念）', async () => {
  const ctrl = new AppController();
  const reconnected: string[] = [];
  ctrl.openCapability('skill', SKILLS);
  const frame = await renderApp(ctrl, { onReconnectCapability: (n) => reconnected.push(n) });
  await wait(40);
  await frame.flush();

  await press(frame, 'r');
  assert.deepEqual(reconnected, [], 'kind=skill 时 R 不触发回调');
  await frame.cleanup();
});

test('Esc：关闭面板，输入框恢复可用', async () => {
  const ctrl = new AppController();
  ctrl.openCapability('mcp', MCPS);
  const frame = await renderApp(ctrl);
  await wait(40);
  await frame.flush();
  assert.ok(ctrl.capabilityPanel, '已打开');

  await press(frame, '\u001B'); // Esc
  await wait(30);
  await frame.flush();
  assert.equal(ctrl.capabilityPanel, null, 'Esc 关闭面板');
  await frame.cleanup();
});

test('空列表给出提示，不渲染空框', async () => {
  const ctrl = new AppController();
  ctrl.openCapability('skill', []);
  const frame = await renderApp(ctrl);
  await wait(40);
  await frame.flush();
  const out = stripAnsi(frame.frame());
  assert.ok(out.includes('没有可用技能'), '空态提示');
  assert.ok(out.includes('0 启用 / 0'), '计数为 0');
  await frame.cleanup();
});

test('setCapabilityNotice：只改指定行，其余行不变', async () => {
  const ctrl = new AppController();
  ctrl.openCapability('mcp', MCPS);
  ctrl.setCapabilityNotice('github', '✓ 已重连（12 工具）');
  const items = ctrl.capabilityPanel!.items;
  assert.equal(items[0]!.notice, '✓ 已重连（12 工具）');
  assert.equal(items[1]!.notice, undefined, '其他行不受影响');
});

test('setCapabilityItems：覆盖后保持面板打开（刷新数据不闪退）', async () => {
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
  const frame = await renderOtui(
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
  await frame.flush();
  await press(frame, '\u0003'); // Ctrl+C
  await wait(30);
  await frame.flush();
  assert.equal(exited, false, '面板打开时 Ctrl+C 由 App 忽略（不退出）');
  await frame.cleanup();
});

// ── 面板高度与滚动窗口 ──────────────────────────────────────
test('capabilityPanelHeight：条目多时受可见条数封顶，不会撑爆终端', async () => {
  const few = capabilityPanelHeight([SKILLS[0]!]);
  const many = capabilityPanelHeight(SKILLS);
  assert.ok(many > few, '条目多则更高');

  const huge = Array.from({ length: 100 }, (_, i) => ({ name: `s${i}`, enabled: true }));
  const capped = capabilityPanelHeight(huge);
  assert.ok(capped <= 6 + 12 + 1, '受可见条数上限封顶');
  assert.ok(capped > 0);
});

test('回归：条目超出一屏时，光标能滚到最后的项（不再永久隐藏）', async () => {
  // 旧实现用"头部裁切 + 还有 N 项"，被裁掉的项永远看不到也选不到。
  // 现在窗口随光标滚动，最后一项必须能翻到。
  const many: CapabilityItem[] = Array.from({ length: 20 }, (_, i) => ({
    name: `skill-${String(i + 1).padStart(2, '0')}`,
    enabled: true,
  }));
  const ctrl = new AppController();
  const toggled: string[] = [];
  ctrl.openCapability('skill', many);
  const frame = await renderApp(ctrl, { onToggleCapability: (n) => toggled.push(n) });
  await wait(60);
  await frame.flush();

  // 逐次 ↓ 到底（每次等光标真的移动到位，避免高频按键被丢）
  for (let i = 2; i <= 20; i++) {
    const target = `skill-${String(i).padStart(2, '0')}`;
    let reached = false;
    for (let attempt = 0; attempt < 30 && !reached; attempt++) {
      await frame.press('\x1b[B');
      await wait(60);
      await frame.flush();
      reached = new RegExp(`❯.*${target}`).test(stripAnsi(frame.frame()));
    }
    assert.ok(reached, `光标应能移动到第 ${i} 项`);
  }

  const out = stripAnsi(frame.frame());
  assert.ok(out.includes('skill-20'), '最后一项可见');
  assert.ok(/❯.*skill-20/.test(out), '最后一项是选中项');

  // 选中项上按空格 → 切换的是最后一项（证明光标真的到了）
  await press(frame, ' ');
  assert.deepEqual(toggled, ['skill-20'], '空格作用于最后一项');
  await frame.cleanup();
});

test('能力面板：面板本身不被压缩（flexShrink=0），历史再长也完整显示', async () => {
  const ctrl = new AppController();
  // 用大量历史把视口撑满
  for (let i = 0; i < 60; i++) ctrl.pushOutput(`历史行 ${i}`);
  ctrl.openCapability('skill', SKILLS);
  const frame = await renderApp(ctrl);
  await wait(60);
  await frame.flush();
  const out = stripAnsi(frame.frame());
  assert.ok(out.includes('commit'), '第一项可见');
  assert.ok(out.includes('red-line-check'), '第二项可见');
  await frame.cleanup();
});

test('kind 类型约束：只有 skill / mcp 两种', async () => {
  const kinds: CapabilityKind[] = ['skill', 'mcp'];
  assert.equal(kinds.length, 2);
});
