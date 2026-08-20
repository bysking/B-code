import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/agent.js';
import type { ModelInput, ModelOutput } from '../src/backend.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.js';

/**
 * 脚本化假后端：按预写剧本依次回复
 * @param script 每步的工具调用数（-1 = 直接文本收尾）
 */
function makeScriptedBackend(script: number[], readFilePath: string) {
  const calls: ModelInput[] = [];
  let step = 0;
  const fn = async (input: ModelInput): Promise<ModelOutput> => {
    // 快照消息数组：循环运行时会原地修改 this.messages，按引用记录会看到最终态
    calls.push({ ...input, messages: [...input.messages] });
    const toolCount = script[step] ?? -1;
    step++;
    if (toolCount === -1) {
      return { content: [{ type: 'text', text: 'all done' }] };
    }
    const content: ContentBlockParam[] = [];
    for (let i = 0; i < toolCount; i++) {
      content.push({
        type: 'tool_use',
        id: `tu-${step}-${i}`,
        name: 'read_file',
        input: { file_path: readFilePath },
      });
    }
    return { content };
  };
  return { fn, calls };
}

/** 按剧本返回任意工具调用（权限用例用） */
function makeToolScriptedBackend(
  script: Array<{ tools: Array<{ name: string; input: Record<string, any> }> } | { text: string }>,
) {
  let step = 0;
  const fn = async (input: ModelInput): Promise<ModelOutput> => {
    const s = script[step] ?? { text: 'all done' };
    step++;
    if ('text' in s) return { content: [{ type: 'text', text: s.text }] };
    return {
      content: s.tools.map((t, i) => ({
        type: 'tool_use' as const,
        id: `tu-${step}-${i}`,
        name: t.name,
        input: t.input,
      })),
    };
  };
  return { fn };
}

let dir: string;
let filePath: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'b-code-agent-'));
  filePath = join(dir, 'target.txt');
  await writeFile(filePath, 'hello world');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('循环：工具执行 → tool_result 关联 id 喂回 → 文本收尾', async () => {
  const { fn, calls } = makeScriptedBackend([1, -1], filePath);
  const agent = new Agent({ callModel: fn, print: () => {} });
  await agent.chat('read it');

  assert.equal(calls.length, 2, '一次工具调用 + 一次文本收尾 = 2 次模型调用');

  // 第一轮：只有用户消息
  assert.deepEqual(calls[0]?.messages, [{ role: 'user', content: 'read it' }]);

  // 第二轮：历史包含 用户 + assistant(tool_use) + user(tool_result)
  const history = calls[1]!.messages;
  assert.equal(history.length, 3);
  const assistant = history[1]!;
  assert.equal(assistant.role, 'assistant');
  const toolUse = (assistant.content as ContentBlockParam[]).find((b) => b.type === 'tool_use');
  assert.equal(toolUse?.type, 'tool_use');

  const fedBack = history[2]!;
  assert.equal(fedBack.role, 'user');
  const results = fedBack.content as ContentBlockParam[];
  // tool_use_id 必须和模型给的 id 严格一致（断开这一步模型会报错）
  assert.equal((results[0] as { tool_use_id: string }).tool_use_id, 'tu-1-0');
  // 工具执行的真实内容被喂回
  assert.ok(String((results[0] as { content: string }).content).includes('hello world'));

  // 最终历史：user, assistant(tool_use), user(tool_result), assistant(text)
  const final = agent.history();
  assert.equal(final.length, 4);
  const last = final[3]!;
  assert.equal(last.role, 'assistant');
  assert.ok(
    (last.content as ContentBlockParam[]).some((b) => b.type === 'text'),
    '文本收尾应进入历史',
  );
});

test('循环：模型一次返回多个 tool_use，全部执行并逐一喂回', async () => {
  const { fn, calls } = makeScriptedBackend([2, -1], filePath);
  const agent = new Agent({ callModel: fn, print: () => {} });
  await agent.chat('read twice');

  // 第一轮就返回 2 个 tool_use
  const secondCall = calls[1]!.messages;
  const results = (secondCall[2] as { content: ContentBlockParam[] }).content;
  assert.equal(results.length, 2);
  assert.equal((results[0] as { tool_use_id: string }).tool_use_id, 'tu-1-0');
  assert.equal((results[1] as { tool_use_id: string }).tool_use_id, 'tu-1-1');
});

