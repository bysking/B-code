import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import type { Registry, RuntimeContext } from './registry.js';
import { cacheable, contentHash, filePointer, type FileStore } from './file-store.js';

/**
 * 内置工具加载器（builtin-loader）：把 6 个核心工具注册进统一注册表。
 * 实现函数保持不变；能力接入方式从 switch 分发变为"注册 + resolve"，
 * 内核循环只认 registry.resolve(name)。
 */

/** 跳过这些目录，避免递归爆炸（node_modules / .git 对模型无意义） */
const IGNORED_DIRS = new Set(['node_modules', '.git', '.b-code']);

/** glob → RegExp（双星跨目录，单星匹配单段内任意字符） */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // 其他正则元字符转义
    .replace(/\*\*/g, '@@GLOBSTAR@@')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/@@GLOBSTAR@@/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * 文件快照写 store（read 首次 / write·edit 成功共用）：
 * path 用 resolve() 规范化作 key；hash 对原始 buffer 算。
 */
function putSnapshot(
  store: FileStore | undefined,
  path: string,
  content: string,
  mtimeMs: number,
  size: number,
  hash: string,
): void {
  if (!store || !cacheable(size)) return;
  store.updateContent(path, content, mtimeMs, size, hash);
}

async function readFileTool(input: { file_path: string }, ctx: RuntimeContext): Promise<string> {
  const path = resolve(input.file_path);
  try {
    const buf = await readFile(path);
    const st = await stat(path);
    const hash = contentHash(buf);
    const content = buf.toString('utf-8');
    const store = ctx.fileStore;
    const snap = store?.get(path);

    if (snap && snap.mtimeMs === st.mtimeMs && snap.size === st.size) {
      // 非首次且磁盘未变：返回指针而非全文（结构性防膨胀，不靠模型自觉）
      return `${filePointer(input.file_path, snap)}\n→ already read, unchanged (hash ${hash}); use file_content to view the content`;
    }
    if (store) {
      if (snap && (snap.mtimeMs !== st.mtimeMs || snap.size !== st.size)) {
        store.markDirty(path); // 磁盘变了：旧快照过期
      }
      putSnapshot(store, path, content, st.mtimeMs, st.size, hash);
    }
    // 首次 / 内容已变：返回全文 + 指针行（store 存完整内容供 file_content 取回）
    return (
      content +
      filePointer(input.file_path, { mtimeMs: st.mtimeMs, size: st.size, hash, content, dirty: false })
    );
  } catch (err) {
    return `Error reading ${input.file_path}: ${(err as Error).message}`;
  }
}

async function writeFileTool(
  input: { file_path: string; content: string },
  ctx: RuntimeContext,
): Promise<string> {
  const path = resolve(input.file_path);
  try {
    await writeFile(path, input.content, 'utf-8');
    // 工具已知新内容 → 直接更新 store（标 fresh），编辑后模型仍可廉价取回
    const st = await stat(path);
    putSnapshot(
      ctx.fileStore,
      path,
      input.content,
      st.mtimeMs,
      st.size,
      contentHash(Buffer.from(input.content)),
    );
    return `Successfully wrote ${input.file_path}`;
  } catch (err) {
    return `Error writing ${input.file_path}: ${(err as Error).message}`;
  }
}

/**
 * 检测文件主导换行符：CRLF 文件若按模型给的 \n 替换会制造混行换行，
 * 未来 git diff 全红、git autocrlf 双写——跨平台兼容的隐形炸弹。
 * 返回 "\r\n" 或 "\n"（平局取定 LF）。
 */
