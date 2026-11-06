import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { AppController, deriveTaskPanel, MAX_SUBAGENT_LINES, MAX_SUBAGENTS } from '../src/ui/controller.js';

test('streamText：首个 delta 开 assistant turn，后续追加，finishStream 停流', () => {
  const c = new AppController();
  c.pushUser('hi');
  c.streamText('你');
  c.streamText('好');
  assert.equal(c.turns.length, 2);
  const t = c.turns[1]!;
  assert.equal(t.role, 'assistant');
  assert.equal(t.streaming, true);
  assert.equal(t.text, '你好');
  c.finishStream();
  assert.equal(c.turns[1]?.streaming, false);
});

test('planTools→toolStart→toolEnd：首个工具开始整批落地，逐个 running→done，整批完成关流', () => {
  const c = new AppController();
  c.planTools([
    { id: 'a', name: 'read_file', input: { file_path: 'x.ts' } },
    { id: 'b', name: 'grep_search', input: { pattern: 'foo' } },
  ]);
  assert.equal(c.turns.length, 0, 'planTools 只记 pending，等首个工具开始才落地（避免空 turn 干扰流式）');

  c.toolStart('a', 'read_file', { file_path: 'a'.repeat(200) });
  const t = c.turns.at(-1)!;
  assert.equal(t.tools.length, 2, '整批一次列出');
  assert.deepEqual(
    t.tools.map((x) => x.status),
    ['running', 'queued'],
  );
  assert.ok((t.tools[0]?.input?.length ?? 0) <= 80, '长输入被截断');

  c.toolEnd('a', 'file content');
  assert.equal(t.tools[0]?.status, 'done');
  assert.equal(t.tools[0]?.output, 'file content');
  assert.equal(t.streaming, false, '还有工具排队时不关流');

  c.toolStart('b', 'grep_search', { pattern: 'foo' });
  c.toolEnd('b');
  assert.equal(t.tools[1]?.status, 'done');
  assert.equal(t.streaming, false, '整批完成 turn 关闭，下一轮回复新建 turn');
});

test('toolStart 兜底：无 planTools 时直接挂 running（旧会话兼容）', () => {
  const c = new AppController();
  c.toolStart('t1', 'read_file', { file_path: 'x' });
  const t = c.turns.at(-1)!;
  assert.equal(t.tools[0]?.id, 't1');
  assert.equal(t.tools[0]?.status, 'running');
});

test('streamThinking：无 assistant turn 时新建，有则累计到当前 turn', () => {
  const c = new AppController();
  c.streamThinking('第一步');
  c.streamThinking('，第二步');
  assert.equal(c.turns.length, 1);
  assert.equal(c.turns[0]?.thinking, '第一步，第二步');
  assert.equal(c.turns[0]?.text, '', 'thinking 与输出文本分离');

  // 模型接着输出文本 → 追加到同一个 turn
  c.streamText('结果');
  assert.equal(c.turns.length, 1);
  assert.equal(c.turns[0]?.text, '结果');
});

test('deriveTaskPanel：整批同名读文件 → 动词/单位推导标题与子项标签', () => {
  const p = deriveTaskPanel([
    { id: 'a', name: 'read_file', input: { file_path: 'src/a.ts' } },
    { id: 'b', name: 'read_file', input: { file_path: 'src/b.ts' } },
  ]);
  assert.equal(p?.title, '读取 2 个文件');
  assert.equal(p?.verb, '读取');
  assert.deepEqual(
    p?.items.map((i) => i.label),
    ['src/a.ts', 'src/b.ts'],
  );
  assert.ok(
    p?.items.every((i) => i.status === 'queued'),
    '宣布即全部 queued（待…）',
  );
});

test('deriveTaskPanel：混合/未知工具回退 执行 N 个任务；run_shell 取 command', () => {
  const mixed = deriveTaskPanel([
    { id: 'a', name: 'read_file', input: { file_path: 'x.ts' } },
    { id: 'b', name: 'run_shell', input: { command: 'npm test' } },
  ]);
  assert.equal(mixed?.title, '执行 2 个任务');
  assert.equal(mixed?.verb, '执行');
  assert.equal(mixed?.items[1]?.label, 'npm test');

  const unknown = deriveTaskPanel([{ id: 'a', name: 'mcp_custom', input: { foo: 1 } }]);
  assert.equal(unknown?.title, '执行 1 个任务');
  assert.equal(unknown?.items[0]?.label, 'mcp_custom', '无 file_path/pattern/command 退回工具名');

  assert.equal(deriveTaskPanel([]), null, '空批不建面板');
});

