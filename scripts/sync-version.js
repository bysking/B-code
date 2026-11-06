#!/usr/bin/env node

/**
 * 版本号统一脚本：改一处，其他全部自动跟上。
 *
 * ## 用途
 *
 * 主包版本一变，有三处必须同步，漏任何一处都会出事：
 *
 *   1. package.json 的 version（源头，唯一手改）
 *   2. package.json 的 optionalDependencies 4 行（用户靠它装到对应平台的二进制）
 *   3. bun.lock 里记录的上述版本（不同步 → CI 的 bun install 报
 *      "lockfile had changes, but lockfile is frozen"）
 *
 * 这个脚本把 2 和 3 一起做掉，所以流程简化成：改 version → 跑脚本 → 提交。
 *
 * ## 用法
 *
 *   bun run version:sync                  # 按当前 version 同步 2、3
 *   bun run version:sync 3.2.7            # 顺便把 version 改成 3.2.7 再同步
 *   bun run version:sync --check          # 只检查是否一致（CI 用，不写文件）
 *
 * ## 为什么不用 prepack 钩子临时注入
 *
 * 曾经这么做过，踩了个很隐蔽的坑（v3.2.1 事故）。npm publish 的顺序是
 *
 *   prepack → 打 tarball → postpack → 读取 package.json 组装 registry 元数据 → 上传
 *
 * postpack 在元数据组装**之前**就把字段删了，于是 tarball 里有、registry 元数据里没有。
 * 而 npm/pnpm 安装时读的是元数据 → 平台包根本不会被拉取，用户装完报「缺少平台包」，
 * 且安装过程没有任何报错。所以这些字段必须真实存在于提交进仓库的 package.json 里。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const pkgPath = join(root, 'package.json');
const lockPath = join(root, 'bun.lock');

/** 支持的平台清单（唯一权威来源，其他脚本/测试都读这里） */
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'];

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
/** 位置参数：可选的显式版本号，如 `version:sync 3.2.7` */
const explicitVersion = args.find((a) => !a.startsWith('-'));

/** 校验版本号格式，避免手误写进 package.json 后发现太晚 */
function assertValidVersion(v) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v)) {
    console.error(`❌ 版本号格式不合法：${v}`);
    console.error('   应形如 3.2.7 或 3.2.7-beta.1');
    process.exit(1);
  }
}

if (explicitVersion) assertValidVersion(explicitVersion);

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
if (explicitVersion && explicitVersion !== pkg.version) pkg.version = explicitVersion;

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
    drift.push(`${name}: 多余条目，应移除`);
  }
}

/** bun.lock 里是否已记录与 package.json 一致的版本 */
function lockNeedsUpdate() {
  if (!existsSync(lockPath)) return false; // 没有 lockfile 就没什么可同步的
  const lock = readFileSync(lockPath, 'utf-8');
  // importers 段里形如  "@bysking/b-code-darwin-arm64": "3.2.7",
  for (const [name, ver] of Object.entries(expected)) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`"${esc}":\\s*"([^"]+)"`);
    const m = re.exec(lock);
    if (!m || m[1] !== ver) return true;
  }
  return false;
}

// ── 只检查模式（CI 用）──
if (checkOnly) {
  const problems = [...drift];
  if (lockNeedsUpdate()) problems.push('bun.lock 里记录的版本未同步');
  if (problems.length > 0) {
    console.error(`❌ ${pkg.name}@${pkg.version} 版本不一致：`);
    for (const d of problems) console.error(`   - ${d}`);
    console.error('\n   修复：bun run version:sync');
    process.exit(1);
  }
  console.log(`✅ ${pkg.name}@${pkg.version}`);
  console.log(`   optionalDependencies 与 bun.lock 均已同步（${PLATFORMS.length} 个平台包）`);
  process.exit(0);
}

// ── 写入模式 ──
const versionChanged = explicitVersion && explicitVersion !== JSON.parse(readFileSync(pkgPath, 'utf-8')).version;

if (drift.length === 0 && !lockNeedsUpdate() && !versionChanged) {
  console.log(`✅ 已是最新：${pkg.name}@${pkg.version}，${PLATFORMS.length} 个平台包版本一致`);
  process.exit(0);
}

// ① package.json：version + optionalDependencies
pkg.optionalDependencies = expected;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`✅ ${pkg.name}@${pkg.version}`);
for (const p of PLATFORMS) console.log(`   ${pkg.name}-${p} @ ${pkg.version}`);
if (drift.length > 0) {
  console.log('\n（本次变更）');
  for (const d of drift) console.log(`   - ${d}`);
}

// ② bun.lock：交给 bun 自己重算。
//    手写正则改 lockfile 太脆（格式、顺序、隐含字段都可能变），
//    让 bun install 以 package.json 为准重写最可靠。
if (existsSync(lockPath)) {
  try {
    execFileSync('bun', ['install'], { cwd: root, stdio: 'pipe' });
    const ok = !lockNeedsUpdate();
    console.log(ok ? '\n✅ bun.lock 已同步' : '\n⚠️  bun.lock 仍未同步，请手动跑 bun install');
  } catch (err) {
    console.error('\n⚠️  bun install 失败，bun.lock 可能未更新：');
    console.error(`   ${(err && err.message ? err.message : String(err)).split('\n')[0]}`);
    console.error('   请手动执行 bun install');
  }
}
