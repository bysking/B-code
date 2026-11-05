import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from '@opentui/react';
import {
  useKeyboard,
  usePaste as otuiUsePaste,
  useTerminalDimensions,
} from '@opentui/react';
import type { KeyEvent } from '@opentui/core';
import {
  EMPTY_KEY,
  type BoxProps,
  type ElementSize,
  type InputHandler,
  type KeyLike,
  type MountedApp,
  type MountOptions,
  type TerminalSize,
  type TextProps,
  type UiEngine,
} from '../types.js';

/**
 * OpenTUI 后端：把 OpenTUI 的 API 翻译成适配层契约。
 *
 * ## 与 ink 的关键差异
 *
 * | 维度 | ink | OpenTUI |
 * |---|---|---|
 * | 挂载 | `render()` 同步返回 Instance | `createCliRenderer()` 异步 → `createRoot().render()` |
 * | 元素标签 | React 组件 `<Box>` | 小写字符串标签 `<box>` / `<text>` |
 * | 按键 | `key.upArrow` 布尔字段 | `KeyEvent.name === 'up'` |
 * | 尺寸 | `{rows, columns}` | `{width, height}` |
 * | 测量 | `useBoxMetrics(ref)` | 渲染对象属性（见 useElementSize） |
 *
 * ## 为什么组件用字符串标签
 *
 * `@opentui/react` 通过自定义 reconciler 把 `<box>` 这类小写标签映射到
 * 原生 Renderable。用 `React.createElement('box', ...)` 而不是包一层组件，
 * 是为了让 reconciler 能直接识别标签名——包一层会多出无谓的组件边界，
 * 且拿不到 OpenTUI 的布局优化路径。
 */

/* ── 属性转换 ────────────────────────────────────────── */

/** 契约的 Box 属性 → OpenTUI box 属性 */
function toOtuiBox(p: BoxProps): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.flexDirection) out.flexDirection = p.flexDirection;
  if (p.height !== undefined) out.height = p.height;
  if (p.width !== undefined) out.width = p.width;
  if (p.flexGrow !== undefined) out.flexGrow = p.flexGrow;
  if (p.flexShrink !== undefined) out.flexShrink = p.flexShrink;
  if (p.paddingX !== undefined) {
    out.paddingLeft = p.paddingX;
    out.paddingRight = p.paddingX;
  }
  if (p.paddingY !== undefined) {
    out.paddingTop = p.paddingY;
    out.paddingBottom = p.paddingY;
  }
  if (p.marginTop !== undefined) out.marginTop = p.marginTop;
  if (p.marginBottom !== undefined) out.marginBottom = p.marginBottom;
  if (p.borderStyle) {
    out.border = true;
    out.borderStyle = p.borderStyle === 'round' ? 'rounded' : 'single';
  }
  if (p.borderColor) out.borderColor = p.borderColor;
  // OpenTUI 的滚动/裁剪模型与 ink 不同：overflow 用 'hidden' 语义接近
  if (p.overflow) out.overflow = p.overflow === 'hidden' ? 'hidden' : 'visible';
  // contentOffsetY：OpenTUI 没有同名属性，靠 ScrollBox 或 translateY 实现。
  // 这里用 translateY 保底（ScrollView 的视口滚动依赖它）
  if (p.contentOffsetY !== undefined && p.contentOffsetY > 0) {
    out.translateY = -p.contentOffsetY;
  }
  if (p.ref) out.ref = p.ref;
  return out;
}

/**
 * 文本属性位掩码（OpenTUI 的 `attributes` 是**单个整数**，不是数组）。
 *
 * 位值取自 ANSI SGR 的标准顺序（BOLD=1, DIM=2, ITALIC=4, UNDERLINE=8,
 * BLINK=16, INVERSE=32, HIDDEN=64, STRIKE=128）。实测这些位都能正常渲染。
 */
const ATTR = {
  bold: 1,
  dim: 2,
  italic: 4,
  underline: 8,
  inverse: 32,
  strikethrough: 128,
} as const;

