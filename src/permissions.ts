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

import { homedir } from 'node:os';
import { resolve } from 'node:path';

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
 *
 * 注意 `rm` 不在这张表里——它的破坏力取决于**目标**（`rm -rf dist` 是日常清理，
 * `rm -rf /` 是灾难），一刀切 deny 会让模型永远清不掉构建产物（本仓库刻意不提供
 * delete_file，删除只能走 shell）。分级逻辑见 checkRm / rmTargets /
 * isCatastrophicTarget，判定出口仍在 checkPermission。
 */
const CMD_START = String.raw`(?:^|[;&|]\s*)`;

export const DANGEROUS_PATTERNS: RegExp[] = [
  // 下列三条同样要求命令位：`echo "git reset --hard"`、`git commit -m "add sudo docs"`
  // 只是**提到**危险词，不该 deny；真正要执行时它必然落在命令位上。
  new RegExp(`${CMD_START}git\\s+reset\\s+--hard\\b`), // 硬重置
  new RegExp(`${CMD_START}sudo\\b`), // 提权
  new RegExp(`${CMD_START}mkfs\\b`), // 格式化磁盘
  new RegExp(`${CMD_START}dd\\s`), // 磁盘操作：dd 必须是命令名
  new RegExp(`${CMD_START}kill\\b`), // 杀进程：排除 kill-port 之类
  new RegExp(`${CMD_START}reboot\\b`), // 重启
  new RegExp(`${CMD_START}shutdown\\b`), // 关机
];

/**
 * 写设备节点：必须**排除** /dev/null、/dev/stdout 这类安全重定向——
 * 原先写成 `> /dev/` 会把最常见的降噪习惯（`ls 2>/dev/null`）全部误杀。
 * 单独成一条而不并入 DANGEROUS_PATTERNS：这一条跑在**原文**上（不走引号剥离），
 * 否则 `> "/dev/sda"` 去掉引号后就能逃逸。
 */