test('planTools→toolStart→toolEnd：任务面板随事件推进，全 done 关 loading', () => {
  const c = new AppController();
  c.planTools([
    { id: 'a', name: 'read_file', input: { file_path: 'a.ts' } },
    { id: 'b', name: 'read_file', input: { file_path: 'b.ts' } },
  ]);
  assert.ok(c.task, 'planTools 立即建面板');
  assert.equal(c.task?.title, '读取 2 个文件');

  c.toolStart('a', 'read_file', { file_path: 'a.ts' });
  assert.equal(c.task?.items[0]?.status, 'running', '首个子项 → 读取中');
  assert.equal(c.task?.items[1]?.status, 'queued');

  c.toolEnd('a');
  assert.equal(c.task?.items[0]?.status, 'done');
  assert.ok(c.task, '还有子项未完成 → 面板保持');

  c.toolStart('b', 'read_file', { file_path: 'b.ts' });
  c.toolEnd('b');
  assert.equal(c.task, null, '全部完成 → 面板移除');
});

test('任务面板：pushUser / clearAll 清空', () => {
  const c = new AppController();
  c.planTools([{ id: 'a', name: 'read_file', input: { file_path: 'a.ts' } }]);
  c.toolStart('a', 'read_file', { file_path: 'a.ts' });
  c.toolEnd('a');
  assert.equal(c.task, null, '全部完成面板已移除');

  c.planTools([{ id: 'b', name: 'grep_search', input: { pattern: 'foo' } }]);
  assert.ok(c.task);
  c.pushUser('再来一轮');
  assert.equal(c.task, null, '新一轮输入清空面板');

  c.planTools([{ id: 'c', name: 'grep_search', input: { pattern: 'foo' } }]);
  assert.ok(c.task);
  c.clearAll();
  assert.equal(c.task, null, '/clear 清空面板');
});

test('ask/resolveAsk：promise 交付答案并清空状态', async () => {
  const c = new AppController();
  const p = c.ask('Allow?', [
    { label: 'No', value: 'no' },
    { label: 'Yes', value: 'yes' },
  ]);
  assert.ok(c.askState);
  c.resolveAsk('yes');
  assert.equal(await p, 'yes');
  assert.equal(c.askState, null);
});

test('slash 开合与查询', () => {
  const c = new AppController();
  c.openSlash('com');
  assert.equal(c.slashOpen, true);
  assert.equal(c.slashQuery, 'com');
  c.closeSlash();
  assert.equal(c.slashOpen, false);
  assert.equal(c.slashQuery, '');
});

test('clearAll 重置对话与输出，busy 归零', () => {
  const c = new AppController();
  c.pushUser('x');
  c.streamText('y');
  c.pushOutput('(resumed 2)');
  c.setBusy('thinking…');
  c.clearAll();
  assert.equal(c.turns.length, 0);
  assert.equal(c.output.length, 0);
  assert.equal(c.busy, null);
});

test('busy 状态：start 启动计时与复位，thinking/tokens 字段随生命周期', () => {
  const c = new AppController();
  c.setBusy('thinking…');
  assert.ok(c.busySince !== null, 'start 记录计时基准');
  assert.equal(c.busyThinking, false);
  assert.equal(c.busyInputTokens, 0);

  c.setBusyThinking(true);
  c.setBusyTokens(1200);
  assert.equal(c.busyThinking, true);
  assert.equal(c.busyInputTokens, 1200, '绝对值设置（估算）');

  c.setBusyTokens(1300);
  assert.equal(c.busyInputTokens, 1300, '真实值覆盖估算');

  c.setBusy(null);
  assert.equal(c.busySince, null, 'stop 复位计时');
  assert.equal(c.busyThinking, false);
  assert.equal(c.busyInputTokens, 0);
});

test('setBusy 同文案幂等：重复 start 不刷新计时基准', async () => {
  const c = new AppController();
  c.setBusy('thinking…');
  const since = c.busySince;
  await new Promise((r) => setTimeout(r, 20));
  c.setBusy('thinking…');
  assert.equal(c.busySince, since, '同文案重复 start 不重置 since');
});

