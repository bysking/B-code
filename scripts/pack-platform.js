#!/usr/bin/env node

/**
 * 生成平台包：把当前平台的编译产物打成可发布的 npm 包。
 *
 * ## 为什么按平台拆包
 *
 * 编译产物 ~75MB/平台。塞进一个包的话用户要下 4 份（300MB），而 npm 的
 * optionalDependencies + os/cpu 字段能让每个人只装自己那份。
 *
 * ## 流程（CI 里每个平台跑一次）
 *
 *   1. bun run build:bun          → dist/bcode
 *   2. node scripts/pack-platform.js → dist-pkg/<platform>/
 *   3. cd dist-pkg/<platform> && npm publish
 *
 * ## 命名规则
 *
 * 包名 `@bysking/b-code-<platform>-<arch>`，os/cpu 字段让 npm 精确匹配。
 *
 * linux 的 musl 变体（Alpine 等）额外加 `-musl` 后缀并用 `libc` 字段区分。
 * 它**必须**同时登记在主包 optionalDependencies、bin/bcode.js 的 SUPPORTED、
 * 本文件的 supported 三处，否则会出现"发了包但启动器不认"的错配；
 * `scripts/check-version.js` 会校验这三处是否对齐。
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

/** 主包 package.json（取版本号等信息） */
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));

/** 判断 musl（Alpine 等） */
function isMusl() {
  if (process.platform !== 'linux') return false;
  try {
    const out = execFileSync('ldd', ['--version'], { encoding: 'utf-8', stdio: 'pipe' });
    return /musl/i.test(out);
  } catch {
    // ldd 在 musl 下会报错，其错误信息里带 musl
    return false;
  }
}

function main() {
  const platform = process.platform;
  const arch = process.arch;
  const musl = isMusl();

  // 支持清单（含 musl 变体）；win32-arm64 用户太少，暂不提供
  const supported = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-x64-musl', 'win32-x64'];
  const suffix = musl ? '-musl' : '';
  const key = `${platform}-${arch}${suffix}`;

  if (!supported.includes(key)) {
    console.error(`❌ 不支持的平台：${key}`);
    console.error(`   支持：${supported.join(', ')}`);
    process.exit(1);
  }

  const binName = platform === 'win32' ? 'bcode.exe' : 'bcode';
  const binPath = join(root, 'dist', binName);
  if (!existsSync(binPath)) {
    console.error(`❌ 未找到 ${binPath}`);
    console.error('   先运行：bun run build:bun');
    process.exit(1);
  }

  const pkgName = `@bysking/b-code-${key}`;
  const outDir = join(root, 'dist-pkg', key);
  mkdirSync(outDir, { recursive: true });

  // 复制二进制（不复制到 dist-pkg 之外，保持发布目录干净）
  // copyFile 会连权限一起带过来，但 Windows 无执行位概念，chmod 会失败 —— 用原生 API 按需设置
  copyFileSync(binPath, join(outDir, binName));
  if (platform !== 'win32') {
    chmodSync(join(outDir, binName), 0o755);
  }

  const pkgJson = {
    name: pkgName,
    version: rootPkg.version,
    description: `bcode 的 ${key} 平台二进制（由 @bysking/b-code 自动安装）`,
    license: rootPkg.license,
    // os/cpu/libc 让 npm 只在该平台安装——这是 optionalDependencies 生效的关键
    os: [platform],
    cpu: [arch],
    ...(musl ? { libc: ['musl'] } : platform === 'linux' ? { libc: ['glibc'] } : {}),
    // 二进制直接放包根，启动器用 require.resolve('pkg/bcode') 定位
    files: [binName],
    // 明确声明可执行文件，某些包管理器需要
    bin: {},
    publishConfig: rootPkg.publishConfig,
    repository: rootPkg.repository,
    homepage: rootPkg.homepage,
  };

  writeFileSync(join(outDir, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n');

  // 打包后立刻校验执行位。npm 打包会保留该位，但 CI 里任何一次
  // zip 中转（如 actions/upload-artifact，官方明确说不保留 Unix 权限）
  // 都会把它抹成 644，用户安装后执行就报 EACCES —— 这类问题只有装到用户机器
  // 才会暴露，所以必须在这里就拦住。
  if (platform !== 'win32') {
    const mode = statSync(join(outDir, binName)).mode & 0o777;
    if ((mode & 0o111) === 0) {
      console.error(`❌ ${binName} 缺少执行位（mode=${mode.toString(8)}）`);
      console.error('   用户安装后运行会报 EACCES。检查构建流程是否经过 zip 中转。');
      process.exit(1);
    }
  }

  // 用 statSync 而非 du：Windows runner 上 du 不一定存在
  const sizeMb = (statSync(join(outDir, binName)).size / 1024 / 1024).toFixed(1);

  console.log('✅ 平台包已生成\n');
  console.log(`   包名:  ${pkgName}@${rootPkg.version}`);
  console.log(`   目录:  dist-pkg/${key}/`);
  console.log(`   体积:  ${sizeMb}MB`);
  console.log(`   平台:  os=${platform} cpu=${arch}${musl ? ' libc=musl' : ''}`);
  console.log(`\n   发布：cd dist-pkg/${key} && npm publish`);
}

main();
