/**
 * 终端尺寸与面板的布局工具。
 *
 * 历史消息走 `<Static>`（终端原生 scrollback），live 区靠按行边界切分控制帧高。
 * 这里剩下两块被各处共用的东西：
 *
 *   1. `useTerminalSize` / `terminalRows` / `terminalCols` —— 终端尺寸。
 *   2. `clampByLines` / `estimateLines` —— 按**渲染行数**裁切列表与估算高度。
 *      面板（待办/任务/能力面板/输出面板）需要限高：条数多了会把底栏撑高。
 *   3. `scrollWindow` —— 长列表的滚动窗口（菜单/能力面板共用）。
 *
 * ## 组件里请用 `useTerminalSize()`，不要直接调这两个函数
 *
 * 这两个函数读的是**真实 `process.stdout`**。如果 ink 渲染用的 stdout 是别的流
 * （测试注入、未来多路输出），读到的值就和实际渲染尺寸不一致——表现为"根盒子
 * height=40，而终端只有 30 行"，整帧比终端高 → ink 整屏清屏 → 历史丢失且滚不动。
 *
 * 组件内一律用 `useTerminalSize()`（基于 ink 的 `useWindowSize`，读的是**当前
 * 渲染流**，且 resize 时自动重渲染）。
 */
import { useTerminalSize as engineTerminalSize } from './ui/index.js';
import wrapAnsi from 'wrap-ansi';

/**
 * 当前渲染流所在终端的尺寸（组件内**唯一**正确来源）。
 *
 * 为什么不能直接用 `process.stdout.rows`：ink 的渲染目标是 `render(..., { stdout })`
 * 传进来的流，可能是测试注入的假流或未来的多路输出。读错对象就会让"根盒子高度"
 * 与"实际终端高度"不一致 → 整帧比终端高 → ink 整屏清屏 → 历史丢失、无法滚动。
 *
 * `useWindowSize` 读的是 ink 自己的 stdout context，且 resize 时自动重渲染。
 */
export function useTerminalSize(): { rows: number; columns: number } {
  // 走适配层：ink → OpenTUI 时这里不用改（各引擎实现自己处理尺寸来源）
  return engineTerminalSize();
}

/** 终端行数兜底（仅供非组件场景；组件内用 useTerminalSize） */
export function terminalRows(): number {
  return process.stdout.rows || 40;
}

/** 终端列宽兜底（仅供非组件场景；组件内用 useTerminalSize） */
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

/**
 * 列表的滚动窗口：给定光标位置与可见条数，算出该渲染哪一段 [start, end)。
 *
 * 核心不变式：**光标项必须落在窗口内**。这是"被裁掉的项永远看不到"的解药——
 * 光标下移穿过窗口下沿时，窗口跟着一起滚，最后一项也能翻到。
 *
 * 窗口采用"光标居中偏下"策略（靠近末尾时贴底）：光标移动时内容不会每步都跳一整屏，
 * 同时又能保证末尾能看到足够的上下文。斜杠菜单与能力面板共用这套语义。
 */
export function scrollWindow(idx: number, length: number, maxVisible: number): [number, number] {
  if (length <= maxVisible || maxVisible <= 0) return [0, length];
  const half = Math.floor(maxVisible / 2);
  const start = Math.min(Math.max(idx - half, 0), length - maxVisible);
  return [start, Math.min(start + maxVisible, length)];
}
