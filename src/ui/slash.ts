import type { SlashItem } from './controller.js';

/**
 * / 斜杠菜单的过滤与键盘选择逻辑（纯函数，供 SlashMenu 组件与单测共用）。
 * 与 cli 的内置命令保持一致：slash menu 只展示"可执行"的目标。
 */

export const BUILTIN_SLASH_ITEMS: SlashItem[] = [
  { name: 'clear', description: '清空当前对话历史' },
  { name: 'plan', description: '切换 plan（只读）模式' },
  { name: 'yolo', description: '切换 bypass 模式' },
  { name: 'default', description: '切换回默认模式' },
  { name: 'skills', description: '列出可用技能' },
  { name: 'mcp', description: '列出已配置的 MCP server' },
  { name: 'exit', description: '退出 b-code' },
];

/** 输入为 /name 参数 形态时，基础名用于过滤 */
export function slashBaseName(query: string): string {
  return query.replace(/^\//, '').split(/\s+/)[0] ?? '';
}

/** 过滤候选：基础名前缀匹配（不区分大小写） */
export function filterSlash(query: string, items: SlashItem[]): SlashItem[] {
  const base = slashBaseName(query).toLowerCase();
  if (!base) return items;
  return items.filter((it) => it.name.toLowerCase().startsWith(base));
}

/** 选中项的下标（循环越界收敛） */
export function clampIndex(idx: number, length: number): number {
  if (length === 0) return 0;
  return (idx + length) % length;
}

/**
 * Tab 补全产出："/name " —— 恒带 / 前缀；尾空格让光标停在"补全内容之后一格"，
 * 继续输入参数时自然有了分隔（光标位置由 App 用 key 重挂 TextInput 保证落点）。
 */
export function buildSlash(_line: string, itemName: string): string {
  // 恒带 `/` 前缀：补全后输入框文本保持"/name "（幂等：再 Tab 结果不变）
  return `/${itemName} `;
}

/** Esc / 无匹配时给出安全行为 */
export function defaultPick(items: SlashItem[]): SlashItem | null {
  return items[0] ?? null;
}
