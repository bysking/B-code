import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proxiedFetch } from './backend.js';
import { log } from './utils/log.js';

/**
 * 版本升级检查（TTY 启动时异步执行，失败静默）。
 *
 * 远程版本查 npmjs registry 的 dist-tags.latest；有更新时在 UI 底部提示升级命令。
 *
 * 设计约束：
 *   - 永不阻塞启动：promise 化 + 网络/解析任何异常都静默降级（返回 null）
 *   - 不新增依赖：semver 比较用内置极小实现（预发布/标签直接放行更新，够用）
 *
 * ## 本地版本号从哪来（三种形态，按序回退）
 *
 *   ① 外部 package.json —— 与可执行文件同目录（打包时由 build-bun.js 放入）
 *   ② 内嵌版本号       —— 编译期由 bun 内联，二进制被单独搬走时仍可用
 *   ③ 空串             —— 都拿不到就不提示，绝不因此报错
 *
 * 为什么不能只靠 ①：`bun build --compile` 出来的产物里 `import.meta.url` 是
 * `file:///$bunfs/root/bcode`——那是产物**内部**的虚拟文件系统，`dirname/../`
 * 指向 `/$bunfs/package.json`，这个文件永远不存在。所以 ① 必须走
 * `process.execPath`（真实的可执行文件路径），不能用 `import.meta.url`。
 */

export const PACKAGE_NAME = '@bysking/b-code';

/**
 * 编译期注入的版本号（构建脚本 --define 注入，见 build-bun.js）。
 * dev/测试环境里这个符号不存在，`typeof` 对未声明标识符是安全的，会走空串分支。
 */
declare const __BCODE_VERSION__: string | undefined;

/** 内嵌版本号：编译产物里是构建时的 package.json version，其他环境为空串 */
const EMBEDDED_VERSION: string = typeof __BCODE_VERSION__ === 'string' ? __BCODE_VERSION__ : '';

/** 与可执行文件同目录的 package.json（打包时放入；dev 下读不到本包，回退） */
function execDirPkgPath(): string | null {
  try {
    // 关键：用 process.execPath 而非 import.meta.url —— 编译产物的
    // import.meta.url 指向 /$bunfs/root/... 这个内部虚拟文件系统，那里永远没有 package.json
    return join(dirname(process.execPath), 'package.json');
  } catch {
    return null;
  }
}

/** 模块同级上一级的 package.json（dev 下 = 仓库根；npm 安装下 = 包根） */
function moduleDirPkgPath(): string | null {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  } catch {
    return null;
  }
}

/** 读一份 package.json 的 version；文件不存在/损坏/无该字段都返回空串 */
function readVersion(pkgPath: string | null): string {
  if (!pkgPath || !existsSync(pkgPath)) return '';
  try {
    const pkg: { version?: unknown } = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch (err) {
    log.debug('package.json read failed', `${pkgPath}: ${(err as Error).message}`);
    return '';
  }
}

/**
 * 按优先级解析版本号。**路径由调用方传入**，使优先级本身可单测——
 * 直接测 localVersion() 只能覆盖当前进程的真实路径，测不到"高优先级命中就短路"。
 *
 * @param execPkgPath   可执行文件同目录的 package.json
 * @param modulePkgPath 模块同级上一级的 package.json
 * @param embedded      编译期内嵌值
 */
export function resolveVersion(
  execPkgPath: string | null,
  modulePkgPath: string | null,
  embedded: string,
): string {
  // ① 可执行文件同目录（打包后的正常形态，package.json 由 build-bun.js 放入）
  const fromExec = readVersion(execPkgPath);
  if (fromExec) return fromExec;
  // ② dev 下模块上一级 = 仓库根；npm 安装下 = 包根
  const fromModule = readVersion(modulePkgPath);
  if (fromModule) return fromModule;
  // ③ 编译期内嵌兜底
  return embedded;
}

/**
 * 当前安装的本地版本；全部来源都拿不到时返回空串（= 不提示更新）。
 *
 * 顺序上把**外部文件**放最前：它跟着产物走，用户升级/替换二进制时最先更新；
 * 内嵌值是构建那一刻的快照，只在外部文件缺失（二进制被单独复制走）时兜底。
 */
export function localVersion(): string {
  return resolveVersion(execDirPkgPath(), moduleDirPkgPath(), EMBEDDED_VERSION);
}

/** 纯 semver 比较：a > b → 1，a < b → -1，相等 → 0。非数字段（如 -beta.1）按主版本序忽略。 */
export function compareVersions(a: string, b: string): number {
  const pa = a
    .split('-')[0]!
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = b
    .split('-')[0]!
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 查询 npmjs 最新版；任何异常返回 null（网络/解析失败都算"查不到"，不打扰用户） */
export async function fetchLatestVersion(timeoutMs = 5000): Promise<string | null> {
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}`;
    const resp = await proxiedFetch(url, {
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      log.debug(`registry responded ${resp.status} for ${PACKAGE_NAME}`);
      return null;
    }
    const data: { 'dist-tags'?: { latest?: unknown } } = JSON.parse(await resp.text());
    const latest = data['dist-tags']?.latest;
    return typeof latest === 'string' ? latest : null;
  } catch (err) {
    log.debug('version check failed (silent)', (err as Error).message);
    return null;
  }
}

export interface UpdateInfo {
  current: string;
  latest: string;
}

/** 汇总检查：有更新返回 { current, latest }，否则 null（失败/已最新/本地版本缺失） */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const current = localVersion();
  if (!current) return null;
  const latest = await fetchLatestVersion();
  if (!latest) return null;
  return compareVersions(latest, current) > 0 ? { current, latest } : null;
}
