#!/usr/bin/env node

/**
 * 版本号单一来源：`package.json` 的 `version` 一处，4 行平台包版本由本脚本展开。
 *
 * ## 为什么不用 prepack 注入（曾经踩过的坑）
 *
 * 最初的实现是 `prepack` 注入 `optionalDependencies`、`postpack` 还原，想在发布时
 * 临时拼出 4 行、源文件永远清爽。**这个方案有致命缺陷**：
 *
 *   npm publish 的执行顺序是
 *     prepack → 打 tarball → postpack → **读取 package.json 组装 registry 元数据** → 上传
 *
 * `postpack` 在元数据组装**之前**就把字段删了，于是出现：
 *   - tarball 里的 package.json **有** optionalDependencies
 *   - registry 元数据里 **没有**
 *
 * npm / pnpm 安装时读的是**元数据**，不是 tarball 内的 package.json。结果就是
 * 平台包根本不会被拉取，用户装完报「缺少平台包」——v3.2.1 正是这个症状。
 *
 * ## 现在的做法
 *
 * 直接写进 package.json 并**提交**。`version` 仍是唯一手改点：
 * 改了 version 后跑 `bun run version:sync`，脚本把 4 行展开成同版本。
 * 忘记跑也不会漏——`prepublishOnly` 会强制执行，CI 的 check-version 也会校验。
 *
 * 这就消除了"两份会漂移的版本号"这个根本问题，同时不依赖任何钩子时序。
 *
 * ## 用法
 *
 *   node scripts/sync-version.js            # 展开/更新 4 行（写回 package.json）
 *   node scripts/sync-version.js --check     # 只校验，不写（CI 用）
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const pkgPath = join(root, 'package.json');

/** 支持的平台清单（唯一权威来源，其他脚本/测试都读这里） */
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'];

const checkOnly = process.argv.includes('--check');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

/** 期望的 { 包名: 版本 }，版本一律等于主包 version */
const expected = {};
for (const p of PLATFORMS) expected[`${pkg.name}-${p}`] = pkg.version;

const current = pkg.optionalDependencies ?? {};
const drift = [];
for (const [name, ver] of Object.entries(expected)) {
  if (current[name] !== ver) drift.push(`${name}: ${current[name] ?? '(缺失)'} → ${ver}`);
}
// 反向：多余的平台包条目（比如已下线的平台）
for (const name of Object.keys(current)) {
  if (name.startsWith(`${pkg.name}-`) && !(name in expected)) {
    drift.push(`${name}: 多余条目，应从 optionalDependencies 移除`);
  }
}

if (checkOnly) {
  if (drift.length > 0) {
    console.error(`❌ ${pkg.name}@${pkg.version} 的平台包版本不一致：`);
    for (const d of drift) console.error(`   - ${d}`);
    console.error('\n   修复：bun run version:sync');
    process.exit(1);
  }
  console.log(`✅ ${pkg.name}@${pkg.version}`);
  console.log(`   optionalDependencies 与 version 一致（${PLATFORMS.length} 个平台包）`);
  process.exit(0);
}

if (drift.length === 0) {
  console.log(`✅ 已是最新：${pkg.name}@${pkg.version}，${PLATFORMS.length} 个平台包版本一致`);
  process.exit(0);
}

pkg.optionalDependencies = expected;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

console.log(`✅ 已同步 ${pkg.name}@${pkg.version}：`);
for (const p of PLATFORMS) console.log(`   ${pkg.name}-${p} @ ${pkg.version}`);
if (drift.length > 0) {
  console.log('\n（本次变更）');
  for (const d of drift) console.log(`   - ${d}`);
}
