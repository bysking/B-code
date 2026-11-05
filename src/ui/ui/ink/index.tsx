import React from 'react';
import {
  Box as InkBox,
  Text as InkText,
  render,
  useBoxMetrics,
  useInput as inkUseInput,
  usePaste as inkUsePaste,
  useWindowSize,
} from 'ink';
import type {
  BoxProps,
  ElementSize,
  InputHandler,
  MountedApp,
  MountOptions,
  TerminalSize,
  TextProps,
  UiEngine,
} from '../types.js';

/**
 * ink 后端：把 ink 的 API 翻译成适配层契约。
 *
 * 这一层的价值在于**隔离**——业务组件只认 `../types.js` 的形状，
 * 将来换成 OpenTUI 时这里的实现被替换掉，业务代码不动。
 *
 * 刻意保持"薄"：不做额外的状态管理或缓存，纯粹是形状转换。
 * 任何在这里加的智能逻辑，换引擎时都要重写一遍。
 */

/* ── 组件 ───────────────────────────────────────────────── */

export function Box({ children, ref, ...props }: BoxProps) {
  // ref 的类型在契约里是 `RefObject<unknown>`（引擎无关），
  // 而 ink 要求 `RefObject<DOMElement | null>`。这里是唯一需要断言的地方——
  // 收敛在这一处，业务代码不必接触 ink 的 DOMElement 类型。
  return (
    <InkBox
      {...(props as Record<string, unknown>)}
      {...(ref ? { ref: ref as React.RefObject<never> } : {})}
    >
      {children}
    </InkBox>
  );
}

export function Text({ children, ...props }: TextProps) {
  return <InkText {...(props as Record<string, unknown>)}>{children}</InkText>;
}

/* ── Hooks ──────────────────────────────────────────────── */

/**
 * 键盘输入。
 *
 * ink 的 useInput 已经提供 `{ isActive }` 选项，直接透传——
 * 它是靠"不注册监听器"实现的，不会像 usePaste 那样连带关掉 raw mode。
 */
export const useInput: UiEngine['useInput'] = (
  handler: InputHandler,
  options?: { isActive?: boolean },
) => {
  inkUseInput(handler, options);
};

/**
 * 括号粘贴。
 *
 * **注意 ink 的一个坑**：`usePaste` 在 `isActive` 变化时会调 `setRawMode(false)`，
 * 把整个 ink 的 raw mode 关掉，之后所有 `useInput` 都收不到按键
 * （表现是"打开某个面板后键盘失灵"）。
 *
 * 所以这里**透传 but 不带 isActive**——需要"某些时候不接收粘贴"的场景，
 * 由调用方在自己的 handler 里判断，而不是靠关掉这个 hook。
 */
export const usePaste: UiEngine['usePaste'] = (handler) => {
  inkUsePaste(handler);
};

/** 终端尺寸：ink 的 useWindowSize 读的是渲染流本身，resize 时自动重渲染 */
export const useTerminalSize: UiEngine['useTerminalSize'] = (): TerminalSize => {
  const { rows, columns } = useWindowSize();
  // 非 TTY / 尚未测量时给兜底值（与 ink 的默认一致）
  return {
    rows: rows > 0 ? rows : 40,
    columns: columns > 0 ? columns : 80,
  };
};

/**
 * 元素实测尺寸。
 *
 * ink 的 useBoxMetrics 返回 `{ clientWidth, clientHeight, hasMeasured }`——
 * `client*` 是**去掉边框后**的内容区尺寸，正是布局计算想要的
 * （边框会吃掉 2 行/列，用外框尺寸算会导致滚动偏移差 2）。
 */
export const useElementSize: UiEngine['useElementSize'] = (ref): ElementSize => {
  const m = useBoxMetrics(ref as React.RefObject<never>);
  return {
    width: m.clientWidth ?? 0,
    height: m.clientHeight ?? 0,
    measured: m.hasMeasured,
  };
};

/* ── 挂载 ───────────────────────────────────────────────── */

/** 挂载组件树。ink 的 render 是同步的，这里包一层 Promise 保持契约统一 */
export async function mount(
  node: React.ReactNode,
  options: MountOptions,
): Promise<MountedApp> {
  const instance = render(node, {
    stdout: options.stdout,
    stdin: options.stdin,
    exitOnCtrlC: options.exitOnCtrlC ?? false,
  });
  return {
    unmount: () => {
      instance.unmount();
    },
  };
}

/** ink 后端实现（供 ui/index.ts 选择） */
export const inkEngine: UiEngine = {
  Box,
  Text,
  useInput,
  usePaste,
  useTerminalSize,
  useElementSize,
  mount,
};
