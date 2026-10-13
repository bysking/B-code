import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CheckpointStore, withCheckpoints } from '../src/checkpoint.js';
import { Registry, type RuntimeContext } from '../src/registry.js';
import { registerBuiltinTools } from '../src/tools.js';

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'b-code-ckpt-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('CheckpointStore：记录前像并逆序还原', async () => {
  const p = join(dir, 'a.txt');
  await writeFile(p, 'original');
  const store = new CheckpointStore();
  store.record(p);
  await writeFile(p, 'changed');
  const { restored } = store.rewind();
  assert.deepEqual(restored, [resolve(p)]);
  assert.equal(await readFile(p, 'utf-8'), 'original', '还原为改动前内容');
  assert.equal(store.size(), 0, '回退后清空记录');
});

test('CheckpointStore：原本不存在的文件 → 回退时删除', async () => {
  const p = join(dir, 'created.txt');
  const store = new CheckpointStore();
  store.record(p); // 记录时不存在
  await writeFile(p, 'new file');
  const { deleted } = store.rewind();
  assert.deepEqual(deleted, [resolve(p)]);
  assert.equal(existsSync(p), false, '新建的文件被删除');
});

test('CheckpointStore：同文件多次记录只保留最早前像', async () => {
  const p = join(dir, 'multi.txt');
  await writeFile(p, 'v0');
  const store = new CheckpointStore();
  store.record(p);
  await writeFile(p, 'v1');
  store.record(p); // 第二次：应跳过，保留 v0
  await writeFile(p, 'v2');
  assert.equal(store.size(), 1);
  store.rewind();
  assert.equal(await readFile(p, 'utf-8'), 'v0', '回退到最早的前像');
});

test('withCheckpoints：包装 write_file → 执行前自动记录', async () => {
  const registry = new Registry();
  registerBuiltinTools(registry);
  const store = new CheckpointStore();
  withCheckpoints(registry, store);

  const p = join(dir, 'wrapped.txt');
  await writeFile(p, 'before-wrap');
  const ctx = {} as RuntimeContext;
  const mp = registry.resolve('write_file')!;
  await Promise.resolve(mp.handler({ file_path: p, content: 'after-wrap' }, ctx) as string);

  assert.equal(store.size(), 1, 'write_file 执行前记录了检查点');
  assert.equal(await readFile(p, 'utf-8'), 'after-wrap', '写入生效');
  store.rewind();
  assert.equal(await readFile(p, 'utf-8'), 'before-wrap', '可回退到写入前');
});

test('withCheckpoints：包装 edit_file → 执行前自动记录', async () => {
  const registry = new Registry();
  registerBuiltinTools(registry);
  const store = new CheckpointStore();
  withCheckpoints(registry, store);

  const p = join(dir, 'edited.txt');
  await writeFile(p, 'line one\nline two\n');
  const mp = registry.resolve('edit_file')!;
  await Promise.resolve(
    mp.handler(
      { file_path: p, old_string: 'line two', new_string: 'CHANGED' },
      {} as RuntimeContext,
    ) as string,
  );
  assert.ok((await readFile(p, 'utf-8')).includes('CHANGED'));
  store.rewind();
  assert.equal(await readFile(p, 'utf-8'), 'line one\nline two\n', 'edit 可回退');
});

test('withCheckpoints：回退后再次改动可重新记录', async () => {
  const registry = new Registry();
  registerBuiltinTools(registry);
  const store = new CheckpointStore();
  withCheckpoints(registry, store);
  const ctx = {} as RuntimeContext;
  const p = join(dir, 'again.txt');
  await writeFile(p, 'first');
  const mp = registry.resolve('write_file')!;

  await Promise.resolve(mp.handler({ file_path: p, content: 'second' }, ctx) as string);
  store.rewind();
  assert.equal(await readFile(p, 'utf-8'), 'first');

  await Promise.resolve(mp.handler({ file_path: p, content: 'third' }, ctx) as string);
  assert.equal(store.size(), 1, '回退后重新记录');
  store.rewind();
  assert.equal(await readFile(p, 'utf-8'), 'first');
});
