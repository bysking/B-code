import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  allowlistHas,
  allowlistKey,
  checkPermission,
  DANGEROUS_PATTERNS,
  SENSITIVE_PATTERNS,
  decideExecution,
  isCatastrophicTarget,
  isEphemeralCommand,
  isPersistableKey,
  loadAllowlist,
  matchAllowlist,
  MAX_ALLOW_KEY_LENGTH,
  MAX_ALLOWLIST_SIZE,
  mergeAllowlistKeys,
  normalizeCommand,
  persistAllowlist,
  persistedKey,
  mcpServerKey,
  RM_RECURSIVE_FORCE_RE,
  rmTargets,
  stripQuotedLiteral,
  type ExecutionContext,
  type AllowlistStore,
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
    allowlist: Set<string>;
    classify: (name: string, input: Record<string, any>) => Promise<{ allow: boolean; reason: string }>;
    askUser: (q: string) => Promise<boolean>;
  }> = {},
): ExecutionContext {
  return {
    mode: overrides.mode ?? 'default',
    allowlist: overrides.allowlist ?? new Set<string>(),
    classify: overrides.classify ?? (async () => ({ allow: true, reason: '' })),
    askUser: overrides.askUser ?? (async () => true),
  };
}

test('危险命令在任何模式下都被 deny（含 --yolo）', () => {
  const shell = mp('run_shell', 'shell');
  const dangerous = [
    'git reset --hard HEAD',
    'sudo apt install x',
    'dd if=/dev/zero of=/dev/sda',
    'mkfs.ext4 /dev/sda1',
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

test('误杀防线：kill-port / add / dd-utils 等合法命令不被 deny', () => {
  const shell = mp('run_shell', 'shell');
  const benign = [
    'npm run kill-port',
    'git add .', // 含 "dd" 但不是 dd 命令
    'pkill -f node', // 注意：未列入危险词（无 boundary kill）
    'ls dd-utils',
    'prettier --check src',
  ];
  for (const cmd of benign) {
    assert.notEqual(
      checkPermission(shell, { command: cmd }, 'default'),
      'deny',
      `不应 deny 合法命令: ${cmd}`,
    );
  }
});

test('命令边界：kill/reboot 出现在语句分隔符后仍被 deny', () => {
  const shell = mp('run_shell', 'shell');
  assert.equal(checkPermission(shell, { command: 'echo hi; kill -9 1' }, 'default'), 'deny');
  assert.equal(checkPermission(shell, { command: 'true && reboot' }, 'default'), 'deny');
  assert.equal(checkPermission(shell, { command: 'a | shutdown now' }, 'default'), 'deny');
});

// ── 星号不是危险信号 ────────────────────────────────────────────────
// 曾经的真实抱怨："带星号的命令全被拒"。带 `*` 的 glob 只是普通命令，
// 走到 ⑤ fail-closed 的 confirm（问用户），绝不该 deny。

test('带星号的 glob 命令不被 deny（只是普通命令，走 confirm）', () => {
  const shell = mp('run_shell', 'shell');
  for (const cmd of [
    'ls *',
    'ls *.ts',
    'rm *.log',
    'cp src/*.ts dist/',
    'git diff *',
    'find . -name "*.ts"',
  ]) {
    for (const mode of ['default', 'bypass'] as const) {
      assert.notEqual(checkPermission(shell, { command: cmd }, mode), 'deny', `不应 deny: ${cmd}`);
    }
  }
});

// ── /dev/null 降噪：最常见的重定向习惯，不能被当成"写设备" ──────────

test('重定向到 /dev/null 等安全节点不被 deny（写裸设备仍 deny）', () => {
  const shell = mp('run_shell', 'shell');
  for (const cmd of [
    'ls 2>/dev/null',
    'command -v rg >/dev/null 2>&1',
    'cat x.txt > /dev/null',
    'npm ls 2> /dev/null',
  ]) {
    assert.notEqual(checkPermission(shell, { command: cmd }, 'default'), 'deny', `不应 deny: ${cmd}`);
  }
  // 真设备仍拦，引号挡不住
  for (const cmd of ['echo hi > /dev/sda', 'echo hi > "/dev/sda"', 'dd of=/dev/rdisk2']) {
    assert.equal(checkPermission(shell, { command: cmd }, 'default'), 'deny', `应 deny: ${cmd}`);
  }
});

// ── 字面量 ≠ 命令：只是"提到"危险词不该拦 ──────────────────────────

test('引号内的危险词只是字面量时不被 deny（真执行仍 deny）', () => {
  const shell = mp('run_shell', 'shell');
  for (const cmd of ['git commit -m "add sudo docs"', 'git log --grep "rm -rf"', 'echo "git reset --hard"']) {
    assert.notEqual(checkPermission(shell, { command: cmd }, 'default'), 'deny', `不应 deny: ${cmd}`);
  }
  // 嵌套 shell 里的引号内容会被真正执行 → 不剥离，仍 deny
  assert.equal(checkPermission(shell, { command: 'bash -c "sudo rm -x"' }, 'default'), 'deny');
});

// ── rm 分级：目标决定命运 ───────────────────────────────────────────
// 本仓库刻意不提供 delete_file（删除只能走 shell），因此 `rm -rf dist`
// 这类日常清理必须可用；而 `rm -rf /` 必须硬拦。

test('rm 日常清理：confirm（可授权持久化免问），不 deny', () => {
  const shell = mp('run_shell', 'shell');
  for (const cmd of [
    'rm -rf node_modules',
    'rm -rf dist .next build',
    'rm -rf /tmp/bcode-1234',
    'rm -rf ./coverage && npm test',
  ]) {
    assert.equal(checkPermission(shell, { command: cmd }, 'default'), 'confirm', `应 confirm: ${cmd}`);
  }
});

test('rm 变体写法同样识别（-fr / -r -f / -Rf / --recursive --force）', () => {
  const shell = mp('run_shell', 'shell');
  // 既不漏：变体也进分级；也不误判：目标是项目内 → confirm
  for (const cmd of [
    'rm -fr dist',
    'rm -r -f dist',
    'rm -Rf dist',
    'rm --recursive --force dist',
    'rm -rfv dist',
    'rm -R dist -f',
  ]) {
    assert.equal(checkPermission(shell, { command: cmd }, 'default'), 'confirm', `应 confirm: ${cmd}`);
  }
  // 变体 + 灾难目标 → 仍 deny（原实现只认字面 `rm -rf`，这些全漏）
  for (const cmd of ['rm -fr /', 'rm -r -f ~', 'rm --recursive --force /usr']) {
    assert.equal(checkPermission(shell, { command: cmd }, 'default'), 'deny', `应 deny: ${cmd}`);
  }
});

test('rm 灾难目标：任何模式都 deny（含 bypass）', () => {
  const shell = mp('run_shell', 'shell');
  const catastrophic = [
    'rm -rf /',
    'rm -rf ~',
    'rm -rf *',
    'rm -rf .',
    'rm -rf ./',
    'rm -rf $HOME',
    'rm -rf "$DIR"',
    'rm -rf /usr',
    'rm -rf /etc',
    'bash -c "rm -rf /"', // 嵌套 shell：提不出目标 → 按最坏算
  ];
  for (const cmd of catastrophic) {
    for (const mode of ['default', 'plan', 'bypass'] as const) {
      assert.equal(checkPermission(shell, { command: cmd }, mode), 'deny', `${mode} 下应 deny: ${cmd}`);
    }
  }
});

test('rm 日常清理在 plan 模式下仍 deny（② plan 只读契约不被 rm 分级绕过）', () => {
  const shell = mp('run_shell', 'shell');
  assert.equal(checkPermission(shell, { command: 'rm -rf dist' }, 'plan'), 'deny');
});

test('敏感命令 git push：default/auto 需确认，plan deny，bypass 也需确认（不再一刀切）', () => {
  const shell = mp('run_shell', 'shell');
  const cmd = { command: 'git push origin main' };
  assert.equal(checkPermission(shell, cmd, 'default'), 'confirm', '默认需确认（可授权免问）');
  assert.equal(checkPermission(shell, cmd, 'auto'), 'confirm', 'auto 下也需人工确认，不走分类器');
  assert.equal(checkPermission(shell, cmd, 'plan'), 'deny', 'plan 只读契约仍 deny 非 read');
  assert.equal(checkPermission(shell, cmd, 'bypass'), 'confirm', 'bypass 下敏感命令仍要确认');
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
  assert.ok(DANGEROUS_PATTERNS.length >= 7);
  assert.ok(DANGEROUS_PATTERNS.some((re) => re.source.includes('sudo')));
  // git push 已移出"无条件 deny"表，进入可授权的敏感表
  assert.ok(!DANGEROUS_PATTERNS.some((re) => re.source.includes('git\\s+push')));
  assert.ok(SENSITIVE_PATTERNS.some((re) => re.source.includes('git\\s+push')));
  // rm 刻意不在无条件 deny 表：破坏力取决于目标，改走 checkRm 分级
  assert.ok(!DANGEROUS_PATTERNS.some((re) => re.source.includes('rm')), 'rm 应已移交 checkRm 分级');
  assert.ok(RM_RECURSIVE_FORCE_RE.source.includes('rm'));
});

// ── 分级逻辑的单元边界 ──────────────────────────────────────────────

test('rmTargets：只认命令位的 rm，字符串里的 rm 不算', () => {
  assert.deepEqual(rmTargets('rm -rf dist'), ['dist']);
  assert.deepEqual(rmTargets('rm -rf dist node_modules'), ['dist', 'node_modules']);
  assert.deepEqual(rmTargets('sudo rm -rf /tmp/x'), ['/tmp/x']);
  assert.deepEqual(rmTargets('cd a && rm -rf b; echo rm -rf c'.replace('echo rm -rf c', 'ls')), ['b']);
  assert.deepEqual(rmTargets('rm -rf -- -weird-name'), ['-weird-name'], '`--` 之后全是操作对象');
  assert.deepEqual(rmTargets('git rm -rf dist'), [], 'git rm 不是 rm 命令位');
  assert.deepEqual(rmTargets('echo "rm -rf x"'), [], '引号内不是命令位');
});

test('isCatastrophicTarget：等价写法归一后判定（. / ./ / cwd 同档）', () => {
  for (const t of ['/', '~', '*', '.', './', '..', '$HOME', '$(pwd)', '""', '', '/usr', '/Users']) {
    assert.equal(isCatastrophicTarget(t), true, `应判为灾难级: ${JSON.stringify(t)}`);
  }
  for (const t of ['dist', './dist', 'node_modules', '/tmp/x', '/Users/me/proj/dist', 'src/*.ts']) {
    assert.equal(isCatastrophicTarget(t), false, `不应判为灾难级: ${t}`);
  }
  // 删掉整个工作目录 == 灾难
  assert.equal(isCatastrophicTarget(process.cwd()), true);
});

test('stripQuotedLiteral：挖空死字面量；嵌套 shell 里把内容提到命令位', () => {
  // 普通命令：引号内是死字面量，挖空
  assert.equal(stripQuotedLiteral('git commit -m "add sudo docs"'), 'git commit -m ""');
  // 嵌套 shell：引号内会被真正执行 → 提成 `; <内容>`，让命令边界规则命中
  assert.equal(stripQuotedLiteral('bash -c "sudo rm -x"'), 'bash -c ; sudo rm -x');
});

// ── 持久化白名单（settings.json permissions.allow 的键与读写契约）────────

test('persistedKey：按工具/文件/命令取值，内容不影响键（避免永不失配）', () => {
  // 文件类：按 file_path，不按 content（内容每次都变，含它会永不命中）
  const a = persistedKey(mp('write_file', 'write'), { file_path: '/x', content: 'hi' });
  const b = persistedKey(mp('write_file', 'write'), { file_path: '/x', content: 'different content' });
  assert.equal(a, b, '同文件不同内容 → 同键');
  assert.equal(a, 'write_file:/x');
  assert.notEqual(a, persistedKey(mp('write_file', 'write'), { file_path: '/y' }));
  // shell：按命令整串
  assert.equal(
    persistedKey(mp('run_shell', 'shell'), { command: 'git push origin main' }),
    'shell:git push origin main',
  );
  // 无 file_path：退回工具名（如自定义 external 工具）
  assert.equal(persistedKey(mp('mcp__x__thing', 'external'), {}), 'mcp__x__thing');
});

test('loadAllowlist / persistAllowlist：载入 + 去重写回（真实存储确定性）', () => {
  let stored: string[] = ['write_file:/a'];
  const store: AllowlistStore = {
    load: () => [...stored],
    save: (keys) => {
      stored = keys;
    },
  };
  const set = new Set<string>();
  loadAllowlist(store, set);
  assert.ok(set.has('write_file:/a'), '启动载入持久化白名单');

  persistAllowlist(store, 'shell:git push origin main');
  persistAllowlist(store, 'shell:git push origin main'); // 重复写去重
  assert.deepEqual(stored.sort(), ['shell:git push origin main', 'write_file:/a'].sort());

  const set2 = new Set<string>();
  loadAllowlist(store, set2);
  assert.equal(set2.size, 2);
});

test('loadAllowlist：store 抛错时静默（不阻断启动）', () => {
  const bad: AllowlistStore = {
    load: () => {
      throw new Error('disk on fire');
    },
    save: () => {},
  };
  const set = new Set<string>();
  assert.doesNotThrow(() => loadAllowlist(bad, set));
  assert.equal(set.size, 0);
});

// ── 通配折叠：`*` 合并同类授权，避免白名单无限累计 ──────────────────

test('matchAllowlist：`*` 通配任意后缀，无 `*` 时退化为全等（正则元字符按字面量）', () => {
  assert.equal(matchAllowlist('write_file:/a/b/c', 'write_file:/a/b/*'), true);
  assert.equal(
    matchAllowlist('write_file:/a/b', 'write_file:/a/b/*'),
    false,
    '前缀须含分隔符，不回退到父目录',
  );
  assert.equal(matchAllowlist('shell:git push origin main', 'shell:git push *'), true);
  assert.equal(matchAllowlist('write_file:/a', 'write_file:/a'), true, '全等命中');
  assert.equal(matchAllowlist('write_file:/a', 'write_file:/b'), false);
  // 正则元字符按字面量：`a+` 不应被当作量词
  assert.equal(matchAllowlist('write_file:/a+b', 'write_file:/a+*'), true);
  assert.equal(matchAllowlist('write_file:/aab', 'write_file:/a+*'), false);
});

test('allowlistHas：精确命中或任一通配键命中', () => {
  const set = new Set(['write_file:/a/b/*']);
  assert.equal(allowlistHas(set, 'write_file:/a/b/c'), true, '通配命中');
  assert.equal(allowlistHas(set, 'write_file:/x/y'), false);
  assert.equal(allowlistHas(new Set(['write_file:/x']), 'write_file:/x'), true, '精确命中');
});

test('mergeAllowlistKeys：同前缀折叠成 `工具:前缀/*`，不同工具互不干扰', () => {
  const merged = mergeAllowlistKeys([
    'write_file:/Users/me/proj/a.ts',
    'write_file:/Users/me/proj/b.ts',
    'write_file:/Users/me/proj/c.ts',
  ]);
  assert.deepEqual(merged, ['write_file:/Users/me/proj/*']);
});

test('mergeAllowlistKeys：shell 命令按词边界折叠（保留尾部空格）', () => {
  const merged = mergeAllowlistKeys(['shell:git push origin main', 'shell:git push origin dev']);
  assert.deepEqual(merged, ['shell:git push origin *']);
});

test('mergeAllowlistKeys：边界外不折叠（前缀不以分隔符结尾）', () => {
  // `/Users/me/proj` 与 `/Users/me/proj2` 的公共前缀不含尾部 `/` → 不合并
  const merged = mergeAllowlistKeys(['write_file:/Users/me/proj', 'write_file:/Users/me/proj2']);
  assert.deepEqual(merged, ['write_file:/Users/me/proj', 'write_file:/Users/me/proj2']);
});

test('mergeAllowlistKeys：过短前缀不折叠（宁可不合并，也不放宽）', () => {
  // 公共前缀 `/a/` 去掉分隔符后仅 2 字符 < MIN_MERGE_PREFIX → 保持原样
  const merged = mergeAllowlistKeys(['write_file:/a/b', 'write_file:/a/c']);
  assert.deepEqual(merged, ['write_file:/a/b', 'write_file:/a/c']);
});

test('mergeAllowlistKeys：已存在的通配键吸收被覆盖的具体键', () => {
  const merged = mergeAllowlistKeys(['write_file:/a/b/*', 'write_file:/a/b/c', 'write_file:/a/b/d']);
  assert.deepEqual(merged, ['write_file:/a/b/*']);
});

test('persistAllowlist：写入时自动折叠历史累计', () => {
  let stored: string[] = ['write_file:/Users/me/proj/a.ts', 'write_file:/Users/me/proj/b.ts'];
  const store: AllowlistStore = {
    load: () => [...stored],
    save: (keys) => {
      stored = keys;
    },
  };
  persistAllowlist(store, 'write_file:/Users/me/proj/c.ts');
  assert.deepEqual(stored, ['write_file:/Users/me/proj/*'], '追加后收敛为通配键');
});

test('loadAllowlist：载入时顺手折叠历史累计并回写', () => {
  let stored: string[] = ['write_file:/Users/me/proj/a.ts', 'write_file:/Users/me/proj/b.ts'];
  const store: AllowlistStore = {
    load: () => [...stored],
    save: (keys) => {
      stored = keys;
    },
  };
  const set = new Set<string>();
  loadAllowlist(store, set);
  assert.deepEqual([...set], ['write_file:/Users/me/proj/*']);
  assert.deepEqual(stored, ['write_file:/Users/me/proj/*'], '折叠结果回写落盘');
});

test('decideExecution：通配键命中 → 新文件免问直接放行', async () => {
  const allowlist = new Set<string>();
  allowlist.add(persistedKey(mp('write_file', 'write'), { file_path: '/Users/me/proj/a.ts' }));
  // 用一条已折叠的通配键替换（模拟上次合并结果）
  allowlist.clear();
  allowlist.add('write_file:/Users/me/proj/*');
  let asks = 0;
  const d = await decideExecution(
    mp('write_file', 'write'),
    { file_path: '/Users/me/proj/new.ts' },
    execCtx({ allowlist, askUser: async () => (asks++, false) }),
  );
  assert.equal(d.allow, true, '通配键命中 → 免问');
  assert.equal(asks, 0, '不再询问');
});

test('decideExecution：持久化键命中 → 敏感命令免问直接放行', async () => {
  const allowlist = new Set<string>();
  allowlist.add(persistedKey(mp('run_shell', 'shell'), { command: 'git push origin main' }));
  const d = await decideExecution(
    mp('run_shell', 'shell'),
    { command: 'git push origin main' },
    execCtx({ allowlist, askUser: async () => false }),
  );
  assert.equal(d.allow, true, '持久化白名单命中 → 不再问用户');
});

test('decideExecution：敏感命令在 bypass 下仍需确认（不被 skip）', async () => {
  let asks = 0;
  const d = await decideExecution(
    mp('run_shell', 'shell'),
    { command: 'git push' },
    execCtx({ mode: 'bypass', askUser: async () => (asks++, false) }),
  );
  assert.equal(asks, 1, 'bypass 下敏感命令仍触发确认');
  assert.equal(d.allow, false, '用户拒绝 → 拦截');
});

test('decideExecution：敏感命令在 auto 下不走分类器，走人工确认', async () => {
  let classified = 0;
  let asked = 0;
  const d = await decideExecution(
    mp('run_shell', 'shell'),
    { command: 'git push origin main' },
    execCtx({
      mode: 'auto',
      classify: async () => (classified++, { allow: true, reason: '' }),
      askUser: async () => (asked++, true),
    }),
  );
  assert.equal(classified, 0, '敏感命令跳过 auto 分类器');
  assert.equal(asked, 1, '改走人工确认');
  assert.equal(d.allow, true);
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

// ── 白名单去噪：归一化 + 准入规则 + 容量上限（防冗余 / 防爆）──────────

test('normalizeCommand：折叠空白/换行为单空格并去首尾（键稳定，消除格式抖动）', () => {
  assert.equal(normalizeCommand('ls   -la'), 'ls -la');
  assert.equal(normalizeCommand('  a\n\tb  '), 'a b');
  assert.equal(
    normalizeCommand('node -e "\nconst x=1\n"'),
    'node -e " const x=1 "',
    '换行折成空格，逻辑内容不变',
  );
});

test('allowlistKey / persistedKey：多行与单行同命令 → 同键（否则白名单永不命中）', () => {
  const one = 'git status --short';
  const multi = 'git   status\n--short';
  assert.equal(
    allowlistKey(mp('run_shell', 'shell'), { command: one }),
    allowlistKey(mp('run_shell', 'shell'), { command: multi }),
    '格式不同、语义相同 → 同键',
  );
  assert.equal(
    persistedKey(mp('run_shell', 'shell'), { command: multi }),
    persistedKey(mp('run_shell', 'shell'), { command: one }),
  );
});

test('isEphemeralCommand：识别 inline / heredoc / 命令替换等一次性命令', () => {
  assert.equal(isEphemeralCommand(`node -e "console.log(1)"`), true);
  assert.equal(isEphemeralCommand(`python -c "print(1)"`), true);
  assert.equal(isEphemeralCommand('cat <<EOF\nhi\nEOF'), true);
  assert.equal(isEphemeralCommand('echo $(date)'), true);
  assert.equal(isEphemeralCommand('echo `date`'), true);
  // 常规命令不算一次性
  assert.equal(isEphemeralCommand('ls -la'), false);
  assert.equal(isEphemeralCommand('git push origin main'), false);
  assert.equal(isEphemeralCommand('npm test'), false);
});

test('isPersistableKey：超长 / 一次性 / 空值不入白名单；常规命令可入', () => {
  assert.equal(isPersistableKey('shell:ls -la'), true);
  assert.equal(isPersistableKey('save_memory'), true);
  assert.equal(isPersistableKey('write_file:/Users/me/proj/a.ts'), true);
  // 一次性命令：内容每次都变，落盘永不失配
  assert.equal(isPersistableKey(`shell:node -e "console.log(1)"`), false);
  assert.equal(isPersistableKey('shell:echo $(date)'), false);
  // 超长：几乎必然是一次性脚本，且会撑爆配置
  assert.equal(isPersistableKey('shell:' + 'x'.repeat(MAX_ALLOW_KEY_LENGTH + 10)), false);
  // 空值无授权意义
  assert.equal(isPersistableKey('shell:'), false);
  assert.equal(isPersistableKey(''), false);
});

test('mergeAllowlistKeys：丢弃一次性命令与超长条目（清洗历史垃圾）', () => {
  const merged = mergeAllowlistKeys([
    'shell:ls -la',
    `shell:node -e "\nconst a=1;\n"`, // 一次性 inline
    'shell:cd /proj && cat > tmp/x.ts <<EOF\nhi\nEOF', // heredoc
    'shell:' + 'y'.repeat(MAX_ALLOW_KEY_LENGTH + 1), // 超长
  ]);
  assert.deepEqual(merged, ['shell:ls -la'], '只留可复用的常规命令');
});

test('mergeAllowlistKeys：换行命令归一化后与同义单行合并去重', () => {
  const merged = mergeAllowlistKeys([
    'shell:git status --short',
    'shell:git   status\n--short', // 归一化后与上条相同
  ]);
  assert.deepEqual(merged, ['shell:git status --short'], '归一化去重为一条');
});

test('mergeAllowlistKeys：条目数超过上限时截断（防爆）', () => {
  const many = Array.from({ length: MAX_ALLOWLIST_SIZE + 50 }, (_, i) => `tool:item-${i}`);
  const merged = mergeAllowlistKeys(many);
  assert.equal(merged.length, MAX_ALLOWLIST_SIZE, '封顶到 MAX_ALLOWLIST_SIZE');
});

test('persistAllowlist：一次性命令不落盘（返回 false），常规命令落盘（返回 true）', () => {
  let stored: string[] = [];
  const store: AllowlistStore = {
    load: () => [...stored],
    save: (keys) => {
      stored = keys;
    },
  };
  assert.equal(persistAllowlist(store, `shell:node -e "x"`), false, '一次性命令拒绝落盘');
  assert.deepEqual(stored, [], '配置文件未被写入垃圾');
  assert.equal(persistAllowlist(store, 'shell:ls -la'), true);
  assert.deepEqual(stored, ['shell:ls -la']);
});

test('loadAllowlist：载入时清洗历史垃圾（一次性/超长条目被剔除并回写）', () => {
  let stored: string[] = [
    'save_memory',
    'shell:ls -la',
    `shell:node -e "\nconst a=1;\n"`, // 历史垃圾：一次性 inline
    'shell:' + 'z'.repeat(MAX_ALLOW_KEY_LENGTH + 5), // 历史垃圾：超长
  ];
  const before = JSON.stringify(stored).length;
  const store: AllowlistStore = {
    load: () => [...stored],
    save: (keys) => {
      stored = keys;
    },
  };
  const set = new Set<string>();
  loadAllowlist(store, set);
  assert.deepEqual([...set].sort(), ['save_memory', 'shell:ls -la'].sort(), '只留可复用条目');
  assert.deepEqual(stored.sort(), ['save_memory', 'shell:ls -la'].sort(), '清洗结果回写落盘');
  assert.ok(JSON.stringify(stored).length < before, '配置文件体积显著缩小');
});

// ── MCP 工具：一次确认 = 授权整个 server ─────────────────────
//
// MCP 的一个 server 就是"一个整体能力"（如 github 集成），其 tool 列表会随
// server 版本变化。若按 tool 粒度记白名单，server 升级新增 tool 后用户又要
// 逐个重新确认。因此 MCP 的持久化键折叠成 mcp__<server>__*。

test('mcpServerKey：从工具名提取 server 级通配键；非 MCP 返回 null', () => {
  assert.equal(mcpServerKey('mcp__github__create_issue'), 'mcp__github__*');
  assert.equal(mcpServerKey('mcp__my-server__do_thing'), 'mcp__my-server__*');
  assert.equal(mcpServerKey('write_file'), null);
  assert.equal(mcpServerKey('mcp__malformed'), null, '缺 tool 段不算');
});

test('persistedKey：MCP 工具折叠成 server 级通配键', () => {
  const tool = (name: string): MountPoint => ({
    name,
    description: '',
    inputSchema: {},
    kind: 'mcp',
    mode: 'external',
    handler: () => '',
  });
  assert.equal(persistedKey(tool('mcp__github__create_issue'), {}), 'mcp__github__*');
  assert.equal(persistedKey(tool('mcp__github__get_issue'), {}), 'mcp__github__*', '同 server 同键');
});

test('MCP 授权一次后，同 server 其他工具免问；别的 server 仍要问', () => {
  const allowlist = new Set<string>();
  const tool = (name: string): MountPoint => ({
    name,
    description: '',
    inputSchema: {},
    kind: 'mcp',
    mode: 'external',
    handler: () => '',
  });
  // 用户在 create_issue 上确认了一次
  allowlist.add(persistedKey(tool('mcp__github__create_issue'), {}));
  assert.ok(allowlistHas(allowlist, persistedKey(tool('mcp__github__get_issue'), {})), '同 server 免问');
  assert.ok(!allowlistHas(allowlist, persistedKey(tool('mcp__jira__get_issue'), {})), '别的 server 仍要问');
});

test('persistedKey：非 MCP 的 kind 即使名字带 mcp__ 前缀也不折叠', () => {
  const weird: MountPoint = {
    name: 'mcp__x__y',
    description: '',
    inputSchema: {},
    kind: 'builtin',
    mode: 'read',
    handler: () => '',
  };
  assert.equal(persistedKey(weird, {}), 'mcp__x__y', '按 kind 判定，不按名字猜');
});
