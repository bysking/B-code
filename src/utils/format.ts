/**
 * 单行摘要工具：把任意长度/带换行的文本压成"恰好一行"，供 UI 面板与日志使用。
 *
 * 为什么单独成模块：工具块标签（工具面板）和子 Agent 步骤行（Ctrl+O「子 Agent」页）
 * 是同一件事——都要把参数/结果压成一行短摘要。内核层（subagent.ts）不能 import UI 层
 * （controller.ts），所以放这里共享，避免两套格式化方言各自漂移。
 */

/** 工具块参数展示上限：足够看清路径/命令主体，又不至于自己就折成两行 */
export const INPUT_LABEL_MAX = 60;

/** 截断并保证**单行**（换行会额外占行，是撑高 live 帧的隐形来源） */
export function clip(s: string, max: number): string {
  const oneLine = s.replace(/\s*\n\s*/g, ' ⏎ ').replace(/\s+/g, ' ');
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

/**
 * 压成单行纯文本（所有空白折叠成单个空格）并按上限截断。
 *
 * 与 `clip` 的区别：不保留 `⏎` 换行标记。日志行要的是"一句话说清这一步"，
 * 换行标记在这里只是噪音。
 */
export function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/**
 * 工具块里展示的参数摘要。
 *
 * 不再整段 JSON：早期实现直接 `JSON.stringify(input)` 截 80 字符，结果工具块长这样
 * `⠒ read_file {"file_path":"/very/long/.../file-22.component.tsx"}` —— 一条占 2 行，
 * 一批 30 个工具就是 60 行，直接把 live 帧撑过终端高度 → ink 整屏清屏（ESC[3J
 * 连 scrollback 一起清），用户回看位置丢失。
 *
 * 现在只取最具辨识度的单个参数（file_path / pattern / command / url / name），
 * 且压成一行短摘要：30 个工具也只占 30 行以内，且一眼能看出操作对象。
 * 完整参数与输出仍在 Ctrl+O 面板。
 */
export function prettyInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  // 按辨识度优先级挑一个关键参数展示
  for (const key of ['file_path', 'pattern', 'command', 'url', 'name', 'id']) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return clip(v.trim(), INPUT_LABEL_MAX);
  }
  // 没有白名单参数：退回第一个字符串值，仍受长度约束
  for (const v of Object.values(o)) {
    if (typeof v === 'string' && v.trim()) return clip(v.trim(), INPUT_LABEL_MAX);
  }
  return '';
}
