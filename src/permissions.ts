/**
 * 权限系统（施工图 P3 §6）
 *
 * 三态判定：allow（放行）/ deny（拦截）/ confirm（问用户）
 * 原则：
 *   1. deny 优先——危险命令在任何模式（含 --yolo/bypass）下都拦得住
 *   2. fail-closed——没声明类型的工具（含未来新增/MCP）默认 confirm，不默认放行
 *   3. plan 只读由权限层强制，不靠提示词"求"模型别动
 *
 * 判定顺序与源码文档 §6.2 一致：
 *   危险命令 → plan 写/shell → 只读放行 → 其余 confirm
 */

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

const READ_TOOLS = new Set(["read_file", "list_files", "grep_search"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

export function checkPermission(
  name: string,
  input: Record<string, any>,
  mode: Mode,
): Permission {
  // ① deny 优先：危险命令
  if (
    name === "run_shell" &&
    DANGEROUS_PATTERNS.some((re) => re.test(String(input.command ?? "")))
  ) {
    return "deny";
  }

  // ② plan 只读契约：写/编辑/跑 shell 全部拦截
  if (mode === "plan" && (WRITE_TOOLS.has(name) || name === "run_shell")) {
    return "deny";
  }

  // ③ 只读操作放行
  if (READ_TOOLS.has(name)) return "allow";

  // ④ fail-closed：写/编辑/run_shell/未知工具 → 需要确认
  return "confirm";
}

/** 会话级白名单键：shell 用命令内容做键（同命令不再问），其他按工具名 */
export function allowlistKey(name: string, input: Record<string, any>): string {
  return name === "run_shell" ? `shell:${String(input.command ?? "")}` : name;
}