/** 契约的 Text 属性 → OpenTUI text 属性 */
function toOtuiText(p: TextProps): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.color) out.fg = p.color;
  if (p.backgroundColor) out.bg = p.backgroundColor;

  let attrs = 0;
  if (p.bold) attrs |= ATTR.bold;
  if (p.dimColor) attrs |= ATTR.dim;
  if (p.italic) attrs |= ATTR.italic;
  if (p.underline) attrs |= ATTR.underline;
  if (p.inverse) attrs |= ATTR.inverse;
  if (p.strikethrough) attrs |= ATTR.strikethrough;
  // 只在非零时传：显式传 0 也是合法的，但省掉能少一次属性设置
  if (attrs !== 0) out.attributes = attrs;

  // wrap: OpenTUI 的 text 默认折行；truncate-end 用 'none' 关掉折行
  if (p.wrap === 'truncate-end') out.wrap = 'none';
  return out;
}

/* ── 组件 ───────────────────────────────────────────── */

/** ink 的 Box 在未指定 flexDirection 时是 **row**（横向排列）。
 *
 * OpenTUI 的 box 默认是 **column**——这个差异会静默改变布局：
 * 比如 ModeBar 是 `<Box>` 里放三个 `<Text>`，期望横排成一行，
 * 在 OpenTUI 下会变成三行（模式栏被拆开，视觉上完全错乱）。
 *
 * 适配层必须显式补上 ink 的默认值，业务代码才能保持原样。
 */
export function Box({ children, ...props }: BoxProps) {
  const p = { flexDirection: 'row' as const, ...props };
  return React.createElement('box', toOtuiBox(p) as never, children);
}

/**
 * 文本。
 *
 * ## 嵌套 Text 的处理
 *
 * ink 支持 `<Text>前缀<Text dimColor>高亮</Text></Text>`——外层给基础样式，
 * 内层覆盖局部。业务代码大量依赖这个（比如工具块的"名称 + 暗淡参数"）。
 *
 * OpenTUI 的 `text` **只接受字符串 / TextNode / StyledText**，传 React 元素
 * 会抛 `TextNodeRenderable only accepts strings...`。
 * 它要求嵌套用 `<span>` 标签。
 *
 * 所以这里做一层转换：把 children 里的 `<Text>` 元素换成 `<span>`
 * （同样的属性映射），其余原样透传。业务代码不用知道这个差异。
 */
function toOtuiChildren(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (!React.isValidElement(child)) return child;
    // 我们的 Text 组件：转成 span（保持同样的样式映射）
    if (child.type === Text) {
      const p = child.props as TextProps;
      return React.createElement(
        'span',
        toOtuiText(p) as never,
        toOtuiChildren(p.children),
      );
    }
    // 其他元素原样返回（含其 children 不递归——保持可预期行为）
    return child;
  });
}

export function Text({ children, ...props }: TextProps) {
  return React.createElement(
    'text',
    toOtuiText(props) as never,
    toOtuiChildren(children),
  );
}

/* ── 按键归一化 ─────────────────────────────────────── */

/** OpenTUI 的 KeyEvent.name → 契约的 KeyLike */
function toKeyLike(e: KeyEvent): KeyLike {
  return {
    ...EMPTY_KEY,
    upArrow: e.name === 'up',
    downArrow: e.name === 'down',
    leftArrow: e.name === 'left',
    rightArrow: e.name === 'right',
    pageUp: e.name === 'pageup',
    pageDown: e.name === 'pagedown',
    home: e.name === 'home',
    end: e.name === 'end',
    return: e.name === 'return',
    escape: e.name === 'escape',
    tab: e.name === 'tab',
    backspace: e.name === 'backspace',
    // OpenTUI 把 Delete 键叫 'delete'；Backspace 单列
    delete: e.name === 'delete',
    ctrl: e.ctrl,
    shift: e.shift,
    meta: e.meta || e.option,
  };
}

/**
 * 本次输入的字符。
 *
 * ink 的约定：功能键（方向键/Enter/Esc…）的 input 是**空串**，只有可打印字符
 * 才给内容。这里照搬同一语义——业务代码（输入框）依赖"空串 = 功能键"判断。
 */
function toInput(e: KeyEvent): string {
  // Ctrl/Meta 组合键：ink 的约定是 `input` 返回**字母本身**（Ctrl+C → 'c'）。
  // 业务代码大量写成 `key.ctrl && input === 'c'`，不这么处理快捷键全都会失灵。
  //
  // OpenTUI 的 sequence 是原始控制字符（Ctrl+C = '\x03'），需要按 Ctrl 键位
  // 映射回字母：\x01-\x1a 对应 a-z。
  if (e.ctrl) {
    const code = e.sequence.charCodeAt(0);
    if (code >= 1 && code <= 26) return String.fromCharCode(code + 96); // 1→a, 3→c
  }
  // 其余只接受可打印单字符（功能键的 sequence 是转义序列，不能当输入）
  const seq = e.sequence;
  if (seq.length === 1 && seq >= ' ') return seq;
  return '';
}

