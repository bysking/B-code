#!/usr/bin/env node

/**
 * 发布前的一致性校验：版本号与平台清单必须处处对齐。
 *
 * ## 为什么需要
 *
 * 主包的 `optionalDependencies` 把平台包版本写死成当前版本号。发版时只改
 * `package.json` 的 `version` 而漏改这几行，用户 `npm i -g` 会去解析一个
 * 不存在的版本 —— npm 对 optionalDependencies 的失败是**静默跳过**的，
 * 最终表现是"装完了但 bcode 命令报缺少平台包"，排查成本很高。
 *
 * 同一份平台清单还散落在三处（optionalDependencies / bin/bcode.js 的
 * SUPPORTED / scripts/pack-platform.js 的 supported），漏掉一处就会出现
 * "发了包但启动器不认"的错配，所以一并校验。
 *
 * Node 最低版本同理散在两处（package.json 的 engines.node / bin/bcode.js
 * 的 MIN_NODE），一并校验。
 *
 * 用法：
 *   node scripts/check-version.js            # 只校验内部一致性
 *   node scripts/check-version.js v3.0.0     # 额外校验与 git tag 一致
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const errors = [];

/**
 * 平台清单的权威来源是 scripts/sync-version.js 的 PLATFORMS。
 *
 * 注意：`package.json` 里的 optionalDependencies 是**提交进仓库**的（由
 * `bun run version:sync` 从 version 展开），不再用 prepack 临时注入——
 * 那种做法会让 registry 元数据丢字段（详见 sync-version.js 顶部注释）。 */
const syncer = readFileSync(join(root, 'scripts', 'sync-version.js'), 'utf-8');
const platformsBlock = /const PLATFORMS = \[([^\]]*)\]/.exec(syncer);
if (!platformsBlock) {
  errors.push('scripts/sync-version.js 里找不到 PLATFORMS 清单');
}
const optionalPlatforms = platformsBlock
  ? [...platformsBlock[1].matchAll(/'([\w-]+)'/g)].map((m) => m[1])
  : [];

if (optionalPlatforms.length === 0) {
  errors.push('scripts/sync-version.js 的 PLATFORMS 为空');
}

// ── 1. 平台包版本必须与主包一致（不一致 → 用户装不上，且 npm 不报错）──
const optional = pkg.optionalDependencies ?? {};
for (const platform of optionalPlatforms) {
  const name = `${pkg.name}-${platform}`;
  const version = optional[name];
  if (version === undefined) {
    errors.push(`${name} 缺失于 optionalDependencies（用户在该平台装不到二进制）`);
  } else if (version !== pkg.version) {
    errors.push(`${name} 为 ${version}，应为 ${pkg.version}（运行 bun run version:sync 修复）`);
  }
}

// ── 2. bin/bcode.js 的 SUPPORTED 必须覆盖同样的平台 ──
const launcher = readFileSync(join(root, 'bin', 'bcode.js'), 'utf-8');
const supportedBlock = /const SUPPORTED = \{([\s\S]*?)\};/.exec(launcher);
if (!supportedBlock) {
  errors.push('bin/bcode.js 里找不到 SUPPORTED 表');
} else {
  const launcherPlatforms = [...supportedBlock[1].matchAll(/'([\w-]+)':/g)].map((m) => m[1]);
  for (const platform of optionalPlatforms) {
    if (!launcherPlatforms.includes(platform)) {
      errors.push(`bin/bcode.js 的 SUPPORTED 缺少 ${platform}（optionalDependencies 里有）`);
    }
  }
  for (const platform of launcherPlatforms) {
    if (!optionalPlatforms.includes(platform)) {
      errors.push(`bin/bcode.js 的 SUPPORTED 多了 ${platform}（optionalDependencies 里没有）`);
    }
  }
}

// ── 3. pack-platform.js 的 supported 必须与之一致 ──
const packer = readFileSync(join(root, 'scripts', 'pack-platform.js'), 'utf-8');
const packerBlock = /const supported = \[([^\]]*)\]/.exec(packer);
if (!packerBlock) {
  errors.push('scripts/pack-platform.js 里找不到 supported 清单');
} else {
  const packerPlatforms = [...packerBlock[1].matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
  for (const platform of optionalPlatforms) {
    if (!packerPlatforms.includes(platform)) {
      errors.push(`scripts/pack-platform.js 的 supported 缺少 ${platform}`);
    }
  }
}

// ── 4. lib/index.js 导出的 platforms 必须与之一致 ──
const libEntry = readFileSync(join(root, 'lib', 'index.js'), 'utf-8');
const libBlock = /export const platforms = \{([\s\S]*?)\};/.exec(libEntry);
if (!libBlock) {
  errors.push('lib/index.js 里找不到 platforms 表');
} else {
  const libPlatforms = [...libBlock[1].matchAll(/'([\w-]+)':/g)].map((m) => m[1]);
  for (const platform of optionalPlatforms) {
    if (!libPlatforms.includes(platform)) {
      errors.push(`lib/index.js 的 platforms 缺少 ${platform}`);
    }
  }
}

// ── 5. package.json 的 files 必须收进 main 与 bin 所在目录 ──
const files = pkg.files ?? [];
const mainDir = (pkg.main ?? '').split('/')[0];
if (mainDir && !files.includes(mainDir)) {
  errors.push(`package.json 的 files 缺少 main 所在目录 "${mainDir}"（发布后入口会丢失）`);
}
const binDir = (pkg.bin?.bcode ?? '').split('/')[1];
if (binDir && !files.includes(binDir)) {
  errors.push(`package.json 的 files 缺少 bin 所在目录 "${binDir}"`);
}

// ── 6. git tag 与 package.json 版本一致（CI 打 tag 触发时）──
const tag = process.argv[2];
if (tag) {
  const expected = `v${pkg.version}`;
  if (tag !== expected) {
    errors.push(`git tag 是 ${tag}，但 package.json 版本是 ${pkg.version}（应为 ${expected}）`);
  }
}

// ── 7. Node 版本要求：bin/bcode.js 的 MIN_NODE 与 package.json 的 engines.node ──
// 启动器的运行时探查和 engines 是同一件事的两处声明：engines 决定 npm 装不装，
// MIN_NODE 决定装了之后跑不跑。只改一处就会出现"npm 放行、运行时报错"（或反之）。
const minNode = /const MIN_NODE = '([^']+)'/.exec(launcher);
const enginesNode = pkg.engines?.node ?? '';
if (!minNode) {
  errors.push('bin/bcode.js 里找不到 MIN_NODE');
} else if (enginesNode !== `>=${minNode[1]}`) {
  errors.push(
    `package.json 的 engines.node 是 ${enginesNode || '(空)'}，应为 >=${minNode[1]}（与 bin/bcode.js 的 MIN_NODE 一致）`,
  );
}

if (errors.length > 0) {
  console.error('❌ 发布版本校验失败：\n');
  for (const e of errors) console.error(`   - ${e}`);
  console.error('\n   修改 package.json 的 version 时，记得同步 optionalDependencies 的 4 行。');
  process.exit(1);
}

console.log(`✅ 版本一致性校验通过：${pkg.name}@${pkg.version}`);
console.log(`   平台：${optionalPlatforms.join(', ')}`);
