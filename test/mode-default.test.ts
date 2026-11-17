import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { initialMode, parseCliArgs } from '../src/cli.js';
import { AppController } from '../src/ui/controller.js';

/**
 * 默认权限模式 = auto。
 *
 * 语义：不给任何标志时进 auto（写/shell 交分类器裁决），而不是 default
 * （每次写都要弹确认框）。显式标志仍然各自生效，`--default` 可以回到旧行为。
 */

test('initialMode：无标志 → auto', () => {
  assert.equal(initialMode({ plan: false, yolo: false, auto: false, defaultMode: false }), 'auto');
});

test('initialMode：--plan 最硬（只读优先于一切）', () => {
  assert.equal(initialMode({ plan: true, yolo: true, auto: true, defaultMode: true }), 'plan');
});

test('initialMode：--yolo 优先于 --auto（显式"别再问我"语义更强）', () => {
  assert.equal(initialMode({ plan: false, yolo: true, auto: true, defaultMode: false }), 'bypass');
});

test('initialMode：--default 能回到旧缺省', () => {
  assert.equal(initialMode({ plan: false, yolo: false, auto: false, defaultMode: true }), 'default');
});

test('parseCliArgs：--default 被正确剥离且不吃掉指令', () => {
  const args = parseCliArgs(['--default', '写个文件']);
  assert.equal(args.defaultMode, true);
  assert.equal(args.instruction, '写个文件');
});

test('AppController：缺省模式是 auto，循环顺序以 auto 打头', () => {
  const c = new AppController();
  assert.equal(c.mode, 'auto', 'UI 初值也是 auto，与 CLI 一致');
  assert.equal(AppController.MODE_CYCLE[0], 'auto');
  // Shift+Tab 从 auto 出发应走到 default
  c.cycleMode();
  assert.equal(c.mode, 'default');
  c.cycleMode();
  assert.equal(c.mode, 'plan');
  c.cycleMode();
  assert.equal(c.mode, 'bypass');
  c.cycleMode();
  assert.equal(c.mode, 'auto', '循环回 auto');
});
