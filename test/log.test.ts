import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupLogging, log, logState, setLogLevel } from "../src/utils/log.js";

let dir: string;
const savedFile = process.env.B_CODE_LOG_FILE;
const savedLevel = process.env.B_CODE_LOG_LEVEL;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "b-code-log-"));
});

after(async () => {
  if (savedFile === undefined) delete process.env.B_CODE_LOG_FILE;
  else process.env.B_CODE_LOG_FILE = savedFile;
  if (savedLevel === undefined) delete process.env.B_CODE_LOG_LEVEL;
  else process.env.B_CODE_LOG_LEVEL = savedLevel;
  await rm(dir, { recursive: true, force: true });
});

test("级别过滤：info 级别下 debug 被丢弃", () => {
  setLogLevel("info"); // 不依赖外部 env
  const err = process.stderr.write;
  let captured = "";
  (process.stderr as any).write = (s: string) => {
    captured += s;
    return true;
  };
  try {
    log.debug("should-not-appear");
    log.info("visible-info");
  } finally {
    process.stderr.write = err;
  }
  assert.ok(!captured.includes("should-not-appear"));
  assert.ok(captured.includes("visible-info"));
});

test("B_CODE_LOG_FILE 开启后落盘，行级别受控", async () => {
  process.env.B_CODE_LOG_FILE = "1";
  process.env.B_CODE_LOG_LEVEL = "warn";
  setupLogging({ dir });
  assert.ok(logState().fileSink.startsWith(join(dir, "b-code-")), "落盘到指定目录");

  log.info("info-not-to-file");
  log.warn("warn-to-file");
  log.debug("debug-not-to-file", { a: 1 });

  // appendFileSync 是同步写，此处读一定能看到已写入的行
  const content = await readFile(logState().fileSink, "utf-8");
  assert.ok(content.includes("warn-to-file"));
  assert.ok(!content.includes("info-not-to-file"), "warn 级别下 info 不入文件");
  assert.ok(!content.includes("debug-not-to-file"));
});

test("关闭 B_CODE_LOG_FILE 后不再产生新文件", () => {
  delete process.env.B_CODE_LOG_FILE;
  setupLogging({ dir });
  assert.equal(logState().fileSink, "");
});