import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSkills, resolveSkill, buildSkillDescriptions, SKILLS_DIR_ENV } from '../src/skills.js';
import { BASE_PATH_ENV } from '../src/utils/paths.js';

let home: string;
let proj: string;
let dataHome: string;

const savedHomeEnv = process.env[BASE_PATH_ENV];
const savedSkillsEnv = process.env[SKILLS_DIR_ENV];

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'b-code-skills-'));
  proj = join(home, 'proj');
  dataHome = join(home, 'data'); // B_CODE_HOME 数据根
  await mkdir(join(proj, '.claude', 'skills'), { recursive: true });
  await mkdir(join(home, '.claude', 'skills'), { recursive: true });
  await mkdir(join(dataHome, 'skills'), { recursive: true });
  process.env[BASE_PATH_ENV] = dataHome;
});

after(async () => {
  if (savedHomeEnv === undefined) delete process.env[BASE_PATH_ENV];
  else process.env[BASE_PATH_ENV] = savedHomeEnv;
  if (savedSkillsEnv === undefined) delete process.env[SKILLS_DIR_ENV];
  else process.env[SKILLS_DIR_ENV] = savedSkillsEnv;
  await rm(home, { recursive: true, force: true });
});

test('resolveSkill：命中并替换 $ARGUMENTS', async () => {
  await writeFile(
    join(proj, '.claude', 'skills', 'commit.md'),
    '---\nname: commit\ndescription: d\nuser-invocable: true\n---\nDo the commit. Request: $ARGUMENTS\n',
  );
  const out = resolveSkill('/commit add login', proj);
  assert.equal(out, 'Do the commit. Request: add login');
});

test('resolveSkill：未命中返回 null；非 / 开头返回 null', async () => {
  assert.equal(resolveSkill('/nothing-here', proj), null);
  assert.equal(resolveSkill('commit add login', proj), null);
});

test('resolveSkill：项目级覆盖用户级同名技能', async () => {
  await writeFile(
    join(home, '.claude', 'skills', 'dup.md'),
    '---\nname: dup\ndescription: user-level\nuser-invocable: true\n---\nUSER VERSION\n',
  );
  await writeFile(
    join(proj, '.claude', 'skills', 'dup.md'),
    '---\nname: dup\ndescription: project-level\nuser-invocable: true\n---\nPROJECT VERSION\n',
  );
  assert.equal(resolveSkill('/dup', proj), 'PROJECT VERSION');
});

test('discoverSkills：只收集 user-invocable 注入描述', async () => {
  await writeFile(
    join(proj, '.claude', 'skills', 'internal.md'),
    '---\nname: internal\ndescription: hidden\n---\ninternal body\n',
  );
  const desc = buildSkillDescriptions(proj);
  assert.ok(desc.includes('/commit'), 'commit 注入');
  assert.ok(!desc.includes('internal'), '非 user-invocable 不注入');
});

test('discoverSkills 返回元信息', async () => {
  const skills = discoverSkills(proj);
  const commit = skills.find((s) => s.name === 'commit');
  assert.ok(commit?.userInvocable);
});

// ── B_CODE_HOME / B_CODE_SKILLS_DIR 兼容层 ─────────────────────

test('B_CODE_HOME/skills 层：用户级技能随数据根迁移可发现', async () => {
  await writeFile(
    join(dataHome, 'skills', 'portable.md'),
    '---\nname: portable\ndescription: portable skill\nuser-invocable: true\n---\nportable body\n',
  );
  const skills = discoverSkills(proj);
  assert.ok(
    skills.some((s) => s.name === 'portable'),
    'B_CODE_HOME/skills 技能被发现',
  );
  assert.equal(resolveSkill('/portable', proj), 'portable body');
});

test('B_CODE_SKILLS_DIR 层：显式覆盖高于 B_CODE_HOME/skills', async () => {
  const custom = join(home, 'custom-skills');
  await mkdir(custom, { recursive: true });
  await writeFile(
    join(custom, 'dup2.md'),
    '---\nname: dup2\ndescription: from env dir\nuser-invocable: true\n---\nENV VERSION\n',
  );
  await writeFile(
    join(dataHome, 'skills', 'dup2.md'),
    '---\nname: dup2\ndescription: from data home\nuser-invocable: true\n---\nDATAHOME VERSION\n',
  );
  process.env[SKILLS_DIR_ENV] = custom;
  try {
    assert.equal(resolveSkill('/dup2', proj), 'ENV VERSION', 'env 目录优先于 B_CODE_HOME/skills');
  } finally {
    delete process.env[SKILLS_DIR_ENV];
  }
});

