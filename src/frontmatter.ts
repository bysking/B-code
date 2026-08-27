/**
 * YAML frontmatter 解析：记忆文件与技能文件共用同一格式。
 *
 * ---
 * key: value
 * ---
 * 正文...
 *
 * 故意保持极简（不支持嵌套/列表/引号）——给 LLM 写的文件不需要完整 YAML。
 * 但支持块标量多行值（> / >- / | / |-）：Claude 生态的 SKILL.md 描述常用
 * `description: >-` 折叠多行写法，不解析会得到字面 ">-"。
 */

export interface Frontmatter {
  meta: Record<string, string>;
  body: string;
}

export function parseFrontmatter(content: string): Frontmatter {
  const lines = content.split('\n');

  if (lines[0]?.trim() !== '---') return { meta: {}, body: content };

  // 找结尾的 ---
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return { meta: {}, body: content };

  // 解析 key: value 对（value 去掉首尾引号）
  const meta: Record<string, string> = {};
  let i = 1;
  while (i < endIdx) {
    const line = lines[i];
    if (!line || !line.trim()) {
      i++;
      continue;
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }
    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();
    if (!key) {
      i++;
      continue;
    }

    // 块标量（>、>-、|、|- 等）：后续比 key 行更深缩进的行都归属该 key
    if (/^[>|][+-]?$/.test(rawValue)) {
      const keyIndent = line.length - line.trimStart().length;
      const folded = rawValue[0] === '>';
      const buf: string[] = [];
      i++;
      while (i < endIdx) {
        const l = lines[i] ?? '';
        if (l.trim() === '') {
          buf.push('');
          i++;
          continue;
        }
        if (l.length - l.trimStart().length <= keyIndent) break;
        buf.push(l.trimStart());
        i++;
      }
      while (buf.length > 0 && buf[0] === '') buf.shift();
      while (buf.length > 0 && buf[buf.length - 1] === '') buf.pop();
      // 折叠（>）拼成一行；字面（|）保留换行
      meta[key] = folded ? buf.join(' ').replace(/\s+/g, ' ').trim() : buf.join('\n');
      continue; // i 已指向块外下一行
    }

    meta[key] = rawValue.replace(/^["']|["']$/g, '');
    i++;
  }

  const body = lines
    .slice(endIdx + 1)
    .join('\n')
    .trim();
  return { meta, body };
}

/** 构建 frontmatter 块（保存记忆/技能共用） */
export function formatFrontmatter(meta: Record<string, string>, body: string): string {
  const head = Object.entries(meta)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return `---\n${head}\n---\n\n${body.trim()}\n`;
}
