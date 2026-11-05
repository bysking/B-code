import React from 'react';
import { mount as engineMount } from './ui/index.js';
import { App } from './app.js';
import { setLogSink } from '../utils/log.js';
import {
  createMouseFilteredInput,
  MOUSE_DISABLE,
  MOUSE_ENABLE,
  type MouseEvent,
} from './mouse.js';
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
}

/** 挂载UI入口 */
export async function mountTtyApp(
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
    /** 鼠标滚轮：滚动历史视口（±1 = 滚一行，通常 ±3） */
    onMouseWheel?: (delta: number) => void;
  },
  initialOutput?: string[],
  /** 输出/输入流（缺省 process.stdout / process.stdin）。注入供测试与未来复用。 */
  streams?: { stdout?: NodeJS.WriteStream; stdin?: NodeJS.ReadStream },
): Promise<TtyMount> {
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
  const realStdin = streams?.stdin ?? process.stdin;

  /**
   * 鼠标滚轮：必须在喂给 ink **之前**拦下。
   *
   * ink 8 会主动丢弃未识别的控制序列（含鼠标报告），所以拿不到这些事件；
   * 我们在 stdin 上挂一层过滤流，把 `\x1b[<64;x;yM` 这类序列摘出来转成滚动，
   * 其余输入原样转发给 ink。
   */
  const mouse = createMouseFilteredInput(realStdin, (ev: MouseEvent) => {
    if (!ev.wheel) return;
    // 一格滚轮 ≈ 3 行，与常见终端行为一致
    hooks.onMouseWheel?.(ev.wheel === 'up' ? 3 : -3);
  });

  // 开启鼠标追踪：只在真实 TTY 下做，非 TTY（管道/CI）会污染输出
  const mouseEnabled = Boolean(process.stdout.isTTY && realStdin.isTTY);
  if (mouseEnabled) out.write(MOUSE_ENABLE);

  const app = await engineMount(
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
    {
      stdout: out,
      stdin: mouse.input,
      // 关闭引擎默认的 exitOnCtrlC：否则 Ctrl+C 被引擎吞掉，我们自己的
      // "第一次提示 / 第二次退出 / 打印恢复命令" 协议永远收不到事件
      exitOnCtrlC: false,
    },
  );
  return {
    unmount: () => {
      app.unmount();
      // 关掉鼠标追踪并摘掉过滤流：否则退出后终端仍在鼠标模式下（原生选中失效）
      if (mouseEnabled) {
        try {
          out.write(MOUSE_DISABLE);
        } catch {
          // 流已关闭
        }
      }
      mouse.dispose();
      restoreLogSink(); // 交还 stderr，退出期日志要能正常打到终端
    },
  };
}
