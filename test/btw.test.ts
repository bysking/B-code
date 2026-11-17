import { test } from 'bun:test';
import assert from 'node:assert/strict';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import type { ModelInput, ModelOutput } from '../src/backend.js';
import { Agent } from '../src/agent.js';
import { finalAssistantText } from '../src/cli.js';

/**
 * `/btw`：旁支只读提问。
 *
 * 核心约束：**不写主历史**。主线 `messages` 一个字节都不该变——
 * 否则用户问一句旁支问题，主线上下文就被污染了。
 */

/** 假后端：把最后一次 user 文本原样回显成 assistant 文本 */
function echoBackend(): (input: ModelInput) => Promise<ModelOutput> {
  return async (input) => {
    const lastUser = [...input.messages].reverse().find((m) => m.role === 'user');
    const text =
      typeof lastUser?.content === 'string'
        ? lastUser.content
        : ((lastUser?.content as any[]) ?? [])
            .filter((b) => b?.type === 'text')
            .map((b) => b.text)
            .join('');
    return {
      content: [
        { type: 'text', text: `echo: ${text}` },
        { type: 'usage', input_tokens: 10, output_tokens: 5 },
      ] as any,
      usage: { input_tokens: 10, output_tokens: 5 },
    } as ModelOutput;
  };
}

function makeAgent(): Agent {
  return new Agent({ callModel: echoBackend(), print: () => {}, mode: 'auto' });
}

test('lastAssistantText：取最后一条含文本的 assistant 消息', () => {
  const messages: MessageParam[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'text', text: '第一次' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }] },
    { role: 'assistant', content: [{ type: 'text', text: '第二次' }] },
  ];
  assert.equal(finalAssistantText(messages), '第二次');
  assert.equal(finalAssistantText([{ role: 'user', content: 'only' }]), '');
});

test('runBtwThread：只读旁支，不写主历史', async () => {
  const agent = makeAgent();
  await agent.chat('主线任务');
  const before = agent.history().length;

  const answer = await agent.runBtwThread('顺便问一句：这个文件里有什么？');
  assert.ok(answer.length > 0, '拿到旁支结论');
  assert.equal(agent.history().length, before, '主线历史没有增长（旁支独立）');
});

test('runBtwThread：旁支任务里带上「只回答、别改文件」的约束', async () => {
  let seenTask = '';
  const agent = new Agent({
    callModel: async (input) => {
      const lastUser = [...input.messages].reverse().find((m) => m.role === 'user');
      seenTask =
        typeof lastUser?.content === 'string'
          ? lastUser.content
          : ((lastUser?.content as any[]) ?? [])
              .filter((b) => b?.type === 'text')
              .map((b) => b.text)
              .join('');
      return { content: [{ type: 'text', text: 'answer' }] as any } as ModelOutput;
    },
    print: () => {},
    mode: 'auto',
  });
  await agent.runBtwThread('这个函数为什么这么写？');
  assert.ok(seenTask.includes('read-only'), '提示词要求只读');
  assert.ok(seenTask.includes('do NOT propose or perform any file changes'), '明确禁止改动文件');
  assert.ok(seenTask.includes('这个函数为什么这么写？'), '原问题带上了');
});

test('空输入：旁支仍能返回（不抛错）', async () => {
  const agent = makeAgent();
  const before = agent.history().length;
  const answer = await agent.runBtwThread('');
  assert.equal(typeof answer, 'string');
  assert.equal(agent.history().length, before, '空问题也不写主历史');
});