test('项目级仍高于 env 层（同名技能项目覆盖）', async () => {
  await writeFile(
    join(proj, '.claude', 'skills', 'dup2.md'),
    '---\nname: dup2\ndescription: from project\nuser-invocable: true\n---\nPROJECT VERSION\n',
  );
  const custom = join(home, 'custom-skills');
  process.env[SKILLS_DIR_ENV] = custom;
  try {
    assert.equal(resolveSkill('/dup2', proj), 'PROJECT VERSION', '项目级最高');
  } finally {
    delete process.env[SKILLS_DIR_ENV];
  }
});

// ── 目录形态技能（Claude 生态 {name}/SKILL.md）──────────────────

test('目录形态：{name}/SKILL.md 可发现且默认 user-invocable', async () => {
  const skillDir = join(proj, '.claude', 'skills', 'changelog-gen');
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    '---\nname: changelog-gen\ndescription: 生成变更日志\n---\nGenerate the changelog: $ARGUMENTS\n',
  );
  const skills = discoverSkills(proj);
  const found = skills.find((s) => s.name === 'changelog-gen');
  assert.ok(found, '目录形态技能可发现');
  assert.equal(found?.userInvocable, true, '目录形态默认可调用');
  assert.ok(found?.description.includes('变更日志'));
});

test('目录形态：小写 skill.md 也可用；user-invocable: false 可关闭', async () => {
  const skillDir = join(proj, '.claude', 'skills', 'lowercase-skill');
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'skill.md'),
    '---\nname: lowercase-skill\ndescription: desc\nuser-invocable: false\n---\nLOWER BODY\n',
  );
  const skills = discoverSkills(proj);
  const found = skills.find((s) => s.name === 'lowercase-skill');
  assert.ok(found, 'skill.md（小写）被发现');
  assert.equal(found?.userInvocable, false, '显式 false 关闭');
  assert.equal(resolveSkill('/lowercase-skill', proj), 'LOWER BODY', '正文可解析');
});

test('目录形态：resolveSkill 命中 SKILL.md 并替换 $ARGUMENTS', async () => {
  assert.equal(resolveSkill('/changelog-gen v1.0', proj), 'Generate the changelog: v1.0');
});

test('目录形态：无 SKILL.md 的目录不算技能；目录带辅助文件不受影响', async () => {
  await mkdir(join(proj, '.claude', 'skills', 'no-doc'), { recursive: true });
  await writeFile(join(proj, '.claude', 'skills', 'no-doc', 'README.md'), 'not a skill\n');
  const withAssets = join(proj, '.claude', 'skills', 'with-assets');
  await mkdir(withAssets, { recursive: true });
  await writeFile(
    join(withAssets, 'SKILL.md'),
    '---\nname: with-assets\ndescription: has assets\n---\nASSET BODY\n',
  );
  await writeFile(join(withAssets, 'template.txt'), 'asset\n');
  const skills = discoverSkills(proj);
  assert.ok(!skills.some((s) => s.name === 'no-doc'), '无 SKILL.md 的目录被忽略');
  assert.ok(
    skills.some((s) => s.name === 'with-assets'),
    '带辅助文件的目录正常',
  );
  assert.equal(resolveSkill('/with-assets', proj), 'ASSET BODY');
});

test('同名冲突：同目录内平铺文件优先于目录；跨目录高优先级生效', async () => {
  // 同目录：proj 里同时放 dup-form.md 和 dup-form/SKILL.md → 平铺生效
  await mkdir(join(proj, '.claude', 'skills', 'dup-form'), { recursive: true });
  await writeFile(
    join(proj, '.claude', 'skills', 'dup-form', 'SKILL.md'),
    '---\nname: dup-form\ndescription: nested\n---\nNESTED\n',
  );
  await writeFile(
    join(proj, '.claude', 'skills', 'dup-form.md'),
    '---\nname: dup-form\ndescription: flat\nuser-invocable: true\n---\nFLAT\n',
  );
  assert.equal(resolveSkill('/dup-form', proj), 'FLAT', '同目录平铺优先');

  // 跨目录：用户级目录形态与项目级平铺同名 → 项目级（更高优先级）生效
  await mkdir(join(home, '.claude', 'skills', 'proj-wins'), { recursive: true });
  await writeFile(
    join(home, '.claude', 'skills', 'proj-wins', 'SKILL.md'),
    '---\nname: proj-wins\ndescription: user nested\n---\nUSER NESTED\n',
  );
  await mkdir(join(proj, '.claude', 'skills', 'proj-wins'), { recursive: true });
  await writeFile(
    join(proj, '.claude', 'skills', 'proj-wins', 'SKILL.md'),
    '---\nname: proj-wins\ndescription: project nested\n---\nPROJECT NESTED\n',
  );
  assert.equal(resolveSkill('/proj-wins', proj), 'PROJECT NESTED', '项目级目录形态覆盖用户级');
});

test('resolveSkill：路径穿越与隐藏名不命中技能', async () => {
  assert.equal(resolveSkill('/..', proj), null);
  assert.equal(resolveSkill('/a/b', proj), null);
  assert.equal(resolveSkill('/.hidden', proj), null);
});
