import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveSession, loadSession, clearSessionFile, newSessionId } from '../src/session.js';
import { BASE_PATH_ENV } from '../src/utils/paths.js';

const saved = process.env[BASE_PATH_ENV];
let home: string;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'b-code-session-'));
  process.env[BASE_PATH_ENV] = home;
});

after(async () => {
  if (saved === undefined) delete process.env[BASE_PATH_ENV];
  else process.env[BASE_PATH_ENV] = saved;
  await rm(home, { recursive: true, force: true });
});

test('保存→加载（current）消息数组原样往返', async () => {
  const messages = [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
    },
  ];
  await saveSession(messages, 'sess-a');
  const loaded = await loadSession(); // current
  assert.deepEqual(loaded, messages);
});

test('多会话并存：--session <id> 精确恢复非 current 会话', async () => {
  await saveSession([{ role: 'user', content: 'alpha' }], 'sess-a');
  await saveSession([{ role: 'user', content: 'beta' }], 'sess-b');
  const a = await loadSession('sess-a');
  assert.deepEqual(a, [{ role: 'user', content: 'alpha' }], '按 id 恢复旧会话');
  const b = await loadSession('sess-b');
  assert.deepEqual(b, [{ role: 'user', content: 'beta' }]);
  const cur = await loadSession();
  assert.deepEqual(cur, [{ role: 'user', content: 'beta' }], 'current 指向最近一次');
});

test('newSessionId：非空且可作文件名', () => {
  const id = newSessionId();
  assert.ok(/^\d{8}-\d{6}-[0-9a-z]{2}$/.test(id), `id 格式: ${id}`);
});

test('无会话文件 → null（不崩溃）', async () => {
  await clearSessionFile(); // 隔离：前面的用例可能已写入会话
  const loaded = await loadSession();
  assert.equal(loaded, null);
});

test('损坏的会话文件 → 降级为 null', async () => {
  await writeFile(join(home, 'sessions', 'cur.json'), '{ bad json', 'utf-8');
  const loaded = await loadSession('cur');
  assert.equal(loaded, null);
});

test('旧版单文件 session.json → 自动迁移为 current', async () => {
  await rm(join(home, 'sessions'), { recursive: true, force: true });
  await writeFile(join(home, 'session.json'), JSON.stringify([{ role: 'user', content: 'legacy' }]), 'utf-8');
  const loaded = await loadSession();
  assert.deepEqual(loaded, [{ role: 'user', content: 'legacy' }]);
});

test('clearSessionFile 删除会话与 current', async () => {
  await saveSession([{ role: 'user', content: 'x' }], 'sess-c');
  assert.ok((await loadSession()) !== null);
  await clearSessionFile();
  assert.equal(await loadSession(), null);
});
