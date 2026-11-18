import { test, beforeEach, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/agent.js';
import { saveTodos, todoFile, type TodoItem } from '../src/todo.js';
import { BASE_PATH_ENV } from '../src/utils/paths.js';
import type { ModelInput, ModelOutput } from '../src/backend.js';
import type { AgentEvent } from '../src/agent.js';

/**
 * 任务完成后**主动清理**项目级 todo.json。
 *
 * 背景：`saveTodos` 已有"全部完成即删文件"，但那条路径只在模型主动调
 * `todo_write` 时才走到。模型跑完就停手是常态，于是 `in_progress` 会永久
 * 留在文件里，下次启动又冒出来。这里锁住 Agent 层的收尾清理规则。
 */

const savedHome = process.env[BASE_PATH_ENV];
const originalCwd = process.cwd();
let home: string;
/** 每个用例独占一个"项目目录"：todo.json 按 cwd 隔离，必须真的切过去 */
let cwd: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'b-code-todo-auto-'));
  process.env[BASE_PATH_ENV] = home;
  cwd = join(home, 'project');
  // Agent 内部用 process.cwd() 定位本项目 —— 和真实运行一致
  process.chdir(await mkdtemp(join(tmpdir(), 'b-code-proj-')));
  cwd = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (savedHome === undefined) delete process.env[BASE_PATH_ENV];
  else process.env[BASE_PATH_ENV] = savedHome;
  await rm(home, { recursive: true, force: true });
});

/** 只回一句话、不调工具的假后端 */
function textOnly(text = 'done'): (input: ModelInput) => Promise<ModelOutput> {
  return async () => ({ content: [{ type: 'text', text }] as any }) as ModelOutput;
}

function makeAgent(events?: (ev: AgentEvent) => void) {
  return new Agent({ callModel: textOnly(), print: () => {}, mode: 'auto', events });
}

/**
 * 往项目里写一份待办。
 *
 * 注意：`saveTodos` 对"全部完成"会**直接删文件**，所以造前置数据时至少要留
 * 一条 pending/in_progress——否则文件根本不会诞生，用例就测了个空。
 */
const seed = (todos: TodoItem[]) => saveTodos(todos, cwd);

test('chat 自然结束：没有 in_progress 残留 → 待办文件被清理', async () => {
  seed([
    { content: '写代码', status: 'completed' },
    { content: '还没动', status: 'pending' },
  ]);
  assert.ok(existsSync(todoFile(cwd)), '前置：文件存在');

  const cleared: string[] = [];
  const agent = makeAgent((ev) => {
    if (ev.type === 'todo_cleared') cleared.push(ev.type);
  });
  // 载入磁盘上的待办（构造函数里做的），再跑一轮自然结束的 chat
  await agent.chat('做完了');

  assert.equal(existsSync(todoFile(cwd)), false, '文件被删掉');
  assert.deepEqual(agent.todoList(), [], '内存快照也归零');
  assert.equal(cleared.length, 1, '发出 todo_cleared 事件供 UI 收起清单');
});

test('chat 自然结束：pending 项也算收口（模型结束了本轮却没推进它）', async () => {
  seed([
    { content: '已完成', status: 'completed' },
    { content: '没来得及做', status: 'pending' },
  ]);
  const agent = makeAgent();
  await agent.chat('先这样吧');
  assert.equal(existsSync(todoFile(cwd)), false, 'pending 残留一并清掉');
  assert.deepEqual(agent.todoList(), []);
});

test('chat 结束：还有 in_progress → 保留（任务中途中断，下次要能接着做）', async () => {
  seed([
    { content: '已完成', status: 'completed' },
    { content: '正在做', status: 'in_progress' },
  ]);
  const agent = makeAgent();
  await agent.chat('继续');

  assert.ok(existsSync(todoFile(cwd)), '文件保留');
  assert.equal(agent.todoList().length, 2, '内存快照保留');
  assert.equal(agent.todoList()[1]?.status, 'in_progress');
});

test('clearHistory（/clear）：无论状态如何都清掉待办文件', async () => {
  seed([{ content: '正在做', status: 'in_progress' }]);
  const agent = makeAgent();
  assert.equal(agent.todoList().length, 1, '前置：载入到了');

  agent.clearHistory();

  assert.equal(existsSync(todoFile(cwd)), false, '/clear 是"这轮不要了"');
  assert.deepEqual(agent.todoList(), []);
});

test('clearStaleTodos：无残留时返回 false，有残留时返回 true', async () => {
  const agent = makeAgent();

  // 空清单 → 没有可清的
  assert.equal(agent.clearStaleTodos(), false);

  // 无 in_progress（completed + pending）→ 有可清的
  seed([
    { content: 'x', status: 'completed' },
    { content: 'y', status: 'pending' },
  ]);
  const agent2 = makeAgent();
  assert.equal(agent2.todoList().length, 2, '前置：载入到了');
  assert.equal(agent2.clearStaleTodos(), true);

  // 有 in_progress → 保留，返回 false
  seed([{ content: 'y', status: 'in_progress' }]);
  const agent3 = makeAgent();
  assert.equal(agent3.clearStaleTodos(), false);
  assert.equal(agent3.todoList().length, 1, '没有被动过');
});

test('清理是按项目隔离的：不影响别的项目目录', async () => {
  const other = join(home, 'other-project');
  saveTodos([{ content: '别的项目的活', status: 'pending' }], other);
  seed([
    { content: '本项目的活', status: 'completed' },
    { content: '还有一条', status: 'pending' },
  ]);

  const agent = makeAgent();
  await agent.chat('done');

  assert.equal(existsSync(todoFile(cwd)), false, '本项目被清');
  assert.ok(existsSync(todoFile(other)), '别的项目不受影响');
});

/**
 * `/todo_clear` 的 Agent 侧：用户主动清空 → **无条件**归零（含 in_progress）。
 *
 * 与 `clearStaleTodos` 的差别只有 in_progress 保护：那个是任务收尾的自动清理，
 * 正在做的那条要留着；用户明说"清掉"时就不该再护着它。
 */
test('clearTodoList（/todo_clear）：in_progress 也一并清掉，返回被清条数', async () => {
  seed([
    { content: '正在做', status: 'in_progress' },
    { content: '还没动', status: 'pending' },
  ]);
  const cleared: string[] = [];
  const agent = makeAgent((ev) => {
    if (ev.type === 'todo_cleared') cleared.push(ev.type);
  });
  assert.equal(agent.todoList().length, 2, '前置：载入到了');

  assert.equal(agent.clearTodoList(), 2, '返回被清掉的条数');

  assert.equal(existsSync(todoFile(cwd)), false, '磁盘文件被删');
  assert.deepEqual(agent.todoList(), [], '内存快照归零');
  assert.equal(cleared.length, 1, '发出 todo_cleared 事件供 UI 收起清单');
});

test('clearTodoList：本来就没有待办 → 返回 0 且不发事件（UI 不该闪一下）', () => {
  const cleared: string[] = [];
  const agent = makeAgent((ev) => {
    if (ev.type === 'todo_cleared') cleared.push(ev.type);
  });

  assert.equal(agent.clearTodoList(), 0);
  assert.equal(cleared.length, 0, '空清单不产生事件');
});
