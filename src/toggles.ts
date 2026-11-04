import { existsSync, readFileSync } from 'node:fs';
import { saveSettings, settingsPath, type Settings } from './config.js';

/**
 * 能力启停状态（技能 / MCP server）。
 *
 * 存在 settings.json 的 `disabled` 字段——与 `permissions.allow` 同一套做法：
 * 写入时先读原始对象、只改自己的字段，绝不抹掉用户的 provider/apiKey 等配置。
 *
 * 语义（刻意区分）：
 *   - 技能禁用 → 只是不注入 system prompt 的 Available Skills 段；
 *                用户手打 /commit 依然照常执行。
 *   - MCP 禁用  → 只是把该 server 的工具从 toolsSchema 摘掉（不花 token）；
 *                子进程保持存活，重新启用瞬时生效。
 *
 * 即「禁用 = 不主动推给模型」，而非「封死」。
 */

export interface DisabledState {
  skills: string[];
  mcpServers: string[];
}

export const EMPTY_DISABLED: DisabledState = { skills: [], mcpServers: [] };

/** settings.json 里承载本状态的字段名 */
const FIELD = 'disabled';

/** 把任意输入清洗成字符串数组（去空、去重、保序） */
function toStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === 'string' && v.trim() && !out.includes(v)) out.push(v);
  }
  return out;
}

/** 读原始 settings 对象（保留未知字段；缺失/损坏 → {}） */
function readRaw(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  } catch {
    // 坏文件当作空：写回时会重建（宁可丢禁用状态，不能阻断启动）
    return {};
  }
}

/** 读取禁用状态（缺失/损坏 → 空状态） */
export function loadDisabled(file: string = settingsPath()): DisabledState {
  const raw = readRaw(file)[FIELD] as Record<string, unknown> | undefined;
  return {
    skills: toStringList(raw?.skills),
    mcpServers: toStringList(raw?.mcpServers),
  };
}

/**
 * 写入禁用状态：只覆盖 `disabled` 字段，其余配置原样保留。
 * 失败静默——禁用状态不是关键路径，写不进去最多下次启动恢复默认（全启用）。
 */
export function saveDisabled(state: DisabledState, file: string = settingsPath()): void {
  try {
    const raw = readRaw(file);
    raw[FIELD] = {
      skills: toStringList(state.skills),
      mcpServers: toStringList(state.mcpServers),
    };
    saveSettings(raw as Settings, file);
  } catch {
    // 忽略：下次启动回到全启用
  }
}

/** 在列表里切换某个名字的启停，返回新数组（纯函数，便于单测） */
export function toggleInList(list: readonly string[], name: string): string[] {
  return list.includes(name) ? list.filter((n) => n !== name) : [...list, name];
}

export function isSkillDisabled(state: DisabledState, name: string): boolean {
  return state.skills.includes(name);
}

export function isMcpServerDisabled(state: DisabledState, name: string): boolean {
  return state.mcpServers.includes(name);
}

/** 禁用 server → registry 前缀（名字形如 mcp__<server>__<tool>） */
export function mcpDisabledPrefixes(state: DisabledState): string[] {
  return state.mcpServers.map((name) => `mcp__${name}__`);
}