const DEVICE_WRITE_RE =
  />\s*["']?\/dev\/(?!(?:null|zero|stdout|stderr|stdin|tty|random|urandom|fd)(?:[\s;&|]|$|\/|["']))/;

// ── rm 分级：按「目标」决定 deny 还是 confirm ────────────────────────
//
// 三条现实约束促成这套分级：
//   ① 没有 delete_file，清理产物只能走 shell —— 无条件 deny 等于砍掉一种能力
//   ② 只匹配字面 `rm -rf` 拦不住变体（-fr / -r -f / -Rf / --recursive --force），
//      既漏又严，反而引导模型去写绕过写法
//   ③ 目标才是破坏力的来源：`dist` 与 `/` 不该同一档

/**
 * 「递归 + 强制」的**存在性**检测：任意位置、任意选项顺序与组合。
 * 只负责"这里有个 rm 强删"，目标分级交给 rmTargets。
 * 之所以要扫任意位置：`bash -c "rm -rf /"` 这种嵌套写法里 rm 不在命令位。
 */
export const RM_RECURSIVE_FORCE_RE = new RegExp(
  String.raw`\brm\s+(?:-[a-zA-Z]*(?:[rR][a-zA-Z]*f|f[a-zA-Z]*[rR])[a-zA-Z]*\b|-[rR]\s+-f\b|-f\s+-[rR]\b|--(?:recursive|force)\b[\s\S]*--(?:recursive|force)\b)`,
);

/**
 * 提取所有**命令位** rm 的操作对象。
 * 命令位 = 行首 / `;` `&` `|` 之后，允许 `sudo` 前缀——`echo "rm -rf x"` 不算。
 * 提取不到目标（嵌套 shell、字符串壳）时返回空数组，由调用方按最坏情况处理。
 */
export function rmTargets(cmd: string): string[] {
  const out: string[] = [];
  for (const seg of cmd.split(/[;&|]/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    const i = toks[0] === 'sudo' ? 1 : 0;
    if (toks[i] !== 'rm') continue;
    let seenSeparator = false; // 遇到 `--` 之后全是操作对象
    for (const t of toks.slice(i + 1)) {
      if (!seenSeparator && t.startsWith('-')) {
        if (t === '--') seenSeparator = true;
        continue;
      }
      out.push(t);
    }
  }
  return out;
}

/**
 * 灾难级目标：删掉就回不来的那几类。
 *   根 / 家目录 / 工作目录本身 / 通配全部 / 顶层目录（/usr、/etc、/Users）
 *   以及**无法静态判定**的目标（变量、命令替换、空）——判定不了就按最坏算。
 */
export function isCatastrophicTarget(t: string): boolean {
  if (!t || t === '""' || t === "''") return true; // 目标被引号挖空 = 内容不可判定
  if (/[$`]/.test(t)) return true; // $HOME、$(...) 之类的展开
  if (t === '*' || t === '/*' || t === './*' || t === '../*') return true; // 通配全部
  const norm = t.replace(/\/+$/, '') || '/';
  if (norm === '/') return true;
  if (norm === '..') return true; // 删上级目录：项目外的不可控范围
  if (norm === '~' || norm === homedir()) return true;
  // 解析成绝对路径后再比：`rm -rf .`、`rm -rf ./`、`rm -rf /repo`（= 工作目录本身）
  // 字面比对会漏掉这些等价写法
  let abs: string;
  try {
    abs = resolve(norm.replace(/^~(?=\/)/, homedir()));
  } catch {
    return true; // 解析失败按最坏算
  }
  if (abs === '/') return true;
  if (abs === resolve(homedir())) return true;
  if (abs === resolve(process.cwd())) return true; // 删掉整个工作目录
  // 删掉工作目录的祖先（`rm -rf ..`、`rm -rf ../..`）—— 范围超出项目，同样不可控
  if (resolve(process.cwd()).startsWith(abs + '/')) return true;
  // 绝对路径且只有一段：/usr、/etc、/Users —— 顶层目录
  if (abs.startsWith('/') && abs.split('/').filter(Boolean).length <= 1) return true;
  return false;
}

/**
 * 嵌套 shell / 求值器：这些上下文里的引号内容**是要执行的**，不能当字面量剥离。
 * 命中则跳过 stripQuotedLiteral，保持原有的严格判定（避免 `bash -c "sudo x"` 逃逸）。
 */
const NESTED_SHELL = /\b(?:eval|sh|bash|zsh|dash|ksh|fish|node|deno|bun|python[23]?|perl|ruby)\b/;

/**
 * 引号剥离：把死字面量挖空，避免 `git commit -m "git reset --hard"` 这类
 * "只是提到危险词"的命令被误杀（`;` `|` 等分隔符在引号内也不该切断词）。
 * 遇到嵌套 shell 时不剥离——那里的引号内容会被真正执行。
 * 设备重定向不经过这个函数：`> "/dev/sda"` 去掉引号后仍会被 DANGEROUS 命中。
 */
export function stripQuotedLiteral(cmd: string): string {
  // 嵌套 shell：引号内容会被真正执行，把它**提到命令位**再判——
  // 否则 `bash -c "sudo rm -x"` 里的 sudo 前面是引号而非分隔符，
  // 命令边界规则就漏了它（引号剥离则会走向另一个极端：整个挖空，同样漏判）。
  if (NESTED_SHELL.test(cmd)) {
    return cmd.replace(/["']([^"']*)["']/g, '; $1');
  }
  return cmd.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/**
 * 敏感命令：默认需确认，但**可经用户授权持久化免问**（与 DANGEROUS 的区别）。
 * 例：git push —— 团队协作高频操作，一刀切 deny 会让工具没法用；
 * 改为一律确认，用户确认一次即可写入持久化白名单。
 */
export const SENSITIVE_PATTERNS: RegExp[] = [
  /\bgit\s+push\b/, // 推送代码（会改动远端）
];

/**
 * rm 分级判定：灾难目标 deny / 其余 confirm；非 rm 强删返回 null（交给后续规则）。
 *
 * 两个入参刻意不同：
 *   presence 用**剥离字面量**后的串 —— 否则 `git log --grep "rm -rf"` 会被当成真删；
 *   targets 用**原文** —— 目标提取要看到引号（`rm -rf "$DIR"` 的 `$` 是灾难信号）。
 * 两者不一致时（如 `bash -c "rm -rf /"`：剥离版有 rm、原文提不出目标）按最坏算 deny。
 */
export function checkRm(presence: string, raw: string): Permission | null {
  if (!RM_RECURSIVE_FORCE_RE.test(presence)) return null;
  const targets = rmTargets(raw);
  // 提取不到目标（嵌套 shell / 引号壳）按最坏情况处理——宁可 deny 不可放过
  if (targets.length === 0) return 'deny';
  return targets.some(isCatastrophicTarget) ? 'deny' : 'confirm';
}

export function checkPermission(mp: MountPoint, input: Record<string, any>, mode: Mode): Permission {
  // ① 自授权工具放行（如 ask_user：它是"与用户对话"，不该再触发一次权限确认）
  if (mp.selfGranted) return 'allow';

  if (mp.mode === 'shell') {
    const raw = String(input.command ?? '');
    const bare = stripQuotedLiteral(raw); // 死字面量挖空，救回「只是提到危险词」
    // ② deny 优先：危险命令（任何模式绕不过，含 --yolo）
    //    git/sudo/mkfs 看 bare；设备重定向看 raw（引号挡不住 DEVICE_WRITE_RE，见其定义）
    if (DANGEROUS_PATTERNS.some((re) => re.test(bare)) || DEVICE_WRITE_RE.test(raw)) {
      return 'deny';
    }
    // ②' rm 分级：灾难目标 deny（硬拦），其余落到后面的 confirm 流程（可授权免问）
    if (checkRm(bare, raw) === 'deny') return 'deny';
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

/**
 * 命令归一化：折叠空白（含换行/制表符）为单空格并去首尾空白。
 *
 * 为什么要在做键之前归一化：模型下发的同一条命令，格式会抖动——
 * 多行 inline 脚本、` && ` 换行缩进等，都会让"同一逻辑调用"产生不同键，
 * 于是白名单永远不命中、每次都新增一条近似重复项。归一化后两侧（写键 / 查键）
 * 走同一函数，键才稳定可比。
 */
export function normalizeCommand(cmd: string): string {
  return cmd.replace(/\s+/g, ' ').trim();
}

/** 会话级白名单键：shell 用归一化后的命令内容做键（同命令不再问），其他按工具名 */
export function allowlistKey(mp: MountPoint, input: Record<string, any>): string {
  return mp.mode === 'shell' ? `shell:${normalizeCommand(String(input.command ?? ''))}` : mp.name;
}

// ── 持久化准入规则：什么样的授权才值得"记住不再问" ──────────────────
//
// 科学原则：持久化白名单应沉淀**可复用的能力类**，而不是**一次性的具体调用**。
// 据此设四条准入规则（不满足即只在本会话记住、不落盘）：
//   ① 单条长度上限 —— 超长命令几乎必然是一次性 inline 脚本，还可能撑爆配置文件
//   ② 一次性命令特征 —— inline 脚本 / heredoc / 命令替换：内容每次都不同，落盘永不失配
//   ③ 归一化 —— 见 normalizeCommand，避免格式差异制造近似重复
//   ④ 容量上限 —— 条目数封顶，超出按落盘序淘汰最旧，保证文件有界

/** 单条白名单键最大长度：超长命令多为一次性 inline 脚本，持久化无意义且撑爆配置 */
export const MAX_ALLOW_KEY_LENGTH = 200;
/** 白名单条目上限：超出按落盘顺序淘汰最旧，避免无限累计 */
export const MAX_ALLOWLIST_SIZE = 100;

/**
 * 一次性命令特征：inline 求值、heredoc、命令替换。
 * 这类命令"每次执行内容都不同"，做成白名单条目既不可复用又常常携带大段脚本体。
 */
const EPHEMERAL_PATTERNS: RegExp[] = [
  /\b(?:node|deno|bun)\s+(?:-e|--eval)\b/, // node -e '...'
  /\b(?:python[23]?|ruby|perl|php)\s+-[ec]\b/, // python -c '...'
  /<<-?\s*['"]?\w+/, // heredoc：cat <<EOF
  /\$\(/, // 命令替换 $(...)
  /`/, // 反引号替换
];

/** 是否为一次性命令（inline 脚本 / heredoc / 命令替换） */
export function isEphemeralCommand(cmd: string): boolean {
  return EPHEMERAL_PATTERNS.some((re) => re.test(cmd));
}

/**
 * 该白名单键是否值得持久化（准入规则①②；长度按归一化后计算）。
 *   shell:<命令> → 长度合规且非一次性命令才落盘
 *   <工具名>     → 仅长度合规（工具名区分度已足够，如 write_file:<path>）
 */
export function isPersistableKey(key: string): boolean {
  const i = key.indexOf(':');
  if (i < 0) return key.length <= MAX_ALLOW_KEY_LENGTH && key.length > 0; // 无 ':' = 整键即工具名
  const ns = key.slice(0, i);
  const value = ns === 'shell' ? normalizeCommand(key.slice(i + 1)) : key.slice(i + 1);
  if (value.length === 0) return false; // 空值（如缺 command）无授权意义
  if (ns === 'shell' && isEphemeralCommand(value)) return false;
  return ns.length + 1 + value.length <= MAX_ALLOW_KEY_LENGTH;
}

// ── 持久化白名单：把"本会话记住"升级为"记住不再问" ──────────────────

/**
 * MCP 工具名 → server 级通配键。
 *
 * 名字形如 `mcp__<server>__<tool>`，确认一次折叠成 `mcp__<server>__*`，
 * 于是"我信任这个 server"只需表达一次，而不是每个 tool 各确认一遍。
 *
 * 为什么 MCP 按 server 粒度而文件类按路径粒度：MCP 的一个 server 就是**一个整体能力**
 * （"github 集成"），它的 tool 列表会随 server 版本变化；按 tool 记白名单意味着
 * server 升级后用户又要重新确认一堆新 tool。而文件写入的风险按**路径**区分才有意义
 * （写 /tmp 与写 /etc 完全两码事）。
 *
 * @returns 通配键；非 MCP 工具返回 null（由调用方走原有规则）
 */
export function mcpServerKey(name: string): string | null {
  const m = /^mcp__(.+?)__/.exec(name);
  return m ? `mcp__${m[1]}__*` : null;
}

/**
 * 持久化白名单存储键：比会话键更**具体**，避免"永久放行整个工具"过宽。
 *   shell   → `shell:<命令>`（同 git push origin main 整串）
 *   MCP     → `mcp__<server>__*`（按 server，见 mcpServerKey）
 *   文件类  → `<工具名>:<file_path>`（按文件，不按内容——内容每次都会变）
 *   其余    → 工具名
 *
 * 刻意不用 JSON.stringify：对象键顺序会因模型每次下发的参数顺序不同而抖动，
 * 且 undefined 键会被丢掉，导致同一逻辑调用产生不同键、白名单永远不命中。
 * shell 命令先归一化空白（见 normalizeCommand），消除多行格式抖动。
 */
export function persistedKey(mp: MountPoint, input: Record<string, any>): string {
  if (mp.mode === 'shell') return `shell:${normalizeCommand(String(input.command ?? ''))}`;
  // MCP：一次确认 = 授权整个 server（否则 server 升级加个 tool 就又要确认）
  const serverKey = mp.kind === 'mcp' ? mcpServerKey(mp.name) : null;
  if (serverKey) return serverKey;
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
 * 合并白名单键（归一化 + 去噪 + 去重 + 通配折叠 + 容量封顶），把
 * `write_file:/a/b/c` + `write_file:/a/b/d` 收成 `write_file:/a/b/*`，
 * `shell:git push origin main` + `...dev` 收成 `shell:git push origin *`。
 * 折叠仅在**分隔符边界**发生且前缀足够具体——宁可不合并，也不产生过宽的授权。
 * 已存在的显式通配键会吸收被它覆盖的具体键。输出按字典序排序（落盘稳定）。
 *
 * 同时承担"清洗历史垃圾"职责（loadAllowlist 复用它）：
 *   - shell 值先归一化空白，消除多行格式抖动制造的同义重复键
 *   - 丢弃不可持久化的键（超长 / 一次性命令，见 isPersistableKey）
 *   - 超过 MAX_ALLOWLIST_SIZE 时截断到上限（去噪后几乎不会触发，纯防爆）
 */
export function mergeAllowlistKeys(keys: string[]): string[] {
  const groups = new Map<string, string[]>(); // 命名空间（首个 ':' 前）→ 值列表
  const plain: string[] = []; // 无 ':' 的键（整键即工具名）原样保留
  const wildcards: string[] = []; // 已是通配的键原样保留（下方统一做吸收）

  for (const raw of new Set(keys)) {
    const i = raw.indexOf(':');
    if (i < 0) {
      if (isPersistableKey(raw)) plain.push(raw);
      continue;
    }
    const ns = raw.slice(0, i);
    const value = ns === 'shell' ? normalizeCommand(raw.slice(i + 1)) : raw.slice(i + 1);
    const k = `${ns}:${value}`;
    if (!isPersistableKey(k)) continue; // 去噪：超长 / 一次性命令不入白名单
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
  const kept = out.filter((k) => !out.some((p) => p !== k && p.includes('*') && matchAllowlist(k, p)));
  // 容量封顶：排序后取前 N，结果确定（去噪 + 折叠后正常远低于上限，纯防爆）
  return [...new Set(kept)].sort().slice(0, MAX_ALLOWLIST_SIZE);
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

/**
 * 把某次授权写入持久化白名单（准入过滤 + 去重 + 通配折叠后落盘；失败静默）。
 * 不可持久化的键（超长 / 一次性命令）直接跳过——仍可经会话白名单本次免问，
 * 但不落盘，避免配置文件被一次性 inline 脚本撑爆。
 * @returns 是否真的落盘（false = 该键不值得/不允许持久化）
 */
export function persistAllowlist(store: AllowlistStore, key: string): boolean {
  if (!isPersistableKey(key)) return false;
  try {
    const keys = store.load();
    if (keys.includes(key)) return true;
    store.save(mergeAllowlistKeys([...keys, key]));
    return true;
  } catch {
    // 持久化失败不影响本会话放行
    return false;
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
