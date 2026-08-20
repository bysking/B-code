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

test('loadClaudeMd：不存在与循环引用都有安全兜底', async () => {
  await writeFile(join(dir, 'CLAUDE.md'), '@missing.md\n@CLAUDE.md\n');
  const out = loadClaudeMd(dir);
  assert.ok(out.includes('not found'));
  assert.ok(out.includes('circular include'));
});
