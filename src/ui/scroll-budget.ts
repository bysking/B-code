/**
 * 布局工具（非组件代码用）。
 *
 * ## 历史
 *
 * 这个文件在 ink 时代承担了大量职责：估算行数、按行数裁剪列表、计算 live 帧预算。
 * 那些能力在切到 OpenTUI 后都已删除——`<scrollbox>` 原生做视口裁剪，
 * 渲染器自己管帧高，应用层不再需要算这些。
 *
 * 现在只剩两个真正通用的工具：
 *   - `terminalRows/Cols`：非组件代码（cli 的降级路径）估算用
 *   - `scrollWindow`：长列表的滚动窗口（能力面板等手写列表用）
 *
 * 组件内请直接用 `useTerminalDimensions()`，不要用这里的函数。
 */

/** 终端行数兜底（仅供非组件场景） */
export function terminalRows(): number {
  return process.stdout.rows || 40;
}

/** 终端列宽兜底（仅供非组件场景） */
export function terminalCols(): number {
  return process.stdout.columns || 80;
}

/** 终端尺寸（非组件代码用；组件内请用 useTerminalDimensions） */
export function useTerminalSize(): { rows: number; columns: number } {
  return { rows: terminalRows(), columns: terminalCols() };
}

/**
 * 列表的滚动窗口：给定光标位置与可见条数，算出该渲染哪一段 [start, end)。
 *
 * 核心不变式：**光标项必须落在窗口内**——否则用户翻不到被裁掉的项。
 * 窗口采用"光标居中"策略，靠近末尾时贴底。
 */
export function scrollWindow(idx: number, length: number, maxVisible: number): [number, number] {
  if (length <= maxVisible || maxVisible <= 0) return [0, length];
  const half = Math.floor(maxVisible / 2);
  const start = Math.min(Math.max(idx - half, 0), length - maxVisible);
  return [start, Math.min(start + maxVisible, length)];
}
