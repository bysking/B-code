import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';

/**
 * 会话导出。
 *
 * ## 背景
 *
 * TTY 下 UI 渲染在**备用屏**（alternate screen）里，退出即销毁——用户回到 shell
 * 后对话历史一点不剩。`--resume` 能恢复会话，但那是"重新进入应用"，
 * 想留存/分享/搜索时不好用。
 *
 * 所以提供两条"把内容带走"的路：
 *   1. `/export [路径]` —— 写 markdown 文件（可搜索、可分享、可归档）
 *   2. 退出时补打最后 N 轮 —— 直接在终端里留下痕迹
 *
 * ## 为什么导出 markdown
 *
 * 对话天然是"用户问 + 助手答（含代码块/列表/公式）"，markdown 是最贴合的格式：
 * 终端工具熟、编辑器/笔记软件都能读、diff 友好。
 */

/** 一轮对话：用户提问 + 助手回答（含工具调用记录） */
export interface ExportTurn {
  role: 'user' | 'assistant';
  text: string;
  /** 助手轮里的工具调用名（只记名字，不记参数——参数动辄几百行） */
  tools: string[];
  /** 用户消息里的图片数量 */
  images: number;
}

/** 从消息数组提取"可导出"的对话轮次 */
export function collectTurns(messages: MessageParam[]): ExportTurn[] {
  const out: ExportTurn[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      // string 型 user 内容 = 用户真实提问；块数组多为 tool_result 回灌，跳过
      if (typeof m.content === 'string') {
        out.push({ role: 'user', text: m.content, tools: [], images: 0 });
        continue;
      }
      // 块数组里可能含 text + image（用户粘贴图片的场景）
      const texts: string[] = [];
      let images = 0;
      for (const b of m.content) {
        if (typeof b === 'string') continue; // 类型上 content 可能是 string | Block 的联合
        if (b.type === 'text') texts.push(b.text);
        else if (b.type === 'image') images++;
      }
      if (texts.length > 0 || images > 0) {
        out.push({ role: 'user', text: texts.join('\n'), tools: [], images });
      }
      continue;
    }
    // assistant
    const texts: string[] = [];
    const tools: string[] = [];
    for (const b of m.content) {
      if (typeof b === 'string') continue;
      if (b.type === 'text') texts.push(b.text);
      else if (b.type === 'tool_use') tools.push(b.name);
    }
    if (texts.length > 0 || tools.length > 0) {
      out.push({ role: 'assistant', text: texts.join('\n'), tools, images: 0 });
    }
  }
  return out;
}

/**
 * 渲染为 markdown。
 *
 * @param turns  要导出的轮次
 * @param meta   会话元信息（id / 时间 / 模型），写在文件头便于归档检索
 */
export function renderMarkdown(
  turns: ExportTurn[],
  meta: { sessionId: string; model?: string; exportedAt?: Date },
): string {
  const at = meta.exportedAt ?? new Date();
  const lines: string[] = [
    '# B Code 会话导出',
    '',
    `- 会话 ID: \`${meta.sessionId}\``,
    ...(meta.model ? [`- 模型: \`${meta.model}\``] : []),
    `- 导出时间: ${at.toISOString().replace('T', ' ').slice(0, 19)}`,
    `- 轮次: ${turns.filter((t) => t.role === 'user').length} 问`,
    '',
    '---',
    '',
  ];

  for (const t of turns) {
    if (t.role === 'user') {
      lines.push('## 👤 User', '');
      if (t.text.trim()) lines.push(t.text.trim(), '');
      if (t.images > 0) lines.push(`*（含 ${t.images} 张图片，未包含在导出中）*`, '');
    } else {
      lines.push('## 🤖 B Code', '');
      if (t.tools.length > 0) {
        lines.push(`> 🔧 调用工具: ${t.tools.join(', ')}`, '');
      }
      if (t.text.trim()) lines.push(t.text.trim(), '');
    }
  }

  return lines.join('\n');
}

/**
 * 渲染为终端纯文本（退出时补打用）。
 *
 * 与 markdown 导出的区别：
 *   - 不带 # 标题等 markdown 标记（终端里看是噪音）
 *   - 助手回复里的 markdown **原样保留**——终端里本来就看惯了这个
 *   - 轮次之间有分隔线，扫读时不易混淆
 *
 * @param maxRounds 最多保留几轮（从最新往前取）
 */
export function renderForTerminal(turns: ExportTurn[], maxRounds = 3): string {
  const userIdx = turns.map((t, i) => (t.role === 'user' ? i : -1)).filter((i) => i >= 0);
  if (userIdx.length === 0) return '';
  const begin = userIdx[Math.max(0, userIdx.length - maxRounds)] ?? 0;
  const picked = turns.slice(begin);

  const parts: string[] = [];
  for (const t of picked) {
    if (t.role === 'user') {
      if (parts.length > 0) parts.push('─'.repeat(60));
      parts.push(`👤 ${t.text.trim()}`);
      if (t.images > 0) parts.push(`（含 ${t.images} 张图片）`);
    } else {
      parts.push('', `🤖 ${t.text.trim()}`);
      if (t.tools.length > 0) parts.push(`   [工具: ${t.tools.join(', ')}]`);
    }
  }
  return parts.join('\n');
}

/** 导出到指定/默认路径。返回实际写入的绝对路径。 */
export function defaultExportPath(sessionId: string, cwd = process.cwd()): string {
  return `${cwd}/bcode-${sessionId}.md`;
}
