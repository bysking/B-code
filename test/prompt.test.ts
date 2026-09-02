import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystemPrompt, flattenSystemBlocks, loadClaudeMd, STATIC_CORE } from '../src/prompt.js';

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'b-code-prompt-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('两段式：第一块是静态核心且带 cache_control，动态块含 Environment', () => {
  const blocks = buildSystemPrompt({ cwd: dir });
  assert.equal(blocks[0]?.type, 'text');
  assert.equal(blocks[0]?.text, STATIC_CORE);
  assert.equal(blocks[0]?.cache_control?.type, 'ephemeral');

  const dynamic = flattenSystemBlocks(blocks.slice(1));
  assert.ok(dynamic.includes('# Environment'));
  assert.ok(dynamic.includes(dir));
});

test('动态上下文在 git 仓库中含 Git 分支信息', () => {
  // 本项目就是 git 仓库：cwd=repo 时可拿到分支行
  const blocks = buildSystemPrompt();
  const dynamic = flattenSystemBlocks(blocks.slice(1));
  assert.ok(dynamic.includes('# Git'));
  assert.ok(/Branch: /.test(dynamic));
});

test('loadClaudeMd：从 startDir 读取并合并 @include（相对路径）', async () => {
  await writeFile(join(dir, 'CLAUDE.md'), 'rules from project\n@included.md\n');
  await writeFile(join(dir, 'included.md'), 'extra rules\n');
  const out = loadClaudeMd(dir);
  assert.ok(out.includes('rules from project'));
  assert.ok(out.includes('extra rules'));
});

test('loadClaudeMd：@include 相对子目录解析', async () => {
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, 'sub', 'rules.md'), 'sub rules\n');
  await writeFile(join(dir, 'CLAUDE.md'), 'top\n@sub/rules.md\n');
  const out = loadClaudeMd(dir);
  assert.ok(out.includes('top'));
  assert.ok(out.includes('sub rules'));
});

test('loadClaudeMd：不存在的引用原样保留（可选引用），循环引用有安全兜底', async () => {
  await writeFile(join(dir, 'CLAUDE.md'), '@missing.md\n@CLAUDE.md\n');
  const out = loadClaudeMd(dir);
  assert.ok(out.includes('@missing.md'));
  assert.ok(out.includes('circular include'));
});

test('loadClaudeMd：路径存在才替换，不存在的保留原行', async () => {
  await writeFile(join(dir, 'exists.md'), 'present rules\n');
  await writeFile(join(dir, 'CLAUDE.md'), '@exists.md\n@nope.md\n');
  const out = loadClaudeMd(dir);
  assert.ok(out.includes('present rules'));
  assert.ok(out.includes('@nope.md'));
});

test('loadClaudeMd：@ 引用支持出现在行中任意位置', async () => {
  await writeFile(join(dir, 'inline.md'), 'inline rules\n');
  await writeFile(join(dir, 'CLAUDE.md'), '正文包含 @inline.md 的引用\n结尾也支持：@inline.md');
  const out = loadClaudeMd(dir);
  assert.ok(out.includes('正文包含 inline rules 的引用'));
  assert.ok(out.includes('结尾也支持：inline rules'));
});

test('loadClaudeMd：@ 引用后跟标点也会正确剥离并展开', async () => {
  await writeFile(join(dir, 'punct.md'), 'punct rules\n');
  await writeFile(join(dir, 'CLAUDE.md'), '详见 @punct.md。以及 (@punct.md)，和 @punct.md。');
  const out = loadClaudeMd(dir);
  assert.ok(!out.includes('@punct.md')); // 无残留的 @ 引用
  assert.equal(out.match(/punct rules/g)?.length, 3); // 三处都展开了
});

test('loadClaudeMd：email 与 scoped 包名等 @ 不误伤（原样保留）', async () => {
  await writeFile(join(dir, 'CLAUDE.md'), '联系 test@example.com 或使用 @babel/core 包');
  const out = loadClaudeMd(dir);
  assert.ok(out.includes('test@example.com'));
  assert.ok(out.includes('@babel/core'));
});
