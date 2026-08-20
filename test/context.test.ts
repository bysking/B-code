import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  maybeCompact,
  truncateResult,
  renderCompaction,
  buildFileIndex,
  contextTokenBudget,
  MAX_RESULT_CHARS,
  COMPACT_THRESHOLD,
  KEEP_RECENT,
} from '../src/context.js';
import { FileStore } from '../src/file-store.js';

// ── truncateResult（Tier 0）───────────────────────────────────

test('小结果原样返回', () => {
  assert.equal(truncateResult('short'), 'short');
});

test('恰好等于上限不改动', () => {
  const s = 'x'.repeat(MAX_RESULT_CHARS);
  assert.equal(truncateResult(s).length, MAX_RESULT_CHARS);
});

test('超上限：头尾各半保留 + 中间省略标记', () => {
  const big = `HEAD!${'x'.repeat(MAX_RESULT_CHARS)}TAIL?`;
  const out = truncateResult(big);
  assert.ok(out.length < MAX_RESULT_CHARS, '截断后必须在窗口内');
  assert.ok(out.startsWith('HEAD!'), '保留头部');
  assert.ok(out.endsWith('TAIL?'), '保留尾部');
  assert.ok(out.includes('truncated'), '含省略说明');
});

// ── maybeCompact（Tier 4 摘要）───────────────────────────────

function messages(n: number): { role: string; content: string }[] {
  return Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `msg-${i}` }));
}

test('消息数未超阈值 → 不压缩、不调摘要', async () => {
  const list = messages(COMPACT_THRESHOLD);
  let called = false;
  const out = await maybeCompact(list, async () => {
    called = true;
    return '摘要';
  });
  assert.equal(called, false);
  assert.equal(out, list, '原数组引用不变');
});

test('超阈值 → 旧消息摘要替换，保留最近 KEEP_RECENT 条', async () => {
  const n = COMPACT_THRESHOLD + 5; // 超过 45 才触发
  const list = messages(n);
  const out = await maybeCompact(list, async (older) => {
    assert.equal(older.length, n - KEEP_RECENT, '摘要回调收到的是旧消息');
    // 刚越过压缩边界的那条（index n-KEEP_RECENT-1，偶数 → user）
    assert.deepEqual(older.slice(-1), [{ role: 'user', content: `msg-${n - KEEP_RECENT - 1}` }]);
    return 'flyweight summary';
  });

  assert.equal(out.length, KEEP_RECENT + 1);
  assert.equal(out[0]?.content, '[Summary of earlier conversation]\nflyweight summary');
  assert.equal(out[0]?.role, 'user');
  assert.deepEqual(
    out.slice(1).map((m) => m.content),
    Array.from({ length: KEEP_RECENT }, (_, i) => `msg-${n - KEEP_RECENT + i}`),
    '最近 5 条原样保留',
  );
});

test('摘要为空字符串 → 保持原样（宁可爆窗不丢上下文）', async () => {
  const list = messages(COMPACT_THRESHOLD + 1);
  const out = await maybeCompact(list, async () => '   ');
  assert.equal(out, list);
});

// 压缩不能拆散 tool_use/tool_result 配对：切点落在 tool_result 上时窗口前移一条
function toolPair(i: number): { role: string; content: unknown }[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: `call_${i}`, name: 't', input: {} }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `call_${i}`, content: `out-${i}` }],
    },
  ];
}

test('切点落在 tool_result 上时，压缩前移窗口保住配对', async () => {
  // 1 条 user(text) + 23 轮工具 = 47 条（>45 触发；奇数，裸切长度-5 会切在 user(tool_result) 上）
  const list: { role: string; content: unknown }[] = [{ role: 'user', content: 'hello' }];
  for (let i = 0; i < 23; i++) list.push(...toolPair(i));
  assert.equal(list.length, 47);

  const out = await maybeCompact(list, async () => 'summary');

  assert.equal(out.length, KEEP_RECENT + 1 + 1, '摘要 + 6 条（窗口前移带上 assistant）');
  const recent = out.slice(1);
  assert.equal(recent[0]?.role, 'assistant', '保留窗口不能以 tool_result 开头');

  // 窗口内每个 tool_result 的 tool_use 必须在前一条消息里
  for (let i = 1; i < recent.length; i++) {
    const m = recent[i]!;
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content as { type: string; tool_use_id: string }[]) {
      if (b.type !== 'tool_result') continue;
      const prev = recent[i - 1]!;
      const ids = (Array.isArray(prev.content) ? prev.content : [])
        .filter(
          (x): x is { type: string; id: string } =>
            typeof x === 'object' && x !== null && (x as { type?: string }).type === 'tool_use',
        )
        .map((x) => x.id);
      assert.ok(ids.includes(b.tool_use_id), `tool_result ${b.tool_use_id} 的 tool_use 必须在前一条消息`);
    }
  }
});
// ── renderCompaction / buildFileIndex（压缩保指针）───────────