function detectEol(content: string): string {
  const crlf = content.match(/\r\n/g)?.length ?? 0;
  const lf = content.match(/(?<!\r)\n/g)?.length ?? 0;
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * edit_file 陷阱：old_string 必须在文件中唯一出现，否则改错位置。
 * 利用 split/join 而非 String.replace —— replace 会处理 $1、$& 等特殊模式。
 */
async function editFileTool(
  input: {
    file_path: string;
    old_string: string;
    new_string: string;
  },
  ctx: RuntimeContext,
): Promise<string> {
  const path = resolve(input.file_path);
  try {
    const content = await readFile(path, 'utf-8');
    if (!content.includes(input.old_string)) {
      return `Error: old_string not found in ${input.file_path}`;
    }
    const count = content.split(input.old_string).length - 1;
    if (count > 1) {
      return `Error: old_string found ${count} times. Must be unique.`;
    }
    // EOL 保持：CRLF 文件上把新文本统一转成 CRLF，避免混行换行
    const eol = detectEol(content);
    const newString =
      eol === '\r\n' && input.new_string.includes('\n')
        ? input.new_string.replace(/(?<!\r)\n/g, '\r\n')
        : input.new_string;
    const updated = content.split(input.old_string).join(newString);
    await writeFile(path, updated, 'utf-8');
    // 工具已知最终内容 → 直接更新 store（标 fresh）
    const st = await stat(path);
    putSnapshot(ctx.fileStore, path, updated, st.mtimeMs, st.size, contentHash(Buffer.from(updated)));
    // 编辑前后 diff：让模型与用户（Ctrl+O 回看）直观看到改了什么
    const diff = snippetDiff(content, input.old_string, newString);
    return `Successfully edited ${input.file_path}\n\nDiff:\n${diff}`;
  } catch (err) {
    return `Error editing ${input.file_path}: ${(err as Error).message}`;
  }
}

async function listFilesTool(input: { pattern?: string; path?: string }): Promise<string> {
  const base = resolve(input.path ?? '.');
  const re = globToRegExp(input.pattern ?? '**/*');
  const found: string[] = [];

  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (found.length < 200) await walk(full);
      } else if (re.test(relative(base, full))) {
        found.push(relative(base, full));
        if (found.length >= 200) return;
      }
    }
  };

  try {
    await walk(base);
  } catch (err) {
    return `Error listing ${base}: ${(err as Error).message}`;
  }
  return found.length === 0 ? '(no files matched)' : found.join('\n');
}

async function grepSearchTool(input: { pattern: string; path?: string }): Promise<string> {
  const base = resolve(input.path ?? '.');
  let re: RegExp;
  try {
    re = new RegExp(input.pattern);
  } catch (err) {
    return `Error: invalid regex "${input.pattern}": ${(err as Error).message}`;
  }

  const hits: string[] = [];
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (hits.length >= 200) return;
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (statSync(full).size > 1024 * 1024) continue; // 跳过大文件/二进制
      try {
        const text = await readFile(full, 'utf-8');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && hits.length < 200; i++) {
          const line = lines[i];
          if (line && re.test(line)) {
            hits.push(`${relative(base, full)}:${i + 1}: ${line.trim().slice(0, 200)}`);
          }
        }
      } catch {
        // 二进制或不可读文件，跳过
      }
    }
  };

  try {
    await walk(base);
  } catch (err) {
    return `Error searching ${base}: ${(err as Error).message}`;
  }
  return hits.length === 0 ? '(no matches)' : hits.join('\n');
}

/**
 * 已读文件按需取回 / 状态探针（根治重读循环的关键）：
 *   status_only → 仅状态行，零内容；默认 → 头行 + 全文（或 offset/limit 行窗口）。
 *   store 命中且磁盘未变（stat 相等）→ 返回缓存，零磁盘 IO；
 *   未命中 / 已变（resume 后 store 空等）→ 回落磁盘重读重建快照。
 */
