#!/usr/bin/env node

/**
 * 版本号单一来源：`package.json` 的 `version` 一处，其余全部派生。
 *
 * ## 为什么需要
 *
 * 主包的 `optionalDependencies` 必须指向**与主包同版本**的 4 个平台包，
 * 否则用户 `npm i -g` 时解析不到（npm 对 optionalDependencies 的失败是**静默**的，
 * 症状是"装成功了但 bcode 跑不起来"，不在安装时报错）。
 *
 * 原来这 4 行版本号要手工跟 `version` 一起改，共 5 处，漏一处就出上面那个坑。
 * 现在改为发布时自动注入：
 *
 *   version（唯一手改）
 *     ↓ prepack
 *   tarball 里的 optionalDependencies（自动注入，同版本）
 *     ↓ postpack
 *   源文件恢复原状（不留在 git 里）
 *
 * 源文件的 `package.json` **不再包含** `optionalDependencies`，所以永远不会漂移。
 *
 * ## 用法
 *
 *   node scripts/sync-version.js             # 打印当前派生结果（只读，CI 校验用）
 *   node scripts/sync-version.js --inject    # prepack：写入 optionalDependencies
 *   node scripts/sync-version.js --restore   # postpack：还原源文件
 *
 * ## 为什么 restore 不是简单删除
 *
 * 手工 `bun install` 会按注入后的 optionalDependencies 更新 `bun.lock`，
 * 若 restore 只删字段，`bun.lock` 里会残留一个源文件不存在的依赖，导致
 * `bun install --frozen-lockfile` 报 "lockfile had changes"。故 restore 时
 * 一并把 lockfile 里这 4 条清掉。
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const pkgPath = join(root, 'package.json');
const lockPath = join(root, 'bun.lock');

const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'];

/** 平台清单 → { 包名: 版本 } */
function platformDeps(version) {
  const out = {};
  for (const p of PLATFORMS) out[`@bysking/b-code-${p}`] = version;
  return out;
}

const mode = process.argv[2] ?? '--check';
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const expected = platformDeps(pkg.version);

// ── 只读模式：报告派生结果（CI 用来确认 version 与平台清单自洽）──
if (mode === '--check') {
  const current = pkg.optionalDependencies ?? {};
  const drift = Object.entries(expected).filter(([n, v]) => current[n] !== v);
  console.log(`${pkg.name}@${pkg.version}`);
  console.log(`  平台包将从 version 派生：${PLATFORMS.join(', ')}`);
  if (Object.keys(current).length === 0) {
    console.log('  源文件未声明 optionalDependencies（预期——由 prepack 注入）');
  } else if (drift.length > 0) {
    console.error('  ⚠️  源文件里的 optionalDependencies 与 version 不一致：');
    for (const [n, v] of drift) console.error(`     ${n}: 期望 ${v}，实际 ${current[n] ?? '缺失'}`);
    process.exit(1);
  } else {
    console.log('  源文件 optionalDependencies 与 version 一致');
  }
  process.exit(0);
}

// ── 注入：prepack ──
if (mode === '--inject') {
  // 记下原始状态，供 restore 精确还原（不靠猜）
  const hadOptional = Object.hasOwn(pkg, 'optionalDependencies');
  const original = hadOptional ? pkg.optionalDependencies : null;

  pkg.optionalDependencies = expected;
  // 保持字段顺序稳定：optionalDependencies 放在 dependencies 之后更符合 npm 惯例，
  // 但这里直接赋值会追加到末尾，对功能无影响，无需排序。
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  writeFileSync(
    join(root, '.version-inject-state.json'),
    JSON.stringify({ hadOptional, original }, null, 2) + '\n',
  );

  console.log(`注入 optionalDependencies @ ${pkg.version}（${PLATFORMS.length} 个平台包）`);
  process.exit(0);
}

// ── 还原：postpack ──
if (mode === '--restore') {
  const statePath = join(root, '.version-inject-state.json');
  // 重新读，避免用到注入前的内存副本
  const cur = JSON.parse(readFileSync(pkgPath, 'utf-8'));

  if (existsSync(statePath)) {
    const { hadOptional, original } = JSON.parse(readFileSync(statePath, 'utf-8'));
    if (hadOptional) cur.optionalDependencies = original;
    else delete cur.optionalDependencies;
    writeFileSync(pkgPath, JSON.stringify(cur, null, 2) + '\n');
  } else {
    // 没有状态文件（prepack 中途失败）：按"源文件本不该有该字段"处理
    delete cur.optionalDependencies;
    writeFileSync(pkgPath, JSON.stringify(cur, null, 2) + '\n');
  }

  // 清 lockfile 里残留的这 4 条，否则 --frozen-lockfile 会报 "lockfile had changes"
  if (existsSync(lockPath)) {
    let lock = readFileSync(lockPath, 'utf-8');
    const before = lock;
    for (const name of Object.keys(expected)) {
      // bun.lock 里形如：  "@bysking/b-code-darwin-arm64": "3.2.0",
      const re = new RegExp(`^\\s*"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}":\\s*"[^"]*",?\\n`, 'gm');
      lock = lock.replace(re, '');
    }
    // 若 optionalDependencies 块被清空则整体移除，避免留个空对象
    lock = lock.replace(/^\s*"optionalDependencies":\s*\{\s*\},?\n/gm, '');
    if (lock !== before) writeFileSync(lockPath, lock);
  }

  try {
    unlinkSync(statePath);
  } catch {
    // 不存在就算了
  }

  console.log('已还原 package.json / bun.lock（optionalDependencies 交给 prepack 注入）');
  process.exit(0);
}

console.error(`未知参数：${mode}`);
console.error('用法：node scripts/sync-version.js [--check|--inject|--restore]');
process.exit(1);
