import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirs, safeName } from './utils/paths.js';
import { formatFrontmatter, parseFrontmatter } from './frontmatter.js';
import type { Memory } from './types.js';
import type { Registry } from './registry.js';

/** 文件记忆实现（P7 策略化；未来换向量库 = 实现同一接口替换） */
export class FileMemory implements Memory {
  save = saveMemory;
  recall = recallMemories;
  dir = memoryDir;
}

/**
 * 跨会话记忆（施工图 P4 §8）
 *
 * 存储：{basePath}/projects/{sha256(cwd)前16位}/memory/*.md（frontmatter + 正文）
 * 召回：**关键词重叠打分，纯确定性、不调模型**——快、省、可预测。
 *       query 与记忆的 name/description/body 做词集重叠，top3 注入 system prompt 末尾。
 */

/** 项目键：同一目录的工作区隔离各自的记忆 */
export function projectKey(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

export function memoryDir(cwd: string = process.cwd()): string {
  return join(dirs.projectsDir(), projectKey(cwd), 'memory');
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
  writeFileSync(file, formatFrontmatter({ name, description, type }, content), 'utf-8');
  return file;
}

/**
 * 半自动沉淀：注册 save_memory 工具（mode: write → confirm）。
 * 模型发现自己应记住的长期事实/偏好/教训时主动调用，经用户确认后落盘。
 */
export function registerMemoryTool(registry: Registry): void {
  registry.register({
    name: 'save_memory',
    description:
      'Save a durable fact, user preference, or reusable lesson to long-term memory. ' +
      'Use when you learn something worth remembering across sessions; the user will confirm the write.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "Short memory name, e.g. 'staging url'" },
        type: {
          type: 'string',
          enum: ['reference', 'project', 'feedback'],
          description: '记忆类型（缺省 reference）',
        },
        content: { type: 'string', description: 'The fact to remember' },
      },
      required: ['name', 'content'],
    },
    mode: 'write',
    kind: 'builtin',
    handler: (input) => {
      const file = saveMemory(
        String(input.name ?? 'memory'),
        String(input.name ?? 'memory'),
        String(input.type ?? 'reference'),
        String(input.content ?? ''),
      );
      return `Saved to memory: ${file}`;
    },
  });
}

// 一次匹配整串连续 CJK（+ 量词），才能按"串"切二叉；若逐个字符匹配则都是单字
const CJK_RE = /[一-鿿㐀-䶿]+/g;

/**
 * 词集：拉丁词 + 中文二叉（CJK 无空格，整段切词会零重叠；
 * "备份服务器地址" 与记忆里的 "备份服务器是" 靠 2-gram 才有共同项）。
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const w of text.split(/\W+/)) {
    if (w.length >= 2) tokens.add(w);
  }
  for (const m of text.matchAll(CJK_RE)) {
    const run = m[0]!;
    if (run.length >= 2) {
      for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
    }
  }
  return tokens;
}

/** 关键词召回：按重叠分排序取 top limit，注入段不存在返回空串 */
export function recallMemories(query: string, limit = 3, cwd: string = process.cwd()): string {
  const dir = memoryDir(cwd);
  if (!existsSync(dir)) return '';

  const queryTokens = tokenize(query.toLowerCase());
  // 噪声过滤：丢掉 2 字符的纯 ASCII 词（is/at/ok…），它们命中率高但信息量低。
  // 过滤后的 sig 才是实际打分集——若直接用 queryTokens，噪声词会给每条记忆刷分。
  const sig = [...queryTokens].filter((t) => !(t.length === 2 && /^[a-z]/.test(t)));
  if (sig.length === 0) return ''; // 无可打分信号 → 不召回（避免噪声匹配）

  const scored: { text: string; score: number }[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const { meta, body } = parseFrontmatter(readFileSync(join(dir, file), 'utf-8'));
    const searchText = `${meta.name ?? ''} ${meta.description ?? ''} ${body}`.toLowerCase();
    const words = tokenize(searchText);

    let score = 0;
    for (const t of sig) if (words.has(t)) score++;
    if (score > 0) scored.push({ text: `- ${meta.name ?? file}: ${body.slice(0, 300)}`, score });
  }

  if (scored.length === 0) return '';
  const top = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.text)
    .join('\n');
  return `\n\n# Memory\n${top}`;
}
