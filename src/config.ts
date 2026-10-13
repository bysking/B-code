import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { basePath } from './utils/paths.js';
import { log } from './utils/log.js';
import type { AllowlistStore } from './permissions.js';

/**
 * 全局配置（对齐 Claude Code 的 ~/.claude/settings.json）：
 *
 *   配置文件：{B_CODE_HOME}/settings.json（B_CODE_CONFIG 可覆盖路径）
 *   字段：
 *     provider  "anthropic" | "openai"        —— 后端选择（缺省按 endpoint 智能判断）
 *     apiKey    对应 provider 的密钥
 *     baseUrl   对应 provider 的端点（anthropic 也会注入 SDK）
 *     model     覆盖默认模型名（等价 B_CODE_MODEL）
 *     env       { KEY: value } 注入环境变量
 *
 *   合并原则：真实环境变量优先，配置只是"缺省值"—— 已 export 的键不会被覆盖。
 */

export const SETTINGS_FILE_ENV = 'B_CODE_CONFIG';

export interface Settings {
  provider?: 'anthropic' | 'openai';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  env?: Record<string, string>;
  /** 权限：持久化白名单（用户确认"记住不再问"的授权键） */
  permissions?: { allow?: string[] };
  /** 生命周期钩子（UserPromptSubmit / PreToolUse / PostToolUse） */
  hooks?: Record<string, { matcher?: string; command: string; timeoutMs?: number }[]>;
}

export function settingsPath(): string {
  return process.env[SETTINGS_FILE_ENV] ?? join(basePath(), 'settings.json');
}

/** 读取配置；文件缺失/损坏 → {}（warn 不阻断启动） */
export function loadSettings(file: string = settingsPath()): Settings {
  if (!existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    return raw && typeof raw === 'object' ? (raw as Settings) : {};
  } catch (err) {
    log.warn(`settings parse failed: ${file}`, (err as Error).message);
    return {};
  }
}

/**
 * 覆盖写入配置文件（重建目录 + 2 空格缩进）。
 * 用于持久化白名单等运行时写入；失败抛错，由调用方决定是否静默（缺省 store 静默）。
 */
export function saveSettings(settings: Settings, file: string = settingsPath()): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

/**
 * settings.json 支撑的持久化白名单存储（PermissionStore 的默认实现）。
 * 读取保留其余配置字段；写入只覆盖 permissions.allow，避免抹掉用户的 provider/apiKey 等。
 */
export function createSettingsAllowlistStore(file: string = settingsPath()): AllowlistStore {
  return {
    load: () => {
      const s: { permissions?: { allow?: unknown } } & Record<string, unknown> = readJsonObject(file);
      const allow = s.permissions?.allow;
      return Array.isArray(allow) ? allow.filter((k): k is string => typeof k === 'string') : [];
    },
    save: (keys) => {
      const s: Record<string, unknown> = readJsonObject(file);
      s.permissions = { ...(s.permissions as object | undefined), allow: keys };
      saveSettings(s as Settings, file);
    },
  };
}

/** 读 settings.json 为原始对象（保留未知字段；缺失/损坏 → {}） */
function readJsonObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 把配置应用进环境（真实 env 优先，缺省才回填） */
export function applySettings(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  settings: Settings = loadSettings(),
): void {
  if (settings.env) {
    for (const [k, v] of Object.entries(settings.env)) {
      if (env[k] === undefined) env[k] = v;
    }
  }
  if (settings.model && env.B_CODE_MODEL === undefined) env.B_CODE_MODEL = settings.model;

  if (settings.apiKey) {
    if (settings.provider === 'anthropic') {
      if (env.ANTHROPIC_API_KEY === undefined) env.ANTHROPIC_API_KEY = settings.apiKey;
    } else if (settings.provider === 'openai') {
      if (env.OPENAI_API_KEY === undefined) env.OPENAI_API_KEY = settings.apiKey;
    } else if (env.OPENAI_API_KEY === undefined && env.ANTHROPIC_API_KEY === undefined) {
      // 未声明 provider：有 baseUrl 视为 OpenAI 兼容端点，否则 Anthropic
      if (settings.baseUrl) env.OPENAI_API_KEY = settings.apiKey;
      else env.ANTHROPIC_API_KEY = settings.apiKey;
    }
  }

  if (settings.baseUrl) {
    if (settings.provider === 'anthropic') {
      if (env.ANTHROPIC_BASE_URL === undefined) env.ANTHROPIC_BASE_URL = settings.baseUrl;
    } else if (env.OPENAI_BASE_URL === undefined) {
      env.OPENAI_BASE_URL = settings.baseUrl;
    }
  }
}

/** 启动创建默认数据目录树（对齐 Claude Code：首跑即有完整约定目录） */
export function ensureDataDirs(base: string = basePath()): void {
  for (const sub of ['sessions', 'logs', 'projects', 'skills', 'plans']) {
    try {
      mkdirSync(join(base, sub), { recursive: true });
    } catch {
      // 不可写时静默（后续写操作各自兜底）
    }
  }
}
