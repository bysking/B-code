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

/**
 * 最低 Node 主版本。启动器跑在用户的 Node 上，低于此值不保证行为一致。
 *
 * 只卡主版本（>= 24），不看次/修订号：
 *   - 拿次版本卡人没有意义——24.22.2 只是我们发布时的环境，不是真实下限；
 *   - 预发布版（如 27.0.0-alpha）主版本够就算通过，否则会被误判为过低。
 */
const MIN_NODE_MAJOR = 24;

/** 启动器运行在用户的 Node 上，低于此版本不保证行为一致 */
const MIN_NODE = String(MIN_NODE_MAJOR);

/**
 * 解析 Node 版本号，返回可信的主版本号；无法解析时返回 null。
 *
 * 不用 parseInt 直接取：
 *   - parseInt('abc', 10) → NaN，`NaN < 24` 也是 false，会**错误放行**垃圾输入；
 *   - 这里只认形如 27 / 27.0.0 / 27.0.0-alpha.0.0 的开头数字段。
 */
function nodeMajor(version) {
  const m = /^(\d+)/.exec(String(version).trim());
  return m ? Number(m[1]) : null;
}

// ── 版本探查：必须放在最前 ──
// 后面的 require.resolve / spawn 在旧版本 Node 上的失败信息是"模块找不到"之类，
// 与真实原因（Node 太旧）毫无关系，排查成本高。先在入口拦住。
const currentNode = process.versions.node;
const currentMajor = nodeMajor(currentNode);
if (currentMajor === null || currentMajor < MIN_NODE_MAJOR) {
  console.error(`\n  bcode 需要 Node v${MIN_NODE_MAJOR} 或更高版本，当前是 v${currentNode}\n`);
  console.error('  请升级 Node 后重试，任选一种：');
  console.error('    官网下载   https://nodejs.org/');
  console.error(`    nvm        nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}`);
  console.error(`    fnm        fnm install ${MIN_NODE_MAJOR} && fnm use ${MIN_NODE_MAJOR}`);
  console.error(`    macOS      brew install node@${MIN_NODE_MAJOR}`);
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
