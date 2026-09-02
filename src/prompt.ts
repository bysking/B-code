import type Anthropic from '@anthropic-ai/sdk';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * 两段式 System Prompt（施工图 L4 prompt.ts）
 *
 * 静态核心 STATIC_CORE：跨会话逐字不变 → 标 cache_control 让 Anthropic API
 * 按 0.1× 缓存命中计费；动态上下文每次重建（cwd/git/CLAUDE.md/记忆/技能）。
 * 动态块放末尾——利用近因效应让模型更关注。
 *
 * 内部统一用 Anthropic block 形状（system 参数），OpenAI 后端在边界拍平。
 */

export type SystemBlock = Anthropic.TextBlockParam;

/** 动态注入的可选段（P4：记忆召回 / 技能描述，放动态块末尾利用近因效应） */
export interface DynamicSections {
  memory?: string;
  skills?: string;
}

export const STATIC_CORE = `You are B Code, a small coding assistant CLI.
You help with software engineering tasks using the tools available to you.

# Doing tasks
- Do not propose changes to code you haven't read. Read files first.
- Do not create files unless necessary. Prefer editing existing files.
- Avoid over-engineering. Only make changes that were requested.
- Keep responses short and concise. Lead with the answer.

# Executing actions with care
- Prefer reversible actions. For risky or destructive ones (rm -rf, git push,
  dropping tables), confirm with the user before proceeding.

# Using your tools
- Use read_file / edit_file / list_files / grep_search instead of shell cat,
  sed, ls, grep. Reserve run_shell for actual shell operations.
- If several tool calls are independent, make them in parallel.
- Re-viewing a file you already read: use file_content, not read_file. A
  read_file result ends with a pointer line (📄 path ... hash <H>); when you
  see one, the full content is cached and unchanged. Use file_content with
  status_only=true to verify a file hasn't changed since your last read before
  editing it, and file_content with offset/limit to view just the lines you
  need. Note pointers in history may be stale after edits — always verify.

# Tone and style
- Reference code as file_path:line_number.

# Long-term memory
- When you learn a durable project fact, user preference, or reusable lesson
  (e.g. a staging URL, an auth rule, a pitfall), call save_memory to persist it
  across sessions. The user will confirm the write.
- Keep it specific and minimal: one fact per memory. Do not save transient details.

# Asking the user
- Whenever the conversation needs a user choice — a quiz with options, deciding
  between approaches, confirming a direction — call ask_user with kind:"choice"
  and the full option list, instead of printing the choices as plain text:
  the UI renders them as an interactive select (arrow keys + Enter).
  Example: "Quiz me on X with 4 options" → ask_user(question, options[A B C D]).
- Use kind:"text" for free-text answers (paths, names, preferences).
- Multi-step decisions: split into several ask_user calls (one decision per step)
  and prefix the step in the question, e.g. "[2/3] Which service?" — the UI
  will show each step's select in sequence.
- Do NOT ask when you can reasonably proceed: prefer reading files, searching,
  or making a sensible default and stating it. Asking has a cost; use it
  sparingly, like a careful engineer would.`;

/** 完整 System Prompt：静态核心（缓存标记）+ 动态上下文 + 记忆/技能注入段 */
export function buildSystemPrompt(args: { cwd?: string } & DynamicSections = {}): SystemBlock[] {
  const blocks: SystemBlock[] = [{ type: 'text', text: STATIC_CORE, cache_control: { type: 'ephemeral' } }];
  const dynamic = buildDynamicContext(args.cwd ?? process.cwd(), {
    memory: args.memory,
    skills: args.skills,
  });
  if (dynamic) blocks.push({ type: 'text', text: dynamic });
  return blocks;
}

