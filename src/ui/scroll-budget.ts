/**
 * 流式防溢出：约束 Ink 的 live 帧高度恒小于终端行数。
 *
 * 背景：Ink 的 live 输出（非 <Static>）一旦超过终端行数，就会触发整屏清屏
 * `clearTerminal = ESC[2J + ESC[3J + ESC[H`——其中 ESC[3J 会连同 scrollback 一起清空，
 * 用户向上滚动查看历史时视口随之失效、被弹回顶部。因此 live 区高度必须始终低于终端行数。
 *
 * 策略：流式追加导致尾部内容超过预算时，把前缀在安全边界切出、提交进 turn.chunks
 * （交给 <Static> 只打印一次），live 区只保留尾部。切分逻辑见 findStreamSplit。
 *
 * 注：这些常量/估算只服务于"防溢出"的高度预算，不追求与 Ink 实际渲染逐行精确一致——
 * 保留 KEEP_RATIO 的余量即为吸收 markdown 渲染（表格/代码框）带来的少量行数膨胀。
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
 * live 区为**固定**底部元素预留的行数：输入行 / busy 行 / 模式栏。
 * 面板（任务清单 / 待办）高度是浮动的，不写在这里——由调用方用
 * liveLineBudget(动态占用) 把它们各自的实测高度传进来。
 */
export const CHROME_RESERVED_ROWS = 16;
/** live 预算下限（极小终端也至少留 8 行给流式尾部） */
export const MIN_LIVE_BUDGET = 8;

/**
 * live 区最多渲染几个工具块（超出折叠成一行汇总）。
 *
 * 两处共用（message-list 渲染 / controller 预算），必须一致：
 * 渲染端按它截断、预算端按它扣行数，任一处改了另一边不跟就会继续溢出。
 */
export const LIVE_TOOL_ROWS_MAX = 4;

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
 * live 区可用行数预算 = 终端行数 − 底部预留。
 *
 * extraChromeRows：底部浮动面板的实测占用行数（todoPanelHeight + taskPanelHeight）。
 * 必须动态传入：面板高度随条数**和折行**变化（一条长待办能占 3 行），
 * 用固定常量预留会导致"面板一变高，live 帧连同面板一起超出终端行数"→
 * ink 整屏清屏（ESC[3J 连 scrollback 一起清）→ 用户回看位置被重置。
 */
export function liveLineBudget(extraChromeRows = 0): number {
  const avail = terminalRows() - (CHROME_RESERVED_ROWS + extraChromeRows);
  // avail ≤ MIN_LIVE_BUDGET 时（终端很小或面板很高）**不能**硬抬到 8：
  // 预算一旦与真实可用空间脱钩，整帧必然溢出终端 → ink 整屏清屏。
  // 此时只保证留 1 行（否则切分逻辑无法收敛）；avail 充裕时才用 MIN_LIVE_BUDGET
  // 作为"别把正文切得太碎"的下限。
  if (avail <= MIN_LIVE_BUDGET) return Math.max(avail, 1);
  return avail;
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

export interface StreamSplit {
  /** 提交前缀的字符切点（落在行边界，前缀以换行结尾） */
  cut: number;
  /** 在代码块内部切分时：前缀末尾需补的闭合围栏（如 "```"） */
  closeFence: string | null;
  /** 在代码块内部切分时：余量开头需重开的同语种围栏（含换行，如 "```ts\n"） */
  openFence: string | null;
}

const FENCE_OPEN_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^\s{0,3}(`{3,}|~{3,})\s*$/;

function parseFenceOpen(line: string): { marker: string; info: string } | null {
  const m = FENCE_OPEN_RE.exec(line);
  if (!m) return null;
  // CommonMark：反引号围栏的 info string 不能包含反引号
  if (m[1]!.startsWith('`') && m[2]!.includes('`')) return null;
  return { marker: m[1]!, info: m[2]!.trim() };
}

function isFenceClose(line: string, marker: string): boolean {
  const m = FENCE_CLOSE_RE.exec(line);
  return !!m && m[1]![0] === marker[0] && m[1]!.length >= marker.length;
}

/**
 * 在流式文本中找一个提交切分点，使 live 区约保留 keepLines 行。
 *
 * 切点必须落在行边界，优先级：空行边界（段落界）> 围栏外任意行边界 > 围栏内边界。
 * 围栏内切分只在整个目标区间都处于同一个大代码块时才会命中（整块代码无空行、也无围栏外边界）；
 * 此时前缀末尾补闭合围栏、余量开头重开同语种围栏，保证两侧各自渲染正确。
 *
 * markdown=false（thinking 纯文本）时不做围栏跟踪，任意行边界均可切。
 * 未超出 keepLines 或无法切分（如单行超长文本）返回 null。
 */
export function findStreamSplit(
  text: string,
  keepLines: number,
  opts: { cols?: number; markdown?: boolean } = {},
): StreamSplit | null {
  const cols = opts.cols ?? terminalCols();
  const markdown = opts.markdown ?? true;
  const lines = text.split('\n');
  if (lines.length < 2) return null;

  // 逐行累计渲染高度，并记录每行之后仍处于打开状态的代码围栏
  const heights: number[] = [];
  const fenceAfter: ({ marker: string; info: string } | null)[] = [];
  let open: { marker: string; info: string } | null = null;
  let total = 0;
  for (const line of lines) {
    const h = estimateLines(line, cols);
    heights.push(h);
    total += h;
    if (markdown) {
      if (open) {
        if (isFenceClose(line, open.marker)) open = null;
      } else {
        open = parseFenceOpen(line);
      }
    }
    fenceAfter.push(open);
  }
  const target = total - keepLines;
  if (target <= 0) return null;

  let inFence: StreamSplit | null = null;
  let outside: StreamSplit | null = null;
  let blank: StreamSplit | null = null;
  let cum = 0;
  let offset = 0;
  // 只遍历到倒数第二行：切点后至少要给 live 区留一行
  for (let i = 0; i < lines.length - 1; i++) {
    cum += heights[i]!;
    offset += lines[i]!.length + 1;
    if (cum > target) break;
    const fence = fenceAfter[i];
    if (fence) {
      inFence = {
        cut: offset,
        closeFence: fence.marker,
        openFence: `${fence.marker}${fence.info ? fence.info : ''}\n`,
      };
    } else {
      outside = { cut: offset, closeFence: null, openFence: null };
      if (lines[i]!.trim() === '' || lines[i + 1]!.trim() === '') blank = outside;
    }
  }
  return blank ?? outside ?? inFence;
}
