import { test } from "node:test";
import assert from "node:assert/strict";
import { allowlistKey, checkPermission, DANGEROUS_PATTERNS } from "../src/permissions.js";
import type { MountPoint } from "../src/registry.js";

/** 构造最小 MountPoint 测试替身 */
function mp(name: string, mode: MountPoint["mode"] = "external"): MountPoint {
  return { name, description: "", inputSchema: {}, mode, handler: () => "" };
}

test("危险命令在三种模式下都被 deny（含 --yolo）", () => {
  const shell = mp("run_shell", "shell");
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
        checkPermission(shell, { command: cmd }, mode),
        "deny",
        `${mode} 下应 deny: ${cmd}`,
      );
    }
  }
});

test("plan 模式：write/shell/external 全拦，read 放行", () => {
  assert.equal(checkPermission(mp("write_file", "write"), { file_path: "a" }, "plan"), "deny");
  assert.equal(checkPermission(mp("run_shell", "shell"), { command: "pwd" }, "plan"), "deny");
  assert.equal(checkPermission(mp("mcp__x__write", "external"), {}, "plan"), "deny");
  assert.equal(checkPermission(mp("read_file", "read"), { file_path: "a" }, "plan"), "allow");
  assert.equal(checkPermission(mp("list_files", "read"), { pattern: "*" }, "plan"), "allow");
  assert.equal(checkPermission(mp("grep_search", "read"), { pattern: "x" }, "plan"), "allow");
});

test("plan 模式下 allowInPlan 的工具放行（如 write_plan）", () => {
  const writePlan = mp("write_plan", "write");
  writePlan.allowInPlan = true;
  assert.equal(checkPermission(writePlan, { plan: "x" }, "plan"), "confirm", "需确认但不禁");
  // plan 下确认会走用户流程；这里断言的是"不是 deny"
  assert.notEqual(checkPermission(writePlan, { plan: "x" }, "plan"), "deny");
});

test("default 模式：read 放行，write/shell/external 需确认", () => {
  assert.equal(checkPermission(mp("read_file", "read"), { file_path: "a" }, "default"), "allow");
  assert.equal(checkPermission(mp("write_file", "write"), { file_path: "a" }, "default"), "confirm");
  assert.equal(checkPermission(mp("run_shell", "shell"), { command: "ls" }, "default"), "confirm");
});

test("fail-closed：未声明 mode 的工具默认 confirm（不默认放行）", () => {
  const unknown = mp("skill:commit"); // 无 mode
  assert.equal(checkPermission(unknown, {}, "default"), "confirm");
});

test("bypass 下普通 shell 是 confirm（调用方再跳过），但危险命令仍 deny", () => {
  const shell = mp("run_shell", "shell");
  assert.equal(checkPermission(shell, { command: "ls" }, "bypass"), "confirm");
  assert.equal(checkPermission(shell, { command: "rm -rf /" }, "bypass"), "deny");
});

test("allowlistKey：shell 用命令内容，其他按工具名", () => {
  assert.equal(allowlistKey(mp("run_shell", "shell"), { command: "ls -la" }), "shell:ls -la");
  assert.equal(allowlistKey(mp("write_file", "write"), {}), "write_file");
});

test("危险模式表非空且含核心条目（守卫误删）", () => {
  assert.ok(DANGEROUS_PATTERNS.length >= 10);
  const first = DANGEROUS_PATTERNS[0];
  assert.ok(first);
  assert.equal(first.source, "\\brm\\s+-rf\\b");
  assert.ok(DANGEROUS_PATTERNS.some((re) => re.source.includes("sudo")));
});