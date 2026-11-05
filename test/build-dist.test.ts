import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 分发布局校验。
 *
 * 发布链路依赖几个硬约定，改坏了要到用户装完才发现：
 *   1. 主包 bin 指向 bin/bcode.js
 *   2. optionalDependencies 覆盖所有支持平台
 *   3. 平台包名/版本与主包一致
 *   4. 启动器的 PLATFORM_MAP 与 package.json 的 optionalDependencies 同步
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));

test('分发：主包 bin 指向启动器，且启动器存在', () => {
  assert.equal(pkg.bin?.bcode, './bin/bcode.js', 'bin 应指向 bin/bcode.js');
  const launcher = join(ROOT, 'bin', 'bcode.js');
  assert.ok(existsSync(launcher), 'bin/bcode.js 必须存在');
});

test('分发：optionalDependencies 覆盖四个支持平台', () => {
  const optional = Object.keys(pkg.optionalDependencies ?? {});
  for (const p of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']) {
    assert.ok(
      optional.includes(`@bysking/b-code-${p}`),
      `缺少平台包 @bysking/b-code-${p}`,
    );
  }
});

test('分发：平台包版本必须与主包一致（否则安装了错的二进制）', () => {
  // 平台包按主包版本发布，两者必须同步；否则用户装到"主包 v3.0.0 + 平台包 v2.0.2"
  // 会拿到不匹配的二进制。允许 "workspace:*" 形式（monorepo 内本地链接）。
  const optional = (pkg.optionalDependencies ?? {}) as Record<string, string>;
  for (const [name, ver] of Object.entries(optional)) {
    assert.ok(
      ver === pkg.version || ver.startsWith('workspace:') || ver.startsWith('file:'),
      `${name} 的版本 (${ver}) 应为主包的 ${pkg.version}`,
    );
  }
});

test('分发：启动器的平台映射与 optionalDependencies 同步', () => {
  const launcher = readFileSync(join(ROOT, 'bin', 'bcode.js'), 'utf-8');
  const optional = Object.keys(pkg.optionalDependencies ?? {});
  for (const name of optional) {
    // @bysking/b-code-darwin-arm64 → darwin-arm64
    const platform = name.replace('@bysking/b-code-', '');
    assert.ok(
      launcher.includes(name),
      `启动器缺少 ${name}（用户在 ${platform} 上会启动失败）`,
    );
  }
});

test('分发：files 只含启动器（平台二进制由 optionalDependencies 分发）', () => {
  assert.ok(pkg.files?.includes('bin'), 'files 应包含 bin/');
  // dist/cli.mjs 已随 ink 一起移除：启动器只 spawn 平台包里的二进制，
  // 主包里再塞一份 bundle 只会白占体积。
  assert.ok(
    !pkg.files?.some((f: string) => f.startsWith('dist')),
    'files 不应再包含 dist（那是已删除的 ink 回退版）',
  );
});

test('分发：engines 声明 node（启动器是 Node 脚本）', () => {
  assert.ok(pkg.engines?.node, 'engines.node 必须声明——启动器需要 Node 执行');
});
