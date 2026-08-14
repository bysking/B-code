import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs } from "../src/cli.js";

test("parseCliArgs：无参数 → 纯 REPL，默认模式", () => {
  assert.deepEqual(parseCliArgs([]), {
    resume: false,
    plan: false,
    yolo: false,
    instruction: "",
  });
});

test("parseCliArgs：--resume 用法", () => {
  assert.deepEqual(parseCliArgs(["--resume"]), {
    resume: true,
    plan: false,
    yolo: false,
    instruction: "",
  });
});

test("parseCliArgs：one-shot 指令保留原文（含空格）", () => {
  assert.deepEqual(parseCliArgs(["Read", "src/index.ts", "and", "summarize"]), {
    resume: false,
    plan: false,
    yolo: false,
    instruction: "Read src/index.ts and summarize",
  });
});

test("parseCliArgs：--resume 与 one-shot 并存", () => {
  assert.deepEqual(parseCliArgs(["--resume", "hello world"]), {
    resume: true,
    plan: false,
    yolo: false,
    instruction: "hello world",
  });
});

test("parseCliArgs：--plan 与 --yolo 被正确剥离", () => {
  assert.deepEqual(parseCliArgs(["--plan", "--yolo", "write a file"]), {
    resume: false,
    plan: true,
    yolo: true,
    instruction: "write a file",
  });
});