import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileStore, cacheable, contentHash, filePointer, FILE_CACHE_MAX_ENTRIES } from '../src/file-store.js';

function snap(content: string, mtimeMs = 1000, size = Buffer.byteLength(content)) {
  return { mtimeMs, size, hash: contentHash(Buffer.from(content)), content, dirty: false };
}

// ── hash ────────────────────────────────────────────────────
test('contentHash：同内容同 hash，改内容 hash 变', () => {
  assert.equal(contentHash(Buffer.from('hello')), contentHash(Buffer.from('hello')));
  assert.notEqual(contentHash(Buffer.from('hello')), contentHash(Buffer.from('hellp')));
  // 对原始 buffer 计算：中文多字节不因字符数混淆
  assert.equal(contentHash(Buffer.from('你好', 'utf-8')), contentHash(Buffer.from('你好', 'utf-8')));
});

test('cacheable：≤1MB 可缓存，超限不缓存', () => {
  assert.equal(cacheable(1024), true);
  assert.equal(cacheable(1024 * 1024), true);
  assert.equal(cacheable(1024 * 1024 + 1), false);
});

// ── 基本操作 ────────────────────────────────────────────────
test('FileStore：get/set/entries/updateContent/markDirty/markFresh', () => {
  const s = new FileStore();
  assert.equal(s.get('a.ts'), undefined, '初始无快照');

  s.set('a.ts', snap('line1\nline2'));
  assert.ok(s.get('a.ts'), 'set 后可见');
  assert.equal(s.get('a.ts')?.dirty, false);

  // 编辑工具已知新内容 → 更新快照
  s.updateContent('a.ts', 'new content', 2000, 11, 'h2');
  assert.equal(s.get('a.ts')?.content, 'new content');
  assert.equal(s.get('a.ts')?.hash, 'h2');
  assert.equal(s.get('a.ts')?.mtimeMs, 2000);

  // 外部变更 → markDirty
  s.markDirty('a.ts');
  assert.equal(s.get('a.ts')?.dirty, true);
  s.markFresh('a.ts');
  assert.equal(s.get('a.ts')?.dirty, false);

  assert.deepEqual(
    s.entries().map(([p]) => p),
    ['a.ts'],
  );
});

test('FileStore：cap 超过上限丢最早插入', () => {
  const s = new FileStore();
  for (let i = 0; i < FILE_CACHE_MAX_ENTRIES + 5; i++) {
    s.set(`f${i}.ts`, snap(`content ${i}`));
  }
  assert.equal(s.entries().length, FILE_CACHE_MAX_ENTRIES, '条数封顶');
  assert.equal(s.get('f0.ts'), undefined, '最早插入被逐出');
  assert.ok(s.get(`f${FILE_CACHE_MAX_ENTRIES + 4}.ts`), '最新保留');
});

// ── 指针行 ──────────────────────────────────────────────────
test('filePointer：生成含行数/字节/hash 的指针行', () => {
  const s = snap('line1\nline2\nline3', 1000, 17);
  const p = filePointer('a.ts', s);
  assert.ok(p.includes('📄 a.ts'));
  assert.ok(p.includes('3 行'));
  assert.ok(p.includes(s.hash));
});
