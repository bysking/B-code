import { test, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, compactToolEcho } from '../src/agent.js';
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

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'b-code-agent-'));
  filePath = join(dir, 'target.txt');
  await writeFile(filePath, 'hello world');
});

afterAll(async () => {
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

test('持久化白名单：授权写回 store，下次启动免问（跨会话记忆）', async () => {
  const target = join(dir, 'persist.txt');
  const stored: string[] = [];
  const store = {
    load: () => [...stored],
    save: (keys: string[]) => {
      stored.length = 0;
      stored.push(...keys);
    },
  };

  // 第一次会话：写入需确认，用户同意 → 持久化键落 store
  const first = makeToolScriptedBackend([
    { tools: [{ name: 'write_file', input: { file_path: target, content: 'v1' } }] },
    { text: 'done' },
  ]);
  let asks1 = 0;
  const agent1 = new Agent({
    callModel: first.fn,
    print: () => {},
    allowlistStore: store,
    askUser: async () => {
      asks1++;
      return true;
    },
  });
  await agent1.chat('write');
  assert.equal(asks1, 1);
  assert.ok(stored.length >= 1, '授权已持久化');

  // 第二次会话：同一调用命中持久化键 → 不再询问
  const second = makeToolScriptedBackend([
    { tools: [{ name: 'write_file', input: { file_path: target, content: 'v2' } }] },
    { text: 'done' },
  ]);
  let asks2 = 0;
  const agent2 = new Agent({
    callModel: second.fn,
    print: () => {},
    allowlistStore: store, // 复用同一存储 = 模拟同一 settings.json
    askUser: async () => {
      asks2++;
      return true;
    },
  });
  await agent2.chat('write again');
  assert.equal(asks2, 0, '持久化白名单命中 → 第二次会话不再询问');
});

test('无 store 时不持久化：仅会话内白名单（测试/内嵌安全）', async () => {
  const target = join(dir, 'nostore.txt');
  const { fn } = makeToolScriptedBackend([
    { tools: [{ name: 'write_file', input: { file_path: target, content: 'a' } }] },
    { tools: [{ name: 'write_file', input: { file_path: target, content: 'b' } }] },
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
  assert.equal(asks, 1, '会话内白名单仍生效（第二次免问）');
});

test('Hooks：PreToolUse 拦截 → 工具不执行，结果回给模型', async () => {
  const target = join(dir, 'hook-blocked.txt');
  const { fn } = makeToolScriptedBackend([
    { tools: [{ name: 'write_file', input: { file_path: target, content: 'x' } }] },
    { text: 'ok' },
  ]);
  const agent = new Agent({
    callModel: fn,
    print: () => {},
    mode: 'bypass', // 跳过权限确认，只验证 hook 层
    hooks: {
      PreToolUse: [{ command: `node -e 'process.stderr.write("forbidden"); process.exit(2)'` }],
    },
  });
  await agent.chat('write it');

  const fedBack = agent.history()[2]!;
  const result = (fedBack.content as ContentBlockParam[])[0] as unknown as { content: string };
  assert.ok(result.content.includes('Blocked by PreToolUse hook'), `应被 hook 拦截：${result.content}`);
  assert.ok(result.content.includes('forbidden'), '原因透传');
  const { access } = await import('node:fs/promises');
  await assert.rejects(() => access(target), /ENOENT/, 'hook 拦截 → 文件未创建');
});

test('Hooks：UserPromptSubmit 拦截 → 原因追加进 prompt', async () => {
  const seen: string[] = [];
  const { fn } = makeScriptedBackend([-1], filePath);
  const agent = new Agent({
    callModel: async (input) => {
      const first = input.messages[0]!;
      seen.push(typeof first.content === 'string' ? first.content : JSON.stringify(first.content));
      return fn(input);
    },
    print: () => {},
    hooks: {
      UserPromptSubmit: [{ command: `node -e 'process.stderr.write("nope"); process.exit(2)'` }],
    },
  });
  await agent.chat('do something');
  assert.ok(seen[0]?.includes('hook notice: nope'), `prompt 应带 hook 提示：${seen[0]}`);
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

// ── 子 Agent 事件（Ctrl+O「子 Agent」页的数据源）────────────────
//
// 脚本后端按**调用顺序**取脚本，而子 Agent 的模型调用夹在父级那次工具调用
// 中间，所以序号天然是：父 → 子(若干轮) → 父。

test('events：子 Agent 的 start/log/end 成对出现，id 与 role 正确', async () => {
  const { fn } = makeToolScriptedBackend([
    { tools: [{ name: 'agent', input: { task: '看看 target.txt 写了什么' } }] }, // 1 父：派子 Agent
    { tools: [{ name: 'read_file', input: { file_path: filePath } }] }, // 2 子：读文件
    { text: '文件里是 hello world' }, // 3 子：收尾
    { text: '父收到摘要' }, // 4 父：继续
  ]);
  const events: import('../src/agent.js').AgentEvent[] = [];
  const agent = new Agent({ callModel: fn, print: () => {}, events: (e) => events.push(e) });
  await agent.chat('派个子 agent 去看看');

  const start = events.find((e) => e.type === 'subagent_start');
  assert.ok(start?.type === 'subagent_start', '有 subagent_start');
  assert.equal(start.role, 'explore', 'agent 工具的人设是 explore');
  assert.ok(start.task.includes('target.txt'), `任务摘要进事件：${start.task}`);

  const logs = events.filter((e) => e.type === 'subagent_log');
  assert.ok(logs.length >= 3, `至少 tool/结果/done 三步：${JSON.stringify(logs)}`);
  assert.ok(
    logs.every((l) => l.type === 'subagent_log' && l.id === start.id),
    '所有步骤与 start 同 id（面板据此归到同一页）',
  );
  assert.ok(
    logs.some((l) => l.type === 'subagent_log' && l.line.startsWith('tool   read_file')),
    `子 Agent 的工具调用被播报：${JSON.stringify(logs)}`,
  );

  const end = events.find((e) => e.type === 'subagent_end');
  assert.ok(end?.type === 'subagent_end', '有 subagent_end');
  assert.equal(end.id, start.id);
  assert.equal(end.status, 'done');
  assert.ok(String(end.summary).includes('hello world'), '末行带摘要首段');

  // 时序：start 在首个步骤之前，end 在最后一个步骤之后
  assert.ok(
    events.indexOf(start) < events.indexOf(logs[0]!),
    'start 必须先于步骤（否则面板要等第一次模型调用才有条目）',
  );
  assert.ok(events.indexOf(logs[logs.length - 1]!) < events.indexOf(end), 'end 收口在最后');
});

test('并发子 Agent：同一批的多个 agent 调用并行执行，日志按 id 各归各的页', async () => {
  // 并行性的判定用**屏障**而不是计时：A 的第一轮模型调用会一直等到 B 也开跑。
  // 若执行是串行的，A 永远等不到 → 测试超时失败。
  let releaseB!: () => void;
  const bStarted = new Promise<void>((r) => {
    releaseB = r;
  });
  const calls = new Map<string, number>();
  const fn = async (input: ModelInput): Promise<ModelOutput> => {
    const head = input.messages[0]!.content;
    const task = typeof head === 'string' ? head : '';
    if (task.startsWith('任务')) {
      const n = (calls.get(task) ?? 0) + 1;
      calls.set(task, n);
      if (task.startsWith('任务A') && n === 1) {
        await bStarted; // 等 B 开跑：串行执行会在这里死等
        return {
          content: [{ type: 'tool_use', id: 'a1', name: 'read_file', input: { file_path: filePath } }],
        };
      }
      if (task.startsWith('任务B') && n === 1) {
        releaseB();
        return { content: [{ type: 'text', text: 'B 一轮就完事' }] };
      }
      return { content: [{ type: 'text', text: `${task.slice(0, 3)}完成` }] };
    }
    // 父级：第一轮同时派两个子 Agent
    if (calls.size === 0) {
      return {
        content: [
          { type: 'tool_use', id: 'p1', name: 'agent', input: { task: '任务A：查输入框' } },
          { type: 'tool_use', id: 'p2', name: 'agent', input: { task: '任务B：查面板' } },
        ],
      };
    }
    return { content: [{ type: 'text', text: '父完成' }] };
  };

  const events: import('../src/agent.js').AgentEvent[] = [];
  const agent = new Agent({ callModel: fn, print: () => {}, events: (e) => events.push(e) });
  await agent.chat('派两个子 agent 并行查');

  const starts = events.filter((e) => e.type === 'subagent_start');
  assert.equal(starts.length, 2, '两个 subagent_start');
  assert.equal(new Set(starts.map((s) => s.id)).size, 2, 'id 不重复');
  assert.ok(
    starts.every((s) => s.role === 'explore'),
    '两个都走 explore 人设',
  );

  // 归页：每个 id 的步骤里只有自己的痕迹（并发交错也不会串页）
  const logsOf = (id: string) =>
    events
      .filter((e) => e.type === 'subagent_log' && e.id === id)
      .map((e) => (e.type === 'subagent_log' ? e.line : ''));
  const [first, second] = starts.map((s) => s.id);
  const aLogs = logsOf(first!);
  const bLogs = logsOf(second!);
  assert.ok(aLogs.some((l) => l.startsWith('tool   read_file')), `A 有自己的工具步骤：${aLogs}`);
  assert.ok(aLogs.some((l) => l.includes('任务A完成')), 'A 有自己的收尾');
  assert.ok(!bLogs.some((l) => l.includes('read_file')), `B 不该混进 A 的步骤：${bLogs}`);
  assert.ok(bLogs.some((l) => l.includes('B 一轮就完事')), 'B 有自己的收尾');

  const ends = events.filter((e) => e.type === 'subagent_end');
  assert.equal(ends.length, 2, '两个都有 end（不会漏收口）');
  assert.ok(
    ends.every((e) => e.type === 'subagent_end' && e.status === 'done'),
    '两个都是 done',
  );
});

test('events：review_plan 派出的审查子 Agent，role 标记为 plan-critic', async () => {
  const { fn } = makeToolScriptedBackend([
    { tools: [{ name: 'review_plan', input: { plan: '1. 改 schema\n2. 上线' } }] }, // 1 父
    { text: 'REVISE: 第 2 步没有回滚' }, // 2 子（对抗审查）
    { text: '父收到审查结论' }, // 3 父
  ]);
  const events: import('../src/agent.js').AgentEvent[] = [];
  const agent = new Agent({ callModel: fn, print: () => {}, events: (e) => events.push(e) });
  await agent.chat('审查一下这个计划');

  const start = events.find((e) => e.type === 'subagent_start');
  assert.ok(start?.type === 'subagent_start');
  assert.equal(start.role, 'plan-critic', '复用同一循环但人设不同');
  const end = events.find((e) => e.type === 'subagent_end');
  assert.ok(end?.type === 'subagent_end' && String(end.summary).includes('REVISE'));
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

test('硬中断：interrupt() 立即 abort 模型请求的 signal，取消不上抛为接口错误', async () => {
  let calls = 0;
  const fn = async (input: ModelInput): Promise<ModelOutput> => {
    calls++;
    assert.ok(input.signal, '模型调用收到取消信号');
    // 模拟真实后端：等待期间被 abort → 抛 AbortError
    return new Promise<ModelOutput>((_resolve, reject) => {
      const sig = input.signal!;
      const onAbort = () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (sig.aborted) return onAbort();
      sig.addEventListener('abort', onAbort, { once: true });
    });
  };
  const agent = new Agent({ callModel: fn, print: () => {} });
  const p = agent.chat('go');
  await new Promise((r) => setTimeout(r, 10));
  agent.interrupt(); // Esc → abort 在飞请求
  await p; // 不应抛出

  assert.equal(agent.interruptedByUser, true, '标记为用户中断');
  assert.equal(calls, 1, '取消后不再发起第二轮模型调用');
});

test('硬中断：shell 工具执行中被取消——子进程立即终止，结果带中断标记', async () => {
  let step = 0;
  const fn = async (_input: ModelInput): Promise<ModelOutput> => {
    step++;
    if (step === 1) {
      return {
        content: [{ type: 'tool_use', id: 'tu-shell', name: 'run_shell', input: { command: 'sleep 30' } }],
      };
    }
    return { content: [{ type: 'text', text: 'done' }] };
  };
  const agent = new Agent({ callModel: fn, print: () => {}, mode: 'bypass' });
  const start = Date.now();
  const p = agent.chat('run long command');
  await new Promise((r) => setTimeout(r, 300)); // 等 shell 起来
  agent.interrupt(); // Esc → SIGTERM 子进程
  await p;

  assert.ok(Date.now() - start < 10_000, '远早于 sleep 30s：子进程被真正终止');
  assert.equal(agent.interruptedByUser, true);
  assert.equal(step, 1, '中断后不再发起第二轮模型调用');
  // 中断标记落进喂回的 tool_result
  const fedBack = agent.history()[agent.history().length - 1]!;
  const result = (fedBack.content as ContentBlockParam[])[0] as unknown as { content: string };
  assert.ok(String(result.content).includes('interrupted'), '工具结果带中断标记');
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

// ── 工具调用重试（幂等工具才重试；写/shell 绝不重试）────────────────

/** 注册一个可控失败次数的假工具，捕获 handler 被调用次数 */
function registerFlakyTool(
  agent: Agent,
  name: string,
  mode: 'read' | 'write' | 'shell' | 'external',
  failTimes: number,
) {
  let calls = 0;
  agent.registry.register({
    name,
    description: `flaky ${name}`,
    inputSchema: { type: 'object', properties: {} },
    mode,
    kind: 'builtin',
    handler: () => {
      calls++;
      if (calls <= failTimes) {
        throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
      }
      return `${name}-ok`;
    },
  });
  return () => calls;
}

/** 让模型先调用一次指定工具，再文本收尾 */
function callToolOnce(fn: (input: ModelInput) => Promise<ModelOutput>, toolName: string) {
  let step = 0;
  return async (input: ModelInput): Promise<ModelOutput> => {
    step++;
    if (step === 1) {
      return { content: [{ type: 'tool_use', id: 'tu-x', name: toolName, input: {} }] };
    }
    return fn(input);
  };
}

test('工具重试：只读工具遇网络错误会重试并最终成功', async () => {
  const { fn } = makeToolScriptedBackend([{ tools: [{ name: 'read_flaky', input: {} }] }, { text: 'done' }]);
  const agent = new Agent({
    callModel: (i: ModelInput) => fn(i),
    print: () => {},
    askUser: async () => true, // 权限层放行（headless 默认拒，会挡住工具执行）
    retrySleep: async () => {}, // 即时退避：不真等 10s
  });
  const calls = registerFlakyTool(agent, 'read_flaky', 'read', 2); // 前两次失败，第三次成功
  await agent.chat('go');

  assert.equal(calls(), 3, '只读工具失败后重试，共执行 3 次');
  const last = agent
    .history()
    .filter((m) => m.role === 'user')
    .at(-1) as {
    content: { content: string }[];
  };
  assert.ok(String(last.content[0]!.content).includes('read_flaky-ok'), '重试后成功，结果喂回模型');
});

test('工具重试：写工具遇到可重试错误也不自动重试（防重复写入）', async () => {
  const { fn } = makeToolScriptedBackend([{ tools: [{ name: 'write_flaky', input: {} }] }, { text: 'done' }]);
  const agent = new Agent({
    callModel: (i: ModelInput) => fn(i),
    print: () => {},
    askUser: async () => true,
  });
  const calls = registerFlakyTool(agent, 'write_flaky', 'write', 1);
  await agent.chat('go');

  assert.equal(calls(), 1, '写工具失败只执行 1 次，绝不重试');
  const last = agent
    .history()
    .filter((m) => m.role === 'user')
    .at(-1) as { content: { content: string }[] };
  assert.ok(String(last.content[0]!.content).startsWith('Error:'), '错误原样交给模型判断');
});

test('工具重试：shell 工具遇到可重试错误也不自动重试（防命令重复执行）', async () => {
  const { fn } = makeToolScriptedBackend([{ tools: [{ name: 'shell_flaky', input: {} }] }, { text: 'done' }]);
  const agent = new Agent({
    callModel: (i: ModelInput) => fn(i),
    print: () => {},
    askUser: async () => true,
  });
  const calls = registerFlakyTool(agent, 'shell_flaky', 'shell', 1);
  await agent.chat('go');

  assert.equal(calls(), 1, 'shell 失败只执行 1 次，绝不重试');
});

// ── 工具回显压缩：write_file 不能把整篇文件打进终端 ────────────

test('compactToolEcho：短参数原样展示，不损失辨识度', () => {
  assert.equal(compactToolEcho({ file_path: 'src/a.ts' }), 'file_path: "src/a.ts"');
  assert.equal(compactToolEcho({ command: 'npm test' }), 'command: "npm test"');
});

test('compactToolEcho：write_file 的整篇文件内容被压成单行短摘要', () => {
  // 回归：原样 JSON.stringify 会把 400 行文件压成一行 5000+ 字符，
  // 按 100 列折成 50+ 行 → live 帧超终端行数 → ink 整屏清屏（视口被重置）
  const content = 'const a = 1;\n'.repeat(400);
  const out = compactToolEcho({ file_path: '/x/a.ts', content });

  assert.ok(out.length < 200, `回显必须压到 200 字符内（实际 ${out.length}）`);
  assert.ok(out.includes('/x/a.ts'), '保留文件路径，能看出在操作哪个文件');
  assert.ok(/\d+ 行 \/ \d+ 字符/.test(out), '标注原内容体积（行数/字符数），比裸截断更有信息量');
  assert.ok(!out.includes('\n'), '必须单行——多行会直接撑高 live 帧');
});

test('compactToolEcho：edit_file 的大段 old/new 也被压缩', () => {
  const out = compactToolEcho({
    file_path: 'a.ts',
    old_string: 'x'.repeat(500),
    new_string: 'y\n'.repeat(200),
  });
  assert.ok(out.length < 250, `总长须受控（实际 ${out.length}）`);
  assert.ok(out.includes('a.ts'));
  assert.ok(!out.includes('\n'));
});

test('compactToolEcho：多参数拼接过长时硬截断（兜底，绝不允许撑爆一屏）', () => {
  const out = compactToolEcho({
    a: 'x'.repeat(80),
    b: 'y'.repeat(80),
    c: 'z'.repeat(80),
    d: 'w'.repeat(80),
  });
  assert.ok(out.length <= 200 + 20, `硬截断生效（实际 ${out.length}）`);
});

test('compactToolEcho：非字符串参数走 JSON，非对象输入返回空串', () => {
  assert.equal(compactToolEcho({ count: 3, flag: true }), 'count: 3, flag: true');
  assert.equal(compactToolEcho(null), '');
  assert.equal(compactToolEcho(undefined), '');
  assert.equal(compactToolEcho('str'), '');
});

// ── 能力启停（技能 / MCP）────────────────────────────────────
//
// 核心不变量：**禁用项不进入发给模型的上下文**。
// 技能走 system prompt 过滤，MCP 走 toolsSchema 过滤——两条路径分别验证。

/** 捕获每次模型调用的 system / tools，便于断言"发了什么" */
function makeCapturingBackend() {
  const calls: ModelInput[] = [];
  const fn = async (input: ModelInput): Promise<ModelOutput> => {
    calls.push({ ...input, messages: [...input.messages] });
    return { content: [{ type: 'text', text: 'ok' }] };
  };
  return { fn, calls };
}

/** 把 system blocks 拼成可搜索的纯文本 */
function systemText(input: ModelInput): string {
  const sys = input.system;
  if (typeof sys === 'string') return sys;
  return (sys ?? []).map((b) => ('text' in b ? b.text : '')).join('\n');
}

/**
 * 只取 `# Available Skills` 段。
 *
 * 必须切开看：动态上下文里还有 Git 状态（`?? .claude/skills/xxx.md`）等段落会
 * 顺带提到技能文件名，直接在全文里搜 name 会误判"还注入着"。
 */
function skillsSection(input: ModelInput): string {
  const text = systemText(input);
  const idx = text.indexOf('# Available Skills');
  if (idx === -1) return '';
  const rest = text.slice(idx);
  // 段落到下一个 "^\n# " 标题为止
  const end = rest.search(/\n\n# /);
  return end === -1 ? rest : rest.slice(0, end);
}

test('禁用技能：不进 system prompt；启用后恢复', async () => {
  const disabledFile = join(dir, 'settings-skills.json');
  const { fn, calls } = makeCapturingBackend();
  const agent = new Agent({ callModel: fn, print: () => {}, disabledFile });
  await agent.initMcp();

  // 先造一个可见技能：写进 cwd 的技能目录（discoverSkills 只扫 cwd 与共享目录）
  // 用项目级目录，避免污染真实 ~/.claude/skills
  const skillDir = join(process.cwd(), '.claude', 'skills');
  const skillFile = join(skillDir, '__toggle_test_skill.md');
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    skillFile,
    '---\nname: __toggle_test_skill\ndescription: toggle me\nuser-invocable: true\n---\nbody\n',
  );
  try {
    await agent.chat('hello');
    assert.ok(skillsSection(calls[0]!).includes('__toggle_test_skill'), '未禁用时注入');

    assert.equal(agent.toggleSkill('__toggle_test_skill'), false, '切换后变为禁用');
    await agent.chat('hello again');
    assert.ok(
      !skillsSection(calls[1]!).includes('__toggle_test_skill'),
      '禁用后不再注入 system prompt',
    );

    assert.equal(agent.toggleSkill('__toggle_test_skill'), true, '再切回来变启用');
    await agent.chat('third');
    assert.ok(skillsSection(calls[2]!).includes('__toggle_test_skill'), '恢复注入');
  } finally {
    await rm(skillFile, { force: true });
  }
});

test('禁用技能：状态落盘，新 Agent 读回依然禁用', async () => {
  const disabledFile = join(dir, 'settings-persist.json');
  const a1 = new Agent({ callModel: makeCapturingBackend().fn, print: () => {}, disabledFile });
  a1.toggleSkill('commit');
  a1.toggleMcpServer('github');

  const a2 = new Agent({ callModel: makeCapturingBackend().fn, print: () => {}, disabledFile });
  const snap = a2.disabledSnapshot();
  assert.deepEqual(snap.skills, ['commit'], '技能禁用跨实例持久');
  assert.deepEqual(snap.mcpServers, ['github'], 'MCP 禁用跨实例持久');
});

test('禁用 MCP：工具从 toolsSchema 摘掉；resolve 仍可执行（旧会话兜底）', async () => {
  const disabledFile = join(dir, 'settings-mcp.json');
  const { fn, calls } = makeCapturingBackend();
  const agent = new Agent({ callModel: fn, print: () => {}, disabledFile });

  // 手工挂一个 MCP 形态工具（不启动真实子进程）
  agent.registry.register({
    name: 'mcp__fake__echo',
    description: 'echo',
    inputSchema: { type: 'object', properties: {} },
    kind: 'mcp',
    mode: 'read',
    handler: () => 'echo!',
  });

  agent.toggleMcpServer('fake'); // 禁用 → 立即同步 registry 前缀
  await agent.chat('hi');
  const tools = (calls[0]!.tools ?? []).map((t) => t.name);
  assert.ok(!tools.includes('mcp__fake__echo'), '禁用后不发给模型');
  assert.ok(agent.registry.resolve('mcp__fake__echo'), 'resolve 仍可达（历史 tool_use 不崩）');

  agent.toggleMcpServer('fake'); // 恢复
  await agent.chat('hi again');
  const tools2 = (calls[1]!.tools ?? []).map((t) => t.name);
  assert.ok(tools2.includes('mcp__fake__echo'), '启用后重新发给模型');
});

test('reconnectMcp：未配置的 server 返回失败结果，不抛', async () => {
  const agent = new Agent({
    callModel: makeCapturingBackend().fn,
    print: () => {},
    disabledFile: join(dir, 'settings-reconnect.json'),
  });
  const r = await agent.reconnectMcp('definitely-not-configured');
  assert.equal(r.ok, false);
  assert.ok(r.error);
});
