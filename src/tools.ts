import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { exec } from "node:child_process";
import { statSync } from "node:fs";
import type { Registry } from "./registry.js";

/**
 * 内置工具加载器（builtin-loader）：把 6 个核心工具注册进统一注册表。
 * 实现函数保持不变；能力接入方式从 switch 分发变为"注册 + resolve"，
 * 内核循环只认 registry.resolve(name)。
 */

/** 跳过这些目录，避免递归爆炸（node_modules / .git 对模型无意义） */
const IGNORED_DIRS = new Set(["node_modules", ".git", ".b-code"]);

/** glob → RegExp（双星跨目录，单星匹配单段内任意字符） */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // 其他正则元字符转义
    .replace(/\*\*/g, "@@GLOBSTAR@@")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/@@GLOBSTAR@@/g, ".*");
  return new RegExp(`^${escaped}$`);
}

async function readFileTool(input: { file_path: string }): Promise<string> {
  try {
    return await readFile(resolve(input.file_path), "utf-8");
  } catch (err) {
    return `Error reading ${input.file_path}: ${(err as Error).message}`;
  }
}

async function writeFileTool(input: { file_path: string; content: string }): Promise<string> {
  try {
    await writeFile(resolve(input.file_path), input.content, "utf-8");
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
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * edit_file 陷阱：old_string 必须在文件中唯一出现，否则改错位置。
 * 利用 split/join 而非 String.replace —— replace 会处理 $1、$& 等特殊模式。
 */
async function editFileTool(input: {
  file_path: string;
  old_string: string;
  new_string: string;
}): Promise<string> {
  try {
    const content = await readFile(resolve(input.file_path), "utf-8");
    if (!content.includes(input.old_string)) {
      return `Error: old_string not found in ${input.file_path}`;
    }
    const count = content.split(input.old_string).length - 1;
    if (count > 1) {
      return `Error: old_string found ${count} times. Must be unique.`;
    }
    // EOL 保持：CRLF 文件上把新文本统一转成 CRLF，避免混行换行
    const eol = detectEol(content);
    const newString = eol === "\r\n" && input.new_string.includes("\n")
      ? input.new_string.replace(/(?<!\r)\n/g, "\r\n")
      : input.new_string;
    const updated = content.split(input.old_string).join(newString);
    await writeFile(resolve(input.file_path), updated, "utf-8");
    return `Successfully edited ${input.file_path}`;
  } catch (err) {
    return `Error editing ${input.file_path}: ${(err as Error).message}`;
  }
}

async function listFilesTool(input: { pattern?: string; path?: string }): Promise<string> {
  const base = resolve(input.path ?? ".");
  const re = globToRegExp(input.pattern ?? "**/*");
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
  return found.length === 0 ? "(no files matched)" : found.join("\n");
}

async function grepSearchTool(input: { pattern: string; path?: string }): Promise<string> {
  const base = resolve(input.path ?? ".");
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
        const text = await readFile(full, "utf-8");
        const lines = text.split("\n");
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
  return hits.length === 0 ? "(no matches)" : hits.join("\n");
}

function runShellTool(input: { command: string }): Promise<string> {
  return new Promise((resolvePromise) => {
    exec(input.command, { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
      if (err) {
        resolvePromise(out ? out : `Error: ${err.message}`);
      } else {
        resolvePromise(out || "(no output)");
      }
    });
  });
}

/** 注册全部内置工具（handler 包一层实现函数，mode 供权限层判定） */
export function registerBuiltinTools(registry: Registry): void {
  registry.register({
    name: "read_file",
    description: "Read the contents of a file.",
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string", description: "The path to the file to read" } },
      required: ["file_path"],
    },
    mode: "read",
    kind: "builtin",
    handler: (input) => readFileTool(input as { file_path: string }),
  });

  registry.register({
    name: "write_file",
    description: "Write content to a file. Creates it if missing, overwrites if it exists.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The path to the file to write" },
        content: { type: "string", description: "The content to write" },
      },
      required: ["file_path", "content"],
    },
    mode: "write",
    kind: "builtin",
    handler: (input) => writeFileTool(input as { file_path: string; content: string }),
  });

  registry.register({
    name: "edit_file",
    description: "Replace an exact string in a file with new content. old_string must match exactly and be unique.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The path to the file to edit" },
        old_string: { type: "string", description: "The exact string to find" },
        new_string: { type: "string", description: "The string to replace it with" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
    mode: "write",
    kind: "builtin",
    handler: (input) =>
      editFileTool(input as { file_path: string; old_string: string; new_string: string }),
  });

  registry.register({
    name: "list_files",
    description: "List files matching a glob pattern (e.g. '**/*.ts').",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern to match files" },
        path: { type: "string", description: "Base directory. Defaults to cwd." },
      },
      required: ["pattern"],
    },
    mode: "read",
    kind: "builtin",
    handler: (input) => listFilesTool(input as { pattern?: string; path?: string }),
  });

  registry.register({
    name: "grep_search",
    description: "Search for a regex pattern in files. Returns matching lines with paths and line numbers.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The regex pattern to search for" },
        path: { type: "string", description: "Directory or file to search." },
      },
      required: ["pattern"],
    },
    mode: "read",
    kind: "builtin",
    handler: (input) => grepSearchTool(input as { pattern: string; path?: string }),
  });

  registry.register({
    name: "run_shell",
    description: "Execute a shell command and return its output.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", description: "The shell command to execute" } },
      required: ["command"],
    },
    mode: "shell",
    kind: "builtin",
    handler: (input) => runShellTool(input as { command: string }),
  });
}