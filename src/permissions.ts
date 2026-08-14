/**
 * 权限系统（施工图 P3 §6 + P5 registry 化）
 *
 * 三态判定：allow（放行）/ deny（拦截）/ confirm（问用户）
 * 原则：
 *   1. deny 优先——危险命令在任何模式（含 --yolo/bypass）下都拦得住
 *   2. fail-closed——未声明 mode 的工具（含未来新增/MCP）默认 confirm，不默认放行
 *   3. plan 只读由权限层强制，不靠提示词"求"模型别动
 *
 * 判定依据 MountPoint.mode（read/write/shell/external），而非硬编码工具名——
 * 这样 MCP/未来工具接入时权限自动正确，注册表是唯一真相源。
 */

import type { MountPoint } from "./registry.js";

export type Permission = "allow" | "deny" | "confirm";
export type Mode = "default" | "plan" | "bypass";

/** 危险命令正则：命中即 deny（连 --yolo 也拦不住） */
export const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/,             // 递归删除
  /\bgit\s+push\b/,           // 推送代码
  /\bgit\s+reset\s+--hard\b/, // 硬重置
  /\bsudo\b/,                  // 提权
  /\bmkfs\b/,                  // 格式化磁盘
  />\s*\/dev\//,              // 写入设备
  /\bdd\s/,                    // 磁盘操作
  /\bkill\b/,                  // 杀进程
  /\breboot\b/,                // 重启
  /\bshutdown\b/,              // 关机
];

export function checkPermission(
  mp: MountPoint,
  input: Record<string, any>,
  mode: Mode,
): Permission {
  // ① deny 优先：shell 工具命中危险命令（任何模式绕不过，含 --yolo）
  if (
    mp.mode === "shell" &&
    DANGEROUS_PATTERNS.some((re) => re.test(String(input.command ?? "")))
  ) {
    return "deny";
  }

  // ② plan 只读契约：非 read 工具全部拦截（allowInPlan 的工具除外，如 write_plan）
  if (mode === "plan" && mp.mode !== "read" && !mp.allowInPlan) {
    return "deny";
  }

  // ③ 只读操作放行
  if (mp.mode === "read") return "allow";

  // ④ fail-closed：write/shell/external/未声明 mode → 需要确认
  return "confirm";
}

/** 会话级白名单键：shell 用命令内容做键（同命令不再问），其他按工具名 */
export function allowlistKey(mp: MountPoint, input: Record<string, any>): string {
  return mp.mode === "shell" ? `shell:${String(input.command ?? "")}` : mp.name;
}