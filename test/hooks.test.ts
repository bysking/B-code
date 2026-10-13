import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadHooks,
  matchesTool,
  parseHookDecision,
  runHooks,
  selectHooks,
  type HooksConfig,
} from '../src/hooks.js';

/** 跨平台 shell 命令：输出一段文本（单引号包裹 node 脚本，避免 sh 引号冲突） */
const nodeEcho = (text: string) => `node -e 'process.stdout.write(${JSON.stringify(text)})'`;

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
  const cfg: HooksConfig = { PostToolUse: [{ command: nodeEcho('hello-hook') }] };
  const out = await runHooks(cfg, 'PostToolUse', { cwd: process.cwd() }, 'read_file');
  assert.equal(out.blocked, false);
  assert.ok(out.stdout.includes('hello-hook'));
});

test('runHooks：退出码 2 → 拦截（stderr 作为原因）', async () => {
  const cmd = `node -e 'process.stderr.write("rejected!"); process.exit(2)'`;
  const cfg: HooksConfig = { PreToolUse: [{ command: cmd }] };
  const out = await runHooks(cfg, 'PreToolUse', { cwd: process.cwd() }, 'run_shell');
  assert.equal(out.blocked, true);
  assert.ok(out.reason.includes('rejected!'));
});

test('runHooks：stdout 决策 JSON block → 拦截', async () => {
  const cmd = nodeEcho('{"decision":"block","reason":"policy"}');
  const cfg: HooksConfig = { PreToolUse: [{ command: cmd }] };
  const out = await runHooks(cfg, 'PreToolUse', { cwd: process.cwd() }, 'write_file');
  assert.equal(out.blocked, true);
  assert.equal(out.reason, 'policy');
});

test('runHooks：非零非 2 退出码 → 仅告警不拦截（fail-open）', async () => {
  const cfg: HooksConfig = { PreToolUse: [{ command: `node -e 'process.exit(3)'` }] };
  const out = await runHooks(cfg, 'PreToolUse', { cwd: process.cwd() }, 'read_file');
  assert.equal(out.blocked, false);
});

test('runHooks：matcher 命中才执行（不匹配的工具跳过）', async () => {
  const cfg: HooksConfig = { PreToolUse: [{ command: nodeEcho('W'), matcher: '^write_' }] };
  const write = await runHooks(cfg, 'PreToolUse', { cwd: process.cwd() }, 'write_file');
  assert.ok(write.stdout.includes('W'), '匹配工具 → 执行');
  const read = await runHooks(cfg, 'PreToolUse', { cwd: process.cwd() }, 'read_file');
  assert.equal(read.stdout, '', '不匹配工具 → 跳过');
});

test('runHook：stdin 收到事件 JSON（协议兼容）', async () => {
  // hook 读 stdin 后原样回显，验证 payload 送达
  const cmd = `node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(s))'`;
  const cfg: HooksConfig = { UserPromptSubmit: [{ command: cmd }] };
  const out = await runHooks(cfg, 'UserPromptSubmit', { cwd: process.cwd(), prompt: 'hi there' });
  assert.ok(out.stdout.includes('UserPromptSubmit'), 'payload 含事件名');
  assert.ok(out.stdout.includes('hi there'), 'payload 含 prompt');
});