test('setTurnUsage：写入当前 assistant turn，busy 清空后仍可见', () => {
  const c = new AppController();
  c.pushUser('hi');
  c.streamText('hello');
  c.setTurnUsage({ input_tokens: 100, output_tokens: 50 }, 3400);
  const t = c.turns.at(-1)!;
  assert.deepEqual(t.usage, { input_tokens: 100, output_tokens: 50 });
  assert.equal(t.elapsedMs, 3400);

  // 无 assistant turn 时静默不炸
  const c2 = new AppController();
  c2.setTurnUsage({ input_tokens: 1, output_tokens: 1 }, 10);
  assert.equal(c2.turns.length, 0);
});

test('subscribe：每次变更触发一次，返回退订可用', () => {
  const c = new AppController();
  let count = 0;
  const off = c.subscribe(() => count++);
  c.pushUser('a');
  off();
  c.pushUser('b');
  assert.equal(count, 1);
});

// ── 子 Agent 日志（Ctrl+O 第三页）─────────────────────────────

test('子 Agent：start 立刻建条目（任务归头部），步骤与收口行追加', () => {
  const c = new AppController();
  c.startSubAgent('sa1', 'explore', '看看 src/ui');
  assert.equal(c.subagents.length, 1);
  const sa = c.subagents[0]!;
  assert.equal(sa.status, 'running');
  assert.equal(sa.role, 'explore');
  assert.equal(sa.task, '看看 src/ui', '任务由面板头部常驻显示');
  assert.equal(sa.lines.length, 0, '不写重复的 start 行（头部已有任务）');

  c.pushSubAgentStep('sa1', 'tool   read_file src/ui/app.tsx');
  c.endSubAgent('sa1', 'done', '结论…');
  assert.equal(sa.status, 'done');
  assert.ok(sa.lines.some((l) => l.includes('read_file')));
  assert.ok(sa.lines.at(-1)!.includes('结论…'), '末行带摘要');
});

test('子 Agent：未知 id 的步骤静默丢弃（条目已被上限淘汰）', () => {
  const c = new AppController();
  c.pushSubAgentStep('nope', 'tool   whatever');
  c.endSubAgent('nope', 'done', 'x');
  assert.equal(c.subagents.length, 0, '不凭一个步骤就重建条目');
});

test('子 Agent：行数上限裁掉最旧的，条目数上限裁掉最旧的', () => {
  const c = new AppController();
  c.startSubAgent('sa1', 'explore', 't');
  for (let i = 0; i < MAX_SUBAGENT_LINES + 50; i++) c.pushSubAgentStep('sa1', `line-${i}`);
  assert.equal(c.subagents[0]!.lines.length, MAX_SUBAGENT_LINES, '行数封顶');
  assert.ok(c.subagents[0]!.lines.at(-1)!.includes(`line-${MAX_SUBAGENT_LINES + 49}`), '保留最新');

  for (let i = 2; i <= MAX_SUBAGENTS + 3; i++) c.startSubAgent(`sa${i}`, 'explore', `t${i}`);
  assert.equal(c.subagents.length, MAX_SUBAGENTS, '条目封顶');
  assert.ok(!c.subagents.some((s) => s.id === 'sa1'), '淘汰最旧的');
});

test('子 Agent：面板关着时不触发重渲染，开着时实时刷新', () => {
  const c = new AppController();
  let renders = 0;
  c.subscribe(() => renders++);

  // 面板关闭：一次探索几十步，不该步步重渲染整个会话
  c.startSubAgent('sa1', 'explore', 't');
  c.pushSubAgentStep('sa1', 'tool   read_file a.ts');
  assert.equal(renders, 0, '关着时静默累积');

  // 打开面板后必须实时刷新——否则"看它在干什么"落空
  c.toggleOutputPanel(true);
  renders = 0;
  c.pushSubAgentStep('sa1', 'tool   read_file b.ts');
  assert.equal(renders, 1, '开着时逐步刷新');
});

test('clearAll：子 Agent 日志一并清空（/clear 后不残留上一轮的视图态）', () => {
  const c = new AppController();
  c.startSubAgent('sa1', 'explore', 't');
  c.clearAll();
  assert.equal(c.subagents.length, 0);
});
