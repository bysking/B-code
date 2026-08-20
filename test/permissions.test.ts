import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowlistKey,
  checkPermission,
  DANGEROUS_PATTERNS,
  decideExecution,
  type ExecutionContext,
} from '../src/permissions.js';
import type { MountPoint } from '../src/registry.js';

/** 构造最小 MountPoint 测试替身 */
function mp(name: string, mode: MountPoint['mode'] = 'external'): MountPoint {
  return { name, description: '', inputSchema: {}, mode, handler: () => '' };
}

/** 决策上下文替身：分类器/确认框行为可脚本化 */
function execCtx(
  overrides: Partial<{
    mode: ExecutionContext['mode'];
    classify: (name: string, input: Record<string, any>) => Promise<{ allow: boolean; reason: string }>;
    askUser: (q: string) => Promise<boolean>;
  }> = {},
): ExecutionContext {
  return {
    mode: overrides.mode ?? 'default',
    allowlist: new Set<string>(),
    classify: overrides.classify ?? (async () => ({ allow: true, reason: '' })),
    askUser: overrides.askUser ?? (async () => true),
  };
}

test('危险命令在三种模式下都被 deny（含 --yolo）', () => {
  const shell = mp('run_shell', 'shell');
  const dangerous = [
    'rm -rf /tmp/x',
    'git push origin main',
    'git reset --hard HEAD',
    'sudo apt install x',
    'dd if=/dev/zero of=/dev/sda',
    'kill -9 1234',
    'reboot now',
    'shutdown -h now',
    'echo hi > /dev/sda',
  ];
  for (const cmd of dangerous) {
    for (const mode of ['default', 'plan', 'bypass'] as const) {
      assert.equal(checkPermission(shell, { command: cmd }, mode), 'deny', `${mode} 下应 deny: ${cmd}`);
    }
  }
});

test('plan 模式：write/shell/external 全拦，read 放行', () => {
  assert.equal(checkPermission(mp('write_file', 'write'), { file_path: 'a' }, 'plan'), 'deny');
  assert.equal(checkPermission(mp('run_shell', 'shell'), { command: 'pwd' }, 'plan'), 'deny');
  assert.equal(checkPermission(mp('mcp__x__write', 'external'), {}, 'plan'), 'deny');
  assert.equal(checkPermission(mp('read_file', 'read'), { file_path: 'a' }, 'plan'), 'allow');
  assert.equal(checkPermission(mp('list_files', 'read'), { pattern: '*' }, 'plan'), 'allow');
  assert.equal(checkPermission(mp('grep_search', 'read'), { pattern: 'x' }, 'plan'), 'allow');
});

test('plan 模式下 allowInPlan 的工具放行（如 write_plan）', () => {
  const writePlan = mp('write_plan', 'write');
  writePlan.allowInPlan = true;
  assert.equal(checkPermission(writePlan, { plan: 'x' }, 'plan'), 'confirm', '需确认但不禁');
  // plan 下确认会走用户流程；这里断言的是"不是 deny"
  assert.notEqual(checkPermission(writePlan, { plan: 'x' }, 'plan'), 'deny');
});

test('default 模式：read 放行，write/shell/external 需确认', () => {
  assert.equal(checkPermission(mp('read_file', 'read'), { file_path: 'a' }, 'default'), 'allow');
  assert.equal(checkPermission(mp('write_file', 'write'), { file_path: 'a' }, 'default'), 'confirm');
  assert.equal(checkPermission(mp('run_shell', 'shell'), { command: 'ls' }, 'default'), 'confirm');
});

test('fail-closed：未声明 mode 的工具默认 confirm（不默认放行）', () => {
  const unknown = mp('skill:commit'); // 无 mode
  assert.equal(checkPermission(unknown, {}, 'default'), 'confirm');
});

test('bypass 下普通 shell 是 confirm（调用方再跳过），但危险命令仍 deny', () => {
  const shell = mp('run_shell', 'shell');
  assert.equal(checkPermission(shell, { command: 'ls' }, 'bypass'), 'confirm');
  assert.equal(checkPermission(shell, { command: 'rm -rf /' }, 'bypass'), 'deny');
});

test('allowlistKey：shell 用命令内容，其他按工具名', () => {
  assert.equal(allowlistKey(mp('run_shell', 'shell'), { command: 'ls -la' }), 'shell:ls -la');
  assert.equal(allowlistKey(mp('write_file', 'write'), {}), 'write_file');
});