test('循环：模型直接给文本（无工具）→ 一轮即止', async () => {
  const { fn, calls } = makeScriptedBackend([-1], filePath);
  const agent = new Agent({ callModel: fn, print: () => {} });
  await agent.chat('just answer');

  assert.equal(calls.length, 1);
  assert.equal(agent.history().length, 2); // user + assistant(text)
});

test('循环：模型状态失忆时的兜底（下一轮直接文本）', async () => {
  // 剧本只有一次工具，但循环要求模型返回工具；假后端在越界时返回文本 → 安全退出不卡死
  const { fn, calls } = makeScriptedBackend([1], filePath);
  const agent = new Agent({ callModel: fn, print: () => {} });
  await agent.chat('run');

  // 第二轮越界 → 文本收尾，循环必终止（防死循环护栏）
  assert.equal(calls.length, 2);
});

test('权限 deny：危险命令被拦，不进工具执行', async () => {
  const { fn } = makeToolScriptedBackend([
    { tools: [{ name: 'run_shell', input: { command: 'rm -rf /tmp/b-code-target' } }] },
    { text: 'ok' },
  ]);
  const agent = new Agent({ callModel: fn, print: () => {}, mode: 'bypass' }); // yolo 也拦
  await agent.chat('run it');

  const fedBack = agent.history()[2]!;
  const result = (fedBack.content as ContentBlockParam[])[0] as unknown as {
    content: string;
  };
  assert.ok(result.content.includes('Denied'), `应返回拒绝信息，实际: ${result.content}`);
});

test('权限 confirm：第一次询问并放行，同命令二次不再问（会话白名单）', async () => {
  const target = join(dir, 'perm.txt');
  const { fn } = makeToolScriptedBackend([
    { tools: [{ name: 'write_file', input: { file_path: target, content: 'v1' } }] },
    { tools: [{ name: 'write_file', input: { file_path: target, content: 'v2' } }] },
    { text: 'done' },
  ]);
  let asks = 0;
  const agent = new Agent({
    callModel: fn,
    print: () => {},
    askUser: async () => {
      asks++;
      return true;
    },
  });
  await agent.chat('write twice');

  assert.equal(asks, 1, '第一次 confirm + 白名单命中第二次不询问');
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(target, 'utf-8'), 'v2', '两次写入都真实执行');
});

test('权限 confirm：用户拒绝 → user rejected 喂回，工具不执行', async () => {
  const { fn } = makeToolScriptedBackend([
    { tools: [{ name: 'write_file', input: { file_path: join(dir, 'nope.txt'), content: 'x' } }] },
    { text: 'fine' },
  ]);
  const agent = new Agent({ callModel: fn, print: () => {}, askUser: async () => false });
  await agent.chat('write it');

  const fedBack = agent.history()[2]!;
  const result = (fedBack.content as ContentBlockParam[])[0] as unknown as {
    content: string;
  };
  assert.ok(result.content.includes('user rejected'));
  const { access } = await import('node:fs/promises');
  await assert.rejects(() => access(join(dir, 'nope.txt')), /ENOENT/, '文件不应被创建');
});

test('空输出兜底：handler 返回空串 → 喂回 (empty output)', async () => {
  const { fn } = makeToolScriptedBackend([{ tools: [{ name: 'noop', input: {} }] }, { text: 'thanks' }]);
  const agent = new Agent({ callModel: fn, print: () => {} });
  // 注册一个"执行成功但无输出"的工具
  agent.registry.register({
    name: 'noop',
    description: 'no-op',
    inputSchema: { type: 'object', properties: {} },
    mode: 'read',
    handler: () => '',
  });
  await agent.chat('run it');

  const fedBack = agent.history()[2]!;
  const result = (fedBack.content as ContentBlockParam[])[0] as unknown as {
    content: string;
  };
  assert.equal(result.content, '(empty output)', '空结果以 (empty output) 标记喂回');
});

test('空输出兜底：纯空白字符串同样标记', async () => {
  const { fn } = makeToolScriptedBackend([{ tools: [{ name: 'whitespace', input: {} }] }, { text: 'ok' }]);
  const agent = new Agent({ callModel: fn, print: () => {} });
  agent.registry.register({
    name: 'whitespace',
    description: 'w',
    inputSchema: { type: 'object', properties: {} },
    mode: 'read',
    handler: () => '   \n  ',
  });
  await agent.chat('run it');

  const fedBack = agent.history()[2]!;
  const result = (fedBack.content as ContentBlockParam[])[0] as unknown as {
    content: string;
  };
  assert.equal(result.content, '(empty output)');
});

