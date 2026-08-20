import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applySettings,
  ensureDataDirs,
  loadSettings,
  settingsPath,
  SETTINGS_FILE_ENV,
} from '../src/config.js';
import { BASE_PATH_ENV } from '../src/utils/paths.js';

const savedHome = process.env[BASE_PATH_ENV];
const savedCfg = process.env[SETTINGS_FILE_ENV];
let home: string;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'b-code-cfg-'));
  process.env[BASE_PATH_ENV] = home;
});
after(async () => {
  if (savedHome === undefined) delete process.env[BASE_PATH_ENV];
  else process.env[BASE_PATH_ENV] = savedHome;
  if (savedCfg === undefined) delete process.env[SETTINGS_FILE_ENV];
  else process.env[SETTINGS_FILE_ENV] = savedCfg;
  await rm(home, { recursive: true, force: true });
});

test('无配置文件 → {}，settingsPath 指向 {basePath}/settings.json', () => {
  assert.deepEqual(loadSettings(), {});
  assert.equal(settingsPath(), join(home, 'settings.json'));
});

test('B_CODE_CONFIG 可覆盖配置路径', async () => {
  const alt = join(home, 'my-config.json');
  process.env[SETTINGS_FILE_ENV] = alt;
  await writeFile(alt, JSON.stringify({ model: 'x' }));
  assert.equal(settingsPath(), alt);
  assert.equal(loadSettings().model, 'x');
  delete process.env[SETTINGS_FILE_ENV];
});

test('损坏配置 → {}（不阻断）', async () => {
  await writeFile(join(home, 'settings.json'), '{ nope');
  assert.deepEqual(loadSettings(), {});
});

test('applySettings：真实环境优先，配置作缺省', () => {
  const settings = { model: 'cfg-model', env: { FOO: 'cfg', BAR: 'cfg' } };
  const env: Record<string, string | undefined> = { BAR: 'real' };
  applySettings(env, settings);
  assert.equal(env.BAR, 'real', '已存在的键不覆盖');
  assert.equal(env.FOO, 'cfg', '缺省键回填');
  assert.equal(env.B_CODE_MODEL, 'cfg-model');
});

test('applySettings：provider 映射 apiKey/baseUrl', () => {
  const env: Record<string, string | undefined> = {};
  applySettings(env, { provider: 'openai', apiKey: 'k', baseUrl: 'http://x/v1' });
  assert.equal(env.OPENAI_API_KEY, 'k');
  assert.equal(env.OPENAI_BASE_URL, 'http://x/v1');

  const env2: Record<string, string | undefined> = {};
  applySettings(env2, { provider: 'anthropic', apiKey: 'k2', baseUrl: 'https://custom' });
  assert.equal(env2.ANTHROPIC_API_KEY, 'k2');
  assert.equal(env2.ANTHROPIC_BASE_URL, 'https://custom');
});

test('applySettings：无 provider 时按 baseUrl 智能分流', () => {
  const env: Record<string, string | undefined> = {};
  applySettings(env, { apiKey: 'k', baseUrl: 'http://c/v1' });
  assert.equal(env.OPENAI_API_KEY, 'k');

  const env2: Record<string, string | undefined> = {};
  applySettings(env2, { apiKey: 'k2' });
  assert.equal(env2.ANTHROPIC_API_KEY, 'k2');
});

test('ensureDataDirs：启动创建默认目录树（幂等）', () => {
  ensureDataDirs(home);
  for (const sub of ['sessions', 'logs', 'projects', 'skills', 'plans']) {
    assert.ok(existsSync(join(home, sub)), `${sub} 目录已创建`);
  }
  ensureDataDirs(home); // 再次调用不抛
});
