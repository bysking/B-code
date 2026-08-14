import { test } from "node:test";
import assert from "node:assert/strict";
import { allowlistKey, checkPermission, DANGEROUS_PATTERNS } from "../src/permissions.js";

test("危险命令在三种模式下都被 deny（含 --yolo）", () => {
  const dangerous = [
    "rm -rf /tmp/x",
    "git push origin main",
    "git reset --hard HEAD",
    "sudo apt install x",
    "dd if=/dev/zero of=/dev/sda",
    "kill -9 1234",
    "reboot now",
    "shutdown -h now",
    "echo hi > /dev/sda",
  ];
  for (const cmd of dangerous) {
    for (const mode of ["default", "plan", "bypass"] as const) {
      assert.equal(
        checkPermission("run_shell", { command: cmd }, mode),
        "deny",
        `${mode} 下应 deny: ${cmd}`,
      );
    }
  }
});

test("plan 模式：写/编辑/shell 全拦，只读放行", () => {
  assert.equal(checkPermission("write_file", { file_path: "a", content: "" }, "plan"), "deny");
  assert.equal(checkPermission("edit_file", { file_path: "a" }, "plan"), "deny");
  assert.equal(checkPermission("run_shell", { command: "pwd" }, "plan"), "deny");
  assert.equal(checkPermission("read_file", { file_path: "a" }, "plan"), "allow");
  assert.equal(checkPermission("list_files", { pattern: "*" }, "plan"), "allow");
  assert.equal(checkPermission("grep_search", { pattern: "x" }, "plan"), "allow");
});

test("default 模式：只读放行，写/编辑/shell 需确认", () => {
  assert.equal(checkPermission("read_file", { file_path: "a" }, "default"), "allow");
  assert.equal(checkPermission("write_file", { file_path: "a", content: "" }, "default"), "confirm");
  assert.equal(checkPermission("edit_file", { file_path: "a" }, "default"), "confirm");
  assert.equal(checkPermission("run_shell", { command: "ls" }, "default"), "confirm");
});

test("fail-closed：未知工具默认 confirm（不默认放行）", () => {
  assert.equal(checkPermission("mcp__future__anything", {}, "default"), "confirm");
  assert.equal(checkPermission("skill:commit", {}, "default"), "confirm");
});

test("bypass 下普通 shell 是 confirm（调用方再跳过），但危险命令仍 deny", () => {
  // bypass 逻辑在 Agent 层：这里 confirm 信号表示"问不问由调用方决定"
  assert.equal(checkPermission("run_shell", { command: "ls" }, "bypass"), "confirm");
  assert.equal(checkPermission("run_shell", { command: "rm -rf /" }, "bypass"), "deny");
});

test("allowlistKey：shell 用命令内容，其他按工具名", () => {
  assert.equal(allowlistKey("run_shell", { command: "ls -la" }), "shell:ls -la");
  assert.equal(allowlistKey("write_file", {}), "write_file");
});

test("危险模式表非空且含核心条目（守卫误删）", () => {
  assert.ok(DANGEROUS_PATTERNS.length >= 10);
  // RegExp.toString() 会把字符类/转义再转义一层：\b → \\b，断言 source 原文
  const first = DANGEROUS_PATTERNS[0];
  assert.ok(first, "表非空");
  assert.equal(first.source, "\\brm\\s+-rf\\b");
  assert.ok(DANGEROUS_PATTERNS.some((re) => re.source.includes("sudo")));
});