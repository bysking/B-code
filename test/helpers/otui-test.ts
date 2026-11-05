import type React from 'react';
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';

/**
 * OpenTUI 测试渲染器封装 —— 替代原先的 `ink-testing-library`。
 *
 * ## 与 ink-testing-library 的对应关系
 *
 * | ink-testing-library | 这里 |
 * |---|---|
 * | `render(node)` | `renderOtui(node)` |
 * | `frame.lastFrame()` | `getFrame()` / `frameText()` |
 * | `frame.stdin.write(keys)` | `press(keys)` / `typeText(s)` |
 * | `frame.cleanup()` | `cleanup()` |
 *
 * ## 为什么要包一层
 *
 * OpenTUI 的测试 API 是异步的（`createTestRenderer` 返回 Promise，
 * 每帧要 `renderOnce()` / `flush()` 才落地），而原测试大量使用同步的
 * `frame.lastFrame()`。这里把异步细节收起来，让业务测试保持原来的
 * "渲染 → 断言文本" 写法。
 */

export interface OtuiTestFrame {
  /** 当前画面文本（等价 ink 的 lastFrame） */
  frame(): string;
  /** 模拟按键。传 KeyCodes 里的常量或普通字符 */
  press(keys: string): Promise<void>;
  /** 逐字符输入文本 */
  typeText(text: string): Promise<void>;
  /** 等画面出现指定文本（超时抛错，带当前画面便于定位） */
  waitFor(needle: string, label?: string, timeoutMs?: number): Promise<string>;
  /** 让渲染落地（改状态后调用） */
  flush(): Promise<void>;
  cleanup(): Promise<void>;
  /** 底层 setup，需要更细粒度控制时用 */
  raw: TestRendererSetup;
}

/** 剥离 ANSI 色码（断言只看纯文本） */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
}

/**
 * 挂载一棵 React 树到测试渲染器。
 *
 * 默认 100x40：足够放下大多数面板，且能复现"内容超屏"的场景。
 */
export async function renderOtui(
  node: React.ReactNode,
  opts: { width?: number; height?: number } = {},
): Promise<OtuiTestFrame> {
  const setup = await createTestRenderer({
    width: opts.width ?? 100,
    height: opts.height ?? 40,
  });

  const root = createRoot(setup.renderer as never);
  root.render(node);
  // renderOnce() 是必需的：createRoot().render() 只提交 React 树，
  // 真正画一帧要显式调它。只调 flush() 会拿到全空白的画面。
  await setup.renderOnce();
  // 再等一轮：<markdown> 等内容型组件是**异步解析**的（tree-sitter），
  // 首帧往往还是空的。给它们一个短窗口落地，否则断言会读到空白画面。
  await new Promise((r) => setTimeout(r, 60));
  await setup.renderOnce();

  const frame: OtuiTestFrame = {
    frame: () => stripAnsi(setup.captureCharFrame()),
    async press(keys: string) {
      // 区分「按键序列」与「文本输入」：
      //   - `\x1b[B` 这类转义序列是**一个**按键（方向键）
      //   - `abc` 是三个字符，要逐字输入
      // OpenTUI 的 pressKey 按"单个按键"解析整串，把 'abc' 传进去会当成一个
      // 未知键丢掉；必须用 typeText 逐字符。
      if (isEscapeSequence(keys) || keys.length <= 1) {
        setup.mockInput.pressKey(keys);
        await setup.renderOnce();
      } else {
        // 逐字符输入，**每个字符之间让渲染落地一次**。
        // 一次 typeText('abc') 会把三个字符在同一微任务里连发，React 的
        // setState 批处理会合并——受控组件（输入框）只能看到最后一个字符，
        // 表现就是"输入 abc 只剩 c"。
        for (const ch of keys) {
          setup.mockInput.pressKey(ch);
          await setup.renderOnce();
        }
      }
    },
    async typeText(text: string) {
      for (const ch of text) {
        setup.mockInput.typeText(ch);
      }
      await setup.renderOnce();
    },
    async flush() {
      await setup.renderOnce();
      // 内容型组件（markdown/代码块）解析是异步的，等一小段再画一次
      await new Promise((r) => setTimeout(r, 60));
      await setup.renderOnce();
    },
    async waitFor(needle: string, label = needle, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const out = frame.frame();
        if (out.includes(needle)) return out;
        if (Date.now() > deadline) {
          throw new Error(`waitFor 超时（${label}）：\n……${out.slice(-800)}`);
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async cleanup() {
      try {
        root.unmount();
      } catch {
        // 已卸载
      }
      await setup.dispose();
    },
    raw: setup,
  };

  return frame;
}

/** 是否为一个完整的转义序列（方向键/功能键等），而非可打印文本 */
function isEscapeSequence(s: string): boolean {
  return s.startsWith('\x1b');
}

/** 等待若干毫秒（渲染提交在帧边界后） */
export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
