import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { registerBuiltinTools, snippetDiff } from '../src/tools.js';
import { Registry, type RuntimeContext } from '../src/registry.js';
import { FileStore } from '../src/file-store.js';

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
  dir = await mkdtemp(join(tmpdir(), 'b-code-tools-'));
  await writeFile(join(dir, 'a.txt'), 'line one\nvalue = 0\nline three\n');
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, 'sub', 'b.ts'), 'export const b = 1;\n');
  // 独立 fixture：供 glob 语义断言使用，避免被其他用例写的文件污染
  await mkdir(join(dir, 'listing'));
  await writeFile(join(dir, 'listing', 'a.txt'), 'x\n');
  await mkdir(join(dir, 'listing', 'sub'));
  await writeFile(join(dir, 'listing', 'sub', 'b.ts'), 'x\n');
  await mkdir(join(dir, 'node_modules'));
  await writeFile(join(dir, 'node_modules', 'junk.ts'), '// should be skipped\n');
  await mkdir(join(dir, '.git'));
  await writeFile(join(dir, '.git', 'config'), '[core]\n');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('工具三要素齐备：name / description / input_schema', () => {
  assert.ok(schemas.length >= 6);
  for (const t of schemas) {
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.description, 'string');
    assert.ok(t.input_schema, `${t.name} 缺 input_schema`);
  }
});

test('read_file 返回文件内容', async () => {
  const out = await run('read_file', { file_path: join(dir, 'a.txt') });
  assert.ok(out.includes('value = 0'));
});

test('read_file 文件不存在 → 报错前缀', async () => {
  const out = await run('read_file', { file_path: join(dir, 'nope.txt') });
  assert.ok(out.startsWith('Error'));
});

test('write_file 创建文件', async () => {
  const p = join(dir, 'created.txt');
  const out = await run('write_file', { file_path: p, content: 'fresh' });
  assert.ok(out.startsWith('Successfully'));
  assert.equal(await readFile(p, 'utf-8'), 'fresh');
});

// ── edit_file：施工图点名的三个坑 ──────────────────────────────

test('edit_file old_string 不存在 → 拒绝', async () => {
  const p = join(dir, 'a.txt');
  const out = await run('edit_file', {
    file_path: p,
    old_string: '不存在的内容',
    new_string: 'x',
  });
  assert.ok(out.includes('not found'));
  assert.ok((await readFile(p, 'utf-8')).includes('value = 0'), '文件不应被改动');
});

test('edit_file old_string 出现多次 → 拒绝（必须唯一）', async () => {
  const p = join(dir, 'dup.txt');
  await writeFile(p, 'value = 0\nvalue = 0\n');
  const out = await run('edit_file', {
    file_path: p,
    old_string: 'value = 0',
    new_string: 'value = 1',
  });
  assert.ok(out.includes('Must be unique'));
  const content = await readFile(p, 'utf-8');
  assert.ok(content.includes('value = 0'), '重复时不改任何一处');
  assert.ok(!content.includes('value = 1'));
});

test('edit_file 唯一匹配 → 替换成功且只改一处', async () => {
  const p = join(dir, 'uniq.txt');
  await writeFile(p, 'a.txt\nsub/b.ts\n');
  const out = await run('edit_file', {
    file_path: p,
    old_string: 'sub/b.ts',
    new_string: 'sub/c.ts',
  });
  assert.ok(out.startsWith('Successfully'));
  assert.equal(await readFile(p, 'utf-8'), 'a.txt\nsub/c.ts\n');
});

test('edit_file 用 split/join：new_string 含 $ 特殊模式时按字面量处理', async () => {
  // String.replace 会把替换串里的 "$&"(匹配本身)/"$1" 当特殊模式展开，
  // split/join 不会——这是源码文档强调的实现细节，必须钉死。
  const p = join(dir, 'dollar.txt');
  await writeFile(p, 'x');
  await run('edit_file', { file_path: p, old_string: 'x', new_string: '$$' });
  assert.equal(await readFile(p, 'utf-8'), '$$');
});

