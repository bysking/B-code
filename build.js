#!/usr/bin/env node

/**
 * Build script for B Code (bcode)
 *
 * Uses esbuild to bundle the CLI into a single executable file.
 * All dependencies are bundled so that npm can execute without
 * downloading/installing dependencies (same pattern as browser-store).
 *
 * Output: dist/cli.mjs — referenced by package.json "bin".
 */

import { build } from 'esbuild';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = join(__dirname, 'dist');

/**
 * react-devtools-core 是 ink 的可选开发依赖：仅在 DEV === 'true' 时被
 * import（ink/build/reconciler.js），生产环境永不执行。esbuild 会因其中的
 * import.meta.resolve() 把它拉进模块图导致解析失败，这里用空模块 stub 掉。
 */
const stubDevtoolsCore = {
  name: 'stub-react-devtools-core',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core',
      namespace: 'stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export default {};',
      loader: 'js',
    }));
  },
};

async function main() {
  console.log('Building B Code with esbuild...\n');

  mkdirSync(outdir, { recursive: true });

  const outfile = join(outdir, 'cli.mjs');

  await build({
    entryPoints: [join(__dirname, 'src/index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    // ink v7 → yoga-layout 3 使用 top-level await，仅支持 ESM 输出
    format: 'esm',
    outfile,
    minify: true,
    sourcemap: false,
    banner: {
      // ESM 输出没有 require；用 createRequire 提供一个，使 CJS 依赖里的
      // 动态 require（dotenv/undici/signal-exit/sdk 等）能正常解析到 node_modules
      js: `#!/usr/bin/env node
import { createRequire as __bcodeCreateRequire } from 'node:module';
const require = __bcodeCreateRequire(import.meta.url);`,
    },
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    plugins: [stubDevtoolsCore],
    // All runtime deps are bundled (react / ink / sdk / undici / dotenv ...).
    // CJS 依赖的动态 require 由 banner 里的 createRequire 兜底。
    external: [],
  });

  console.log('Build complete!');
  console.log('  Output: dist/cli.mjs');
  console.log('  This file includes all npm dependencies bundled together.');
  console.log('\n  Run: node dist/cli.mjs --help');
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
