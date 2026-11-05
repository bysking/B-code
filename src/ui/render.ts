import React from 'react';
import { createCliRenderer, type CliRenderer } from '@opentui/core';
import { createRoot, type Root } from '@opentui/react';
import { App } from './app.js';
import { setLogSink } from '../utils/log.js';
import type { AppController } from './controller.js';
import type { Mode } from '../permissions.js';
import type { ClipboardImage } from '../utils/clipboard.js';

/**
 * TTY 挂载入口（OpenTUI）。
 *
 * ## 两阶段初始化
 *
 * OpenTUI 的 `createCliRenderer()` 是异步的（要加载原生库、探测终端能力），
 * 所以挂载流程是：
 *
 *   1. `createCliRenderer()` —— 建渲染器，接管终端（备用屏、raw mode、鼠标）
 *   2. `createRoot(renderer).render(node)` —— 挂 React 树
 *
 * 卸载时顺序反过来：先 unmount React 树，再 destroy 渲染器（它负责还终端）。
 *
 * ## 日志去哪了
 *
 * OpenTUI 接管 stdout 后，`console.log` 默认进它的 **console overlay**
 * （屏幕上的一块浮层），而不是终端滚动区。这有两个后果：
 *
 *   - 调试信息不会打乱 UI（好事）
 *   - 但 overlay 默认不显示，看起来就像"日志被吞了"（正是之前踩的 bug）
 *
 * 处理：`consoleMode: 'console-overlay'` + 挂载后 `renderer.console.show()`。
 * 业务日志仍走 `setLogSink` 收进 Ctrl+O 面板（与之前一致）。
 */

export interface TtyMount {
  unmount(): void;
  /** 渲染器实例（测试/调试用） */
  renderer: CliRenderer;
}

export interface TtyHooks {
  onSubmit: (text: string | { text: string; images?: ClipboardImage[] }) => void;
  onInterrupt: () => void;
  onExit: () => void;
  onSetMode?: (mode: Mode) => void;
  /** 能力面板（/skills、/mcp）：空格启停 */
  onToggleCapability?: (name: string) => void;
  /** 能力面板 R：重连 MCP server */
  onReconnectCapability?: (name: string) => void;
  /** 能力面板：重拉列表数据 */
  refreshCapability?: () => void;
}

/** 挂载 UI */
export async function mountTtyApp(
  ctrl: AppController,
  hooks: TtyHooks,
  initialOutput?: string[],
  /** 输出/输入流（缺省 process.stdout / process.stdin）。注入供测试用。 */
  streams?: { stdout?: NodeJS.WriteStream; stdin?: NodeJS.ReadStream },
): Promise<TtyMount> {
  /**
   * 接管系统日志：收进 controller 供 Ctrl+O 的"日志"页查看。
   *
   * 不直接写 stderr 的原因：每写一次终端就把视口拉到光标处，用户向上回看历史时
   * 会被后台日志（MCP 连接、hook 超时等）硬拽回底部。
   * 文件落地（B_CODE_LOG_FILE）不受影响，仍在 log.ts 里照写。
   */
  const restoreLogSink = setLogSink((line) => ctrl.pushLog(line));

  const renderer = await createCliRenderer({
    // 关闭默认的 Ctrl+C 退出：我们要自己实现"第一次提示、第二次退出"协议
    exitOnCtrlC: false,
    // console.* 进浮层而不是打乱主界面
    consoleMode: 'console-overlay',
    // 备用屏：退出后恢复用户原来的终端内容（vim/htop 同款行为）
    screenMode: 'alternate-screen',
    // 外部输出（子进程 stdout 等）直通，不拦截
    externalOutputMode: 'passthrough',
    ...(streams?.stdout ? { stdout: streams.stdout } : {}),
    ...(streams?.stdin ? { stdin: streams.stdin } : {}),
  });

  const root: Root = createRoot(renderer);
  root.render(
    React.createElement(App, {
      ctrl,
      onSubmit: hooks.onSubmit,
      onInterrupt: hooks.onInterrupt,
      onExit: hooks.onExit,
      onSetMode: hooks.onSetMode ?? (() => {}),
      onToggleCapability: hooks.onToggleCapability,
      onReconnectCapability: hooks.onReconnectCapability,
      refreshCapability: hooks.refreshCapability,
      initialOutput,
    }),
  );

  /**
   * console overlay **默认不打开**。
   *
   * 打开它会悬浮在 UI 上方遮挡内容（实测：斜杠菜单被 `Console (Focused)` 盖住）。
   * 调试时需要看 console 输出，用 `BCODE_DEBUG_CONSOLE=1` 环境变量启动。
   *
   * 业务日志本来就不走 console——它们经 `setLogSink` 收进 Ctrl+O 面板，
   * 所以默认关掉 overlay 不影响正常诊断。
   */
  if (process.env.BCODE_DEBUG_CONSOLE === '1') {
    renderer.console.show();
  }

  return {
    renderer,
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
      restoreLogSink(); // 交还 stderr，退出期日志要能正常打到终端
    },
  };
}
