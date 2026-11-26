import { test, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE_PATH_ENV, dirs } from '../src/utils/paths.js';
import { MEMORY_DIR_ENV, globalMemoryDir, memoryDir, recallMemories, saveMemory } from '../src/memory.js';

const savedHome = process.env[BASE_PATH_ENV];
const savedMem = process.env[MEMORY_DIR_ENV];
let home: string;
let cwdA: string;
let cwdB: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'b-code-gmem-'));
  process.env[BASE_PATH_ENV] = home;
  cwdA = join(home, 'proj-a');
  cwdB = join(home, 'proj-b');
});

afterAll(async () => {
  delete process.env[MEMORY_DIR_ENV];
  if (savedMem !== undefined) process.env[MEMORY_DIR_ENV] = savedMem;
  if (savedHome === undefined) delete process.env[BASE_PATH_ENV];
  else process.env[BASE_PATH_ENV] = savedHome;
  await rm(home, { recursive: true, force: true });
});

test('globalMemoryDir 默认是 {B_CODE_HOME}/memory', () => {
  delete process.env[MEMORY_DIR_ENV];
  assert.equal(globalMemoryDir(), dirs.memoryDir());
  assert.equal(globalMemoryDir(), join(home, 'memory'));
});

test('B_CODE_MEMORY_DIR 绝对路径覆盖全局记忆目录', () => {
  process.env[MEMORY_DIR_ENV] = join(home, 'shared-mem');
  assert.equal(globalMemoryDir(), join(home, 'shared-mem'));
});

test('B_CODE_MEMORY_DIR 相对路径相对 basePath（不 throw）', () => {
  process.env[MEMORY_DIR_ENV] = './rel-mem';
  assert.equal(globalMemoryDir(), join(home, 'rel-mem'));
  delete process.env[MEMORY_DIR_ENV];
});

test('saveMemory scope=global 落在全局目录，scope=project 仍在项目目录', () => {
  delete process.env[MEMORY_DIR_ENV];
  const g = saveMemory('shared rule', 'all projects', 'reference', 'commit in chinese', cwdA, 'global');
  assert.equal(g, join(home, 'memory', 'shared_rule.md'));
  assert.ok(existsSync(g));

  const p = saveMemory('local rule', 'this repo', 'reference', 'use pnpm here', cwdA);
  assert.equal(p, join(memoryDir(cwdA), 'local_rule.md'));
});

test('全局记忆可被另一个项目召回（跨项目共享）', () => {
  delete process.env[MEMORY_DIR_ENV];
  saveMemory('shared rule', 'all projects', 'reference', 'commit in chinese', cwdA, 'global');
  const recalled = recallMemories('commit in chinese rule', 3, cwdB);
  assert.ok(recalled.includes('# Memory'), 'b 项目也召到全局记忆');
  assert.ok(recalled.includes('commit in chinese'));
});

test('项目记忆不会被其他项目看到（隔离仍生效）', () => {
  saveMemory('only in a', 'secret a', 'project', 'aaa-marker', cwdA);
  const inB = recallMemories('aaa-marker secret', 3, cwdB);
  assert.ok(!inB.includes('aaa-marker'), '项目层记忆不跨项目');
});

test('同分时全局记忆排在项目记忆之前', () => {
  saveMemory('deploy global', 'deploy', 'reference', 'deploy-global-marker', cwdA, 'global');
  saveMemory('deploy local', 'deploy', 'reference', 'deploy-local-marker', cwdA, 'project');
  const recalled = recallMemories('deploy', 3, cwdA);
  const first = recalled.split('\n').find((l) => l.startsWith('- ')) ?? '';
  assert.ok(first.includes('deploy-global-marker'), `全局层应优先: ${first}`);
});

test('B_CODE_MEMORY_DIR 指向的目录真的被扫描（而不是默认目录）', async () => {
  const external = join(home, 'external-mem');
  await mkdir(external, { recursive: true });
  saveMemory('ext fact', 'external', 'reference', 'external-marker-xyz', cwdA); // 先落项目层
  process.env[MEMORY_DIR_ENV] = external;
  saveMemory('ext global', 'external dir', 'reference', 'extdir-marker-xyz', cwdA, 'global');
  assert.equal(globalMemoryDir(), external);
  const recalled = recallMemories('extdir-marker-xyz', 3, cwdA);
  assert.ok(recalled.includes('extdir-marker-xyz'), '自定义全局目录被扫描');
  delete process.env[MEMORY_DIR_ENV];
});

test('两层目录都不存在 → 返回空串（不抛）', () => {
  delete process.env[MEMORY_DIR_ENV];
  process.env[MEMORY_DIR_ENV] = join(home, 'never-created');
  assert.equal(recallMemories('anything at all', 3, join(home, 'ghost')), '');
  delete process.env[MEMORY_DIR_ENV];
});
