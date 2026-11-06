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
 *   2. 平台清单覆盖所有支持平台
 *   3. 平台包版本与主包一致
 *   4. 启动器的 SUPPORTED 与平台清单同步
 *
 * 注意平台清单的**权威来源是 scripts/sync-version.js 的 PLATFORMS**，
 * 不是 package.json——源文件已不再声明 optionalDependencies，那 4 行由
 * prepack 时 `sync-version.js --inject` 按 version 自动注入（改版本只需改一处）。
 * 所以这里校验的是「派生输入是否正确」，注入结果由 CI 的 npm pack 步骤验证。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));

/** 从 sync-version.js 读出 PLATFORMS 清单（唯一的平台来源） */
function platformList(): string[] {
  const src = readFileSync(join(ROOT, 'scripts', 'sync-version.js'), 'utf-8');
  const m = /const PLATFORMS = \[([^\]]*)\]/.exec(src);
  assert.ok(m, 'scripts/sync-version.js 里找不到 PLATFORMS 清单');
  return [...m[1]!.matchAll(/'([\w-]+)'/g)].map((x) => x[1]!);
}

test('分发：主包 bin 指向启动器，且启动器存在', () => {
  assert.equal(pkg.bin?.bcode, './bin/bcode.js', 'bin 应指向 bin/bcode.js');
  const launcher = join(ROOT, 'bin', 'bcode.js');
  assert.ok(existsSync(launcher), 'bin/bcode.js 必须存在');
});

test('分发：平台清单覆盖四个支持平台', () => {
  const platforms = platformList();
  for (const p of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']) {
    assert.ok(platforms.includes(p), `缺少平台包 @bysking/b-code-${p}`);
  }
});

test('分发：源 package.json 不残留 optionalDependencies（否则会造成版本漂移）', () => {
  // 该字段由 prepack 注入、postpack 还原。若源文件里有，说明某次注入后没清干净，
  // 下次改 version 时它会与 version 不一致 → 用户装不上平台包（npm 静默失败）。
  assert.equal(
    pkg.optionalDependencies,
    undefined,
    '源 package.json 不应包含 optionalDependencies（由 scripts/sync-version.js 自动派生）',
  );
});

test('分发：启动器的 SUPPORTED 与平台清单同步', () => {
  const launcher = readFileSync(join(ROOT, 'bin', 'bcode.js'), 'utf-8');
  for (const platform of platformList()) {
    // @bysking/b-code-darwin-arm64
    const name = `@bysking/b-code-${platform}`;
    assert.ok(launcher.includes(name), `启动器缺少 ${name}（用户在 ${platform} 上会启动失败）`);
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
