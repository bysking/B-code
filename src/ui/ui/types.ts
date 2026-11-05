import type React from 'react';

/**
 * 渲染引擎适配层的类型契约。
 *
 * ## 为什么需要这一层
 *
 * 业务组件（transcript / panels / wizard…）不应该知道底层用的是 ink 还是 OpenTUI。
 * 这里把两者能力取**交集**，收敛成一组最小接口；换引擎只改 `ui/<engine>/` 的实现，
 * 业务代码一行不动。
 *
 * ## 设计原则
 *
 * 1. **只暴露真正用到的能力**。全量对齐两个库的 API 是徒劳的——它们各有各的高级特性
 *    （ink 的 `<Static>`、OpenTUI 的 `scrollbox`），业务层用不到就不该进契约。
 * 2. **命名贴近语义而非某个库**。用 `useTerminalSize` 而不是照抄任一方的命名。
 * 3. **归一化到中立形态**。比如按键统一成 `KeyLike`（布尔字段），而不是暴露
 *    ink 的 `key` 对象或 OpenTUI 的 `KeyEvent`。
 */

/** 终端颜色名（两个引擎都支持的 8+1 色） */
export type Color =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'gray';

/** 盒子（flexbox 容器）。
 *
 * 字段是**实际用到的那部分**——不是 ink Box 的全集。
 * 新增需求时才扩，避免契约膨胀成"另一个 ink"。 */
export interface BoxProps {
  children?: React.ReactNode;
  flexDirection?: 'row' | 'column';
  /** 固定高度（行）。省略时由 flex 分配 */
  height?: number;
  /** 固定宽度（列）。省略时撑满 */
  width?: number;
  flexGrow?: number;
  flexShrink?: number;
  paddingX?: number;
  paddingY?: number;
  marginTop?: number;
  marginBottom?: number;
  /** 边框样式；round = 圆角 */
  borderStyle?: 'round' | 'single';
  borderColor?: Color;
  /** 内容溢出裁剪（滚动视口用） */
  overflow?: 'hidden' | 'visible';
  /** 内容纵向偏移（滚动位置，配合 overflow="hidden"） */
  contentOffsetY?: number;
  /** 布局测量用（供 useElementSize 读取）。
   * 必须是 RefObject（`useRef(null)` 的结果），因为测量需要在渲染后读 `.current`。 */
  ref?: React.RefObject<unknown>;
}

/** 文本。支持嵌套（内层覆盖外层样式） */
export interface TextProps {
  children?: React.ReactNode;
  color?: Color;
  backgroundColor?: Color;
  bold?: boolean;
  dimColor?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  /** 反色（光标块用） */
  inverse?: boolean;
  /** 换行策略：wrap = 自动折行；truncate-end = 单行截断 */
  wrap?: 'wrap' | 'truncate-end';
}

/**
 * 归一化后的按键。
 *
 * ink 给你 `key.upArrow` / `key.return`…，OpenTUI 给你 `event.name === 'up'`。
 * 业务代码只认这里，两边各自翻译。
 */
export interface KeyLike {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageUp: boolean;
  pageDown: boolean;
  home: boolean;
  end: boolean;
  return: boolean;
  escape: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
}

/** 全 false 的按键（便于构造） */
export const EMPTY_KEY: KeyLike = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageUp: false,
  pageDown: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  tab: false,
  backspace: false,
  delete: false,
  ctrl: false,
  shift: false,
  meta: false,
};

/** 键盘事件处理器：`input` 是本次输入的字符（非字符键为空串） */
export type InputHandler = (input: string, key: KeyLike) => void;

/** 元素实测尺寸 */
export interface ElementSize {
  width: number;
  height: number;
  /** 是否已完成首次测量（false = 还没量到，调用方应跳过基于尺寸的逻辑） */
  measured: boolean;
}

/** 终端尺寸 */
export interface TerminalSize {
  rows: number;
  columns: number;
}

/** 挂载选项 */
export interface MountOptions {
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  /** 是否让引擎处理 Ctrl+C（我们要自己管，传 false） */
  exitOnCtrlC?: boolean;
}

/** 挂载结果 */
export interface MountedApp {
  /** 卸载并清理（交还终端） */
  unmount(): void;
}

/**
 * 引擎实现契约。
 *
 * 每个后端（ink / opentui）导出一个这个形状的对象，
 * `ui/index.ts` 根据环境选择。
 */
export interface UiEngine {
  Box: React.ComponentType<BoxProps>;
  Text: React.ComponentType<TextProps>;

  /** 键盘输入。isActive=false 时该 handler 不接收事件（用于让位给上层交互） */
  useInput(handler: InputHandler, options?: { isActive?: boolean }): void;

  /** 括号粘贴：整段文本一次到达，不会被逐字符当成按键 */
  usePaste(handler: (text: string) => void): void;

  /** 终端尺寸（resize 时自动重渲染） */
  useTerminalSize(): TerminalSize;

  /** 元素实测尺寸（传 Box 的 ref，须为 RefObject） */
  useElementSize(ref: React.RefObject<unknown>): ElementSize;

  /** 挂载组件树 */
  mount(node: React.ReactNode, options: MountOptions): Promise<MountedApp>;
}
