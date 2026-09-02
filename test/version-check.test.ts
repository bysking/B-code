import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, localVersion, PACKAGE_NAME } from '../src/version-check.js';

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

test('PACKAGE_NAME 指向发布的 scoped 包', () => {
  assert.equal(PACKAGE_NAME, '@bysking/b-code');
});
