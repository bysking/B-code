import { spawn } from 'node:child_process';
import type { Settings } from './config.js';
import { log } from './utils/log.js';

/**
 * Hooks —— 在关键生命周期点执行用户自定义命令（对齐 Claude Code 的 hooks 机制）。
 *
 * 支持的事件：
 *   UserPromptSubmit —— 用户提交输入、发给模型之前
 *   PreToolUse       —— 工具执行前（可拦截）
 *   PostToolUse      —— 工具执行后
 *
 * 协议（与 Claude Code 兼容）：
 *   - 事件 JSON 经 **stdin** 传给命令；`hook_event_name` 区分事件
 *   - 环境变量 `B_CODE_HOOK_EVENT` 亦可用
 *   - 退出码 0 = 放行；2 = 拦截（stderr 作为原因回给模型）；其他非零 = 仅告警不拦截
 *   - PreToolUse 的命令可在 stdout 输出一行 JSON `{"decision":"block","reason":"..."}`
 *     来拦截（与退出码 2 等价），便于脚本化
 *
 * 安全与健壮：hook 是用户自己在 settings.json 里配的命令（受信），但仍加超时兜底，
 * 且任何 spawn/超时异常都 fail-open（不阻断主流程）——除了显式的退出码 2 / block 决策。
 */

export type HookEvent = 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse';

export interface HookMatcher {
  /** 工具名匹配正则（仅 PreToolUse/PostToolUse 有意义）；缺省或空 = 匹配全部 */
  matcher?: string;
  /** 要执行的 shell 命令 */
  command: string;
  /** 超时 ms（缺省 60000） */
  timeoutMs?: number;
}

export type HooksConfig = Partial<Record<HookEvent, HookMatcher[]>>;

/** 单次 hook 的调用负载（序列化进 stdin） */
export interface HookPayload {
  hook_event_name: HookEvent;
  cwd: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: string;
  prompt?: string;
}

export interface HookOutcome {
  /** 是否被拦截（PreToolUse） */
  blocked: boolean;
  /** 拦截原因 / 附加上下文（喂回模型或追加到 prompt） */
  reason: string;
  /** 命令 stdout 原文（调用方按需注入） */
  stdout: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** 从 settings 取 hooks 配置（缺省空） */
export function loadHooks(settings: Settings): HooksConfig {
  const h = (settings as { hooks?: unknown }).hooks;
  return h && typeof h === 'object' ? (h as HooksConfig) : {};
}

/** 工具名是否命中该 matcher（正则；空 matcher 全匹配；正则非法时退化为全匹配） */
export function matchesTool(matcher: string | undefined, toolName: string): boolean {
  if (!matcher) return true;
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return true; // 非法正则不静默吞掉 hook，宁可全匹配
  }
}

/** 选中某事件下、匹配该工具名的 hook 列表（PostToolUse 等无 tool 的事件传 undefined） */
export function selectHooks(cfg: HooksConfig, event: HookEvent, toolName?: string): HookMatcher[] {
  const list = cfg[event] ?? [];
  if (toolName === undefined) return list;
  return list.filter((h) => matchesTool(h.matcher, toolName));
}

/** 解析 PreToolUse 的 stdout 决策：`{"decision":"block","reason":...}` */
export function parseHookDecision(stdout: string): { block: boolean; reason: string } {
  const line = stdout
    .split('\n')
    .reverse()
    .find((l) => l.trim().startsWith('{'));
  if (!line) return { block: false, reason: '' };
  try {
    const obj = JSON.parse(line);
    if (obj?.decision === 'block') return { block: true, reason: String(obj.reason ?? 'blocked by hook') };
  } catch {
    // 非 JSON：忽略
  }
  return { block: false, reason: '' };
}

/**
 * 执行单个 hook 命令：stdin 喂 JSON payload，收集 stdout/stderr，按退出码判定。
 * 异常/超时 → fail-open（blocked=false），仅记日志。
 */
export function runHook(hook: HookMatcher, payload: HookPayload): Promise<HookOutcome> {
  return new Promise((resolve) => {
    const timeoutMs = hook.timeoutMs && hook.timeoutMs > 0 ? hook.timeoutMs : DEFAULT_TIMEOUT_MS;
    let child;
    try {
      child = spawn(hook.command, {
        shell: true,
        cwd: payload.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, B_CODE_HOOK_EVENT: payload.hook_event_name },
      });
    } catch (err) {
      log.warn(`hook spawn failed: ${hook.command}`, (err as Error).message);
      return resolve({ blocked: false, reason: '', stdout: '' });
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (outcome: HookOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      log.warn(`hook timed out after ${timeoutMs}ms: ${hook.command}`);
      finish({ blocked: false, reason: '', stdout }); // 超时 fail-open
    }, timeoutMs);
    timer.unref();

    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', (err) => {
      log.warn(`hook error: ${hook.command}`, err.message);
      finish({ blocked: false, reason: '', stdout });
    });
    child.on('close', (code) => {
      // 退出码 2 = 拦截；stdout 决策 JSON 亦可拦截
      const decision = parseHookDecision(stdout);
      if (code === 2) {
        finish({ blocked: true, reason: stderr.trim() || 'blocked by hook', stdout });
      } else if (decision.block) {
        finish({ blocked: true, reason: decision.reason, stdout });
      } else {
        if (code !== 0) log.warn(`hook exited ${code}: ${hook.command}`, stderr.trim());
        finish({ blocked: false, reason: '', stdout });
      }
    });

    // 喂 payload；写失败（命令立即退出）不致命
    try {
      child.stdin?.end(JSON.stringify(payload));
    } catch {
      // ignore
    }
  });
}

/**
 * 依次执行某事件下匹配的 hook 列表：
 * 任一 hook 拦截（PreToolUse）即短路返回；全部放行则汇聚各自 stdout 作为附加上下文。
 */
export async function runHooks(
  cfg: HooksConfig,
  event: HookEvent,
  payload: Omit<HookPayload, 'hook_event_name'>,
  toolName?: string,
): Promise<HookOutcome> {
  const hooks = selectHooks(cfg, event, toolName);
  if (hooks.length === 0) return { blocked: false, reason: '', stdout: '' };

  const outputs: string[] = [];
  for (const hook of hooks) {
    const out = await runHook(hook, { ...payload, hook_event_name: event });
    if (out.blocked) return out; // 短路：已被拦截
    if (out.stdout.trim()) outputs.push(out.stdout.trim());
  }
  return { blocked: false, reason: '', stdout: outputs.join('\n') };
}
