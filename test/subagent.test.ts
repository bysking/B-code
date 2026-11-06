import { test, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry, type RuntimeContext } from '../src/registry.js';
import { registerBuiltinTools } from '../src/tools.js';
import { runSubAgent, summarizeResult, CRITIC_SYSTEM, SUBAGENT_INTERRUPTED } from '../src/subagent.js';
import type { ModelInput, ModelOutput } from '../src/backend.js';

let dir: string;
let filePath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'b-code-sub-'));
  filePath = join(dir, 'target.txt');
  await writeFile(filePath, 'subagent sees this');
});

afterAll(async () => {
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

test('回归：子 Agent 工具面不含 agent 子 Agent 工具，防无限递归套娃', async () => {
  const registry = new Registry();
  registerBuiltinTools(registry);
  // 复刻主 Agent 注册的 agent 工具形态：只读但 kind='subagent'
  registry.register({
    name: 'agent',
    description: 'fork a sub-agent',
    inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
    mode: 'read',
    kind: 'subagent',
    handler: () => 'should never run',
  });

  const calls: ModelInput[] = [];
  let step = 0;
  const callModel = async (input: ModelInput): Promise<ModelOutput> => {
    calls.push(input);
    step++;
    if (step === 1) {
      return {
        content: [
          { type: 'tool_use', id: 's-1', name: 'read_file', input: { file_path: filePath } },
          // 模型幻觉：调用未在工具面出现的 agent（递归入口）→ 执行路径须拦截
          { type: 'tool_use', id: 's-2', name: 'agent', input: { task: 'recurse forever' } },
        ],
      };
    }
    return { content: [{ type: 'text', text: 'done' }] };
  };

  const ctx: RuntimeContext = { callModel, model: 'm', setMode: () => {} };
  const result = await runSubAgent('explore', ctx, registry);
  assert.equal(result, 'done');

  // 工具面：agent 被排除（只读列表里不含它）
  const toolNames = calls[0]!.tools.map((t) => t.name);
  assert.ok(!toolNames.includes('agent'), `子 Agent 不应拿到 agent 工具，实际: ${toolNames}`);

  // 执行路径：即便模型幻觉调用 agent，也被拒（fail-closed），绝不递归
  const results = (
    calls[1]!.messages[2] as unknown as { content: { tool_use_id: string; content: string }[] }
  ).content;
  const agentResult = results.find((r) => r.tool_use_id === 's-2');
  assert.ok(String(agentResult?.content).includes('read-only'), 'agent 调用被拒而非递归执行');
  assert.ok(!String(agentResult?.content).includes('should never run'), 'agent handler 未被执行');
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

// ── 逐步播报（Ctrl+O「子 Agent」页的数据来源）─────────────────

test('逐步播报：text / tool / 结果摘要 / done 各一行，按序', async () => {
  const registry = new Registry();
  registerBuiltinTools(registry);
  let step = 0;
  const callModel = async (): Promise<ModelOutput> => {
    step++;
    if (step === 1) {
      return {
        content: [
          { type: 'text', text: '先读这个文件看看' },
          { type: 'tool_use', id: 's-1', name: 'read_file', input: { file_path: filePath } },
        ],
      };
    }
    return { content: [{ type: 'text', text: '结论：文件里写着 subagent sees this' }] };
  };
  const ctx: RuntimeContext = { callModel, model: 'm', setMode: () => {} };
  const lines: string[] = [];
  const result = await runSubAgent('explore', ctx, registry, undefined, (l) => lines.push(l));

  assert.equal(lines.length, 4, `应是 text/tool/结果/done 四行，实际: ${JSON.stringify(lines)}`);
  assert.ok(lines[0]!.startsWith('text   '), '模型文本行');
  assert.ok(lines[0]!.includes('先读这个文件看看'), '文本内容在内');
  assert.ok(lines[1]!.startsWith('tool   read_file'), '工具名在内');
  // 参数摘要按 INPUT_LABEL_MAX(60) 截断，长临时路径的尾段会被切掉——断言前缀即可
  assert.ok(lines[1]!.includes(filePath.slice(0, 20)), '参数摘要（路径）在内');
  assert.ok(lines[2]!.startsWith('←'), '结果摘要行');
  assert.match(lines[2]!, /\d+ 行/, `读文件应报行数：${lines[2]}`);
  assert.ok(lines[3]!.startsWith('done   '), '结束行');
  assert.ok(result.includes('subagent sees this'), '返回值不受播报影响');
});

test('逐步播报：长文本压成一行并截断（不把转录搬进面板）', async () => {
  const registry = new Registry();
  registerBuiltinTools(registry);
  let step = 0;
  const long = 'A'.repeat(500);
  const callModel = async (): Promise<ModelOutput> => {
    step++;
    // 第一轮带工具调用，长文本才会作为"中间轮的 text 行"被播报
    if (step === 1) {
      return {
        content: [
          { type: 'text', text: `第一行\n第二行\n${long}` },
          { type: 'tool_use', id: 's-1', name: 'read_file', input: { file_path: filePath } },
        ],
      };
    }
    return { content: [{ type: 'text', text: 'ok' }] };
  };
  const ctx: RuntimeContext = { callModel, model: 'm', setMode: () => {} };
  const lines: string[] = [];
  await runSubAgent('explore', ctx, registry, undefined, (l) => lines.push(l));

  const textLine = lines.find((l) => l.startsWith('text   '))!;
  assert.ok(!textLine.includes('\n'), '日志行必须单行');
  assert.ok(textLine.length <= 110, `应截断到 ~100 字符：${textLine.length}`);
});

test('中断时也播报收口行（面板不会停在半截）', async () => {
  const registry = new Registry();
  registerBuiltinTools(registry);
  const ac = new AbortController();
  const callModel = async (): Promise<ModelOutput> => {
    ac.abort(); // 第一轮模型调用后立刻取消
    return {
      content: [{ type: 'tool_use', id: 's-1', name: 'read_file', input: { file_path: filePath } }],
    };
  };
  const ctx: RuntimeContext = { callModel, model: 'm', setMode: () => {}, signal: ac.signal };
  const lines: string[] = [];
  const result = await runSubAgent('explore', ctx, registry, undefined, (l) => lines.push(l));

  assert.equal(result, SUBAGENT_INTERRUPTED);
  assert.ok(
    lines.some((l) => l.includes('中断')),
    `应有中断收口行：${JSON.stringify(lines)}`,
  );
});

test('summarizeResult：按工具返回形态给一眼可读的摘要', () => {
  assert.match(
    summarizeResult('read_file', 'body\n\n📄 /tmp/a.ts (42 行, 900 字节, hash abc)'),
    /^42 行$/,
    '读文件取指针行里的行数',
  );
  assert.equal(summarizeResult('grep_search', '(no matches)'), '无命中');
  assert.equal(summarizeResult('grep_search', 'a.ts:1: x\nb.ts:2: y'), '2 处命中');
  assert.equal(summarizeResult('list_files', 'a.ts\nb.ts\nc.ts'), '3 项');
  assert.equal(summarizeResult('mcp__github__get', '第一行内容\n第二行'), '第一行内容');
});