test('权限 plan 模式：写文件被 deny（只读约束由代码强制）', async () => {
  const { fn } = makeToolScriptedBackend([
    { tools: [{ name: 'write_file', input: { file_path: join(dir, 'plan.txt'), content: 'x' } }] },
    { text: 'ok' },
  ]);
  const agent = new Agent({ callModel: fn, print: () => {}, mode: 'plan' });
  await agent.chat('write in plan');

  const fedBack = agent.history()[2]!;
  const result = (fedBack.content as ContentBlockParam[])[0] as unknown as {
    content: string;
  };
  assert.ok(result.content.includes('Denied'), 'plan 下写文件被 permission 系统拦截');
});

test('events：tool_end 携带工具真实输出（Ctrl+O 面板数据源）', async () => {
  const { fn } = makeToolScriptedBackend([
    { tools: [{ name: 'read_file', input: { file_path: filePath } }] },
    { text: 'ok' },
  ]);
  const events: import('../src/agent.js').AgentEvent[] = [];
  const agent = new Agent({ callModel: fn, print: () => {}, events: (e) => events.push(e) });
  await agent.chat('read');
  const end = events.find((e) => e.type === 'tool_end');
  assert.ok(end && end.type === 'tool_end');
  assert.ok(String(end.output).includes('hello world'), 'tool_end 带文件内容');
});

test('interrupt：Esc 软中断在循环边界生效，不再发起新的模型调用', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const fn = async (_input: ModelInput): Promise<ModelOutput> => {
    calls++;
    await gate; // 模拟一次"长时间在飞"的模型调用
    return { content: [{ type: 'text', text: 'done' }] };
  };
  const agent = new Agent({ callModel: fn, print: () => {} });
  const p = agent.chat('go');
  await new Promise((r) => setTimeout(r, 10));
  agent.interrupt(); // Esc
  release();
  await p;

  assert.equal(agent.interruptedByUser, true);
  assert.equal(calls, 1, '中断后循环停在边界，不再发起第二轮');
  assert.equal(agent.history().length, 2, 'user + 一次 assistant 回复');
});

test('spinner 生命周期：模型期 thinking、工具期 running，start/stop 配平', async () => {
  const { fn } = makeScriptedBackend([1, -1], filePath);
  const events: string[] = [];
  const recording: import('../src/ui.js').SpinnerLike = {
    start: (m) => events.push(`start:${m}`),
    stop: () => events.push('stop'),
  };
  const agent = new Agent({ callModel: fn, print: () => {}, spinner: recording });
  await agent.chat('read it');

  assert.ok(
    events.some((e) => e.includes('thinking')),
    '模型期有 thinking',
  );
  assert.ok(
    events.some((e) => e.includes('running read_file')),
    '工具期有 running',
  );
  const starts = events.filter((e) => e.startsWith('start')).length;
  const stops = events.filter((e) => e === 'stop').length;
  assert.equal(starts, stops, '每个 start 都必须配一个 stop（spinner 不残留）');
});

test('模型调用事件序列：busy_think → busy_tokens(估算) → usage → busy_tokens(真实)', async () => {
  const { fn } = makeScriptedBackend([-1], filePath);
  const events: import('../src/agent.js').AgentEvent[] = [];
  const agent = new Agent({
    callModel: async (input) => ({
      ...(await fn(input)),
      usage: { input_tokens: 999, output_tokens: 42 },
    }),
    print: () => {},
    spinner: { start: () => {}, stop: () => {} },
    events: (ev) => events.push(ev),
  });
  await agent.chat('hi');

  const types = events.map((e) => e.type);
  assert.deepEqual(
    types.slice(0, 5),
    ['busy_think', 'busy_tokens', 'usage', 'busy_tokens', 'stream_end'],
    '顺序：思考相位 → 估算 → 真实 usage → 真实值回填 → 流结束',
  );
  const estimate = events[1] as { input_tokens: number };
  assert.ok(estimate.input_tokens > 0, '估算值非零');
  const usage = events[2] as { usage: { input_tokens: number; output_tokens: number } };
  assert.deepEqual(usage.usage, { input_tokens: 999, output_tokens: 42 }, '真实用量');
  const realBusy = events[3] as { input_tokens: number };
  assert.equal(realBusy.input_tokens, 999, '真实值覆盖估算回填 busy');
});
