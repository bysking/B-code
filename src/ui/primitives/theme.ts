/**
 * 视觉主题：颜色与文本属性的唯一来源。
 *
 * ## 为什么要集中定义
 *
 * 之前颜色散落在各组件里（`color="yellow"` / `color={active ? 'cyan' : undefined}`），
 * 换一个色调要改十几处，而且容易不一致。收敛到语义化的 tone 后，
 * 组件只表达"这是什么"，不关心"具体什么颜色"。
 *
 * ## 为什么用 attributes 位掩码
 *
 * OpenTUI 的 `<text>` 用单个整数表示样式组合（不是数组、不是独立布尔值）。
 * 位值取自 ANSI SGR 标准顺序，实测这些位都能正常渲染。
 */

/** 语义色板（RGB 十六进制，比 8 色名更可控） */
export const COLORS = {
  /** 主文本 */
  text: '#c0caf5',
  /** 次要文本（说明、提示） */
  muted: '#565f89',
  /** 强调（品牌、标题） */
  accent: '#7aa2f7',
  /** 成功 */
  success: '#9ece6a',
  /** 警告 */
  warning: '#e0af68',
  /** 错误 */
  error: '#f7768e',
  /** 用户输入 */
  user: '#7dcfff',
  /** 边框 */
  border: '#414868',
  /** 边框（聚焦态） */
  borderFocus: '#7aa2f7',
  /** 面板背景 */
  surface: '#24283b',
  /** 更深一层的背景 */
  surfaceDeep: '#1a1b26',
} as const;

export type Tone = keyof typeof COLORS;

/** 文本属性位（ANSI SGR 顺序，OpenTUI 用整数位掩码） */
export const ATTR = {
  bold: 1,
  dim: 2,
  italic: 4,
  underline: 8,
  blink: 16,
  inverse: 32,
  hidden: 64,
  strikethrough: 128,
} as const;

/** 按名字组合属性位 */
export function attrs(...names: (keyof typeof ATTR)[]): number {
  return names.reduce((n, k) => n | ATTR[k], 0);
}

/** 语义 tone → 颜色值（组件里 `fg={tone('muted')}`） */
export function tone(t: Tone): string {
  return COLORS[t];
}

/** 工具状态 → 颜色（与 controller 的 ToolStatus 对应） */
export const TOOL_TONE = {
  queued: 'muted',
  running: 'warning',
  done: 'success',
} as const satisfies Record<string, Tone>;

/** 工具状态 → 符号 */
export const TOOL_SYMBOL = {
  queued: '○',
  running: '⠒',
  done: '✓',
} as const;

/** 待办状态 → 符号与颜色 */
export const TODO_SYMBOL = {
  pending: '☐',
  in_progress: '◐',
  completed: '☑',
} as const;

export const TODO_TONE = {
  pending: 'muted',
  in_progress: 'warning',
  completed: 'success',
} as const satisfies Record<string, Tone>;

/** 权限模式 → 标签颜色 */
export const MODE_TONE = {
  default: 'accent',
  plan: 'warning',
  auto: 'success',
  bypass: 'error',
} as const satisfies Record<string, Tone>;
