/**
 * 渲染引擎适配层 —— 业务组件的唯一入口。
 *
 * 业务代码一律 `from './ui/index.js'`，**永远不要直接 import 'ink' 或 '@opentui/*'**。
 * 这样换引擎只改这一层，业务组件一行不动。
 *
 * ## 引擎选择机制
 *
 * 构建期用 `BCODE_UI_ENGINE` 注入（见 build.js / build-bun.js），**不是运行时判断**。
 *
 * 为什么不做运行时切换：两个后端实现同一份契约，构建产物只需要其中一个。
 * 运行时判断意味着两个引擎的代码都被打进包——OpenTUI 原生模块 18MB，
 * 白白拖慢 ink 版的启动与体积。ESM 的静态 import 也没法按环境变量条件加载。
 *
 *   BCODE_UI_ENGINE=ink      → 只打包 ink（Node 运行时，开发/回退）
 *   BCODE_UI_ENGINE=opentui  → 只打包 OpenTUI（Bun 运行时，发布版）
 *
 * 未设置时默认 ink —— 开发态 `tsx`/`node` 跑测试都走这条路径。
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

/** 当前引擎名（构建期由 define 注入；开发态缺省 ink） */
export type EngineName = 'ink' | 'opentui';

/**
 * 引擎实现。
 *
 * `__BCODE_UI_ENGINE__` 是构建期替换的常量（esbuild/bun 的 define）。
 * 未注入时（开发态直接跑 TS）退化为 ink。
 *
 * 这里的 import 是**静态**的 —— 打包器能据此 tree-shake 掉另一个引擎。
 * 代价是开发态（未构建）两个都会被解析，但 tsx 是按需加载的，影响很小。
 */
declare const __BCODE_UI_ENGINE__: 'ink' | 'opentui' | undefined;

const ENGINE_NAME: EngineName =
  typeof __BCODE_UI_ENGINE__ !== 'undefined' ? __BCODE_UI_ENGINE__ : 'ink';

// 用 import 而非 require（ESM）；打包时另一个分支会被 tree-shake 掉
import { inkEngine } from './ink/index.js';
import { opentuiEngine } from './opentui/index.js';

export const engineName: EngineName = ENGINE_NAME;

export const engine: UiEngine = ENGINE_NAME === 'opentui' ? opentuiEngine : inkEngine;

/* 便捷导出：业务组件直接 `import { Box, Text } from './ui/index.js'` */
export const Box = engine.Box;
export const Text = engine.Text;
export const useInput = engine.useInput;
export const usePaste = engine.usePaste;
export const useTerminalSize = engine.useTerminalSize;
export const useElementSize = engine.useElementSize;
export const mount = engine.mount;