async function fileContentTool(
  input: {
    file_path: string;
    status_only?: boolean;
    offset?: number;
    limit?: number;
  },
  ctx: RuntimeContext,
): Promise<string> {
  const path = resolve(input.file_path);
  const store = ctx.fileStore;
  try {
    const st = await stat(path);
    const snap = store?.get(path);
    const unchanged = Boolean(snap && snap.mtimeMs === st.mtimeMs && snap.size === st.size);
    const statusOnly = Boolean(input.status_only);
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const limit = Math.max(0, Math.floor(input.limit ?? 0));

    if (statusOnly) {
      if (unchanged) return `unchanged (hash ${snap!.hash})`;
      if (snap) {
        store?.markDirty(path);
        return `changed since read (old hash ${snap.hash}, new size ${st.size}); use file_content without status_only to get the new content`;
      }
      return `not read this session; use read_file or file_content to load it`;
    }

    let content: string;
    let hash: string;
    if (unchanged) {
      content = snap!.content;
      hash = snap!.hash;
    } else {
      if (snap) store?.markDirty(path);
      const buf = await readFile(path);
      hash = contentHash(buf);
      content = buf.toString('utf-8');
      putSnapshot(store, path, content, st.mtimeMs, st.size, hash);
    }

    let body = content;
    const totalLines = content.split('\n').length;
    if (limit > 0) {
      body = content
        .split('\n')
        .slice(offset, offset + limit)
        .join('\n');
    }
    const state = unchanged ? 'unchanged since read' : 'refreshed';
    return `📄 ${input.file_path} (${totalLines} 行, hash ${hash}, ${state})\n${body}`;
  } catch (err) {
    return `Error reading ${input.file_path}: ${(err as Error).message}`;
  }
}

/** run_shell 超时（ms）：env 可配（B_CODE_SHELL_TIMEOUT），默认 30s；无效值回退默认 */
const SHELL_TIMEOUT_MS = (() => {
  const n = Number(process.env.B_CODE_SHELL_TIMEOUT ?? '30000');
  return Number.isFinite(n) && n > 0 ? n : 30_000;
})();
const MAX_SHELL_OUTPUT = 10 * 1024 * 1024; // 与旧 exec maxBuffer 一致

/**
 * 执行 shell 命令。spawn（而非 exec）换取两件事：
 *   1. 实时日志——stdout/stderr 逐块经 ctx.onToolOutput 转发（UI 持续打印，不再干等 30s）；
 *   2. 可控超时——到点 SIGTERM → 1s 后 SIGKILL 兜底，结果带上"已超时"标记。
 * 输出仍累积截断（MAX_SHELL_OUTPUT）后整体返回，模型看到的语义与旧 exec 一致。
 */
function runShellTool(input: { command: string }, ctx?: RuntimeContext): Promise<string> {
  return new Promise((resolvePromise) => {
    const child = spawn(input.command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let settled = false;

    const finish = (msg: string) => {
      if (settled) return;
      settled = true;
      resolvePromise(msg);
    };

    const onData = (chunk: Buffer) => {
      if (out.length < MAX_SHELL_OUTPUT) out += chunk.toString();
      // 实时转发：逐块（近似逐行）打印，让用户看到长命令的进展
      ctx?.onToolOutput?.(chunk.toString());
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    // 统一终止：SIGTERM → 1s 后 SIGKILL 兜底（超时与用户中断共用）
    const killChild = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    };

    const timer = setTimeout(() => {
      killChild();
      finish(`(timed out after ${SHELL_TIMEOUT_MS / 1000}s; process killed)\n${out.trim()}`);
    }, SHELL_TIMEOUT_MS);
    timer.unref();

    // 硬中断：用户取消（Esc）→ 立即终止子进程，结果带"已中断"标记
    const signal = ctx?.signal;
    const onAbort = () => {
      killChild();
      finish(`(interrupted by user; process killed)\n${out.trim()}`);
    };
    if (signal) {
      if (signal.aborted) {
        killChild();
        clearTimeout(timer);
        return finish('(interrupted by user; process killed)');
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => finish(`Error: ${err.message}`));
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const body = out.trim();
      finish(code === 0 ? body || '(no output)' : body || `(exit ${code})`);
    });
  });
}

/**
 * 编辑点行级 diff：定位 old_string 在旧文件中的起始行，输出
 *   上下文行（前 1 行） → - 删除行 → + 新增行 → 上下文行（后 1 行）
 * 比全文 LCS 更适合 edit_file 场景：O(n) 定位、输出聚焦在变化处、超大文件不爆内存。
 */
