import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proxiedFetch } from './backend.js';
import { log } from './utils/log.js';

/**
 * 版本升级检查（TTY 启动时异步执行，失败静默）。
 *
 * 本地版本读取 package.json（dev 下在仓库根、发布后与 dist/cli.mjs 同级的
 * node_modules/@bysking/b-code/package.json——两种形态下都位于模块上一级）。
 * 远程版本查 npmjs registry 的 dist-tags.latest；有更新时在 UI 底部提示升级命令。
 *
 * 设计约束：
 *   - 永不阻塞启动：promise 化 + 网络/解析任何异常都静默降级（返回 null）
 *   - 不新增依赖：semver 比较用内置极小实现（预发布/标签直接放行更新，够用）
 */

export const PACKAGE_NAME = '@bysking/b-code';

/** 当前安装的本地版本；读取失败（极端环境）返回空串 = 不提示 */
export function localVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    const pkgPath = join(dirname(here), '..', 'package.json');
    if (!existsSync(pkgPath)) return '';
    const pkg: { version?: unknown } = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch (err) {
    log.debug('local version read failed', (err as Error).message);
    return '';
  }
}

/** 纯 semver 比较：a > b → 1，a < b → -1，相等 → 0。非数字段（如 -beta.1）按主版本序忽略。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
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
