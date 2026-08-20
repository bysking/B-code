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

import type { MountPoint } from './registry.js';
import type { PermissionPolicy } from './types.js';

export type Permission = 'allow' | 'deny' | 'confirm';
export type Mode = 'default' | 'plan' | 'bypass' | 'auto';

/** 规则表实现（P7 策略化）：危险命令 + plan 只读 + read 放行 + fail-closed */
export const rulePermission: PermissionPolicy = {
  check: checkPermission,
};

/** 危险命令正则：命中即 deny（连 --yolo 也拦不住） */
export const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/, // 递归删除
  /\bgit\s+push\b/, // 推送代码
  /\bgit\s+reset\s+--hard\b/, // 硬重置
  /\bsudo\b/, // 提权
  /\bmkfs\b/, // 格式化磁盘
  />\s*\/dev\//, // 写入设备
  /\bdd\s/, // 磁盘操作
  /\bkill\b/, // 杀进程
  /\breboot\b/, // 重启
  /\bshutdown\b/, // 关机
];

export function checkPermission(mp: MountPoint, input: Record<string, any>, mode: Mode): Permission {
  // ① 自授权工具放行（如 ask_user：它是"与用户对话"，不该再触发一次权限确认）
  if (mp.selfGranted) return 'allow';

  // ② deny 优先：shell 工具命中危险命令（任何模式绕不过，含 --yolo）
  if (mp.mode === 'shell' && DANGEROUS_PATTERNS.some((re) => re.test(String(input.command ?? '')))) {
    return 'deny';
  }

  // ② plan 只读契约：非 read 工具全部拦截（allowInPlan 的工具除外，如 write_plan）
  if (mode === 'plan' && mp.mode !== 'read' && !mp.allowInPlan) {
    return 'deny';
  }

  // ③ 只读操作放行
  if (mp.mode === 'read') return 'allow';

  // ④ fail-closed：write/shell/external/未声明 mode → 需要确认
  return 'confirm';
}

/** 会话级白名单键：shell 用命令内容做键（同命令不再问），其他按工具名 */
export function allowlistKey(mp: MountPoint, input: Record<string, any>): string {
  return mp.mode === 'shell' ? `shell:${String(input.command ?? '')}` : mp.name;
}

// ── 放行决策（P7 策略化的落地：agent.chat 里的权限分支收拢到此）────────

import type { ActionVerdict } from './autonomy.js';

/** 工具执行放行决策结果 */
export interface ExecDecision {
  allow: boolean;
  /** 拦截原因（喂回模型）；allow=true 时为空 */
  reason?: string;
  /** 确认通过后需要记入会话白名单（下同不再问） */
  remember?: boolean;
}

/** 决策所需的运行时依赖（由 agent 注入，保持 permissions 层可单测） */
export interface ExecutionContext {
  mode: Mode;
  allowlist: Set<string>;
  /** Auto Mode 分类器（write/shell 放行决策） */
  classify(name: string, input: Record<string, any>): Promise<ActionVerdict>;
  /** 权限确认框（confirm 路径） */
  askUser(question: string): Promise<boolean>;
}

/**
 * 工具执行前的完整裁决链（顺序与 7 层检查一致）：
 *   deny 优先（任何模式绕不过）→ auto 分类器 → 白名单/确认框（bypass 跳过）→ 放行。
 * 判定依据 MountPoint.mode + 调用方注入的运行时（分类器/确认框），
 * 使 agent.chat 的工具循环只依赖这一个入口。
 */
export async function decideExecution(
  mp: MountPoint,
  input: Record<string, any>,
  ctx: ExecutionContext,
): Promise<ExecDecision> {
  const permission = checkPermission(mp, input, ctx.mode);

  // ① deny 优先：危险命令任何模式都拦得住（含 --yolo）
  if (permission === 'deny') {
    return { allow: false, reason: `Denied: ${mp.name} was blocked by the permission system.` };
  }
  // ② Auto Mode：写/编辑/shell 先过分类器（分类器代替人工确认框）
  if (ctx.mode === 'auto' && (mp.mode === 'write' || mp.mode === 'shell')) {
    const verdict = await ctx.classify(mp.name, input);
    return verdict.allow
      ? { allow: true }
      : { allow: false, reason: `Blocked by auto-mode monitor: ${verdict.reason}` };
  }
  // ③ confirm：白名单命中直接放行，否则问用户（bypass 跳过）
  if (permission === 'confirm' && ctx.mode !== 'bypass') {
    const key = allowlistKey(mp, input);
    if (ctx.allowlist.has(key)) return { allow: true };
    const label = mp.mode === 'shell' ? String(input.command ?? '') : mp.name;
    const ok = await ctx.askUser(`Allow ${label}? (y/n)`);
    if (ok) return { allow: true, remember: true };
    return { allow: false, reason: `Denied: user rejected ${mp.name}.` };
  }
  // ④ 其余（read / bypass / selfGranted）→ 放行
  return { allow: true };
}
