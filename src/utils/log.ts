import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { basePath } from './paths.js';

/**
 * 调试日志：分级 + 可选落盘，统一走 stderr（stdout 只属于 Agent 的模型文本，
 * 管线、one-shot 输出不被日志污染）。P6 无人值守/CI 排查全靠它复盘。
 *
 * 环境变量：
 *   B_CODE_LOG_LEVEL  debug | info | warn | error（默认 info）
 *   B_CODE_LOG_FILE   非空即开启落盘 → {basePath}/logs/b-code-YYYY-MM-DD.log
 *
 * 用法：入初始化一行 setupLogging()，之后 log.debug/info/warn/error 零配置调用。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const state: { level: LogLevel; fileSink: string } = {
  level: 'info',
  fileSink: '', // 空 = 仅终端
};

/** 幂等：可按 env 重新初始化（测试注入 dir / level） */
export function setupLogging(opts: { dir?: string; level?: LogLevel } = {}): void {
  const fromEnv = (process.env.B_CODE_LOG_LEVEL ?? '').toLowerCase();
  state.level = opts.level ?? (RANK[fromEnv as LogLevel] !== undefined ? (fromEnv as LogLevel) : 'info');

  const fileFlag = process.env.B_CODE_LOG_FILE;
  state.fileSink = '';
  if (fileFlag) {
    const dir = opts.dir ?? join(basePath(), 'logs');
    try {
      mkdirSync(dir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      state.fileSink = join(dir, `b-code-${day}.log`);
    } catch {
      state.fileSink = ''; // 目录不可写则安静降级到纯终端
    }
  }
}

export function setLogLevel(level: LogLevel): void {
  state.level = level;
}

function fmt(extra: unknown): string {
  if (typeof extra === 'string') return extra;
  try {
    return JSON.stringify(extra);
  } catch {
    return String(extra);
  }
}

function emit(level: LogLevel, msg: string, extra?: unknown): void {
  if (RANK[level] < RANK[state.level]) return; // 级别不够直接丢弃，零格式化开销
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}${
    extra === undefined ? '' : ` ${fmt(extra)}`
  }`;
  // 终端输出：info 用浅色，warn/error 用对应颜色，便于区分启动日志与用户直接输出
  const dim = level === 'info' ? '\x1b[2m' : '';
  const reset = level === 'info' ? '\x1b[22m' : '';
  process.stderr.write(dim + line + reset + '\n');
  // 文件输出：不加 ANSI 转义
  if (state.fileSink) {
    try {
      appendFileSync(state.fileSink, line + '\n');
    } catch {
      // 磁盘/权限异常时日志不阻塞主流程
    }
  }
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit('debug', msg, extra),
  info: (msg: string, extra?: unknown) => emit('info', msg, extra),
  warn: (msg: string, extra?: unknown) => emit('warn', msg, extra),
  error: (msg: string, extra?: unknown) => emit('error', msg, extra),
};

/** 当前日志状态：让调用方/测试可见（落盘路径、级别） */
export function logState(): { level: LogLevel; fileSink: string } {
  return { ...state };
}