test('危险模式表非空且含核心条目（守卫误删）', () => {
  assert.ok(DANGEROUS_PATTERNS.length >= 10);
  const first = DANGEROUS_PATTERNS[0];
  assert.ok(first);
  assert.equal(first.source, '\\brm\\s+-rf\\b');
  assert.ok(DANGEROUS_PATTERNS.some((re) => re.source.includes('sudo')));
});

// ── decideExecution：完整裁决链（策略化后 agent 的唯一权限入口）────────

test('decideExecution：deny 优先，bypass 也拦，且不进分类器', async () => {
  let classified = 0;
  const ctx = execCtx({
    mode: 'bypass',
    classify: async () => {
      classified++;
      return { allow: true, reason: '' };
    },
  });
  const d = await decideExecution(mp('run_shell', 'shell'), { command: 'rm -rf /' }, ctx);
  assert.equal(d.allow, false);
  assert.ok(d.reason?.includes('Denied'));
  assert.equal(classified, 0, '危险命令直接 deny，分类器不被调用');
});

test('decideExecution：auto 模式 write/shell 走分类器；BLOCK 拦截 ALLOW 放行', async () => {
  const blocked = await decideExecution(
    mp('write_file', 'write'),
    { file_path: 'a' },
    execCtx({
      mode: 'auto',
      classify: async () => ({ allow: false, reason: 'unexpected write' }),
    }),
  );
  assert.equal(blocked.allow, false);
  assert.ok(blocked.reason?.includes('Blocked by auto-mode monitor'));
  assert.ok(blocked.reason?.includes('unexpected write'), '分类器原因透传');

  const allowed = await decideExecution(
    mp('write_file', 'write'),
    { file_path: 'a' },
    execCtx({
      mode: 'auto',
      classify: async () => ({ allow: true, reason: '' }),
    }),
  );
  assert.equal(allowed.allow, true);
});

test('decideExecution：auto 模式下 read 工具不打扰分类器', async () => {
  let classified = 0;
  const d = await decideExecution(
    mp('read_file', 'read'),
    { file_path: 'a' },
    execCtx({
      mode: 'auto',
      classify: async () => {
        classified++;
        return { allow: true, reason: '' };
      },
    }),
  );
  assert.equal(d.allow, true);
  assert.equal(classified, 0, 'read 直接放行');
});

test('decideExecution：confirm 首次询问 + remember，白名单命中二次直接放行', async () => {
  let asks = 0;
  const allowlist = new Set<string>();
  const ctx: ExecutionContext = {
    mode: 'default',
    allowlist,
    classify: async () => ({ allow: true, reason: '' }),
    askUser: async () => {
      asks++;
      return true;
    },
  };
  const first = await decideExecution(mp('write_file', 'write'), { file_path: 'a' }, ctx);
  assert.equal(first.allow, true);
  assert.equal(first.remember, true, '确认通过标记入白名单');
  assert.equal(asks, 1);

  allowlist.add(allowlistKey(mp('write_file', 'write'), { file_path: 'a' }));
  const second = await decideExecution(mp('write_file', 'write'), { file_path: 'a' }, ctx);
  assert.equal(second.allow, true);
  assert.equal(second.remember, undefined, '白名单命中不再重复标记');
  assert.equal(asks, 1, '不再询问');
});

test('decideExecution：confirm 用户拒绝 → 拦截且 remember 未设', async () => {
  const d = await decideExecution(
    mp('write_file', 'write'),
    { file_path: 'a' },
    execCtx({ askUser: async () => false }),
  );
  assert.equal(d.allow, false);
  assert.ok(d.reason?.includes('user rejected'));
});

test('decideExecution：bypass 跳过 confirm 直接放行', async () => {
  const d = await decideExecution(
    mp('write_file', 'write'),
    { file_path: 'a' },
    execCtx({ mode: 'bypass', askUser: async () => false }),
  );
  assert.equal(d.allow, true, 'bypass 不问用户');
});

test('decideExecution：read 工具任何模式放行', async () => {
  for (const mode of ['default', 'plan', 'auto', 'bypass'] as const) {
    const d = await decideExecution(mp('read_file', 'read'), { file_path: 'a' }, execCtx({ mode }));
    assert.equal(d.allow, true, `${mode} 下 read 放行`);
  }
});
