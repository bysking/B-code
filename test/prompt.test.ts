import { test, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystemPrompt, flattenSystemBlocks, loadClaudeMd, STATIC_CORE } from '../src/prompt.js';
import { BASE_PATH_ENV } from '../src/utils/paths.js';

const savedHome = process.env[BASE_PATH_ENV];
let dir: string;
let home: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'b-code-prompt-'));
  home = await mkdtemp(join(tmpdir(), 'b-code-prompt-home-'));
  // 全局层读 {B_CODE_HOME}/CLAUDE.md|AGENTS.md —— 指向临时目录，避免读真实的 ~/.b-code
  process.env[BASE_PATH_ENV] = home;
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env[BASE_PATH_ENV];
  else process.env[BASE_PATH_ENV] = savedHome;
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
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

test('loadClaudeMd：同一目录同时读取 CLAUDE.md 与 AGENTS.md，CLAUDE.md 在前', async () => {
  await writeFile(join(dir, 'CLAUDE.md'), 'claude rules\n');
  await writeFile(join(dir, 'AGENTS.md'), 'agents rules\n@agents-inc.md\n');
  await writeFile(join(dir, 'agents-inc.md'), 'agents extra\n');
  const out = loadClaudeMd(dir);
  assert.ok(out.includes('claude rules'));
  assert.ok(out.includes('agents rules'));
  assert.ok(out.includes('agents extra'));
  // 分目录层级合并：CLAUDE.md（本层）出现在 AGENTS.md（同层）之前
  assert.ok(out.indexOf('claude rules') < out.indexOf('agents rules'));
});

// ── 全局层：{B_CODE_HOME}/AGENTS.md 与 CLAUDE.md ──────────────────

test('全局层：B_CODE_HOME 下的 AGENTS.md 不依赖 cwd 也会注入', async () => {
  const project = await mkdtemp(join(tmpdir(), 'b-code-global-proj-'));
  try {
    await writeFile(join(home, 'AGENTS.md'), 'global agents rules\n');
    const out = loadClaudeMd(project);
    assert.ok(out.includes('global agents rules'), `全局 AGENTS.md 应注入: ${out}`);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('全局层：B_CODE_HOME 下的 CLAUDE.md 也读，且在同层排在 AGENTS.md 之前', async () => {
  const project = await mkdtemp(join(tmpdir(), 'b-code-global-proj2-'));
  try {
    await writeFile(join(home, 'CLAUDE.md'), 'global claude rules\n');
    await writeFile(join(home, 'AGENTS.md'), 'global agents rules\n');
    const out = loadClaudeMd(project);
    assert.ok(out.includes('global claude rules'));
    assert.ok(out.includes('global agents rules'));
    assert.ok(out.indexOf('global claude rules') < out.indexOf('global agents rules'));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('全局层排在项目层之前（项目约定读作"在全局之上收紧"）', async () => {
  const project = await mkdtemp(join(tmpdir(), 'b-code-global-proj3-'));
  try {
    await writeFile(join(home, 'AGENTS.md'), 'global-first-marker\n');
    await writeFile(join(project, 'AGENTS.md'), 'project-second-marker\n');
    const out = loadClaudeMd(project);
    assert.ok(out.indexOf('global-first-marker') < out.indexOf('project-second-marker'));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('全局层：cwd 就是 B_CODE_HOME 时同一文件不重复注入', async () => {
  await writeFile(join(home, 'AGENTS.md'), 'dedupe-marker\n');
  const out = loadClaudeMd(home);
  assert.equal(out.match(/dedupe-marker/g)?.length, 1, '同一物理文件只注入一次');
});

test('全局层：@include 相对 B_CODE_HOME 解析', async () => {
  const project = await mkdtemp(join(tmpdir(), 'b-code-global-proj4-'));
  try {
    await writeFile(join(home, 'global-inc.md'), 'global included rules\n');
    await writeFile(join(home, 'AGENTS.md'), 'global head\n@global-inc.md\n');
    const out = loadClaudeMd(project);
    assert.ok(out.includes('global included rules'), '全局文件里的 @include 相对全局目录解析');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('全局层：buildSystemPrompt 把全局 AGENTS.md 放进 Project Instructions 段', async () => {
  await writeFile(join(home, 'AGENTS.md'), 'global agents rules\n'); // 复位（上一条用例改写过它）
  const blocks = buildSystemPrompt({ cwd: dir });
  const dynamic = flattenSystemBlocks(blocks.slice(1));
  assert.ok(dynamic.includes('# Project Instructions'));
  assert.ok(dynamic.includes('global agents rules'), '全局约定进了动态块');
  // 静态核心不受全局文件影响（缓存前缀保持稳定）
  assert.equal(blocks[0]?.text, STATIC_CORE);
});
