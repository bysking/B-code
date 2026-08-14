import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSession, loadSession, clearSessionFile } from "../src/session.js";
import { BASE_PATH_ENV } from "../src/utils/paths.js";

const saved = process.env[BASE_PATH_ENV];
let home: string;

before(async () => {
  home = await mkdtemp(join(tmpdir(), "b-code-session-"));
  process.env[BASE_PATH_ENV] = home;
});

after(async () => {
  if (saved === undefined) delete process.env[BASE_PATH_ENV];
  else process.env[BASE_PATH_ENV] = saved;
  await rm(home, { recursive: true, force: true });
});

test("保存→加载 消息数组原样往返", async () => {
  const messages = [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    },
  ];
  await saveSession(messages);
  const loaded = await loadSession();
  assert.deepEqual(loaded, messages);
});

test("无会话文件 → null（不崩溃）", async () => {
  await clearSessionFile(); // 隔离：前面的用例可能已写入会话
  const loaded = await loadSession();
  assert.equal(loaded, null);
});

test("损坏的会话文件 → 降级为 null", async () => {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(home, "session.json"),
    "{ this is not json ",
    "utf-8",
  );
  const loaded = await loadSession();
  assert.equal(loaded, null);
});

test("clearSessionFile 删除会话", async () => {
  await saveSession([{ role: "user", content: "x" }]);
  assert.ok((await loadSession()) !== null);
  await clearSessionFile();
  assert.equal(await loadSession(), null);
});