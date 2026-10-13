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

/**
 * 危险命令正则：命中即 deny（连 --yolo 也拦不住）。
 *
 * 误杀防线：`kill`/`dd`/`shutdown` 这类短词必须匹配到**命令边界**——命令串
 * 以它开头，或出现在 `;` `&` `|` 之后（`kill -9 1`、`ls; kill 2`），
 * 否则 `npm run kill-port`、`add`、`dd-utils` 会被误伤。
 * 命令边界见 CMD_START（行首或语句分隔符后的空白）。
 */
const CMD_START = String.raw`(?:^|[;&|]\s*)`;

export const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/, // 递归删除
  /\bgit\s+reset\s+--hard\b/, // 硬重置
  /\bsudo\b/, // 提权
  /\bmkfs\b/, // 格式化磁盘
  />\s*\/dev\//, // 写入设备
  new RegExp(`${CMD_START}dd\\s`), // 磁盘操作：dd 必须是命令名
  new RegExp(`${CMD_START}kill\\b`), // 杀进程：排除 kill-port 之类
  new RegExp(`${CMD_START}reboot\\b`), // 重启
  new RegExp(`${CMD_START}shutdown\\b`), // 关机
];

/**
 * 敏感命令：默认需确认，但**可经用户授权持久化免问**（与 DANGEROUS 的区别）。
 * 例：git push —— 团队协作高频操作，一刀切 deny 会让工具没法用；
 * 改为一律确认，用户确认一次即可写入持久化白名单。
 */
export const SENSITIVE_PATTERNS: RegExp[] = [
  /\bgit\s+push\b/, // 推送代码（会改动远端）
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

  // ④ 敏感命令（如 git push）：一律确认——用户确认后可经持久化白名单免问
  if (mp.mode === 'shell' && SENSITIVE_PATTERNS.some((re) => re.test(String(input.command ?? '')))) {
    return 'confirm';
  }

  // ⑤ fail-closed：write/shell/external/未声明 mode → 需要确认
  return 'confirm';
}

/** 会话级白名单键：shell 用命令内容做键（同命令不再问），其他按工具名 */
export function allowlistKey(mp: MountPoint, input: Record<string, any>): string {
  return mp.mode === 'shell' ? `shell:${String(input.command ?? '')}` : mp.name;
}

// ── 持久化白名单：把"本会话记住"升级为"记住不再问" ──────────────────

/**
 * 持久化白名单存储键：比会话键更**具体**，避免"永久放行整个工具"过宽。
 *   shell   → `shell:<命令>`（同 git push origin main 整串）
 *   文件类  → `<工具名>:<file_path>`（按文件，不按内容——内容每次都会变）
 *   其余    → 工具名
 *
 * 刻意不用 JSON.stringify：对象键顺序会因模型每次下发的参数顺序不同而抖动，
 * 且 undefined 键会被丢掉，导致同一逻辑调用产生不同键、白名单永远不命中。
 */
export function persistedKey(mp: MountPoint, input: Record<string, any>): string {
  if (mp.mode === 'shell') return `shell:${String(input.command ?? '')}`;
  const path = input.file_path;
  return typeof path === 'string' && path ? `${mp.name}:${path}` : mp.name;
}

/** 持久化白名单的读写契约（agent 用 settings.json 实现：{permissions:{allow:[...]}}） */
export interface AllowlistStore {
  load(): string[];
  save(keys: string[]): void;
}

/** 启动时载入持久化白名单到会话集合（失败静默：读不到就当空） */
export function loadAllowlist(store: AllowlistStore, into: Set<string>): void {
  try {
    for (const k of store.load()) into.add(k);
  } catch {
    // 读取失败不阻断启动
  }
}

/** 把某次授权写入持久化白名单（去重后落盘；失败静默，不影响本次放行） */
export function persistAllowlist(store: AllowlistStore, key: string): void {
  try {
    const keys = store.load();
    if (!keys.includes(key)) store.save([...keys, key]);
  } catch {
    // 持久化失败不影响本会话放行
  }
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
  // 敏感命令（如 git push）：跳过分类型器，一律人工确认（auto 模式下也不自动放行）
  const sensitive =
    mp.mode === 'shell' && SENSITIVE_PATTERNS.some((re) => re.test(String(input.command ?? '')));
  // ② Auto Mode：写/编辑/shell 先过分类器（分类器代替人工确认框）
  if (!sensitive && ctx.mode === 'auto' && (mp.mode === 'write' || mp.mode === 'shell')) {
    const verdict = await ctx.classify(mp.name, input);
    return verdict.allow
      ? { allow: true }
      : { allow: false, reason: `Blocked by auto-mode monitor: ${verdict.reason}` };
  }
  // ③ confirm：白名单命中直接放行，否则问用户（bypass 跳过；敏感命令连 bypass 也要问）
  if (permission === 'confirm' && (ctx.mode !== 'bypass' || sensitive)) {
    const key = allowlistKey(mp, input);
    // 会话键（粗粒度）或持久化键（更具体）任一命中即免问
    if (ctx.allowlist.has(key) || ctx.allowlist.has(persistedKey(mp, input))) {
      return { allow: true };
    }
    const label = mp.mode === 'shell' ? String(input.command ?? '') : mp.name;
    const ok = await ctx.askUser(`Allow ${label}? (y/n)`);
    if (ok) return { allow: true, remember: true };
    return { allow: false, reason: `Denied: user rejected ${mp.name}.` };
  }
  // ④ 其余（read / bypass / selfGranted）→ 放行
  return { allow: true };
}
