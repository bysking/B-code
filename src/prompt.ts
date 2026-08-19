import type Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
export function buildSystemPrompt(
  args: { cwd?: string } & DynamicSections = {},
): SystemBlock[] {
  const blocks: SystemBlock[] = [
    { type: "text", text: STATIC_CORE, cache_control: { type: "ephemeral" } },
  ];
  const dynamic = buildDynamicContext(args.cwd ?? process.cwd(), {
    memory: args.memory,
    skills: args.skills,
  });
  if (dynamic) blocks.push({ type: "text", text: dynamic });
  return blocks;
}

/** 动态上下文：环境 / Git / CLAUDE.md / + 注入段（放末尾利用近因效应） */
function buildDynamicContext(cwd: string, sections: DynamicSections = {}): string {
  const parts: string[] = [`# Environment\n- Platform: ${process.platform}`, `- Working directory: ${cwd}`];

  // Git 状态（非 git 目录静默跳过）
  try {
    const branch = execSync("git branch --show-current", { cwd, encoding: "utf-8" }).trim();
    const dirty = execSync("git -c color.ui=never status --porcelain", { cwd, encoding: "utf-8" })
      .toString()
      .trim();
    parts.push(`\n# Git\n- Branch: ${branch || "(detached)"}`);
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

  return parts.join("\n");
}

const MAX_INCLUDE_DEPTH = 5;

/**
 * CLAUDE.md 向上查找合并；支持 @include 指令：
 *   @./relative / @~/home / @/absolute
 * 嵌套最深 5 层防循环引用。
 */
export function loadClaudeMd(startDir: string = process.cwd()): string {
  const parts: string[] = [];
  let dir = resolve(startDir);
  const visited = new Set<string>();

  for (;;) {
    const file = join(dir, "CLAUDE.md");
    if (existsSync(file) && !visited.has(file)) {
      parts.push(`<file key="${file}">\n${resolveIncludes(file, 0, visited)}\n</file>`);
    }
    const parent = dirname(dir);
    if (parent === dir) break; // 到根目录
    dir = parent;
  }
  return parts.join("\n");
}

function resolveIncludes(file: string, depth: number, visited: Set<string>): string {
  if (depth > MAX_INCLUDE_DEPTH) return `<!-- include too deep: ${file} -->`;
  visited.add(file);

  let content = readFileSync(file, "utf-8");
  content = content.replace(/^@(.+)$/gm, (_, raw: string) => {
    const p = raw.trim();
    const resolved = p.startsWith("~")
      ? join(homedir(), p.slice(1))
      : resolve(join(dirname(file), p));
    if (!existsSync(resolved)) return `<!-- not found: ${p} -->`;
    if (visited.has(resolved)) return `<!-- circular include: ${p} -->`;
    return resolveIncludes(resolved, depth + 1, visited);
  });
  return content;
}

/** 供 Agent 直接取纯文本（未来 OpenAI 边界也用得到） */
export function flattenSystemBlocks(blocks: SystemBlock[]): string {
  return blocks.map((b) => b.text).join("\n\n");
}