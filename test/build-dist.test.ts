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

test('分发：optionalDependencies 已写进 package.json 且版本等于主包', () => {
  // 该字段**必须**存在于 package.json（不是靠 prepack 临时注入）：
  // npm 用 package.json 组装 registry 元数据，而安装时读的正是元数据。
  // v3.2.1 用 prepack 注入 + postpack 还原，postpack 在元数据组装前就删了字段，
  // 导致 tarball 里有、元数据里没有 → 用户装完缺平台包。
  const optional = (pkg.optionalDependencies ?? {}) as Record<string, string>;
  assert.ok(
    Object.keys(optional).length > 0,
    'optionalDependencies 必须写进 package.json（否则 registry 元数据缺失，用户装不到平台包）',
  );
  for (const [name, ver] of Object.entries(optional)) {
    assert.equal(
      ver,
      pkg.version,
      `${name} 的版本 (${ver}) 必须等于主包 ${pkg.version}（否则会装到不匹配的二进制）`,
    );
  }
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

test('分发：Node 版本门槛只卡主版本（误写成次版本会拦掉正常版本）', () => {
  // 只要求 >= 24 这种粗粒度。写成 >=24.22.2 会把 24.0.0 拦掉，
  // 且 24.22.2 只是发布时的环境，不是真实下限。
  assert.match(
    pkg.engines.node,
    /^>=\d+$/,
    `engines.node 应形如 ">=24"（只卡主版本），实际是 ${pkg.engines.node}`,
  );
});

test('分发：启动器的 MIN_NODE_MAJOR 与 engines.node 一致', () => {
  const launcher = readFileSync(join(ROOT, 'bin', 'bcode.js'), 'utf-8');
  const m = /const MIN_NODE_MAJOR = (\d+)/.exec(launcher);
  assert.ok(m, 'bin/bcode.js 里应有 MIN_NODE_MAJOR');
  assert.equal(
    pkg.engines.node,
    `>=${m[1]}`,
    'engines.node 与 MIN_NODE_MAJOR 必须一致（一个是 npm 的准入，一个是运行时自查）',
  );
});

test('启动器：版本判定按主版本，预发布版与垃圾输入都不误判', () => {
  const launcher = readFileSync(join(ROOT, 'bin', 'bcode.js'), 'utf-8');
  // 取出 nodeMajor 的实现，在测试里跑真实逻辑而不是复制一份
  const fn = /function nodeMajor\([\s\S]*?\n\}/.exec(launcher);
  assert.ok(fn, 'bin/bcode.js 里应有 nodeMajor 函数');
  const nodeMajor = new Function(`${fn[0]}; return nodeMajor;`)() as (v: string) => number | null;

  // 预发布版主版本够就放行（曾因比较次版本而误报）
  assert.equal(nodeMajor('27.0.0-alpha.0.0'), 27);
  assert.equal(nodeMajor('26.2.0'), 26);
  assert.equal(nodeMajor('24.0.0'), 24);
  assert.equal(nodeMajor('23.11.1'), 23);
  // 垃圾输入返回 null（不能返回 NaN，否则 NaN < 24 为 false 会错误放行）
  assert.equal(nodeMajor('abc'), null);
  assert.equal(nodeMajor(''), null);
});

test('启动器：能识别 registry 是否为官方源（私有镜像导致缺包时给出正确提示）', () => {
  const launcher = readFileSync(join(ROOT, 'bin', 'bcode.js'), 'utf-8');
  const fn = /function isOfficialRegistry\([\s\S]*?\n\}/.exec(launcher);
  assert.ok(fn, 'bin/bcode.js 里应有 isOfficialRegistry 函数');
  // 该函数依赖模块级常量，提取时一并带上
  const constDecl = /const OFFICIAL_REGISTRY = '[^']*';/.exec(launcher);
  assert.ok(constDecl, 'bin/bcode.js 里应有 OFFICIAL_REGISTRY 常量');
  const isOfficial = new Function(`${constDecl[0]} ${fn[0]}; return isOfficialRegistry;`)() as (
    u: string | null,
  ) => boolean;

  // 官方源的几种写法都应识别（尾斜杠、大小写、协议差异）
  assert.equal(isOfficial('https://registry.npmjs.org/'), true);
  assert.equal(isOfficial('https://registry.npmjs.org'), true);
  assert.equal(isOfficial('http://REGISTRY.NPMJS.ORG/'), true);
  // 私有镜像/镜像站必须判为「非官方」，否则不会提示用户去查源
  assert.equal(isOfficial('https://packages.aliyun.com/xxx/npm/npm-registry'), false);
  assert.equal(isOfficial('https://registry.npmmirror.com/'), false);
  assert.equal(isOfficial(null), false);
});

test('启动器：缺平台包时提示应指出 registry 而非只提 optionalDependencies', () => {
  // 这个报错最常见的根因是私有镜像未同步公共包（npm 静默跳过可选依赖），
  // 若提示只让用户加 --include=optional，会把人带偏。
  const launcher = readFileSync(join(ROOT, 'bin', 'bcode.js'), 'utf-8');
  const fn = /function reportMissingPlatformPackage\([\s\S]*?\n\}/.exec(launcher);
  assert.ok(fn, 'bin/bcode.js 里应有 reportMissingPlatformPackage 函数');
  assert.ok(fn[0].includes('registry'), '提示里必须打印当前 registry');
  assert.ok(fn[0].includes('@bysking:registry'), '提示里应给出 scope 级源配置方案');
  assert.ok(fn[0].includes('--registry=https://registry.npmjs.org/'), '应给出临时换源命令');
  assert.ok(fn[0].includes('--include=optional'), '仍应保留跳过可选依赖的排查项');
});
