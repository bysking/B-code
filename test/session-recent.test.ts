import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentTurns, renderRecentTurns } from '../src/session.js';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';

/** 造一轮：user 问 + assistant 文本（可带工具） */
function round(question: string, answer: string, tools: string[] = []): MessageParam[] {
  const msgs: MessageParam[] = [{ role: 'user', content: question }];
  const blocks: any[] = [];
  for (const t of tools) blocks.push({ type: 'tool_use', id: t, name: t, input: {} });
  blocks.push({ type: 'text', text: answer });
  msgs.push({ role: 'assistant', content: blocks });
  // tool_result 回灌的一条 user（块数组，不算"轮"）
  if (tools.length)
    msgs.push({
      role: 'user',
      content: tools.map((t) => ({ type: 'tool_result', tool_use_id: t, content: 'ok' })),
    });
  return msgs;
}

test('recentTurns：取最后 5 轮，tool_result 不进轮、工具名被收集', () => {
  const all = [
    ...round('q1', 'a1'), // 轮1
    ...round('q2', 'a2', ['read_file']), // 轮2
    ...round('q3', 'a3'), // 轮3
    ...round('q4', 'a4'), // 轮4
    ...round('q5', 'a5'), // 轮5
    ...round('q6', 'a6'), // 轮6 —— 应被截掉
  ];
  const turns = recentTurns(all, 5);
  const questions = turns.filter((t) => t.role === 'user').map((t) => t.text);
  assert.deepEqual(questions, ['q2', 'q3', 'q4', 'q5', 'q6'], '最后 5 轮，最旧 q1 被截掉');

  const a2 = turns.find((t) => t.role === 'assistant' && t.text === 'a2');
  assert.deepEqual(a2?.tools, ['read_file'], 'assistant 的工具名被收集');
  assert.ok(!turns.some((t) => t.text.includes('tool_result')), 'tool_result 不进轮');
});

test('recentTurns：压缩摘要轮（user 文本）也计入边界', () => {
  const all = [
    { role: 'user' as const, content: '[Summary of earlier conversation]\nblah' },
    ...round('继续', '好'),
  ];
  const turns = recentTurns(all, 5);
  assert.equal(turns.filter((t) => t.role === 'user').length, 2, '摘要轮 + 新轮');
  assert.equal(turns[0]?.text.startsWith('[Summary'), true);
});

test('recentTurns：空/无 user 文本 → []', () => {
  assert.deepEqual(recentTurns([], 5), []);
  assert.deepEqual(
    recentTurns([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'x' }] }], 5),
    [],
  );
});

test('renderRecentTurns：紧凑文本含标注（轮数 = user 消息数）', () => {
  const out = renderRecentTurns([
    { role: 'user', text: '你好', tools: [] },
    { role: 'assistant', text: 'hello', tools: ['read_file'] },
  ]);
  assert.ok(out.includes('── 最近 1 轮对话 ──'));
  assert.ok(out.includes('user: 你好'));
  assert.ok(out.includes('[tools: read_file]'));
  assert.ok(out.includes('hello'));
});
