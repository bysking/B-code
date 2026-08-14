import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs } from "../src/cli.js";

const base = { resume: false, plan: false, yolo: false, auto: false, goal: "", loop: 0, session: "", instruction: "" };

test("parseCliArgs：无参数 → 纯 REPL，默认模式", () => {
  assert.deepEqual(parseCliArgs([]), base);
});

test("parseCliArgs：--resume 用法", () => {
  assert.deepEqual(parseCliArgs(["--resume"]), { ...base, resume: true });
});

test("parseCliArgs：one-shot 指令保留原文（含空格）", () => {
  assert.deepEqual(parseCliArgs(["Read", "src/index.ts", "and", "summarize"]), {
    ...base,
    instruction: "Read src/index.ts and summarize",
  });
});

test("parseCliArgs：--resume 与 one-shot 并存", () => {
  assert.deepEqual(parseCliArgs(["--resume", "hello world"]), {
    ...base,
    resume: true,
    instruction: "hello world",
  });
});

test("parseCliArgs：--plan / --yolo / --auto 被正确剥离", () => {
  assert.deepEqual(parseCliArgs(["--plan", "--yolo", "--auto", "write a file"]), {
    ...base,
    plan: true,
    yolo: true,
    auto: true,
    instruction: "write a file",
  });
});

test("parseCliArgs：--goal 取下一 token 为条件，其余为指令", () => {
  assert.deepEqual(parseCliArgs(["--goal", "test.txt exists", "create test.txt"]), {
    ...base,
    goal: "test.txt exists",
    instruction: "create test.txt",
  });
});

test("parseCliArgs：--loop 解析秒数，非法值归 0", () => {
  assert.deepEqual(parseCliArgs(["--loop", "30", "watch it"]), {
    ...base,
    loop: 30,
    instruction: "watch it",
  });
  assert.equal(parseCliArgs(["--loop", "abc"]).loop, 0);
});