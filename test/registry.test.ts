import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Registry, type RuntimeContext } from '../src/registry.js';
import { registerBuiltinTools } from '../src/tools.js';
import { registerPlanTools } from '../src/plan.js';
import { dirs } from '../src/utils/paths.js';

const ctx = {} as RuntimeContext;

test('register/resolve/list 基本行为', () => {
  const r = new Registry();
  r.register({ name: 'a', description: 'd', inputSchema: {}, handler: () => 'A' });
  r.register({ name: 'b', description: 'd', inputSchema: {}, handler: () => 'B' });
  assert.equal(r.resolve('a')?.name, 'a');
  assert.equal(r.resolve('nope'), undefined);
  assert.equal(r.list().length, 2);
});

test('内置工具经注册表可见齐备（7 个）', () => {
  const r = new Registry();
  registerBuiltinTools(r);
  assert.equal(r.list().length, 7);
  assert.equal(r.resolve('read_file')?.mode, 'read');
  assert.equal(r.resolve('run_shell')?.mode, 'shell');
  assert.equal(r.resolve('write_file')?.mode, 'write');
  assert.equal(r.resolve('file_content')?.mode, 'read');
});

test('toolsSchema：deferred 默认排除，includeDeferred 放开', () => {
  const r = new Registry();
  registerBuiltinTools(r);
  registerPlanTools(r, { plansDir: dirs.plansDir() });
  const normal = r.toolsSchema(false).map((t) => t.name);
  assert.ok(!normal.includes('write_plan'), 'deferred 工具不发给模型');
  assert.ok(normal.includes('read_file'));

  const withPlan = r.toolsSchema(true).map((t) => t.name);
  assert.ok(withPlan.includes('write_plan'), 'plan 模式放开 deferred');
});

test('handler 经注册表可执行（read_file 完整路径）', async () => {
  const r = new Registry();
  registerBuiltinTools(r);
  const mp = r.resolve('read_file');
  assert.ok(mp);
  const here = fileURLToPath(import.meta.url);
  const out = await mp.handler({ file_path: here }, ctx);
  assert.ok(String(out).includes('register/resolve/list'));
});

// ── 禁用前缀（技能/MCP 启停）────────────────────────────────
test('setDisabledPrefixes：命中前缀的工具不出现在 toolsSchema / list', () => {
  const r = new Registry();
  r.register({ name: 'mcp__github__pr', description: 'd', inputSchema: {}, handler: () => '' });
  r.register({ name: 'mcp__github__read_resource', description: 'd', inputSchema: {}, handler: () => '' });
  r.register({ name: 'mcp__jira__issue', description: 'd', inputSchema: {}, handler: () => '' });
  r.register({ name: 'read_file', description: 'd', inputSchema: {}, handler: () => '' });

  r.setDisabledPrefixes(['mcp__github__']);

  const names = r.toolsSchema().map((t) => t.name);
  assert.ok(!names.includes('mcp__github__pr'), 'github 工具隐身');
  assert.ok(!names.includes('mcp__github__read_resource'), 'github 资源工具一并隐身');
  assert.ok(names.includes('mcp__jira__issue'), '别的 server 不受影响');
  assert.ok(names.includes('read_file'), '内置工具不受影响');

  assert.equal(r.list().length, 2, 'list 默认也过滤禁用项');
  assert.equal(r.list(undefined, true).length, 4, 'includeDisabled 能看全量（管理视图用）');
});

test('禁用不影响 resolve：历史里已发出的 tool_use 仍可执行', () => {
  const r = new Registry();
  r.register({ name: 'mcp__github__pr', description: 'd', inputSchema: {}, handler: () => 'ok' });
  r.setDisabledPrefixes(['mcp__github__']);
  // 刻意保留：模型看不到（schema 隐身），但旧会话的 tool_use 不能因此崩掉
  assert.ok(r.resolve('mcp__github__pr'), 'resolve 不做禁用过滤');
  assert.equal(r.isDisabled('mcp__github__pr'), true);
});

test('unregisterByPrefix：一次性摘掉某 server 的全部工具', () => {
  const r = new Registry();
  r.register({ name: 'mcp__github__a', description: 'd', inputSchema: {}, handler: () => '' });
  r.register({ name: 'mcp__github__b', description: 'd', inputSchema: {}, handler: () => '' });
  r.register({ name: 'keep', description: 'd', inputSchema: {}, handler: () => '' });

  const removed = r.unregisterByPrefix('mcp__github__');
  assert.deepEqual(removed.sort(), ['mcp__github__a', 'mcp__github__b']);
  assert.equal(r.resolve('mcp__github__a'), undefined, '已摘除');
  assert.ok(r.resolve('keep'), '无关工具保留');
});