test('edit_file old_string 当精确字符串而非正则', async () => {
  // "a.b" 里 . 是正则元字符，但 edit_file 应做精确匹配
  const p = join(dir, 'regex.txt');
  await writeFile(p, 'a.b\naxb\n');
  await run('edit_file', { file_path: p, old_string: 'a.b', new_string: 'OK' });
  assert.equal(await readFile(p, 'utf-8'), 'OK\naxb\n');
});

// ── EOL 保持：跨平台兼容（CRLF 文件不被 edit 成混行换行） ─────────

test('edit_file 在 CRLF 文件上把 new_string 统一转 CRLF，不产生混行', async () => {
  const p = join(dir, 'crlf.txt');
  await writeFile(p, 'a\r\nb\r\nc\r\n');
  // 模型给的是 LF 风格的新文本
  await run('edit_file', {
    file_path: p,
    old_string: 'b',
    new_string: 'B1\nB2',
  });
  const content = await readFile(p, 'utf-8');
  // 全文件仍保持 CRLF，无裸 \n
  assert.equal(content, 'a\r\nB1\r\nB2\r\nc\r\n');
  assert.equal(content.includes('\n\n') || /[^\r]\n/.test(content), false);
});

test('edit_file 在 LF 文件上保持 LF 不误转', async () => {
  const p = join(dir, 'lf.txt');
  await writeFile(p, 'a\nb\nc\n');
  await run('edit_file', { file_path: p, old_string: 'b', new_string: 'B' });
  assert.equal(await readFile(p, 'utf-8'), 'a\nB\nc\n');
});

// ── list_files / grep_search ──────────────────────────────────

test('list_files 跳过 node_modules 与 .git', async () => {
  const out = await run('list_files', { pattern: '**/*.ts', path: dir });
  const files = out.split('\n');
  assert.deepEqual(files.sort(), ['listing/sub/b.ts', 'sub/b.ts']);
  assert.ok(files.every((f) => !f.includes('node_modules') && !f.includes('.git')));
});

test('list_files 单段 * 不跨目录，双段 ** 跨目录', async () => {
  const list = join(dir, 'listing');
  const single = await run('list_files', { pattern: '*.txt', path: list });
  assert.deepEqual(single.split('\n').sort(), ['a.txt']);
  const all = await run('list_files', { pattern: '**/*', path: list });
  assert.ok(all.split('\n').includes('sub/b.ts'));
});

test('grep_search 返回 path:行号:内容 且命中正确行', async () => {
  const out = await run('grep_search', { pattern: 'value = 0', path: dir });
  assert.ok(out.startsWith('a.txt:2:'), `实际输出：${out}`);
  assert.ok(!out.includes('junk.ts'), 'node_modules 不应被搜到');
});

test('grep_search 非法正则 → 报错而非崩溃', async () => {
  const out = await run('grep_search', { pattern: '([', path: dir });
  assert.ok(out.startsWith('Error'));
});

test('run_shell 执行并捕获输出', async () => {
  const out = await run('run_shell', { command: 'echo hi' });
  assert.ok(out.includes('hi'));
});

test('run_shell 实时日志：逐块经 ctx.onToolOutput 转发', async () => {
  const chunks: string[] = [];
  const rctx = { ...ctx, onToolOutput: (line: string) => chunks.push(line) } as RuntimeContext;
  const mp = registry.resolve('run_shell')!;
  const out = await Promise.resolve(mp.handler({ command: 'echo realtime' }, rctx) as string);
  assert.ok(out.includes('realtime'), '整体输出仍返回');
  assert.ok(chunks.join('').includes('realtime'), 'onToolOutput 收到增量');
});

