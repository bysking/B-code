#!/usr/bin/env node
/**
 * bcode 启动器：把调用转发到当前平台的预编译二进制。
 *
 * ## 为什么需要这一层
 *
 * 发布版是 `bun build --compile` 出的单文件可执行程序（~75MB，内含 Bun 运行时），
 * 每个平台一份。npm 没法把多个平台的大文件塞进一个包（且用户只需自己那份），
 * 所以拆成 optionalDependencies：
 *
 *   @bysking/b-code                  主包（本文件，~30KB）
 *   @bysking/b-code-darwin-arm64     各平台二进制
 *   ...
 *
 * npm 按 os/cpu 字段自动只装匹配的那个，这里负责找到并启动它。
 *
 * 注意：主包 `"type": "module"`，所以本文件是 ESM——
 * 用 `createRequire` 拿到 require 才能 require.resolve 平台包。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';

const require = createRequire(import.meta.url);

/** 启动器运行在用户的 Node 上，低于此版本不保证行为一致 */
const MIN_NODE = '24.22.2';

/**
 * 比较版本号，返回 -1 / 0 / 1。
 *
 * 只比较 主.次.修订，预发布后缀（-rc.1 等）直接忽略：这里只做准入判断，
 * 不需要 semver 的完整语义，为它引一个依赖不值得。
 */
function compareVersion(a, b) {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

// ── 版本探查：必须放在最前 ──
// 后面的 require.resolve / spawn 在旧版本 Node 上的失败信息是"模块找不到"之类，
// 与真实原因（Node 太旧）毫无关系，排查成本高。先在入口拦住。
const currentNode = process.versions.node;
if (compareVersion(currentNode, MIN_NODE) < 0) {
  console.error(`\n  bcode 需要 Node v${MIN_NODE} 或更高版本，当前是 v${currentNode}\n`);
  console.error('  请升级 Node 后重试，任选一种：');
  console.error('    官网下载   https://nodejs.org/');
  console.error('    nvm        nvm install 24 && nvm use 24');
  console.error('    fnm        fnm install 24 && fnm use 24');
  console.error('    macOS      brew install node@24');
  console.error('    Windows    winget install OpenJS.NodeJS\n');
  process.exit(1);
}

const platform = process.platform;
const arch = process.arch;

/** 支持的平台（与 package.json 的 optionalDependencies 一致） */
const SUPPORTED = {
  'darwin-arm64': '@bysking/b-code-darwin-arm64',
  'darwin-x64': '@bysking/b-code-darwin-x64',
  'linux-x64': '@bysking/b-code-linux-x64',
  'win32-x64': '@bysking/b-code-win32-x64',
};

const key = `${platform}-${arch}`;
const pkg = SUPPORTED[key];

if (!pkg) {
  console.error(`\n  bcode 暂不支持 ${key}\n`);
  console.error('  支持的平台：');
  for (const p of Object.keys(SUPPORTED)) console.error(`    ${p}`);
  console.error('\n  可以提 issue 或自行构建：');
  console.error('    git clone https://github.com/bysking/b-code');
  console.error('    bun install && bun run build:bun\n');
  process.exit(1);
}

const exe = platform === 'win32' ? 'bcode.exe' : 'bcode';

let binaryPath;
try {
  binaryPath = require.resolve(`${pkg}/${exe}`);
} catch {
  console.error(`\n  缺少平台包 ${pkg}\n`);
  console.error('  这通常意味着安装时跳过了 optionalDependencies。请重试：');
  console.error('    npm install -g @bysking/b-code --include=optional\n');
  process.exit(1);
}

// 转发所有参数与 stdio（终端 TUI 需要继承 stdin/stdout 才能正常交互）
const child = spawn(binaryPath, process.argv.slice(2), { stdio: 'inherit' });

child.on('error', (err) => {
  console.error(`\n  启动 bcode 失败：${err.message}\n`);
  process.exit(1);
});

// 信号转发：Ctrl+C 等要传给子进程，否则它收不到中断
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig));
}

child.on('exit', (code, signal) => {
  // 被信号杀掉时用 128+n 作为退出码（shell 惯例）
  if (signal) process.exit(128 + (os.constants.signals[signal] ?? 1));
  process.exit(code ?? 0);
});
