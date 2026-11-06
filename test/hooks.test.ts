import { test, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeScriptCommand } from './helpers/script-command.js';
import {
  loadHooks,
  matchesTool,
  parseHookDecision,
  runHooks,
  selectHooks,
  type HooksConfig,
} from '../src/hooks.js';

let hooksDir: string;

/** 跨平台 hook 命令的构造（为什么不能写 `node -e '...'` 见 helpers/script-command.ts） */
const nodeScript = (body: string) => writeScriptCommand(hooksDir, body);

beforeAll(async () => {
  hooksDir = await mkdtemp(join(tmpdir(), 'b-code-hooks-'));
});

afterAll(async () => {
  await rm(hooksDir, { recursive: true, force: true });
});

test('loadHooks：缺省 {}，读到对象则原样返回', () => {
  assert.deepEqual(loadHooks({}), {});
  const cfg = { PreToolUse: [{ command: 'x' }] };
  assert.deepEqual(loadHooks({ hooks: cfg }), cfg);
  assert.deepEqual(loadHooks({ hooks: 'bad' as never }), {});
});

test('matchesTool：空 matcher 全匹配；正则匹配；非法正则退化为全匹配', () => {
  assert.equal(matchesTool(undefined, 'run_shell'), true);
  assert.equal(matchesTool('', 'anything'), true);
  assert.equal(matchesTool('^write_', 'write_file'), true);
  assert.equal(matchesTool('^write_', 'read_file'), false);
  assert.equal(matchesTool('([', 'read_file'), true, '非法正则不吞 hook');
});

test('selectHooks：按事件取列表并按工具名过滤', () => {
  const cfg: HooksConfig = {
    PreToolUse: [{ command: 'a', matcher: '^write_' }, { command: 'b' }],
    PostToolUse: [{ command: 'c' }],
  };
  assert.deepEqual(
    selectHooks(cfg, 'PreToolUse', 'write_file').map((h) => h.command),
    ['a', 'b'],
  );
  assert.deepEqual(
    selectHooks(cfg, 'PreToolUse', 'read_file').map((h) => h.command),
    ['b'],
  );
  assert.equal(selectHooks(cfg, 'UserPromptSubmit').length, 0);
});

test('parseHookDecision：识别 block 决策 JSON（取最后一行 JSON）', () => {
  assert.deepEqual(parseHookDecision('{"decision":"block","reason":"no"}'), {
    block: true,
    reason: 'no',
  });
  assert.deepEqual(parseHookDecision('log line\n{"decision":"block"}'), {
    block: true,
    reason: 'blocked by hook',
  });
  assert.deepEqual(parseHookDecision('{"decision":"allow"}'), { block: false, reason: '' });
  assert.deepEqual(parseHookDecision('not json'), { block: false, reason: '' });
});

test('runHooks：无匹配 hook → 直接放行（不 spawn）', async () => {
  const out = await runHooks({}, 'PreToolUse', { cwd: process.cwd() }, 'read_file');
  assert.equal(out.blocked, false);
  assert.equal(out.stdout, '');
});

test('runHooks：命令 stdout 作为附加上下文汇聚', async () => {
  const cfg: HooksConfig = {
    PostToolUse: [{ command: await nodeScript('process.stdout.write("hello-hook");') }],
  };
  const out = await runHooks(cfg, 'PostToolUse', { cwd: process.cwd() }, 'read_file');
  assert.equal(out.blocked, false);
  assert.ok(out.stdout.includes('hello-hook'));
});

test('runHooks：退出码 2 → 拦截（stderr 作为原因）', async () => {
  const cmd = await nodeScript('process.stderr.write("rejected!"); process.exit(2);');
  const cfg: HooksConfig = { PreToolUse: [{ command: cmd }] };
  const out = await runHooks(cfg, 'PreToolUse', { cwd: process.cwd() }, 'run_shell');
  assert.equal(out.blocked, true);
  assert.ok(out.reason.includes('rejected!'));
});

test('runHooks：stdout 决策 JSON block → 拦截', async () => {
  const cmd = await nodeScript(
    'process.stdout.write(JSON.stringify({ decision: "block", reason: "policy" }));',
  );
  const cfg: HooksConfig = { PreToolUse: [{ command: cmd }] };
  const out = await runHooks(cfg, 'PreToolUse', { cwd: process.cwd() }, 'write_file');
  assert.equal(out.blocked, true);
  assert.equal(out.reason, 'policy');
});

test('runHooks：非零非 2 退出码 → 仅告警不拦截（fail-open）', async () => {
  // 先证明这个脚本**真的跑起来了**再谈退出码：让它留个标记文件。
  // 只断言 blocked=false 的话，"命令根本没执行成功"也会让用例变绿——
  // 这条曾经就是假绿（`node -e 'process.exit(3)'` 在 Windows 上 exit 0 而不是 3）
  const marker = join(hooksDir, 'ran-exit3.txt');
  const cmd = await nodeScript(
    [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(marker)}, "ran");`,
      'process.exit(3);',
    ].join('\n'),
  );
  const cfg: HooksConfig = { PreToolUse: [{ command: cmd }] };
  const out = await runHooks(cfg, 'PreToolUse', { cwd: process.cwd() }, 'read_file');
  assert.equal(out.blocked, false, '退出码 3 → fail-open');
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(marker, 'utf-8'), 'ran', '脚本确实执行了（不是假绿）');
});

test('runHooks：matcher 命中才执行（不匹配的工具跳过）', async () => {
  const cfg: HooksConfig = {
    PreToolUse: [{ command: await nodeScript('process.stdout.write("W");'), matcher: '^write_' }],
  };
  const write = await runHooks(cfg, 'PreToolUse', { cwd: process.cwd() }, 'write_file');
  assert.ok(write.stdout.includes('W'), '匹配工具 → 执行');
  const read = await runHooks(cfg, 'PreToolUse', { cwd: process.cwd() }, 'read_file');
  assert.equal(read.stdout, '', '不匹配工具 → 跳过');
});

test('runHook：stdin 收到事件 JSON（协议兼容）', async () => {
  // hook 读 stdin 后原样回显，验证 payload 送达
  const cmd = await nodeScript(
    [
      'let s = "";',
      'process.stdin.on("data", (c) => (s += c)).on("end", () => process.stdout.write(s));',
    ].join('\n'),
  );
  const cfg: HooksConfig = { UserPromptSubmit: [{ command: cmd }] };
  const out = await runHooks(cfg, 'UserPromptSubmit', { cwd: process.cwd(), prompt: 'hi there' });
  assert.ok(out.stdout.includes('UserPromptSubmit'), 'payload 含事件名');
  assert.ok(out.stdout.includes('hi there'), 'payload 含 prompt');
});
