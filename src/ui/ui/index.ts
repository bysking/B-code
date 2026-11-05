/**
 * 渲染引擎适配层 —— 业务组件的唯一入口。
 *
 * 业务代码一律 `from './ui/index.js'`，**永远不要直接 import 'ink'**。
 * 这样换引擎（ink → OpenTUI）只改这一层，业务组件一行不动。
 *
 * ## 当前状态
 *
 * 只有 ink 后端。OpenTUI 后端待实现（见 plans/render-engine-adapter.md）。
 * 引擎选择机制等第二个实现落地后再加——现在提前引入"运行时切换"只会
 * 增加复杂度而无收益。
 */
export { inkEngine } from './ink/index.js';
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

import { inkEngine } from './ink/index.js';

/**
 * 当前生效的引擎。
 *
 * 现在恒为 ink。将来接入 OpenTUI 后，这里改为按环境变量或构建时注入选择。
 */
export const engine = inkEngine;

/** 便捷导出：业务组件直接 `import { Box, Text } from './ui/index.js'` */
export const Box = inkEngine.Box;
export const Text = inkEngine.Text;
export const useInput = inkEngine.useInput;
export const usePaste = inkEngine.usePaste;
export const useTerminalSize = inkEngine.useTerminalSize;
export const useElementSize = inkEngine.useElementSize;
export const mount = inkEngine.mount;
