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
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** 官方 registry —— 用于判断用户是否在用镜像源 */
const OFFICIAL_REGISTRY = 'registry.npmjs.org';

/**
 * 读取用户实际生效的 npm registry。
 *
 * 只做文件级解析（不 spawn `npm config get`）：启动器要快，且 npm 可能不在 PATH 上。
 * 查找顺序与 npm 一致：项目 .npmrc → 用户 .npmrc → 全局 npmrc → 内置默认值。
 * 找到 `@bysking:registry` 则优先（scope 级覆盖对整个包生效）。
 *
 * 解析失败一律返回 null，绝不因为诊断信息本身抛错而干扰用户。
 */
function readRegistry() {
  try {
    const files = [
      // 项目级：从 cli 入口往上找（全局安装时通常没有）
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.npmrc'),
      // 用户级
      join(os.homedir(), '.npmrc'),
      // 全局（npm 的全局前缀因平台而异，这里只覆盖常见位置）
      process.env.npm_config_globalconfig,
      process.env.PREFIX ? join(process.env.PREFIX, 'etc', 'npmrc') : null,
    ].filter(Boolean);

    let registry = null;
    let scopeRegistry = null;
    for (const f of files) {
      if (!existsSync(f)) continue;
      let text;
      try {
        text = readFileSync(f, 'utf-8');
      } catch {
        continue;
      }
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const k = line.slice(0, eq).trim();
        const v = line.slice(eq + 1).trim();
        if (!v) continue;
        if (k === 'registry') registry = v;
        else if (k === '@bysking:registry') scopeRegistry = v;
      }
    }
    // scope 级配置优先于全局 registry
    return scopeRegistry ?? registry ?? 'https://registry.npmjs.org/';
  } catch {
    return null;
  }
}

/** 判断是否为官方 registry（大小写、尾斜杠、协议差异都归一化） */
function isOfficialRegistry(url) {
  if (!url) return false;
  return url.toLowerCase().replace(/\/+$/, '').includes(OFFICIAL_REGISTRY);
}

/**
 * 平台包缺失时的诊断输出。
 *
 * 这条路径最常见的根因**不是** optionalDependencies 被跳过，而是用户的 npm 默认
 * registry 指向私有镜像（企业 npm 源、淘宝源等），镜像上没有同步这个公共包。
 * npm 对 optionalDependencies 的解析失败是**静默**的——不报错、不中断安装，
 * 只是少装一个包，用户直到运行时才发现。
 *
 * 所以这里先打印用户实际用的 registry，再按概率给出排查顺序。
 */
function reportMissingPlatformPackage(pkgName) {
  const registry = readRegistry();
  const official = isOfficialRegistry(registry);

  console.error(`\n  缺少平台包 ${pkgName}\n`);
  console.error(`  当前 npm registry: ${registry ?? '(无法读取)'}`);
  if (registry && !official) {
    console.error('  ⚠️  这不是 npm 官方源。私有镜像/镜像站常常没有同步这类公共包，');
    console.error('     而 npm 装不上可选依赖时**不会报错**，只会静默跳过。');
    console.error('     这是本错误最常见的原因。\n');
  } else {
    console.error('');
  }

  console.error('  按以下顺序排查：');
  console.error('    1) 私有镜像未同步该包（若上面不是官方源，优先查这个）');
  console.error('       临时用官方源重装：');
  console.error(`         npm  i -g  ${'@bysking/b-code'} --registry=https://registry.npmjs.org/`);
  console.error(`         pnpm add -g ${'@bysking/b-code'} --registry=https://registry.npmjs.org/`);
  console.error('       或长期配置（只影响本包，不动公司私有源）：');
  console.error('         echo "@bysking:registry=https://registry.npmjs.org/" >> ~/.npmrc');
  console.error('    2) 安装时跳过了可选依赖');
  console.error('         npm install -g @bysking/b-code --include=optional');
  console.error('    3) 平台不受支持（见上方支持的平台列表）\n');
}

let binaryPath;
try {
  binaryPath = require.resolve(`${pkg}/${exe}`);
} catch {
  reportMissingPlatformPackage(pkg);
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
