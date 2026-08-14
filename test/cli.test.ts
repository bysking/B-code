import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs } from "../src/cli.js";

test("parseCliArgs：无参数 → 纯 REPL", () => {
  assert.deepEqual(parseCliArgs([]), { resume: false, instruction: "" });
});

test("parseCliArgs：--resume 用法", () => {
  assert.deepEqual(parseCliArgs(["--resume"]), { resume: true, instruction: "" });
});

test("parseCliArgs：one-shot 指令保留原文（含空格）", () => {
  assert.deepEqual(parseCliArgs(["Read", "src/index.ts", "and", "summarize"]), {
    resume: false,
    instruction: "Read src/index.ts and summarize",
  });
});

test("parseCliArgs：--resume 与 one-shot 并存", () => {
  assert.deepEqual(parseCliArgs(["--resume", "hello world"]), {
    resume: true,
    instruction: "hello world",
  });
});