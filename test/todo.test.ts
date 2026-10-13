import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE_PATH_ENV } from '../src/utils/paths.js';
import { Registry, type RuntimeContext } from '../src/registry.js';
import {
  loadTodos,
  normalizeTodos,
  renderTodos,
  registerTodoTool,
  saveTodos,
  todoFile,
} from '../src/todo.js';

const saved = process.env[BASE_PATH_ENV];
let home: string;
let cwd: string;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'b-code-todo-'));
  process.env[BASE_PATH_ENV] = home;
  cwd = join(home, 'proj');
});
after(async () => {
  if (saved === undefined) delete process.env[BASE_PATH_ENV];
  else process.env[BASE_PATH_ENV] = saved;
  await rm(home, { recursive: true, force: true });
});

test('normalizeTodos：清洗非法项、钳制状态、丢弃空内容', () => {
  const out = normalizeTodos([
    { content: '写测试', status: 'in_progress' },
    { content: '  ', status: 'pending' }, // 空 → 丢
    { content: '部署', status: 'weird' }, // 非法状态 → pending
    'not an object',
    { content: '带表述', status: 'completed', activeForm: 'Running it' },
  ]);
  assert.deepEqual(
    out.map((t) => [t.content, t.status]),
    [
      ['写测试', 'in_progress'],
      ['部署', 'pending'],
      ['带表述', 'completed'],
    ],
  );
  assert.equal(out[2]?.activeForm, 'Running it');
});

test('normalizeTodos：非数组 → []', () => {
  assert.deepEqual(normalizeTodos(null), []);
  assert.deepEqual(normalizeTodos({ content: 'x' }), []);
});

test('saveTodos / loadTodos：按项目隔离落盘并可回读', () => {
  const cwdA = join(home, 'a');
  const cwdB = join(home, 'b');
  saveTodos([{ content: 'A 任务', status: 'pending' }], cwdA);
  saveTodos([{ content: 'B 任务', status: 'completed' }], cwdB);

  assert.deepEqual(loadTodos(cwdA), [{ content: 'A 任务', status: 'pending' }]);
  assert.deepEqual(loadTodos(cwdB), [{ content: 'B 任务', status: 'completed' }]);
  assert.ok(todoFile(cwdA).startsWith(home), '落在 B_CODE_HOME 下');
});

test('loadTodos：无文件 / 损坏文件 → []', () => {
  assert.deepEqual(loadTodos(join(home, 'never-written')), []);
});

test('renderTodos：三态标记', () => {
  const text = renderTodos([
    { content: 'a', status: 'pending' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'completed' },
  ]);
  assert.equal(text, '[ ] a\n[~] b\n[x] c');
  assert.equal(renderTodos([]), '(no todos)');
});

test('todo_write 工具：selfGranted（免权限确认）并落盘 + 触发回调', async () => {
  const registry = new Registry();
  const seen: unknown[] = [];
  registerTodoTool(registry, { cwd, onTodos: (t) => seen.push(t) });

  const mp = registry.resolve('todo_write')!;
  assert.equal(mp.selfGranted, true, '自授权：不触发权限确认');
  assert.equal(mp.mode, 'write');

  const ctx: RuntimeContext = { callModel: async () => ({ content: [] }), model: 'm', setMode: () => {} };
  const result = await Promise.resolve(
    mp.handler(
      {
        todos: [
          { content: '第一步', status: 'in_progress', activeForm: 'Doing step 1' },
          { content: '第二步', status: 'pending' },
        ],
      },
      ctx,
    ) as string,
  );
  assert.ok(result.includes('第一步') && result.includes('第二步'), '返回更新后的清单');
  assert.equal(loadTodos(cwd).length, 2, '已落盘');
  assert.equal(seen.length, 1, 'onTodos 回调触发');
});

test('todo_write 工具：ctx.onTodos 也会收到更新（UI 接线）', async () => {
  const registry = new Registry();
  registerTodoTool(registry, { cwd });
  const got: unknown[] = [];
  const ctx = {
    callModel: async () => ({ content: [] }),
    model: 'm',
    setMode: () => {},
    onTodos: (t: unknown) => got.push(t),
  } as RuntimeContext;
  const mp = registry.resolve('todo_write')!;
  await Promise.resolve(mp.handler({ todos: [{ content: 'x', status: 'pending' }] }, ctx) as string);
  assert.equal(got.length, 1);
});
