import React from "react";
import { render, type Instance } from "ink";
import { App } from "./app.js";
import type { AppController } from "./controller.js";

/**
 * TTY 模式挂载/卸载 ink 应用。非 TTY 不使用本模块（保持 raw 直写）。
 * unmount 幂等：渲染实例与退出清理。
 */

export interface TtyMount {
  unmount(): void;
  instance: Instance;
}

export function mountTtyApp(
  ctrl: AppController,
  hooks: { onSubmit: (text: string) => void; onInterrupt: () => void; onExit: () => void },
  initialOutput?: string[],
): TtyMount {
  const instance = render(
    React.createElement(App, {
      ctrl,
      onSubmit: hooks.onSubmit,
      onInterrupt: hooks.onInterrupt,
      onExit: hooks.onExit,
      initialOutput,
    }),
  );
  return { instance, unmount: () => instance.unmount() };
}