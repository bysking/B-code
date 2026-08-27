import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { basePath } from './utils/paths.js';

/**
 * 技能系统（施工图 P4 §9）：把常用提示词包装成一个 `/name 参数` 命令。
 *
 * 技能搜索链（越靠前优先级越高，同名技能前者生效）：
 *   1. {cwd}/.claude/skills            项目级
 *   2. $B_CODE_SKILLS_DIR              显式覆盖（CI/多环境）
 *   3. $B_CODE_HOME/skills             用户级·随数据根迁移（对齐 B_CODE_HOME 哲学）
 *   4. ~/.claude/skills                兼容既有 claude 生态的兜底
 *
 * 技能两种形态（技能名 = 文件名 / 目录名，同一目录内平铺文件优先于同名目录）：
 *   - 平铺文件 {name}.md                 frontmatter 需显式 user-invocable: true
 *   - 技能目录 {name}/SKILL.md|skill.md  对齐 Claude 生态：目录名即技能名，描述与
 *                                       正文读目录下的 SKILL.md（或 skill.md），
 *                                       默认可调用（写 user-invocable: false 关闭）
 *
 * 技能文件 = frontmatter（name/description/user-invocable）+ 正文（可含 $ARGUMENTS 占位）。
 */

const MAX_ARGUMENTS_CHARS = 2000;
export const SKILLS_DIR_ENV = 'B_CODE_SKILLS_DIR';

/** 目录形态技能的描述文件（按此顺序探测） */
const SKILL_DOC_FILES = ['SKILL.md', 'skill.md'];

/** 技能入口：平铺的 {name}.md 本体，或技能目录里的 SKILL.md */
interface SkillEntry {
  name: string;
  file: string;
  directoryForm: boolean;
}

function skillDirs(cwd: string): string[] {
  const dirs: string[] = [join(cwd, '.claude', 'skills')];
  const envDir = process.env[SKILLS_DIR_ENV];
  if (envDir) dirs.push(envDir);
  dirs.push(join(basePath(), 'skills'));
  dirs.push(join(homedir(), '.claude', 'skills'));
  return dirs;
}

export interface SkillInfo {
  name: string;
  description: string;
  userInvocable: boolean;
  dir: string;
}

/** 技能名来自文件/目录名或用户输入，拦截 `.`/`..`/路径穿越/隐藏文件 */
function isSafeSkillName(name: string): boolean {
  return name !== '' && !name.startsWith('.') && !name.includes('/') && !name.includes('\\');
}

/** 扫描单个技能根目录：平铺 *.md + 含 SKILL.md 的子目录（返回值不含同名冲突中的落败方） */
function scanSkillDir(dir: string): SkillEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // 目录消失/无权限
  }
  const flat = new Map<string, SkillEntry>();
  const nested = new Map<string, SkillEntry>();
  for (const name of names) {
    if (name.startsWith('.')) continue; // 隐藏文件/目录（.DS_Store 等）
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full); // 跟随符号链接，symlink 的技能文件/目录也能被发现
    } catch {
      continue; // 坏链接跳过
    }
    if (st.isFile() && name.endsWith('.md')) {
      flat.set(name.slice(0, -3), { name: name.slice(0, -3), file: full, directoryForm: false });
    } else if (st.isDirectory()) {
      const doc = SKILL_DOC_FILES.map((f) => join(full, f)).find((p) => existsSync(p));
      if (doc) nested.set(name, { name, file: doc, directoryForm: true });
    }
  }
  return [...flat.values(), ...[...nested.values()].filter((e) => !flat.has(e.name))];
}

/** 在单个技能根目录里定位指定名称的技能入口（平铺优先，其次目录形态） */
function findSkillEntry(dir: string, name: string): SkillEntry | null {
  if (!isSafeSkillName(name)) return null;
  const file = join(dir, `${name}.md`);
  if (existsSync(file)) return { name, file, directoryForm: false };
  for (const doc of SKILL_DOC_FILES) {
    const p = join(dir, name, doc);
    if (existsSync(p)) return { name, file: p, directoryForm: true };
  }
  return null;
}

/** 列出搜索链上发现的全部技能（同名技能前者生效） */
export function discoverSkills(cwd: string = process.cwd()): SkillInfo[] {
  const out: SkillInfo[] = [];
  const seen = new Set<string>();

  for (const dir of skillDirs(cwd)) {
    if (!existsSync(dir)) continue;
    for (const entry of scanSkillDir(dir)) {
      if (seen.has(entry.name)) continue; // 高优先级目录已注册同名
      seen.add(entry.name);
      try {
        const { meta } = parseFrontmatter(readFileSync(entry.file, 'utf-8'));
        out.push({
          name: entry.name,
          // 多行描述（块标量）折叠成一行，保证注入 prompt/菜单时格式不破
          description: (meta.description ?? '').replace(/\s+/g, ' ').trim(),
          // 目录形态对齐 Claude 生态默认可调用（显式 false 关闭）；平铺文件沿用显式 true
          userInvocable: entry.directoryForm
            ? meta['user-invocable'] !== 'false'
            : meta['user-invocable'] === 'true',
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
  if (!input.startsWith('/')) return null;
  const [name, ...rest] = input.slice(1).split(' ');
  if (!name) return null;

  for (const dir of skillDirs(cwd)) {
    const entry = findSkillEntry(dir, name);
    if (!entry) continue;
    const { meta, body } = parseFrontmatter(readFileSync(entry.file, 'utf-8'));
    if (!entry.directoryForm && !meta.name) continue; // 平铺形态无 name 的 frontmatter 不算技能

    const args = rest.join(' ').trim();
    let prompt = body;
    if (args) prompt = prompt.replace(/\$ARGUMENTS/g, args.slice(0, MAX_ARGUMENTS_CHARS));
    return prompt;
  }
  return null;
}

/** 把 user-invocable 技能注入 system prompt（只暴露用户可主动调用的） */
export function buildSkillDescriptions(cwd: string = process.cwd()): string {
  const skills = discoverSkills(cwd).filter((s) => s.userInvocable);
  if (skills.length === 0) return '';
  const lines = skills.map((s) => `- /${s.name}: ${s.description}`);
  return `\n\n# Available Skills\n${lines.join('\n')}`;
}