test('run_shell 硬中断：ctx.signal abort → 子进程立即终止，结果带中断标记', async () => {
  const ac = new AbortController();
  const rctx = { ...ctx, signal: ac.signal } as RuntimeContext;
  const mp = registry.resolve('run_shell')!;
  const start = Date.now();
  const pending = Promise.resolve(mp.handler({ command: 'sleep 30' }, rctx) as string);
  await new Promise((r) => setTimeout(r, 200)); // 等子进程起来
  ac.abort(); // 用户取消
  const out = await pending;
  assert.ok(Date.now() - start < 10_000, '远早于 sleep 30s：进程被真正杀掉');
  assert.ok(out.includes('interrupted'), `结果带中断标记，实际：${out}`);
});

test('run_shell 硬中断：signal 已 abort 时调用 → 立即返回中断标记', async () => {
  const ac = new AbortController();
  ac.abort();
  const rctx = { ...ctx, signal: ac.signal } as RuntimeContext;
  const mp = registry.resolve('run_shell')!;
  const out = await Promise.resolve(mp.handler({ command: 'sleep 30' }, rctx) as string);
  assert.ok(out.includes('interrupted'));
});

// ── 编辑点 diff ───────────────────────────────────────────────

test('snippetDiff：定位替换点，输出上下文 + 删除/新增行', () => {
  assert.equal(snippetDiff('a\nb\nc\nd\n', 'c', 'C\nC2'), '  b\n- c\n+ C\n+ C2\n  d');
});

test('snippetDiff：old_string 不存在 → 空串', () => {
  assert.equal(snippetDiff('a\nb\n', 'zzz', 'x'), '');
});

test('snippetDiff：单行替换（文件首行，无前上下文）', () => {
  assert.equal(snippetDiff('first\nsecond\n', 'first', 'one'), '- first\n+ one\n  second');
});

test('edit_file 结果包含编辑点 diff（- 旧 / + 新）', async () => {
  const p = join(dir, 'diff.txt');
  await writeFile(p, 'keep1\nold line\nkeep2\n');
  const out = await run('edit_file', {
    file_path: p,
    old_string: 'old line',
    new_string: 'new line',
  });
  assert.ok(out.includes('- old line'), `diff 含旧行: ${out}`);
  assert.ok(out.includes('+ new line'), `diff 含新行: ${out}`);
  assert.ok(out.includes('keep1'), 'diff 带上下文行');
  assert.equal(await readFile(p, 'utf-8'), 'keep1\nnew line\nkeep2\n');
});

test('未知工具 → 明确的 Unknown tool', async () => {
  const out = await run('does_not_exist', {});
  assert.ok(out.includes('Unknown tool'));
});

// ── 文件快照缓存（read_file / write / edit / file_content）─────────────────
const handler = (name: string) => {
  const mp = registry.resolve(name);
  if (!mp) throw new Error(`missing tool ${name}`);
  return (input: unknown, rctx: RuntimeContext) => mp.handler(input as Record<string, any>, rctx);
};
const fileCtx = () => ({ ...ctx, fileStore: new FileStore() }) as RuntimeContext;

test('read_file 首次读：返回全文 + 指针行 + store 快照', async () => {
  const rctx = fileCtx();
  const path = join(dir, 'a.txt');
  const out = await handler('read_file')({ file_path: path }, rctx);
  assert.ok(out.includes('value = 0'), '首次仍返回全文');
  assert.ok(out.includes('📄'), '结果含指针行');
  assert.ok(out.includes('hash '), '指针含 hash');
  assert.ok(rctx.fileStore!.get(resolve(path)), 'store 有快照');
});

test('read_file 非首次且未变：返回指针而非全文（防膨胀）', async () => {
  const rctx = fileCtx();
  const path = join(dir, 'a.txt');
  const first = await handler('read_file')({ file_path: path }, rctx);
  assert.ok(first.includes('value = 0'), '首次全文');
  const second = await handler('read_file')({ file_path: path }, rctx);
  assert.ok(second.includes('already read, unchanged'), '非首次返回指针');
  assert.ok(!second.includes('value = 0'), '不再返回全文');
});

