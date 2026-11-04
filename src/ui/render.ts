import React from 'react';
import { render, type Instance } from 'ink';
import { App } from './app.js';
import { setLogSink } from '../utils/log.js';
import type { AppController } from './controller.js';
import type { Mode } from '../permissions.js';
import type { ClipboardImage } from '../utils/clipboard.js';

/**
 * TTY 模式挂载/卸载 ink 应用（ink 8 滚动视口版）。
 *
 * 旧实现这里还挂着两套补丁，现在都不需要了：
 *
 *   1. **CPR 光标探测过滤流**（scroll-follow）：向终端发 `\x1b[6n` 问光标位置来判断
 *      用户是否滚离底部，还要把应答从输入里剥掉以免污染输入框。滚动改成应用内状态后
 *      完全不需要——视口是我们自己画的，位置也是我们自己的变量。
 *
 *   2. **劫持 stdout.write 实测帧高**（reconcileLiveHeight）：因为旧模型要求 live 帧
 *      恒矮于终端行数，估偏就会触发 ink 整屏清屏，所以得旁路数每帧行数再回灌修正。
 *      新模型下内容画在固定高度视口里，溢出只是裁剪滚动，不存在"帧太高"这回事。
 *
 * 顺带的好处：ink 8 的 useInput 已经会丢弃未识别的控制序列（光标位置报告、鼠标事件等），
 * 不再需要自己做输入过滤。
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
    /** 能力面板（/skills、/mcp）：空格启停 */
    onToggleCapability?: (name: string) => void;
    /** 能力面板 R：重连 MCP server */
    onReconnectCapability?: (name: string) => void;
    /** 能力面板：重拉列表数据 */
    refreshCapability?: () => void;
  },
  initialOutput?: string[],
  /** 输出/输入流（缺省 process.stdout / process.stdin）。注入供测试与未来复用。 */
  streams?: { stdout?: NodeJS.WriteStream; stdin?: NodeJS.ReadStream },
): TtyMount {
  /**
   * 接管系统日志：TTY 下不写 stderr，而是收进 controller 供 Ctrl+O 的"日志"页查看。
   *
   * 不写 stderr 的原因：每写一次终端就把视口拉到光标处——用户向上回看历史时会被
   * 后台日志（MCP 连接、hook 超时、会话保存失败等）硬拽回底部；而且 ink 接管屏幕后
   * stderr 的内容本来也没地方展示，等于既打扰又看不见。
   * 文件落地（B_CODE_LOG_FILE）不受影响，仍在 log.ts 里照写。
   */
  const restoreLogSink = setLogSink((line) => ctrl.pushLog(line));

  const out = streams?.stdout ?? process.stdout;
  const instance = render(
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
    // 关闭 ink 默认 exitOnCtrlC：否则 Ctrl+C 被 ink 吞掉，我们自己的
    // "第一次提示 / 第二次退出 / 打印恢复命令" 协议永远收不到事件
    { exitOnCtrlC: false, stdin: streams?.stdin ?? process.stdin, stdout: out },
  );
  return {
    instance,
    unmount: () => {
      instance.unmount();
      restoreLogSink(); // 交还 stderr，退出期日志要能正常打到终端
    },
  };
}
