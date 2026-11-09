import { afterAll, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, localVersion, PACKAGE_NAME, resolveVersion } from '../src/version-check.js';

/** 临时目录：模拟「可执行文件旁边有 package.json」的发布形态 */
const tmp = mkdtempSync(join(tmpdir(), 'bcode-ver-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** 在 tmp 下造一份 package.json，返回其路径 */
function makePkg(name: string, version: string): string {
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify({ name: '@bysking/b-code', version }));
  return p;
}

test('compareVersions：常规 semver 比较', () => {
  assert.equal(compareVersions('0.1.8', '0.1.9'), -1);
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.1.8', '0.1.8'), 0);
});

test('compareVersions：预发布后缀忽略（beta 等）', () => {
  assert.equal(compareVersions('0.1.8-beta.1', '0.1.8'), 0);
  assert.equal(compareVersions('0.1.8', '0.1.9-beta.2'), -1);
});

test('compareVersions：不同长度段按缺省 0 补齐', () => {
  assert.equal(compareVersions('0.1', '0.1.0'), 0);
  assert.equal(compareVersions('0.1.1', '0.1'), 1);
});

test('localVersion：能读到当前包版本（非空且形如 x.y.z）', () => {
  const v = localVersion();
  assert.ok(v, '本地版本不应为空');
  assert.match(v, /^\d+\.\d+\.\d+/, `版本格式: ${v}`);
});

test('localVersion：dev 下读到的是仓库根 package.json 的版本', () => {
  // dev（bun test）里 process.execPath 是 bun 自身，读不到本包 → 回退到模块上一级
  const rootPkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
  assert.equal(localVersion(), rootPkg.version);
});

test('resolveVersion：外部文件优先，内嵌值只在前两者都缺失时兜底', () => {
  const execPkg = makePkg('exec-package.json', '9.9.9');
  const modulePkg = makePkg('module-package.json', '8.8.8');

  // ① 可执行文件同目录命中 → 短路，不读后面两个
  assert.equal(resolveVersion(execPkg, modulePkg, '7.7.7'), '9.9.9');
  // ② 只有模块同级 → 用它
  assert.equal(resolveVersion(join(tmp, 'nope.json'), modulePkg, '7.7.7'), '8.8.8');
  // ③ 两个文件都没有 → 内嵌值
  assert.equal(resolveVersion(null, null, '7.7.7'), '7.7.7');
  // ④ 什么都没有 → 空串（= 不提示更新，绝不抛错）
  assert.equal(resolveVersion(null, null, ''), '');
});

test('resolveVersion：损坏/无 version 字段的 package.json 被跳过而不是污染结果', () => {
  const broken = join(tmp, 'broken.json');
  writeFileSync(broken, '{ not json');
  const noVersion = join(tmp, 'no-version.json');
  writeFileSync(noVersion, JSON.stringify({ name: 'x' }));

  assert.equal(resolveVersion(broken, noVersion, '7.7.7'), '7.7.7', '两处都无效 → 回退内嵌值');
  assert.equal(resolveVersion(broken, noVersion, ''), '', '无内嵌值时返回空串');
});

test('PACKAGE_NAME 指向发布的 scoped 包', () => {
  assert.equal(PACKAGE_NAME, '@bysking/b-code');
});