function toolCall(id: string, name: string, input: Record<string, unknown>) {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use' as const, id, name, input }],
  };
}
function toolResult(id: string, content: string) {
  return {
    role: 'user',
    content: [{ type: 'tool_result' as const, tool_use_id: id, content }],
  };
}

test('renderCompaction：read_file 渲染指针行，其余块脱敏', () => {
  const store = new FileStore();
  store.set(resolve('/tmp/x.ts'), {
    mtimeMs: 1,
    size: 10,
    hash: 'abc123',
    content: 'line1\nline2',
    dirty: false,
  });
  const msgs = [
    { role: 'user', content: 'hello' },
    toolCall('u1', 'read_file', { file_path: '/tmp/x.ts' }),
    toolResult('u1', 'FULL CONTENT OF X'),
    toolCall('u2', 'grep_search', { pattern: 'x' }),
    toolResult('u2', 'grep hits secret'),
  ];
  const out = renderCompaction(msgs, store);
  assert.ok(out.includes('read /tmp/x.ts (2 行, hash abc123)'), 'read_file 渲染指针行');
  assert.ok(!out.includes('FULL CONTENT OF X'), 'read_file 不泄漏全文');
  assert.ok(out.includes('[tool call grep_search]'), '其余 tool_use 脱敏为 [tool call]');
  assert.ok(!out.includes('grep hits secret'), '其余 tool_result 不泄漏');
});

test('renderCompaction：read_file 但 store 无快照 → 退化为脱敏', () => {
  const msgs = [toolCall('u1', 'read_file', { file_path: '/tmp/nope.ts' }), toolResult('u1', 'SOME CONTENT')];
  const out = renderCompaction(msgs, new FileStore());
  assert.ok(out.includes('[tool result]'), '无快照时脱敏');
  assert.ok(!out.includes('SOME CONTENT'), '不泄漏内容');
});

test('buildFileIndex：列出已读文件 + dirty 标记', () => {
  const store = new FileStore();
  store.set(resolve('/tmp/a.ts'), { mtimeMs: 1, size: 5, hash: 'h1', content: 'a\nb', dirty: false });
  store.set(resolve('/tmp/b.ts'), { mtimeMs: 2, size: 7, hash: 'h2', content: 'x\ny\nz', dirty: true });
  const out = buildFileIndex(store);
  assert.ok(out.includes('# Read files this session'), '索引标题');
  assert.ok(out.includes('/tmp/a.ts: 2 行, hash h1'), '正常条目');
  assert.ok(out.includes('changed since read'), 'dirty 条目标记');
});

test('buildFileIndex：空 store 返回空串', () => {
  assert.equal(buildFileIndex(new FileStore()), '');
});

// ── token 预算触发 ─────────────────────────────────────────

test('contextTokenBudget：默认 1M 窗口 → 40% = 40 万', () => {
  assert.equal(contextTokenBudget(), 400000);
});

test('maybeCompact force=true：低于条数阈值也强制压缩', async () => {
  const list = messages(10); // > KEEP_RECENT 但 < COMPACT_THRESHOLD
  const out = await maybeCompact(list, async () => 'forced summary', true);
  assert.equal(out.length, KEEP_RECENT + 1, '强制压缩产生摘要 + 保留窗口');
  assert.equal(out[0]?.content, '[Summary of earlier conversation]\nforced summary');
});

test('maybeCompact force=true：消息不足保留窗口时原样返回', async () => {
  const list = messages(3); // 全部落在保留窗口
  const out = await maybeCompact(list, async () => 'summary', true);
  assert.equal(out, list, '无足够旧消息不压缩');
});
