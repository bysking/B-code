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

/**
 * 语义色板 —— VS Code「2026 深色」主题。
 *
 * 色值直接取自 VS Code 默认主题
 * （`extensions/theme-defaults/themes/2026-dark.json`），不是凭印象调出来的。
 * 好处：用户在编辑器里看惯的颜色，终端里看到的是同一套，认知负担最低。
 *
 * 命名保持**语义化**（text/muted/accent…）而不是 vscode 的键名
 * （editor.foreground/sideBar.background…）——组件只该表达"这是什么"，
 * 具体映射到哪个编辑器区域是主题层的事。
 */
export const COLORS = {
  /** 主文本（editor.foreground） */
  text: '#BBBEBF',
  /** 次要文本：说明、提示、行号（editorLineNumber.foreground） */
  muted: '#858889',
  /** 强调：标题、选中态（focusBorder 的同色系提亮） */
  accent: '#4FA8CE',
  /** 成功（语法高亮的字符串绿） */
  success: '#7EE787',
  /** 警告（语法高亮的常量橙） */
  warning: '#FFA657',
  /** 错误（语法高亮的关键字红） */
  error: '#FF7B72',
  /** 用户输入（语法高亮的函数蓝） */
  user: '#79C0FF',
  /** 边框：侧边栏与编辑器的分界 */
  border: '#2A2B2D',
  /** 边框（聚焦态，取自 focusBorder #3994BCB3 的实色化） */
  borderFocus: '#3994BC',
  /** 面板背景（sideBar.background） */
  surface: '#191A1B',
  /** 更深一层：输入框等（editor.background） */
  surfaceDeep: '#121314',
  /** 选中行背景（list.activeSelectionBackground #FFFFFF22 的实色化） */
  selection: '#2A2C2E',
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
