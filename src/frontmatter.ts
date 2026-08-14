/**
 * YAML frontmatter 解析：记忆文件与技能文件共用同一格式。
 *
 * ---
 * key: value
 * ---
 * 正文...
 *
 * 故意保持极简（不支持嵌套/列表/引号）——给 LLM 写的文件不需要完整 YAML。
 */

export interface Frontmatter {
  meta: Record<string, string>;
  body: string;
}

export function parseFrontmatter(content: string): Frontmatter {
  const lines = content.split("\n");

  if (lines[0]?.trim() !== "---") return { meta: {}, body: content };

  // 找结尾的 ---
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return { meta: {}, body: content };

  // 解析 key: value 对（value 去掉首尾引号）
  const meta: Record<string, string> = {};
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i];
    if (!line) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key) meta[key] = value;
  }

  const body = lines.slice(endIdx + 1).join("\n").trim();
  return { meta, body };
}

/** 构建 frontmatter 块（保存记忆/技能共用） */
export function formatFrontmatter(meta: Record<string, string>, body: string): string {
  const head = Object.entries(meta)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${head}\n---\n\n${body.trim()}\n`;
}