/** 动态上下文：环境 / Git / CLAUDE.md / + 注入段（放末尾利用近因效应） */
function buildDynamicContext(cwd: string, sections: DynamicSections = {}): string {
  const parts: string[] = [`# Environment\n- Platform: ${process.platform}`, `- Working directory: ${cwd}`];

  // Git 状态（非 git 目录静默跳过）
  try {
    const branch = execSync('git branch --show-current', { cwd, encoding: 'utf-8' }).trim();
    const dirty = execSync('git -c color.ui=never status --porcelain', { cwd, encoding: 'utf-8' })
      .toString()
      .trim();
    parts.push(`\n# Git\n- Branch: ${branch || '(detached)'}`);
    if (dirty) parts.push(`- Uncommitted changes:\n${dirty.slice(0, 500)}`);
  } catch {
    // 不在 git 仓库
  }

  const claudeMd = loadClaudeMd(cwd);
  if (claudeMd) parts.push(`\n# Project Instructions\n${claudeMd}`);

  // 插入段：记忆召回 / 技能描述（由调用方算好传入）
  for (const section of [sections.skills, sections.memory]) {
    if (section) parts.push(section);
  }

  return parts.join('\n');
}

const MAX_INCLUDE_DEPTH = 5;

/**
 * CLAUDE.md 向上查找合并；支持 @include 指令，@ 引用允许出现在文本任意位置：
 *   @./relative / @~/home / @/absolute / @sub/file.md
 * 引用 = @ 后跟非空白的完整 token；路径不存在（或非文件）时原样保留（可选引用）。
 * 嵌套最深 5 层防循环引用。
 */
export function loadClaudeMd(startDir: string = process.cwd()): string {
  const parts: string[] = [];
  let dir = resolve(startDir);

  for (;;) {
    const file = join(dir, 'CLAUDE.md');
    if (existsSync(file)) {
      parts.push(`<file key="${file}">\n${resolveIncludes(file, 0, [])}\n</file>`);
    }
    const parent = dirname(dir);
    if (parent === dir) break; // 到根目录
    dir = parent;
  }
  return parts.join('\n');
}

/** chain = 当前包含链上的祖先文件（循环检测只看链，同一文件可在文档多处引用） */
function resolveIncludes(file: string, depth: number, chain: string[]): string {
  if (depth > MAX_INCLUDE_DEPTH) return `<!-- include too deep: ${file} -->`;

  const content = readFileSync(file, 'utf-8');
  // @ 引用允许出现在任意位置：@ 后跟一个 token（非空白序列），行首/行中/句尾皆可。
  // token 边界分两类：CJK 闭合标点（，。等，路径中不会出现）在任意位置截断并保留余文，
  // 兼容无空格中文正文（详见 @x.md，以及……）；ASCII 标点（. , ) 等）可能是路径的
  // 一部分（如 .md），只剥尾部。
  // 兜底语义（可选引用）：路径不存在或不是文件时原样保留原 token——
  // 同一份 CLAUDE.md 可跨环境复用，也不会误伤 email（test@example.com）或包名（@babel/core）。
  return content.replace(/@([^\s]+)/g, (_, raw: string) => {
    const cjkCut = raw.search(/[，。；：！？）」』》】、]/);
    const head = cjkCut === -1 ? raw : raw.slice(0, cjkCut);
    const tail = cjkCut === -1 ? '' : raw.slice(cjkCut);
    const asciiTrail = head.match(/[.,;:!?)\]}>]+$/)?.[0] ?? '';
    const p = head.slice(0, head.length - asciiTrail.length);
    if (p === '') return `@${raw}`; // 首字符就是标点：不是路径形态，保留原样
    const resolved = p.startsWith('~') ? join(homedir(), p.slice(1)) : resolve(join(dirname(file), p));
    let st;
    try {
      st = statSync(resolved);
    } catch {
      return `@${raw}`; // 不存在：保留原 token
    }
    if (!st.isFile()) return `@${raw}`; // 目录等非文件：不展开
    if (resolved === file || chain.includes(resolved)) return `<!-- circular include: ${p} -->`;
    return resolveIncludes(resolved, depth + 1, [...chain, file]).trim() + asciiTrail + tail;
  });
}

/** 供 Agent 直接取纯文本（未来 OpenAI 边界也用得到） */
export function flattenSystemBlocks(blocks: SystemBlock[]): string {
  return blocks.map((b) => b.text).join('\n\n');
}
