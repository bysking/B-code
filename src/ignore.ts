/**
 * .gitignore 解析与匹配（grep_search / list_files 共用的忽略层）。
 *
 * 问题：这两个工具原本只跳过 IGNORED_DIRS（node_modules/.git/.b-code），
 * 不读 .gitignore —— 于是 dist/、coverage/、build/、*.log 等构建产物会被
 * 一并搜索/列出，既污染结果又烧 token。本模块补上 git 语义的忽略判定。
 *
 * 支持的语法（git 常用子集）：
 *   - 注释 `#...`、空行
 *   - 取反 `!pattern`
 *   - 仅目录 `pattern/`
 *   - 锚定 `/foo`（前导斜杠）或含中间斜杠的 `foo/bar`
 *   - 通配 `*`（不跨 /）、`?`（单个非 / 字符）、`**`（跨目录）
 *   - 目录级 .gitignore：深层规则覆盖浅层
 * 语义：按规则顺序，**最后一条匹配的规则**决定去留（同 git）。
 *
 * 有意不支持：`\` 转义空格等罕见写法、`**` 的少数边角组合——够用即可。
 */

interface Rule {
  /** .gitignore 所在目录（相对搜索根，'' = 搜索根本身） */
  dir: string;
  negated: boolean;
  dirOnly: boolean;
  re: RegExp;
}

/** 把 glob 片段编译成正则体（不含首尾锚点） */
function globToBody(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          out += '(?:.*/)?'; // **/ 匹配零个或多个目录，含零个
        } else {
          out += '.*'; // ** 跨目录任意
        }
      } else {
        out += '[^/]*'; // * 不跨 /
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '\\' && i + 1 < glob.length) {
      i++;
      out += escapeRe(glob[i]!); // 反斜杠转义下一个字符
    } else {
      out += escapeRe(c);
    }
  }
  return out;
}

function escapeRe(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 解析单行 .gitignore 规则；空行/注释返回 null */
function parseRule(dir: string, raw: string): Rule | null {
  // 去尾部未转义空白（简化为直接 trim 尾部空白）
  let line = raw.replace(/\s+$/, '');
  if (line === '' || line.startsWith('#')) return null;

  let negated = false;
  if (line.startsWith('!')) {
    negated = true;
    line = line.slice(1);
  } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
    line = line.slice(1); // 转义的 ! / # 视为字面量
  }

  let dirOnly = false;
  if (line.endsWith('/')) {
    dirOnly = true;
    line = line.replace(/\/+$/, '');
  }
  if (line === '') return null;

  // 锚定判定：前导 / 或中间含 / → 锚定到 .gitignore 所在目录；否则按 basename 任意层级匹配
  let anchored = false;
  if (line.startsWith('/')) {
    anchored = true;
    line = line.slice(1);
  } else if (line.includes('/')) {
    anchored = true;
  }
  if (line === '') return null;

  const body = globToBody(line);
  const re = anchored ? new RegExp(`^${body}$`) : new RegExp(`(?:^|/)${body}$`);
  return { dir, negated, dirOnly, re };
}

/** 取 path 相对 dir 的路径；path 不在 dir 之下（含等于）时返回 null */
function relativeUnder(dir: string, path: string): string | null {
  if (dir === '') return path;
  if (path.startsWith(dir + '/')) return path.slice(dir.length + 1);
  return null; // path === dir 或不在其下：该 .gitignore 的规则不适用
}

export class GitIgnore {
  private rules: Rule[] = [];

  /** 载入某目录的 .gitignore 内容，返回新增规则数（供 pop 回退，DFS 栈式作用域） */
  push(dir: string, content: string): number {
    const before = this.rules.length;
    for (const raw of content.split(/\r?\n/)) {
      const rule = parseRule(dir, raw);
      if (rule) this.rules.push(rule);
    }
    return this.rules.length - before;
  }

  /** 回退最近 push 的规则（离开目录时调用，保证兄弟目录互不影响） */
  pop(count: number): void {
    if (count > 0) this.rules.length = Math.max(0, this.rules.length - count);
  }

  /** 判定相对搜索根的路径是否被忽略（isDir 供「仅目录」规则使用） */
  ignoring(relPath: string, isDir: boolean): boolean {
    let ignored = false;
    for (const r of this.rules) {
      if (r.dirOnly && !isDir) continue;
      const rel = relativeUnder(r.dir, relPath);
      if (rel === null) continue;
      if (r.re.test(rel)) ignored = !r.negated; // 最后匹配者胜
    }
    return ignored;
  }
}