export function snippetDiff(oldText: string, oldString: string, newString: string, contextLines = 1): string {
  const idx = oldText.indexOf(oldString);
  if (idx === -1) return '';
  const lines = oldText.split('\n');
  const startLine = oldText.slice(0, idx).split('\n').length - 1; // old_string 首行（0-based）
  const oldLines = oldString.split('\n');
  const newLines = newString.split('\n');

  const out: string[] = [];
  for (let k = Math.max(0, startLine - contextLines); k < startLine; k++) out.push(`  ${lines[k]}`);
  for (const l of oldLines) out.push(`- ${l}`);
  for (const l of newLines) out.push(`+ ${l}`);
  const endLine = startLine + oldLines.length;
  for (let k = endLine; k < Math.min(lines.length, endLine + contextLines); k++) out.push(`  ${lines[k]}`);
  return out.join('\n');
}

/** 注册全部内置工具（handler 包一层实现函数，mode 供权限层判定） */
export function registerBuiltinTools(registry: Registry): void {
  registry.register({
    name: 'read_file',
    description: 'Read the contents of a file.',
    inputSchema: {
      type: 'object',
      properties: { file_path: { type: 'string', description: 'The path to the file to read' } },
      required: ['file_path'],
    },
    mode: 'read',
    kind: 'builtin',
    handler: (input, ctx) => readFileTool(input as { file_path: string }, ctx),
  });

  registry.register({
    name: 'write_file',
    description: 'Write content to a file. Creates it if missing, overwrites if it exists.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The path to the file to write' },
        content: { type: 'string', description: 'The content to write' },
      },
      required: ['file_path', 'content'],
    },
    mode: 'write',
    kind: 'builtin',
    handler: (input, ctx) => writeFileTool(input as { file_path: string; content: string }, ctx),
  });

  registry.register({
    name: 'edit_file',
    description:
      'Replace an exact string in a file with new content. old_string must match exactly and be unique.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The path to the file to edit' },
        old_string: { type: 'string', description: 'The exact string to find' },
        new_string: { type: 'string', description: 'The string to replace it with' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
    mode: 'write',
    kind: 'builtin',
    handler: (input, ctx) =>
      editFileTool(input as { file_path: string; old_string: string; new_string: string }, ctx),
  });

  registry.register({
    name: 'list_files',
    description: "List files matching a glob pattern (e.g. '**/*.ts').",
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match files' },
        path: { type: 'string', description: 'Base directory. Defaults to cwd.' },
      },
      required: ['pattern'],
    },
    mode: 'read',
    kind: 'builtin',
    handler: (input) => listFilesTool(input as { pattern?: string; path?: string }),
  });

  registry.register({
    name: 'grep_search',
    description: 'Search for a regex pattern in files. Returns matching lines with paths and line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The regex pattern to search for' },
        path: { type: 'string', description: 'Directory or file to search.' },
      },
      required: ['pattern'],
    },
    mode: 'read',
    kind: 'builtin',
    handler: (input) => grepSearchTool(input as { pattern: string; path?: string }),
  });

  registry.register({
    name: 'file_content',
    description:
      'Retrieve the content of an already-read file (from session cache, or re-read from disk if changed/missing from cache). ' +
      'status_only=true just reports whether the file changed since last read — use it as a cheap freshness probe. ' +
      'offset/limit read a 0-based line window (limit 0 = whole file) — use after read_file truncated a large file. ' +
      'Prefer file_content over read_file to re-view a file you already read.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file' },
        status_only: { type: 'boolean', description: 'Only report change status, skip content' },
        offset: { type: 'number', description: '0-based start line for a window read' },
        limit: { type: 'number', description: 'Number of lines to read (0 = whole file)' },
      },
      required: ['file_path'],
    },
    mode: 'read',
    kind: 'builtin',
    handler: (input, ctx) =>
      fileContentTool(
        input as { file_path: string; status_only?: boolean; offset?: number; limit?: number },
        ctx,
      ),
  });

  registry.register({
    name: 'run_shell',
    description: 'Execute a shell command and return its output.',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The shell command to execute' } },
      required: ['command'],
    },
    mode: 'shell',
    kind: 'builtin',
    handler: (input, ctx) => runShellTool(input as { command: string }, ctx),
  });
}
