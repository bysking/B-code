import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_PATH_ENV, dirs } from "../src/utils/paths.js";
import { memoryDir, projectKey, recallMemories, saveMemory } from "../src/memory.js";

const saved = process.env[BASE_PATH_ENV];
let home: string;
let cwd1: string;
let cwd2: string;

before(async () => {
  home = await mkdtemp(join(tmpdir(), "b-code-mem-"));
  process.env[BASE_PATH_ENV] = home;
  cwd1 = join(home, "proj-a");
  cwd2 = join(home, "proj-b");
});

after(async () => {
  if (saved === undefined) delete process.env[BASE_PATH_ENV];
  else process.env[BASE_PATH_ENV] = saved;
  await rm(home, { recursive: true, force: true });
});

test("projectKey：不同 cwd 不同键，同 cwd 稳定", () => {
  const a = projectKey(cwd1);
  assert.notEqual(a, projectKey(cwd2));
  assert.equal(a, projectKey(cwd1));
});

test("memoryDir 落在 basePath/projects 下", () => {
  assert.ok(memoryDir(cwd1).startsWith(join(dirs.projectsDir(), projectKey(cwd1))));
});

test("saveMemory → recallMemories 关键词命中", () => {
  saveMemory("staging url", "staging 环境地址", "reference", "https://staging.example.com", cwd1);
  const recalled = recallMemories("what is the staging url", 3, cwd1);
  assert.ok(recalled.includes("# Memory"), "recall 返回 Memory 段");
  assert.ok(recalled.includes("https://staging.example.com"), "内容被召回");
});

test("不相关 query 不命中", () => {
  const recalled = recallMemories("unrelated topic", 3, cwd2);
  assert.equal(recalled, "");
});

test("关键词重叠越多的记忆排越前", () => {
  saveMemory("database config", "postgres connection", "project", "host db:5432 user app", cwd1);
  saveMemory("database backup", "postgres nightly", "project", "cron 3am", cwd1);
  // query 与 config 重叠 2 词（database/config），与 backup 只重叠 1 词（database）
  const recalled = recallMemories("database config", 3, cwd1);
  const first = recalled.split("\n").find((l) => l.startsWith("- ")) ?? "";
  assert.ok(first.includes("database config"), `重叠词多的应在前: ${first}`);
});

test("不同项目目录记忆互不可见（隔离）", () => {
  saveMemory("only in a", "secret a", "project", "aaa", cwd1);
  const inB = recallMemories("secret a", 3, cwd2);
  assert.equal(inB, "", "b 项目召不到 a 项目的记忆");
});

test("中文召回：无空格文本靠二叉分词命中", () => {
  saveMemory("备份服务器", "运维", "project", "备份服务器是 192.168.1.99，密码在 1Password", cwd1);
  const recalled = recallMemories("备份服务器地址是什么?", 3, cwd1);
  assert.ok(recalled.includes("192.168.1.99"), `中文二叉应命中: ${recalled}`);
});

test("英文召回不受影响（回归）", () => {
  saveMemory("postgres db", "database", "project", "host db:5432", cwd1);
  const recalled = recallMemories("postgres server", 3, cwd1);
  assert.ok(recalled.includes("postgres db"));
});