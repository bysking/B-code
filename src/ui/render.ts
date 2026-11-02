import React from 'react';
import { render, type Instance } from 'ink';
import { App } from './app.js';
import { createScrollFollow, type ScrollFollow } from './scroll-follow.js';
import type { AppController } from './controller.js';
import type { Mode } from '../permissions.js';
import type { ClipboardImage } from '../utils/clipboard.js';

/**
 * TTY 模式挂载/卸载 ink 应用。非 TTY 不使用本模块（保持 raw 直写）。
 * unmount 幂等：渲染实例与退出清理。
 *
 * 智能跟随（scrollFollow）：ink 默认监听 process.stdin，而我们需先从输入里剥掉
 * CPR 响应（否则会被输入框当普通字符插入），因此把过滤流交给 ink，并把控制器
 * 传进组件树。探测在非 TTY 下自动关闭（恒跟随，行为与改动前一致）。
 */

export interface TtyMount {
  unmount(): void;
  instance: Instance;
  scrollFollow: ScrollFollow;
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
  const scrollFollow = createScrollFollow();
  const instance = render(
    React.createElement(App, {
      ctrl,
      onSubmit: hooks.onSubmit,
      onInterrupt: hooks.onInterrupt,
      onExit: hooks.onExit,
      onSetMode: hooks.onSetMode ?? (() => {}),
      initialOutput,
      scrollFollow,
    }),
    // 关闭 ink 默认 exitOnCtrlC：否则 Ctrl+C 被 ink 吞掉，我们自己的
    // "第一次提示 / 第二次退出 / 打印恢复命令" 协议永远收不到事件
    { exitOnCtrlC: false, stdin: scrollFollow.input },
  );
  return {
    instance,
    unmount: () => {
      scrollFollow.dispose();
      instance.unmount();
    },
    scrollFollow,
  };
}
