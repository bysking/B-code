import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { basePath, dirs, safeName } from './utils/paths.js';
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
 * 存储两层：
 *   - 全局层 {basePath}/memory/*.md                 所有项目共享（B_CODE_MEMORY_DIR 可覆盖）
 *   - 项目层 {basePath}/projects/{sha256(cwd)前16}/memory/*.md
 * 召回：**关键词重叠打分，纯确定性、不调模型**——快、省、可预测。
 *       query 与记忆的 name/description/body 做词集重叠，top3 注入 system prompt 末尾。
 *       两层一起打分（全局层每条加 GLOBAL_BOOST 一点权重），所以同分时全局事实更稳。
 */

export const MEMORY_DIR_ENV = 'B_CODE_MEMORY_DIR';

/** 全局层记忆的召回加分：同分时压过项目层（只影响排序，不改变是否命中） */
const GLOBAL_BOOST = 0.5;

/** 项目键：同一目录的工作区隔离各自的记忆 */
export function projectKey(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

/** 项目层记忆目录（按 cwd 隔离，`/remember` 与 `save_memory` 默认落这里） */
export function memoryDir(cwd: string = process.cwd()): string {
  return join(dirs.projectsDir(), projectKey(cwd), 'memory');
}

/**
 * 全局记忆目录：默认 {basePath}/memory，$B_CODE_MEMORY_DIR 显式覆盖
 * （绝对路径原样使用，相对路径相对 basePath() —— 与 B_CODE_HOME 的强校验相反，
 * 这里宽一点，命令行里写 `B_CODE_MEMORY_DIR=./memory` 不至于让进程起不来）。
 */
export function globalMemoryDir(): string {
  const override = process.env[MEMORY_DIR_ENV];
  if (!override) return dirs.memoryDir();
  return isAbsolute(override) ? override : resolve(basePath(), override);
}

/** 召回时参与扫描的全部目录（全局层在前） */
function recallDirs(cwd: string): string[] {
  const global = globalMemoryDir();
  const project = memoryDir(cwd);
  return global === project ? [global] : [global, project];
}

/** 保存一条记忆（同步：REPL 路径简单可靠，量级远小于磁盘能力） */
export function saveMemory(
  name: string,
  description: string,
  type: string,
  content: string,
  cwd: string = process.cwd(),
  scope: 'project' | 'global' = 'project',
): string {
  const dir = scope === 'global' ? globalMemoryDir() : memoryDir(cwd);
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
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description:
            'project（缺省）只在本目录有效；global 存入跨项目共享的全局记忆目录（同一偏好/账号/工具约定在多个仓库都适用时用它）',
        },
      },
      required: ['name', 'content'],
    },
    mode: 'write',
    kind: 'builtin',
    handler: (input) => {
      const scope = input.scope === 'global' ? 'global' : 'project';
      const file = saveMemory(
        String(input.name ?? 'memory'),
        String(input.name ?? 'memory'),
        String(input.type ?? 'reference'),
        String(input.content ?? ''),
        process.cwd(),
        scope,
      );
      return `Saved to memory (${scope}): ${file}`;
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

/** 关键词召回：全局层 + 项目层一起打分，按重叠分排序取 top limit；无命中返回空串 */
export function recallMemories(query: string, limit = 3, cwd: string = process.cwd()): string {
  const queryTokens = tokenize(query.toLowerCase());
  // 噪声过滤：丢掉 2 字符的纯 ASCII 词（is/at/ok…），它们命中率高但信息量低。
  // 过滤后的 sig 才是实际打分集——若直接用 queryTokens，噪声词会给每条记忆刷分。
  const sig = [...queryTokens].filter((t) => !(t.length === 2 && /^[a-z]/.test(t)));
  if (sig.length === 0) return ''; // 无可打分信号 → 不召回（避免噪声匹配）

  const scored: { text: string; score: number }[] = [];
  for (const [idx, dir] of recallDirs(cwd).entries()) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const { meta, body } = parseFrontmatter(readFileSync(join(dir, file), 'utf-8'));
      const searchText = `${meta.name ?? ''} ${meta.description ?? ''} ${body}`.toLowerCase();
      const words = tokenize(searchText);

      let score = 0;
      for (const t of sig) if (words.has(t)) score++;
      // 全局层（idx===0）同分时优先：用户特意存进 {basePath}/memory 的事实应稳定召回
      if (score > 0)
        scored.push({
          text: `- ${meta.name ?? file}: ${body.slice(0, 300)}`,
          score: idx === 0 ? score + GLOBAL_BOOST : score,
        });
    }
  }

  if (scored.length === 0) return '';
  const top = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.text)
    .join('\n');
  return `\n\n# Memory\n${top}`;
}
