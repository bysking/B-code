import { MarkdownRenderable } from '@opentui/core';

/**
 * 让 `<markdown>` 支持鼠标拖选。
 *
 * ## 为什么必须打这个补丁
 *
 * OpenTUI 的选中判定入口是 `renderable.shouldStartSelection(x, y)`。
 * 基类 `Renderable` 的实现是**硬编码 `return false`**——只有
 * `TextBufferRenderable`（`<text>`）和 `EditBufferRenderable` 覆盖了它。
 *
 * `<markdown>` 直接继承 `Renderable`，所以它**永远不允许开始选中**。
 * 而鼠标事件走 `hitTest`，命中的正是落在空行上的 `<markdown>` 节点
 * （有文字的格子命中的是它内部的 `<text>`，那类格子本来就能选中），
 * 于是从空行开始拖选毫无反应——用户想选"两段之间的空行往下带"，选不动。
 *
 * 补丁逻辑与 `TextBufferRenderable` 的官方实现一致：`selectable` +
 * 点击点落在自身范围内就允许。
 *
 * 0.9.x 的 markdown 改成原生引擎（内部是 TextRenderable），但**空行仍然
 * 命中 MarkdownRenderable 本身**，所以补丁依旧必要——`test/ui-selection.test.tsx`
 * 里有一条用例专门锁着它（空行起选）。
 *
 * 这是唯一一处"改上游原型"的地方，收敛在这里并留注释；
 * 等 OpenTUI 给 Markdown 补上实现后可整段删除。
 */
let patched = false;

export function patchMarkdownSelection(): void {
  if (patched) return;
  patched = true;
  const proto = MarkdownRenderable.prototype as unknown as {
    selectable: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    shouldStartSelection(x: number, y: number): boolean;
  };
  proto.shouldStartSelection = function (x: number, y: number): boolean {
    if (!this.selectable) return false;
    const lx = x - this.x;
    const ly = y - this.y;
    return lx >= 0 && lx < this.width && ly >= 0 && ly < this.height;
  };
}
