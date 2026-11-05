import { test, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMPTY_DISABLED,
  isMcpServerDisabled,
  isSkillDisabled,
  loadDisabled,
  mcpDisabledPrefixes,
  saveDisabled,
  toggleInList,
} from '../src/toggles.js';

let dir: string;
let file: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'b-code-toggles-'));
  file = join(dir, 'settings.json');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('loadDisabled：文件缺失 → 空状态', () => {
  assert.deepEqual(loadDisabled(join(dir, 'nope.json')), EMPTY_DISABLED);
});

test('loadDisabled：坏 JSON → 空状态（不抛）', async () => {
  const bad = join(dir, 'bad.json');
  await writeFile(bad, '{ not json');
  assert.deepEqual(loadDisabled(bad), EMPTY_DISABLED);
});

test('saveDisabled / loadDisabled：往返一致 + 清洗非字符串项', async () => {
  saveDisabled({ skills: ['commit', 'commit', ''], mcpServers: ['github'] }, file);
  const back = loadDisabled(file);
  assert.deepEqual(back, { skills: ['commit'], mcpServers: ['github'] }, '去重去空');
});

test('saveDisabled：不抹掉 settings.json 里的其它字段', async () => {
  await writeFile(
    file,
    JSON.stringify({ provider: 'anthropic', apiKey: 'sk-x', permissions: { allow: ['run_shell:ls'] } }),
  );
  saveDisabled({ skills: ['commit'], mcpServers: [] }, file);
  const raw = JSON.parse(await readFile(file, 'utf-8'));
  assert.equal(raw.provider, 'anthropic', 'provider 保留');
  assert.equal(raw.apiKey, 'sk-x', 'apiKey 保留');
  assert.deepEqual(raw.permissions.allow, ['run_shell:ls'], 'permissions 保留');
  assert.deepEqual(raw.disabled, { skills: ['commit'], mcpServers: [] }, 'disabled 写入');
});

test('toggleInList：加入/移除，纯函数不改原数组', () => {
  const base = ['a'];
  assert.deepEqual(toggleInList(base, 'b'), ['a', 'b'], '加入');
  assert.deepEqual(toggleInList(base, 'a'), [], '移除');
  assert.deepEqual(base, ['a'], '原数组不变');
});

test('isSkillDisabled / isMcpServerDisabled', () => {
  const st = { skills: ['commit'], mcpServers: ['github'] };
  assert.equal(isSkillDisabled(st, 'commit'), true);
  assert.equal(isSkillDisabled(st, 'other'), false);
  assert.equal(isMcpServerDisabled(st, 'github'), true);
  assert.equal(isMcpServerDisabled(st, 'jira'), false);
});

test('mcpDisabledPrefixes：server 名 → registry 名前缀', () => {
  assert.deepEqual(mcpDisabledPrefixes({ skills: [], mcpServers: ['github', 'jira'] }), [
    'mcp__github__',
    'mcp__jira__',
  ]);
});
