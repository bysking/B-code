import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBuiltinTools } from "../src/tools.js";
import { Registry, type RuntimeContext } from "../src/registry.js";

/** 经注册表执行内置工具（P5：测试走真实解析路径，而非旧 switch） */
const registry = new Registry();
const ctx = {} as RuntimeContext;
registerBuiltinTools(registry);
const run = (name: string, input: unknown): Promise<string> => {
  const mp = registry.resolve(name);
  if (!mp) return Promise.resolve(`Unknown tool: ${name}`);
  return Promise.resolve(mp.handler(input as Record<string, any>, ctx) as string);
};
const schemas = registry.toolsSchema();

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "b-code-tools-"));
  await writeFile(join(dir, "a.txt"), "line one\nvalue = 0\nline three\n");
  await mkdir(join(dir, "sub"));
  await writeFile(join(dir, "sub", "b.ts"), "export const b = 1;\n");
  // 独立 fixture：供 glob 语义断言使用，避免被其他用例写的文件污染
  await mkdir(join(dir, "listing"));
  await writeFile(join(dir, "listing", "a.txt"), "x\n");
  await mkdir(join(dir, "listing", "sub"));
  await writeFile(join(dir, "listing", "sub", "b.ts"), "x\n");
  await mkdir(join(dir, "node_modules"));
  await writeFile(join(dir, "node_modules", "junk.ts"), "// should be skipped\n");
  await mkdir(join(dir, ".git"));
  await writeFile(join(dir, ".git", "config"), "[core]\n");
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("工具三要素齐备：name / description / input_schema", () => {
  assert.ok(schemas.length >= 6);
  for (const t of schemas) {
    assert.equal(typeof t.name, "string");
    assert.equal(typeof t.description, "string");
    assert.ok(t.input_schema, `${t.name} 缺 input_schema`);
  }
});

test("read_file 返回文件内容", async () => {
  const out = await run("read_file", { file_path: join(dir, "a.txt") });
  assert.ok(out.includes("value = 0"));
});

test("read_file 文件不存在 → 报错前缀", async () => {
  const out = await run("read_file", { file_path: join(dir, "nope.txt") });
  assert.ok(out.startsWith("Error"));
});

test("write_file 创建文件", async () => {
  const p = join(dir, "created.txt");
  const out = await run("write_file", { file_path: p, content: "fresh" });
  assert.ok(out.startsWith("Successfully"));
  assert.equal(await readFile(p, "utf-8"), "fresh");
});

// ── edit_file：施工图点名的三个坑 ──────────────────────────────

test("edit_file old_string 不存在 → 拒绝", async () => {
  const p = join(dir, "a.txt");
  const out = await run("edit_file", {
    file_path: p,
    old_string: "不存在的内容",
    new_string: "x",
  });
  assert.ok(out.includes("not found"));
  assert.ok((await readFile(p, "utf-8")).includes("value = 0"), "文件不应被改动");
});

test("edit_file old_string 出现多次 → 拒绝（必须唯一）", async () => {
  const p = join(dir, "dup.txt");
  await writeFile(p, "value = 0\nvalue = 0\n");
  const out = await run("edit_file", {
    file_path: p,
    old_string: "value = 0",
    new_string: "value = 1",
  });
  assert.ok(out.includes("Must be unique"));
  const content = await readFile(p, "utf-8");
  assert.ok(content.includes("value = 0"), "重复时不改任何一处");
  assert.ok(!content.includes("value = 1"));
});

test("edit_file 唯一匹配 → 替换成功且只改一处", async () => {
  const p = join(dir, "uniq.txt");
  await writeFile(p, "a.txt\nsub/b.ts\n");
  const out = await run("edit_file", {
    file_path: p,
    old_string: "sub/b.ts",
    new_string: "sub/c.ts",
  });
  assert.ok(out.startsWith("Successfully"));
  assert.equal(await readFile(p, "utf-8"), "a.txt\nsub/c.ts\n");
});

test("edit_file 用 split/join：new_string 含 $ 特殊模式时按字面量处理", async () => {
  // String.replace 会把替换串里的 "$&"(匹配本身)/"$1" 当特殊模式展开，
  // split/join 不会——这是源码文档强调的实现细节，必须钉死。
  const p = join(dir, "dollar.txt");
  await writeFile(p, "x");
  await run("edit_file", { file_path: p, old_string: "x", new_string: "$$" });
  assert.equal(await readFile(p, "utf-8"), "$$");
});

test("edit_file old_string 当精确字符串而非正则", async () => {
  // "a.b" 里 . 是正则元字符，但 edit_file 应做精确匹配
  const p = join(dir, "regex.txt");
  await writeFile(p, "a.b\naxb\n");
  await run("edit_file", { file_path: p, old_string: "a.b", new_string: "OK" });
  assert.equal(await readFile(p, "utf-8"), "OK\naxb\n");
});

// ── EOL 保持：跨平台兼容（CRLF 文件不被 edit 成混行换行） ─────────

test("edit_file 在 CRLF 文件上把 new_string 统一转 CRLF，不产生混行", async () => {
  const p = join(dir, "crlf.txt");
  await writeFile(p, "a\r\nb\r\nc\r\n");
  // 模型给的是 LF 风格的新文本
  await run("edit_file", {
    file_path: p,
    old_string: "b",
    new_string: "B1\nB2",
  });
  const content = await readFile(p, "utf-8");
  // 全文件仍保持 CRLF，无裸 \n
  assert.equal(content, "a\r\nB1\r\nB2\r\nc\r\n");
  assert.equal(content.includes("\n\n") || /[^\r]\n/.test(content), false);
});

test("edit_file 在 LF 文件上保持 LF 不误转", async () => {
  const p = join(dir, "lf.txt");
  await writeFile(p, "a\nb\nc\n");
  await run("edit_file", { file_path: p, old_string: "b", new_string: "B" });
  assert.equal(await readFile(p, "utf-8"), "a\nB\nc\n");
});

// ── list_files / grep_search ──────────────────────────────────

test("list_files 跳过 node_modules 与 .git", async () => {
  const out = await run("list_files", { pattern: "**/*.ts", path: dir });
  const files = out.split("\n");
  assert.deepEqual(files.sort(), ["listing/sub/b.ts", "sub/b.ts"]);
  assert.ok(files.every((f) => !f.includes("node_modules") && !f.includes(".git")));
});

test("list_files 单段 * 不跨目录，双段 ** 跨目录", async () => {
  const list = join(dir, "listing");
  const single = await run("list_files", { pattern: "*.txt", path: list });
  assert.deepEqual(single.split("\n").sort(), ["a.txt"]);
  const all = await run("list_files", { pattern: "**/*", path: list });
  assert.ok(all.split("\n").includes("sub/b.ts"));
});

test("grep_search 返回 path:行号:内容 且命中正确行", async () => {
  const out = await run("grep_search", { pattern: "value = 0", path: dir });
  assert.ok(out.startsWith("a.txt:2:"), `实际输出：${out}`);
  assert.ok(!out.includes("junk.ts"), "node_modules 不应被搜到");
});

test("grep_search 非法正则 → 报错而非崩溃", async () => {
  const out = await run("grep_search", { pattern: "([", path: dir });
  assert.ok(out.startsWith("Error"));
});

test("run_shell 执行并捕获输出", async () => {
  const out = await run("run_shell", { command: "echo hi" });
  assert.ok(out.includes("hi"));
});

test("未知工具 → 明确的 Unknown tool", async () => {
  const out = await run("does_not_exist", {});
  assert.ok(out.includes("Unknown tool"));
});