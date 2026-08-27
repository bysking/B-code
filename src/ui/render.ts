import React from 'react';
import { render, type Instance } from 'ink';
import { App } from './app.js';
import type { AppController } from './controller.js';
import type { Mode } from '../permissions.js';
import type { ClipboardImage } from '../utils/clipboard.js';

/**
 * TTY 模式挂载/卸载 ink 应用。非 TTY 不使用本模块（保持 raw 直写）。
 * unmount 幂等：渲染实例与退出清理。
 */

export interface TtyMount {
  unmount(): void;
  instance: Instance;
}

/** 挂载UI入口 */
export function mountTtyApp(
  ctrl: AppController,
  hooks: {
    onSubmit: (text: string | { text: string; images?: ClipboardImage[] }) => void;
    onInterrupt: () => void;
    onExit: () => void;
    onSetMode?: (mode: Mode) => void;
  },
  initialOutput?: string[],
): TtyMount {
  const instance = render(
    React.createElement(App, {
      ctrl,
      onSubmit: hooks.onSubmit,
      onInterrupt: hooks.onInterrupt,
      onExit: hooks.onExit,
      onSetMode: hooks.onSetMode ?? (() => {}),
      initialOutput,
    }),
    // 关闭 ink 默认 exitOnCtrlC：否则 Ctrl+C 被 ink 吞掉，我们自己的
    // "第一次提示 / 第二次退出 / 打印恢复命令" 协议永远收不到事件
    { exitOnCtrlC: false },
  );
  return { instance, unmount: () => instance.unmount() };
}
