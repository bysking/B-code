import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { basePath } from "./utils/paths.js";

/**
 * 技能系统（施工图 P4 §9）：把常用提示词包装成一个 `/name 参数` 命令。
 *
 * 技能搜索链（越靠前优先级越高，同名技能前者生效）：
 *   1. {cwd}/.claude/skills            项目级
 *   2. $B_CODE_SKILLS_DIR              显式覆盖（CI/多环境）
 *   3. $B_CODE_HOME/skills             用户级·随数据根迁移（对齐 B_CODE_HOME 哲学）
 *   4. ~/.claude/skills                兼容既有 claude 生态的兜底
 *
 * 技能文件 = frontmatter（name/description/user-invocable）+ 正文（可含 $ARGUMENTS 占位）。
 */

const MAX_ARGUMENTS_CHARS = 2000;
export const SKILLS_DIR_ENV = "B_CODE_SKILLS_DIR";

function skillDirs(cwd: string): string[] {
  const dirs: string[] = [join(cwd, ".claude", "skills")];
  const envDir = process.env[SKILLS_DIR_ENV];
  if (envDir) dirs.push(envDir);
  dirs.push(join(basePath(), "skills"));
  dirs.push(join(homedir(), ".claude", "skills"));
  return dirs;
}

export interface SkillInfo {
  name: string;
  description: string;
  userInvocable: boolean;
  dir: string;
}

/** 列出搜索链上发现的全部技能（同名技能前者生效） */
export function discoverSkills(cwd: string = process.cwd()): SkillInfo[] {
  const out: SkillInfo[] = [];
  const seen = new Set<string>();

  for (const dir of skillDirs(cwd)) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const name = file.slice(0, -3);
      if (seen.has(name)) continue; // 高优先级目录已注册同名
      seen.add(name);
      try {
        const { meta } = parseFrontmatter(readFileSync(join(dir, file), "utf-8"));
        out.push({
          name,
          description: meta.description ?? "",
          userInvocable: meta["user-invocable"] === "true",
          dir,
        });
      } catch {
        // 坏文件跳过
      }
    }
  }
  return out;
}

/**
 * 解析技能调用："/commit 新功能" → name=commit, args="新功能"
 * 命中返回替换好 $ARGUMENTS 的正文；未命中返回 null。
 */
export function resolveSkill(input: string, cwd: string = process.cwd()): string | null {
  if (!input.startsWith("/")) return null;
  const [name, ...rest] = input.slice(1).split(" ");
  if (!name) return null;

  for (const dir of skillDirs(cwd)) {
    const file = join(dir, `${name}.md`);
    if (!existsSync(file)) continue;
    const { meta, body } = parseFrontmatter(readFileSync(file, "utf-8"));
    if (!meta.name) continue; // 无 name 的 frontmatter 不算技能

    const args = rest.join(" ").trim();
    let prompt = body;
    if (args) prompt = prompt.replace(/\$ARGUMENTS/g, args.slice(0, MAX_ARGUMENTS_CHARS));
    return prompt;
  }
  return null;
}

/** 把 user-invocable 技能注入 system prompt（只暴露用户可主动调用的） */
export function buildSkillDescriptions(cwd: string = process.cwd()): string {
  const skills = discoverSkills(cwd).filter((s) => s.userInvocable);
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- /${s.name}: ${s.description}`);
  return `\n\n# Available Skills\n${lines.join("\n")}`;
}