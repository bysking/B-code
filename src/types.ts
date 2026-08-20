import type { MountPoint } from './registry.js';
import type { Permission, Mode } from './permissions.js';

/**
 * types.ts —— 契约层（施工图 P7）
 *
 * 六大策略接口 + 公共类型的唯一出处。依赖规则：实现模块可以 import 这里，
 * 这里只 import 类型（全部 type-only，运行时零依赖，无循环）。
 *
 * 扩展新能力时先看这里有没有对应接口——有则实现它，没有则在此定义。
 */

// ── 模型后端 ──────────────────────────────────────────────────
export type { ModelInput, ModelOutput, ModelBackend } from './backend.js';

// ── 工具/能力挂载 ─────────────────────────────────────────────
export type { MountPoint, RuntimeContext, ToolMode } from './registry.js';

// ── 权限 ──────────────────────────────────────────────────────
export type { Permission, Mode } from './permissions.js';

/** 权限策略：同一职责多实现（规则表 / 白名单 / AI 分类器）的替换点 */
export interface PermissionPolicy {
  check(mp: MountPoint, input: Record<string, any>, mode: Mode): Permission;
}

// ── 上下文管理 ────────────────────────────────────────────────
export type { SystemBlock, DynamicSections } from './prompt.js';

/** 上下文策略：控制"消息能占多大、塞不下怎么办" */
export interface ContextPolicy {
  /** Tier 0：单次工具结果截断 */
  truncate(result: string): string;
}

// ── 记忆 ──────────────────────────────────────────────────────
/** 记忆策略：跨会话存储与召回（文件 / 未来向量库 / 数据库） */
export interface Memory {
  save(name: string, description: string, type: string, content: string, cwd?: string): string;
  recall(query: string, limit?: number, cwd?: string): string;
  dir(cwd?: string): string;
}

// ── 技能 ──────────────────────────────────────────────────────
export type { SkillInfo } from './skills.js';

// ── 自治 ──────────────────────────────────────────────────────
export type { GoalVerdict, ActionVerdict } from './autonomy.js';

// ── UI ────────────────────────────────────────────────────────
export type { SpinnerLike } from './ui.js';
