/**
 * 库入口：让 `require('@bysking/b-code')` / `import('@bysking/b-code')`
 * 拿到版本与平台信息，而不是一执行就启动 TUI。
 *
 * ## 为什么需要
 *
 * 主包的 `main` 指向 `bin/bcode.js`（启动器）。它只用了 node 内置模块，
 * 手写 JS，不引任何依赖——但如果直接把它当 `main`，任何 `require()` 都会
 * 立刻 `spawn` 子进程并接管 stdio，对调用方是灾难。所以主包导出这个空壳。
 *
 * ## 为什么是手写 JS 而不是 TS
 *
 * 主包 tarball 里只有 `bin/`（见 package.json 的 files），不含源码也不含
 * 构建产物。这个文件因此必须零依赖、无构建步骤，Node 直接可跑。
 * 版本号在发布时从 package.json 现读，避免两处维护。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 主包 package.json（与 bin/ 同级） */
function readPkg() {
  try {
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8'));
  } catch {
    return {};
  }
}

const pkg = readPkg();

/** 包名 */
export const name = pkg.name ?? '@bysking/b-code';

/** 主包版本（与各平台包版本一致） */
export const version = pkg.version ?? '0.0.0';

/** 支持的平台 → 平台包名（与 bin/bcode.js 的 SUPPORTED 保持一致） */
export const platforms = {
  'darwin-arm64': '@bysking/b-code-darwin-arm64',
  'darwin-x64': '@bysking/b-code-darwin-x64',
  'linux-x64': '@bysking/b-code-linux-x64',
  'win32-x64': '@bysking/b-code-win32-x64',
};

const info = { name, version, platforms };
export default info;
