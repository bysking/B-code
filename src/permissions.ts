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

// ── 通配匹配：`*` 折叠同类授权，避免白名单无限累计 ──────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 白名单通配匹配：pattern 中的 `*` 匹配任意字符序列（含空）。无 `*` 时退化为全等。
 * 例：`write_file:/a/b/*` 命中 `write_file:/a/b/c`；`shell:git push *` 命中 `shell:git push origin main`。
 */
export function matchAllowlist(key: string, pattern: string): boolean {
  if (pattern === key) return true;
  if (!pattern.includes('*')) return false;
  return new RegExp('^' + pattern.split('*').map(escapeRegExp).join('.*') + '$').test(key);
}

/** 会话集命中判定：精确键 **或** 任一通配键命中即视为已授权 */
export function allowlistHas(allowlist: Set<string>, key: string): boolean {
  if (allowlist.has(key)) return true;
  for (const p of allowlist) if (matchAllowlist(key, p)) return true;
  return false;
}

/** 折叠点的最小前缀长度：太短的公共前缀（如 `/a`、`git`）折叠过宽，宁可不合并 */
const MIN_MERGE_PREFIX = 4;
/** 折叠边界：前缀须止于路径分隔符或空白，避免 `/a/bc`+`/a/bd` → 过宽的 `/a/b*` */
const MERGE_BOUNDARY = /[/\\\s]/;

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

/** 可折叠判定：公共前缀止于分隔符，且去掉尾部分隔符后仍足够具体 */
function isMergeBoundary(lcp: string): boolean {
  if (lcp.length === 0) return false;
  if (!MERGE_BOUNDARY.test(lcp[lcp.length - 1]!)) return false;
  return lcp.replace(/[/\\\s]+$/, '').length >= MIN_MERGE_PREFIX;
}

/** 同命名空间内的值两两折叠：反复取最长公共前缀合成 `前缀*`，直到无可折叠 */
function mergeValues(values: string[]): string[] {
  const items = [...new Set(values)];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < items.length && !changed; i++) {
      for (let j = i + 1; j < items.length && !changed; j++) {
        const lcp = commonPrefix(items[i]!, items[j]!);
        if (isMergeBoundary(lcp)) {
          items[i] = `${lcp}*`;
          items.splice(j, 1);
          changed = true;
        }
      }
    }
  }
  return items;
}

/**
 * 合并白名单键（去重 + 通配折叠），把 `write_file:/a/b/c` + `write_file:/a/b/d`
 * 收成 `write_file:/a/b/*`，`shell:git push origin main` + `...dev` 收成 `shell:git push origin *`。
 * 折叠仅在**分隔符边界**发生且前缀足够具体——宁可不合并，也不产生过宽的授权。
 * 已存在的显式通配键会吸收被它覆盖的具体键。输出按字典序排序（落盘稳定）。
 */
export function mergeAllowlistKeys(keys: string[]): string[] {
  const groups = new Map<string, string[]>(); // 命名空间（首个 ':' 前）→ 值列表
  const plain: string[] = []; // 无 ':' 的键（整键即工具名）原样保留
  const wildcards: string[] = []; // 已是通配的键原样保留（下方统一做吸收）

  for (const k of new Set(keys)) {
    const i = k.indexOf(':');
    if (i < 0) {
      plain.push(k);
      continue;
    }
    const ns = k.slice(0, i);
    const value = k.slice(i + 1);
    if (value.includes('*')) {
      wildcards.push(k);
      continue;
    }
    const arr = groups.get(ns) ?? [];
    arr.push(value);
    groups.set(ns, arr);
  }

  const out: string[] = [...plain, ...wildcards];
  for (const [ns, values] of groups) {
    for (const v of mergeValues(values)) out.push(`${ns}:${v}`);
  }
  // 通配键吸收被覆盖的具体键
  const kept = out.filter(
    (k) => !out.some((p) => p !== k && p.includes('*') && matchAllowlist(k, p)),
  );
  return [...new Set(kept)].sort();
}

/** 启动时载入持久化白名单到会话集合（顺手折叠历史累计；失败静默：读不到就当空） */
export function loadAllowlist(store: AllowlistStore, into: Set<string>): void {
  try {
    const loaded = store.load();
    const merged = mergeAllowlistKeys(loaded);
    // 折叠出变化 → 回写，清掉历史累积的冗余条目（写回失败不影响本次载入）
    if (JSON.stringify(merged) !== JSON.stringify(loaded)) {
      try {
        store.save(merged);
      } catch {
        // 写回失败静默
      }
    }
    for (const k of merged) into.add(k);
  } catch {
    // 读取失败不阻断启动
  }
}

/** 把某次授权写入持久化白名单（去重 + 通配折叠后落盘；失败静默，不影响本次放行） */
export function persistAllowlist(store: AllowlistStore, key: string): void {
  try {
    const keys = store.load();
    if (keys.includes(key)) return;
    store.save(mergeAllowlistKeys([...keys, key]));
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
    // 会话键（粗粒度）或持久化键（更具体）任一命中即免问；支持通配键折叠（`*`）
    if (allowlistHas(ctx.allowlist, key) || allowlistHas(ctx.allowlist, persistedKey(mp, input))) {
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