test('read_file 非首次但磁盘已变：返回新全文（旧快照标 dirty）', async () => {
  const rctx = fileCtx();
  const path = join(dir, 'a.txt');
  await handler('read_file')({ file_path: path }, rctx);
  await writeFile(path, 'changed externally\n', 'utf-8');
  const out = await handler('read_file')({ file_path: path }, rctx);
  assert.ok(out.includes('changed externally'), '返回新内容');
  assert.equal(rctx.fileStore!.get(resolve(path))?.dirty, false, '重建后标 fresh');
});

test('write_file 后 store 更新为已知新内容；file_content 取回', async () => {
  const rctx = fileCtx();
  const path = join(dir, 'w.txt');
  await writeFile(path, 'old line\n', 'utf-8');
  await handler('read_file')({ file_path: path }, rctx);
  await handler('write_file')({ file_path: path, content: 'new v1\nnew v2' }, rctx);
  assert.equal(rctx.fileStore!.get(resolve(path))?.content, 'new v1\nnew v2', 'store 更新为已知新内容');
  const out = await handler('file_content')({ file_path: path }, rctx);
  assert.ok(out.includes('new v2'), 'file_content 返回新内容');
  assert.ok(out.includes('unchanged since read'), 'stat 相等标记未变');
});

test('edit_file 后 store 更新为编辑结果', async () => {
  const rctx = fileCtx();
  const path = join(dir, 'e.txt');
  await writeFile(path, 'alpha = 1\n', 'utf-8');
  await handler('read_file')({ file_path: path }, rctx);
  await handler('edit_file')({ file_path: path, old_string: 'alpha = 1', new_string: 'alpha = 2' }, rctx);
  assert.ok(rctx.fileStore!.get(resolve(path))?.content.includes('alpha = 2'), 'store 为编辑后内容');
});

test('file_content status_only 三态：未读 / 未变 / 已变', async () => {
  const rctx = fileCtx();
  const path = join(dir, 'c.txt');
  await writeFile(path, 'c line\n', 'utf-8');
  const notRead = await handler('file_content')({ file_path: path, status_only: true }, rctx);
  assert.ok(notRead.includes('not read this session'), '未读态');
  await handler('read_file')({ file_path: path }, rctx);
  const unchanged = await handler('file_content')({ file_path: path, status_only: true }, rctx);
  assert.ok(unchanged.includes('unchanged'), '未变态');
  await writeFile(path, 'externally changed\n', 'utf-8'); // 外部改，不经工具
  const changed = await handler('file_content')({ file_path: path, status_only: true }, rctx);
  assert.ok(changed.includes('changed since read'), '已变态');
  assert.equal(rctx.fileStore!.get(resolve(path))?.dirty, true, '检测到变化标 dirty');
});

test('file_content 未命中回落磁盘重建快照 + offset/limit 切片', async () => {
  const rctx = fileCtx();
  const path = join(dir, 'fc.txt');
  await writeFile(path, 'line one\nline two\nline three\n', 'utf-8');
  // 未命中（未 read_file）→ 回落磁盘
  const out = await handler('file_content')({ file_path: path }, rctx);
  assert.ok(out.includes('line two'), '回落磁盘返回内容');
  assert.ok(out.includes('refreshed'), '回落重建标 refreshed');
  assert.ok(rctx.fileStore!.get(resolve(path)), '回落重建快照');
  // 切片：offset=0 limit=1 只回第一行
  const sliced = await handler('file_content')({ file_path: path, offset: 0, limit: 1 }, rctx);
  assert.ok(sliced.includes('line one'), '切片含第一行');
  assert.ok(!sliced.includes('line two'), '切片不含第二行');
});

test('file_content 不存在文件 → Error 前缀', async () => {
  const rctx = fileCtx();
  const out = await handler('file_content')({ file_path: join(dir, 'nope.txt') }, rctx);
  assert.ok(out.startsWith('Error'));
});
