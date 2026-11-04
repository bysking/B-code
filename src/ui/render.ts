import React from 'react';
import { render, type Instance } from 'ink';
import { App } from './app.js';
import { createScrollFollow, type ScrollFollow } from './scroll-follow.js';
import { setLogSink } from '../utils/log.js';
import { terminalRows } from './scroll-budget.js';
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

  /**
   * 实测帧高并回灌（闭环校验）。
   *
   * ink 的 onRender 只给 renderTime，拿不到高度；而它写 stdout 的内容里带着完整的
   * 帧文本，所以直接旁路统计：每当一笔写入含"内容"（非纯控制序列），就按该笔的
   * 行数当作本帧高度。
   *
   * 为什么必须实测而不能只靠估算：enforceLiveHeight 用 estimateLines + 常量预留，
   * 一旦估偏（软换行/CJK 宽度/面板浮动/markdown 膨胀），live 帧超出终端后 ink 会
   * 整屏清屏（ESC[3J 连 scrollback 一起清），用户回看位置直接丢失。实测回灌把
   * "猜"换成"量"，超了就继续切，直到真的降下来。
   */
  const observed = { rows: 0 };
  // 观测对象必须是 **ink 真正写入的那条流**（下方显式传给 render），而不是
  // 假定 process.stdout——测试/未来切换输出流时两者可能不是同一个对象，
  // 那样观测不到任何写入，闭环校验会静默失效。
  const out = streams?.stdout ?? process.stdout;
  const originalWrite = out.write.bind(out) as (chunk: any, ...a: any[]) => boolean;
  let reconciling = false;
  (out as { write: unknown }).write = (chunk: any, ...rest: any[]): boolean => {
    const s = typeof chunk === 'string' ? chunk : String(chunk);
    const result = originalWrite(chunk, ...rest);
    // 只统计真正含内容的写入：纯 CSI（同步更新/光标/CPR）不动画面，不构成帧
    const visible = s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
    if (visible.trim()) {
      const rows = visible.split('\n').length;
      // 防重入：reconcile 里会 bump() → 触发下一帧 → 又会写 stdout
      if (!reconciling && rows > 0) {
        observed.rows = rows;
        if (rows > Math.max(terminalRows() - 1, 1)) {
          // 必须在**渲染帧之外**收敛：此处正处于 ink 的 renderInteractiveFrame
          // 内部，同步 bump() 会让 React 在渲染期间更新状态并抛错。
          // 用 setImmediate 推到下一轮事件循环，让 ink 先完成本次提交。
          reconciling = true;
          setImmediate(() => {
            try {
              ctrl.reconcileLiveHeight(rows);
            } finally {
              reconciling = false;
            }
          });
        }
      }
    }
    return result;
  };
  const restoreStdout = (): void => {
    (out as { write: unknown }).write = originalWrite;
  };

  const scrollFollow = createScrollFollow({
    ...(streams?.stdin ? { stdin: streams.stdin } : {}),
    ...(streams?.stdout ? { stdout: streams.stdout } : {}),
  });
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
      scrollFollow,
    }),
    // 关闭 ink 默认 exitOnCtrlC：否则 Ctrl+C 被 ink 吞掉，我们自己的
    // "第一次提示 / 第二次退出 / 打印恢复命令" 协议永远收不到事件
    { exitOnCtrlC: false, stdin: scrollFollow.input, stdout: out },
  );
  return {
    instance,
    unmount: () => {
      scrollFollow.dispose();
      instance.unmount();
      restoreStdout(); // 解除帧高观测
      restoreLogSink(); // 交还 stderr，退出期日志要能正常打到终端
    },
    scrollFollow,
  };
}
