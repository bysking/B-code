#!/usr/bin/env node

/**
 * 发布构建：Bun + OpenTUI → 单文件可执行程序
 *
 * 与 build.js（esbuild + ink）的区别：
 *
 *   | | build.js | build-bun.js |
 *   |---|---|---|
 *   | 运行时 | Node | Bun（已嵌入二进制） |
 *   | 引擎 | ink | OpenTUI |
 *   | 产物 | dist/cli.mjs 1.9MB | dist/bcode ~70-90MB |
 *   | 用户依赖 | 需要 Node | **零依赖** |
 *
 * ## 为什么必须用 Bun 编译
 *
 * OpenTUI 的原生 FFI 只实现了 Bun 绑定（Node 26 实测也报
 * "native FFI is not available for this runtime"）。所以发布版必须用
 * `bun build --compile`，它会把 Bun 运行时一起打包。
 *
 * ## 平台包的限制
 *
 * OpenTUI 的动态 `import('@opentui/core-<platform>')` 让打包器把所有平台的
 * 原生包都当必需依赖，而这些包带 `os`/`cpu` 字段 → npm 只允许装匹配当前机器的。
 *
 * 结论：**只能在目标平台上原生编译**，交叉编译会因缺包失败。
 * 因此本脚本只构建当前平台，全平台发布由 CI 矩阵完成（见 .github/workflows）。
 *
 * 用法：
 *   node build-bun.js              # 构建当前平台
 *   node build-bun.js --all-check  # 检查各平台前置条件
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = join(__dirname, 'dist');

/** 当前平台的产物名（Windows 要 .exe） */
function outputName() {
  return process.platform === 'win32' ? 'bcode.exe' : 'bcode';
}

/** 检查 Bun 是否可用 */
function assertBun() {
  try {
    execFileSync('bun', ['--version'], { stdio: 'pipe' });
  } catch {
    console.error('❌ 未找到 Bun。安装：https://bun.sh');
    console.error('   macOS/Linux: curl -fsSL https://bun.sh/install | bash');
    console.error('   Windows:     powershell -c "irm bun.sh/install.ps1 | iex"');
    process.exit(1);
  }
}

/**
 * 检查本平台的原生包是否已安装。
 *
 * 装错平台会导致编译时报 "Could not resolve: @opentui/core-<platform>"，
 * 提前给出清晰提示比让用户看打包器报错友好。
 */
function assertNativePackage() {
  const pkg = `@opentui/core-${process.platform}-${process.arch}${
    process.platform === 'linux' ? (isMusl() ? '-musl' : '') : ''
  }`;
  const dir = join(__dirname, 'node_modules', '@opentui', pkg.replace('@opentui/', ''));
  if (!existsSync(dir)) {
    console.warn(`⚠️  未找到 ${pkg}`);
    console.warn('   如果编译失败，运行：bun install');
    console.warn('   （npm 会按 os/cpu 自动跳过其他平台的原生包，这是预期行为）');
  }
  return pkg;
}

/** 判断是否 musl libc（Alpine 等） */
function isMusl() {
  if (process.platform !== 'linux') return false;
  try {
    const { execSync } = require('node:child_process');
    const out = execSync('ldd --version 2>&1 || true', { encoding: 'utf-8' });
    return /musl/i.test(out);
  } catch {
    return false;
  }
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--all-check')) {
    console.log('各平台构建前置条件：\n');
    for (const [os, arch, note] of [
      ['darwin', 'arm64', 'macos-15 (Apple Silicon)'],
      ['darwin', 'x64', 'macos-15-intel (Intel)'],
      ['linux', 'x64', 'ubuntu-latest'],
      ['linux', 'x64-musl', 'ubuntu-latest + musl toolchain'],
      ['win32', 'x64', 'windows-latest'],
    ]) {
      console.log(`  ${os}-${arch.padEnd(9)} ← ${note}`);
    }
    console.log('\n每个平台都必须在该平台上原生编译（npm 的 os/cpu 校验禁止装其他平台的原生包）。');
    return;
  }

  assertBun();
  const nativePkg = assertNativePackage();
  mkdirSync(outdir, { recursive: true });

  const outfile = join(outdir, outputName());
  console.log('Building B Code with Bun + OpenTUI...\n');
  console.log(`  平台:      ${process.platform}-${process.arch}`);
  console.log(`  原生包:    ${nativePkg}`);
  console.log(`  输出:      dist/${outputName()}\n`);

  // 先删旧产物：bun --compile 对已存在的目标可能复用，导致版本混淆
  rmSync(outfile, { force: true });

  try {
    execFileSync(
      'bun',
      [
        'build',
        join(__dirname, 'src/index.ts'),
        '--compile',
        `--outfile=${outfile}`,
        // 构建期注入引擎选择（见 src/ui/ui/index.ts 的 __BCODE_UI_ENGINE__）
        '--define',
        '__BCODE_UI_ENGINE__="opentui"',
        // 生产环境：压缩 + NODE_ENV=production
        '--production',
        // 保留原生包的解析路径：这些包含平台二进制，由 bun 在编译期内联
        // （实测：不写 external 时 bun 会把当前平台的原生二进制正确嵌进产物，
        //  产物脱离 node_modules 仍可运行）
        '--target',
        'bun',
      ],
      { stdio: 'inherit', cwd: __dirname },
    );
  } catch (err) {
    console.error('\n❌ 构建失败');
    console.error('   常见原因：本平台的原生包未安装（运行 bun install）');
    console.error('   另一个可能：bun 版本过旧（需要 >= 1.3.14）');
    process.exit(1);
  }

  console.log('\n✅ 构建完成');
  console.log(`   产物：dist/${outputName()}`);
  console.log('   单文件可执行，用户机器无需安装 Bun 或 Node。');
}

main();
