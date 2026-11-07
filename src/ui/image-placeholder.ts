/**
 * 输入框里图片占位符（`[image #N]`）的「原子块」处理。
 *
 * ## 为什么需要
 *
 * 占位符是纯文本 `[image #1]`（10 个字符），编辑器不知道它是一块整体。
 * 光标停在它后面按一次 Backspace，只会删掉 `]`，留下 `[image #1`——
 * 用户得连按 10 次才能清掉一张图，中途还会留下 `[image #` 这种半截标签，
 * 发出去时正则匹配不上，占位符就变成了纯文本噪声。
 *
 * 这里提供"把光标前后的一整块占位符当作单个字符"的判定，供输入框的
 * Backspace / Delete 复用。
 *
 * 放在独立文件是为了纯函数可测——不依赖渲染器，也不依赖剪贴板。
 */

/**
 * 占位符的字面格式。
 *
 * **与 `app.tsx` 的提交解析必须保持一致**：那边用 `/\[image #(\d+)\]/g`
 * 匹配、按编号回查 `imagesRef`。这里多匹配（比如允许空格）就会让"能整块删
 * 但提交时解析不了"的占位符出现，少匹配则相反。
 */
const PLACEHOLDER_RE = /\[image #\d+\]/g;

/** 一个占位符在文本中的位置（`end` 为开区间，便于 `slice`） */
export interface PlaceholderSpan {
  start: number;
  end: number;
}

/** 找出文本里全部占位符的位置 */
export function findPlaceholders(text: string): PlaceholderSpan[] {
  const spans: PlaceholderSpan[] = [];
  // 每次现建 RegExp：模块级带 g 标志的表达式有 lastIndex 状态，
  // 复用会漏匹配（经典坑）
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

/**
 * Backspace 该整块删除的范围。
 *
 * 光标在 `[image #1]` 的右边界（或其内部任意位置）时，返回该块的整体范围，
 * 边界与编辑器行为一致：**紧贴右边界算命中**（光标在 `]` 之后按退格，
 * 用户想删的就是这张图），左边界不算（光标在 `[` 之前按退格，删的是前面
 * 那个字符）。
 *
 * 返回 null 表示"不在占位符上"，调用方走原生逐字符删除。
 */
export function backspaceSpan(text: string, cursorOffset: number): PlaceholderSpan | null {
  // 光标偏移是**显示列宽**（汉字占 2 列），占位符下标是**字符下标**（占位符本身
  // 全是 ASCII，所以块内两者相等；块**前面**若有汉字就会错位）。先把光标列宽
  // 换算成字符下标，再比较。
  const cursorChar = columnToCharIndex(text, cursorOffset);
  for (const span of findPlaceholders(text)) {
    if (cursorChar > span.start && cursorChar <= span.end) return span;
  }
  return null;
}

/**
 * Delete（前向删除）该整块删除的范围。
 *
 * 与 Backspace 镜像：光标在 `[image #1]` 的左边界（或其内部）时命中，
 * 紧贴左边界算命中（光标在 `[` 之前按 Delete，用户想删的是这张图），
 * 右边界不算。
 */
export function deleteSpan(text: string, cursorOffset: number): PlaceholderSpan | null {
  const cursorChar = columnToCharIndex(text, cursorOffset);
  for (const span of findPlaceholders(text)) {
    if (cursorChar >= span.start && cursorChar < span.end) return span;
  }
  return null;
}

/**
 * 显示列宽偏移 → 字符下标。
 *
 * ## 为什么需要
 *
 * OpenTUI 的 `EditBufferRenderable.cursorOffset` 是**终端显示列**的偏移，
 * 不是 JS 字符串下标：`"中"` 一个字符，`cursorOffset` 是 2；`"中ab"` 三个
 * 字符是 4。而 `plainText` 上的 `indexOf` / 正则给的 `m.index` 都是**字符
 * 下标**。两者在"占位符前面有宽字符"时会错位（实测：`前[image #1]` 的
 * `cursorOffset` 是 12，字符长度只有 11），拿去比较必然漏判。
 *
 * 占位符自身全是 ASCII（宽 1），所以块内的列宽 == 字符下标；只有块**前面**
 * 的宽字符会造成偏移，这里逐字累加宽度即可换算。
 *
 * 宽度按 East Asian Width 的宽字符近似判定（汉字、假名、全角标点、emoji）。
 * 不做完整 Unicode 表——输入框里的占位符删除只需要"前面有没有双宽字符"这一个
 * 判断，近似足够，且不会随 Unicode 版本变动而失准。
 */
export function columnToCharIndex(text: string, column: number): number {
  let col = 0;
  let idx = 0;
  for (const ch of text) {
    if (col >= column) return idx;
    col += charWidth(ch);
    idx += ch.length; // 代理对占 2 个 UTF-16 单元，idx 要跟着走
  }
  return idx;
}

/** 单字符的显示宽度：宽字符 2，其余 1（含 emoji 的主要区间） */
function charWidth(ch: string): number {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 1;
  // 组合附加符号不占宽
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // 韩文字母
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首 ~ 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 韩文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角形式
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B+
  ) {
    return 2;
  }
  return 1;
}

/**
 * 字符下标 → 显示列宽偏移。
 *
 * `setSelection(start, end)` 要的也是**列宽**（实测：直接传字符下标会把
 * `前[image #1]` 的选区算偏，删完只剩 `]`）。所以判定命中后，要把占位符的
 * 字符下标换算回列宽再交给编辑器。
 */
export function charIndexToColumn(text: string, charIndex: number): number {
  let col = 0;
  let idx = 0;
  for (const ch of text) {
    if (idx >= charIndex) break;
    col += charWidth(ch);
    idx += ch.length;
  }
  return col;
}
