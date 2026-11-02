/**
 * 统一重试策略：模型接口与（幂等）工具调用共用同一套退避节奏。
 *
 * 节奏：10s → 20s → 30s → 2min（最多重试 4 次，即首次 + 4 = 最多 5 次尝试）。
 *
 * 边界：
 * - 只重试"可恢复"错误：网络故障、5xx、429、超时、连接重置等；
 *   4xx 客户端错误（参数非法/鉴权失败/上下文超长）重试也不会变好，直接上抛。
 * - 用户中断（AbortError）绝不重试——Esc 是明确意图。
 * - 写操作类工具（write_file/edit_file/run_shell）不自动重试：请求可能已在服务端
 *   生效但响应丢失，重试会造成重复写入/重复执行。是否重试由调用方按"幂等性"决定。
 */

/** 退避节奏（ms）：第 n 次重试前等待 RETRY_DELAYS_MS[n] */
export const RETRY_DELAYS_MS = [10_000, 20_000, 30_000, 120_000] as const;

/** 最大重试次数（不含首次尝试） */
export const MAX_RETRIES = RETRY_DELAYS_MS.length;

/** 可注入的等待实现（测试用：避免真等 3 分钟） */
export type Sleeper = (ms: number, signal?: AbortSignal) => Promise<void>;

/** 默认等待：响应 abort，避免用户中断后还要等完退避 */
export const defaultSleep: Sleeper = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** 是否为用户中断导致的错误（AbortError / signal.reason） */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name;
  return name === 'AbortError';
}

/** HTTP 状态码提取（Anthropic SDK 错误带 status；undici 响应类错误带 status/statusCode） */
function statusOf(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const o = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const v of [o.status, o.statusCode, o.response?.status]) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/** 网络层瞬时错误码：重试往往能恢复 */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

/**
 * 判断错误是否可重试。
 *
 * 判定顺序：中断 → 不重试；有状态码 → 5xx/408/429 可重试，其余 4xx 不重试；
 * 无状态码 → 看错误码/错误名/消息特征（网络类 + 流超时）。
 */
export function isRetryableError(err: unknown): boolean {
  if (isAbortError(err)) return false;
  if (!err || typeof err !== 'object') return false;

  const status = statusOf(err);
  if (status !== null) {
    // 5xx 服务端故障、408 请求超时、409 冲突、429 限流：值得再试
    return status >= 500 || status === 408 || status === 409 || status === 429;
  }

  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && RETRYABLE_CODES.has(code)) return true;

  const name = (err as { name?: string }).name ?? '';
  if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') return true;

  // 无结构化信息的兜底：按消息特征识别网络/超时类（各 SDK 文案不一，宁严勿滥）
  const msg = String((err as { message?: unknown }).message ?? '').toLowerCase();
  return (
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('socket hang up') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('timeout') ||
    msg.includes('temporarily unavailable') ||
    msg.includes('overloaded') ||
    msg.includes('rate limit')
  );
}

export interface RetryOptions {
  /** 最大重试次数（默认 MAX_RETRIES = 4） */
  maxRetries?: number;
  /** 自定义退避节奏（默认 RETRY_DELAYS_MS） */
  delays?: readonly number[];
  /** 注入等待实现（测试用） */
  sleep?: Sleeper;
  signal?: AbortSignal;
  /** 每次重试前回调（用于 UI 提示"将在 Ns 后重试"）；抛错可中止重试 */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/**
 * 通用重试包装：对 fn 执行至多 1 + maxRetries 次。
 *
 * fn 返回结果直接返回；抛出的错误若 isRetryableError 且还有次数 → 退避后重试，
 * 否则原样上抛（含最后一次失败的错误）。
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const delays = opts.delays ?? RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const { signal, onRetry } = opts;

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
    try {
      return await fn(attempt);
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
      if (attempt >= maxRetries || !isRetryableError(err)) throw err;
      // 最后一档节奏用尽后保持该间隔（避免越界 undefined 变成"立即重试"）
      const delayMs = delays[Math.min(attempt, delays.length - 1)]!;
      onRetry?.({ attempt: attempt + 1, delayMs, error: err });
      await sleep(delayMs, signal);
    }
  }
}

/** 人类可读的等待时长（日志/提示用）：120000 → "2min"、30000 → "30s" */
export function formatDelay(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}min`;
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}
