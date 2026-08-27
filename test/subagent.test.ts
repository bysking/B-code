import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry, type RuntimeContext } from '../src/registry.js';
import { registerBuiltinTools } from '../src/tools.js';
import { runSubAgent, CRITIC_SYSTEM } from '../src/subagent.js';
import type { ModelInput, ModelOutput } from '../src/backend.js';

let dir: string;
let filePath: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'b-code-sub-'));
  filePath = join(dir, 'target.txt');
  await writeFile(filePath, 'subagent sees this');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('子 Agent：只读工具循环 → 返回纯文本摘要；非只读工具被拒', async () => {
  const registry = new Registry();
  registerBuiltinTools(registry);

  const calls: ModelInput[] = [];
  let step = 0;
  const callModel = async (input: ModelInput): Promise<ModelOutput> => {
    calls.push(input);
    step++;
    if (step === 1) {
      return {
        content: [
          { type: 'tool_use', id: 's-1', name: 'read_file', input: { file_path: filePath } },
          // 子 agent 若试图写文件 → 应被拒（不给写工具，仍被拒兜底）
          { type: 'tool_use', id: 's-2', name: 'write_file', input: { file_path: filePath, content: 'x' } },
        ],
      };
    }
    return { content: [{ type: 'text', text: 'found everything' }] };
  };

  const ctx: RuntimeContext = { callModel, model: 'm', setMode: () => {} };
  const result = await runSubAgent('explore', ctx, registry);

  assert.equal(result, 'found everything');

  // 第一轮 tools 参数只含只读工具
  const first = calls[0]!;
  const toolNames = first.tools.map((t) => t.name);
  assert.ok(
    toolNames.every((n) => registry.resolve(n)?.mode === 'read'),
    `子 agent 只能拿只读工具，实际: ${toolNames}`,
  );
  assert.ok(!toolNames.includes('write_file'));
  assert.ok(!toolNames.includes('run_shell'));

  // 喂回结果：read_file 得到内容；write_file 被拒
  const second = calls[1]!;
  const results = second.messages[2] as unknown as { content: { tool_use_id: string; content: string }[] };
  const readResult = results.content.find((r) => r.tool_use_id === 's-1');
  const writeResult = results.content.find((r) => r.tool_use_id === 's-2');
  assert.ok(String(readResult?.content).includes('subagent sees this'));
  assert.ok(String(writeResult?.content).includes('read-only'));
});

test('对抗性审查角色：自定义 system（CRITIC_SYSTEM）注入首轮调用', async () => {
  const registry = new Registry();
  registerBuiltinTools(registry);

  const calls: ModelInput[] = [];
  const callModel = async (input: ModelInput): Promise<ModelOutput> => {
    calls.push(input);
    return { content: [{ type: 'text', text: 'verdict: REVISE — missing retry logic' }] };
  };

  const ctx: RuntimeContext = { callModel, model: 'm', setMode: () => {} };
  const result = await runSubAgent('review this plan', ctx, registry, CRITIC_SYSTEM);

  assert.equal(result, 'verdict: REVISE — missing retry logic');
  // 首轮 system 用对抗性审查提示词（而非默认 explore）
  const systemText = calls[0]!.system.map((b) => b.text).join('');
  assert.ok(systemText.includes('adversarial reviewer'), '应使用 Plan critic 人设');
  assert.ok(!systemText.includes('explore sub-agent'), '不应是默认 explore 人设');
});

test('硬中断：父级 signal 透传给子 Agent 的模型调用；abort 后不再发起新一轮', async () => {
  const registry = new Registry();
  registerBuiltinTools(registry);

  const ac = new AbortController();
  let calls = 0;
  const callModel = async (input: ModelInput): Promise<ModelOutput> => {
    calls++;
    assert.equal(input.signal, ac.signal, '子 Agent 模型调用收到父级取消信号');
    if (calls === 1) {
      // 模拟调用耗时；期间父级取消 → 工具执行后的循环边界应停
      await new Promise((r) => setTimeout(r, 30));
      return {
        content: [{ type: 'tool_use', id: 's-1', name: 'read_file', input: { file_path: filePath } }],
      };
    }
    return { content: [{ type: 'text', text: 'should not reach' }] };
  };

  const ctx: RuntimeContext = { callModel, model: 'm', setMode: () => {}, signal: ac.signal };
  const pending = runSubAgent('explore', ctx, registry);
  await new Promise((r) => setTimeout(r, 10));
  ac.abort(); // 父级取消
  const result = await pending;

  assert.equal(calls, 1, 'abort 后不再发起第二轮模型调用');
  assert.ok(result.includes('interrupted'), '返回中断标记而非继续执行');
});
