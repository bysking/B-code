import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirs, safeName } from "./utils/paths.js";
import { formatFrontmatter, parseFrontmatter } from "./frontmatter.js";

/**
 * 跨会话记忆（施工图 P4 §8）
 *
 * 存储：{basePath}/projects/{sha256(cwd)前16位}/memory/*.md（frontmatter + 正文）
 * 召回：**关键词重叠打分，纯确定性、不调模型**——快、省、可预测。
 *       query 与记忆的 name/description/body 做词集重叠，top3 注入 system prompt 末尾。
 */

/** 项目键：同一目录的工作区隔离各自的记忆 */
export function projectKey(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

export function memoryDir(cwd: string = process.cwd()): string {
  return join(dirs.projectsDir(), projectKey(cwd), "memory");
}

/** 保存一条记忆（同步：REPL 路径简单可靠，量级远小于磁盘能力） */
export function saveMemory(
  name: string,
  description: string,
  type: string,
  content: string,
  cwd: string = process.cwd(),
): string {
  const dir = memoryDir(cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${safeName(name)}.md`);
  writeFileSync(file, formatFrontmatter({ name, description, type }, content), "utf-8");
  return file;
}

/** 关键词召回：按重叠分排序取 top limit，注入段不存在返回空串 */
export function recallMemories(
  query: string,
  limit = 3,
  cwd: string = process.cwd(),
): string {
  const dir = memoryDir(cwd);
  if (!existsSync(dir)) return "";

  const queryWords = new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  if (queryWords.size === 0) return "";

  const scored: { text: string; score: number }[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const { meta, body } = parseFrontmatter(readFileSync(join(dir, file), "utf-8"));
    const searchText = `${meta.name ?? ""} ${meta.description ?? ""} ${body}`.toLowerCase();
    const words = new Set(searchText.split(/\W+/));

    let score = 0;
    for (const w of queryWords) if (words.has(w)) score++;
    if (score > 0) scored.push({ text: `- ${meta.name ?? file}: ${body.slice(0, 300)}`, score });
  }

  if (scored.length === 0) return "";
  const top = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.text)
    .join("\n");
  return `\n\n# Memory\n${top}`;
}