/* ── Hooks ──────────────────────────────────────────── */

/**
 * 键盘输入。
 *
 * OpenTUI 的 `useKeyboard` **没有 isActive 选项**——它总是活跃。
 * 所以这里自己实现门控：`isActive=false` 时 handler 直接不调用。
 *
 * 用 ref 存 handler 与开关，避免每次渲染都重新订阅（订阅本身不便宜，
 * 且高频重订阅会丢事件）。
 */
export const useInput: UiEngine['useInput'] = (
  handler: InputHandler,
  options?: { isActive?: boolean },
) => {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const activeRef = useRef(options?.isActive !== false);
  activeRef.current = options?.isActive !== false;

  useKeyboard((e: KeyEvent) => {
    if (!activeRef.current) return;
    // 只处理按下/重复；release 事件对业务无意义（会把手势逻辑弄乱）
    if (e.eventType === 'release') return;
    handlerRef.current(toInput(e), toKeyLike(e));
  });
};

/** 括号粘贴：OpenTUI 给的是原始字节，解码成 UTF-8 文本 */
export const usePaste: UiEngine['usePaste'] = (handler) => {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  otuiUsePaste((event) => {
    // OpenTUI 的 PasteEvent 带 `bytes: Uint8Array`（保持原始字节，支持二进制粘贴）。
    // 契约只要文本，这里解码一次。用 TextDecoder 而非 toString 以避免多字节
    // 字符（中文/emoji）被截断成乱码。
    handlerRef.current(new TextDecoder().decode(event.bytes));
  });
};

/** 终端尺寸：OpenTUI 给 {width, height}，转成契约的 {rows, columns} */
export const useTerminalSize: UiEngine['useTerminalSize'] = (): TerminalSize => {
  const { width, height } = useTerminalDimensions();
  return {
    rows: height > 0 ? height : 40,
    columns: width > 0 ? width : 80,
  };
};

/**
 * 元素实测尺寸。
 *
 * OpenTUI 的渲染对象带 `width` / `height` 属性，但那是**布局后**的值，
 * 在 effect 里读才准确。这里用 state + effect 轮询一次（布局完成后立即读到）。
 *
 * 注意：OpenTUI 没有 ink 的 `hasMeasured` 概念——用 `height > 0` 判断已测到。
 */
export const useElementSize: UiEngine['useElementSize'] = (ref): ElementSize => {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const node = ref.current as { width?: number; height?: number } | null;
    if (!node) return;
    const w = node.width ?? 0;
    const h = node.height ?? 0;
    if (w !== size.width || h !== size.height) {
      setSize({ width: w, height: h });
    }
  });
  return { ...size, measured: size.height > 0 };
};

/* ── 挂载 ───────────────────────────────────────────── */

/**
 * 挂载组件树。
 *
 * OpenTUI 的初始化是**异步**的（要加载原生库、探测终端能力），
 * 所以 mount 返回 Promise——这正是把契约统一成 Promise 的原因。
 *
 * 这里动态 import `@opentui/core`：只有真正使用 OpenTUI 后端时才加载
 * 18MB 的原生模块，ink 后端路径不受影响。
 */
export async function mount(
  node: React.ReactNode,
  options: MountOptions,
): Promise<MountedApp> {
  const { createCliRenderer } = await import('@opentui/core');
  const renderer = await createCliRenderer({
    exitOnCtrlC: options.exitOnCtrlC ?? false,
    // OpenTUI 默认自己接管 stdin/stdout；测试或自定义流时传进去
    ...(options.stdout ? { stdout: options.stdout } : {}),
    ...(options.stdin ? { stdin: options.stdin } : {}),
  } as never);

  const root = createRoot(renderer as never);
  root.render(node);

  return {
    unmount: () => {
      try {
        root.unmount();
      } catch {
        // 已卸载
      }
      try {
        renderer.destroy();
      } catch {
        // 已销毁
      }
    },
  };
}

/** OpenTUI 后端实现 */
export const opentuiEngine: UiEngine = {
  Box,
  Text,
  useInput,
  usePaste,
  useTerminalSize,
  useElementSize,
  mount,
};
