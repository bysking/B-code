/**
 * 终端尺寸与面板的布局工具。
 *
 * 历史消息渲染已改为应用内滚动视口（`viewport/scroll-view.tsx`），
 * 原先那套"估算行数 → 切片提交进 <Static>"的防溢出机制随之删除。
 * 这里只剩两块仍被面板类组件共用的东西：
 *
 *   1. `terminalRows` / `terminalCols` —— 终端尺寸（非 TTY 兜底）。
 *   2. `clampByLines` / `estimateLines` —— 按**渲染行数**裁切列表。
 *      面板（待办/任务/能力面板/输出面板）仍需要限高：它们不是滚动视口，
 *      条数多了会把底栏撑高、挤占正文。
 */
import wrapAnsi from 'wrap-ansi';

/** 终端行数（非 TTY/测试环境兜底 40） */
export function terminalRows(): number {
  return process.stdout.rows || 40;
}

/** 终端列宽（非 TTY/测试环境兜底 80） */
export function terminalCols(): number {
  return process.stdout.columns || 80;
}
/**
 * 终端太小时，底部面板必须让位。
 *
 * 面板（待办 + 任务）在窄/矮终端里折行后能轻易吃掉十几二十行；此时再把正文和
 * 面板一起塞进一屏，物理上放不下 → 整帧必然超过终端高度 → ink 整屏清屏。
 * 与其继续压缩正文（压到 1 行也没用），不如收起面板：正文才是主体，
 * 待办/任务状态仍可通过 Ctrl+O 与下一次刷新看到。
 *
 * 阈值 = 可用给"正文 + 面板"的总行数；低于它就只保留最必要的部分。
 */
export const COMPACT_TERMINAL_ROWS = 30;

/** 终端是否紧张（矮终端） */
export function isCompactTerminal(): boolean {
  return terminalRows() < COMPACT_TERMINAL_ROWS;
}

/**
 * 按**渲染行数**（而非条数）裁剪列表，返回可见项与剩余条数。
 *
 * 为什么不能只限条数：面板里每项是一段自然语言（如 "Add userTodos state + editor
 * open flag + persist hook to AppController"），在窄终端会折成 2~3 行。限 10 条
 * 实际可能占 30 行，面板高度失控 → 整帧超过终端行数 → ink 整屏清屏（连 scrollback
 * 一起清），用户回看位置被重置。按行数裁切才能给出确定的高度上限。
 *
 * 第一项总会保留（哪怕它自己就超预算），否则面板会变成空白。
 */
export function clampByLines<T>(
  items: T[],
  textOf: (item: T) => string,
  maxLines: number,
  opts: { cols?: number; reservedLines?: number; lineOf?: (item: T) => number } = {},
): { visible: T[]; hidden: number; lines: number } {
  const cols = opts.cols ?? terminalCols();
  const reserved = opts.reservedLines ?? 0; // 边框/标题/省略提示等固定占用
  const budget = Math.max(maxLines - reserved, 1);
  const visible: T[] = [];
  let used = 0;
  for (const item of items) {
    const h = opts.lineOf ? opts.lineOf(item) : estimateLines(textOf(item), cols);
    if (visible.length > 0 && used + h > budget) break;
    used += h;
    visible.push(item);
  }
  return { visible, hidden: items.length - visible.length, lines: used };
}

/** 估算文本按终端宽度硬换行后的行数（CJK 宽度由 wrap-ansi 内部的 string-width 处理） */
export function estimateLines(text: string, cols = terminalCols()): number {
  if (text == null) return 0;
  return wrapAnsi(text, Math.max(cols, 10), { hard: true, trim: false }).split('\n').length;
}

