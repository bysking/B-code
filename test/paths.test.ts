import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { basePath, safeName, userHomeDir, dirs, BASE_PATH_ENV } from '../src/utils/paths.js';

const saved = process.env[BASE_PATH_ENV];
after(() => {
  if (saved === undefined) delete process.env[BASE_PATH_ENV];
  else process.env[BASE_PATH_ENV] = saved;
});

test('默认 basePath = {用户主目录}/.b-code', () => {
  delete process.env[BASE_PATH_ENV];
  assert.equal(userHomeDir(), homedir());
  assert.equal(basePath(), join(homedir(), '.b-code'));
});

test('B_CODE_HOME 覆盖 basePath', () => {
  process.env[BASE_PATH_ENV] = join('/tmp', 'b-code-home');
  assert.equal(basePath(), join('/tmp', 'b-code-home'));
});

test('B_CODE_HOME 相对路径 → 报错（防静默歧义）', () => {
  process.env[BASE_PATH_ENV] = 'relative/path';
  assert.throws(() => basePath(), /必须是绝对路径/);
});

test('dirs 全部落在 basePath 之下', () => {
  process.env[BASE_PATH_ENV] = join('/tmp', 'b-code-dirs');
  assert.equal(dirs.sessionFile(), join('/tmp', 'b-code-dirs', 'session.json'));
  assert.equal(dirs.logsDir(), join('/tmp', 'b-code-dirs', 'logs'));
  assert.equal(dirs.projectsDir(), join('/tmp', 'b-code-dirs', 'projects'));
  assert.equal(dirs.mcpConfigFile(), join('/tmp', 'b-code-dirs', 'mcp.json'));
});

test('safeName：Windows 非法字符 → _，空白压缩，长度截断', () => {
  assert.equal(safeName('deploy: to staging?'), 'deploy_to_staging');
  assert.equal(safeName('a"b<c>d|e:f*g'), 'a_b_c_d_e_f_g');
  assert.equal(safeName('  spaced   name  '), 'spaced_name');
  assert.equal(safeName('..hidden..'), 'hidden');
  assert.equal(safeName('a'.repeat(300)).length, 120);
});

test('safeName：清空后兜底 unnamed 而非空串', () => {
  assert.equal(safeName(':::???'), 'unnamed');
  assert.equal(safeName(''), 'unnamed');
});
