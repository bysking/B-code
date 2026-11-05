/**
 * 渲染引擎适配层 —— 业务组件的唯一入口。
 *
 * 业务代码一律 `from './ui/index.js'`，**不要直接 import '@opentui/*'**。
 *
 * ## 为什么保留这一层（只有一个引擎了）
 *
 * 即便现在只有 OpenTUI，适配层依然有价值：
 *
 * 1. **收敛 OpenTUI 与 ink 的语义差异**。我们从 ink 迁移过来，业务代码是按
 *    ink 的语义写的（Box 默认 row、Text 可嵌套、按键用布尔字段…）。
 *    适配层把这些差异吃掉，业务组件不用逐处修改。
 * 2. **隔离原生依赖**。OpenTUI 的原生模块只能跑 Bun（Node 下 FFI 加载失败）。
 *    适配层是唯一接触它的地方，将来若要再换引擎只改这里。
 * 3. **测试可注入**。`mount` 可替换，业务逻辑测试不必真起渲染器。
 */
import type { UiEngine } from './types.js';

export type {
  BoxProps,
  Color,
  ElementSize,
  InputHandler,
  KeyLike,
  MountedApp,
  MountOptions,
  TerminalSize,
  TextProps,
  UiEngine,
} from './types.js';
export { EMPTY_KEY } from './types.js';

/** 当前引擎名（只有 opentui 一个实现，保留常量便于日志/诊断） */
export type EngineName = 'opentui';
export const engineName: EngineName = 'opentui';

import { opentuiEngine } from './opentui/index.js';

export const engine: UiEngine = opentuiEngine;

/* 便捷导出：业务组件直接 `import { Box, Text } from './ui/index.js'` */
export const Box = engine.Box;
export const Text = engine.Text;
export const useInput = engine.useInput;
export const usePaste = engine.usePaste;
export const useTerminalSize = engine.useTerminalSize;
export const useElementSize = engine.useElementSize;
export const mount = engine.mount;
