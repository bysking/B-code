import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dirs } from './utils/paths.js';
import { projectKey } from './memory.js';
import type { Registry, RuntimeContext } from './registry.js';

/**
 * 结构化待办（模型自管任务清单）——对齐 Claude Code 的 TodoWrite。
 *
 * 与"从工具调用反推"的 TaskPanel（deriveTaskPanel）不同：这份清单由**模型主动维护**，
 * 跨轮次存续，描述"要做什么"而非"正在跑什么"。多步任务里模型据此自我跟踪进度，
 * 用户也能看到全局任务视图。
 *
 * 存储：{B_CODE_HOME}/projects/{sha256(cwd)前16}/todo.json（按项目隔离，跨会话存续）。
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
  /** 进行中的动词短语（如 "Running tests"），供 UI 展示 activeForm */
  activeForm?: string;
}

const MAX_ITEMS = 50;
const MAX_CONTENT = 300;

export function todoFile(cwd: string = process.cwd()): string {
  return join(dirs.projectsDir(), projectKey(cwd), 'todo.json');
}

/** 读取项目待办（缺失/损坏 → []；不阻断） */
export function loadTodos(cwd: string = process.cwd()): TodoItem[] {
  const file = todoFile(cwd);
  if (!existsSync(file)) return [];
  try {
    return normalizeTodos(JSON.parse(readFileSync(file, 'utf-8')));
  } catch {
    return [];
  }
}

/** 写入项目待办（重建目录；失败静默——清单不是关键路径） */
export function saveTodos(todos: TodoItem[], cwd: string = process.cwd()): void {
  const file = todoFile(cwd);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(todos, null, 2), 'utf-8');
  } catch {
    // 写失败不影响本轮
  }
}

/** 清洗模型下发的 todos：过滤非法项、钳制长度与条数，保证 UI/存储拿到规整数据 */
export function normalizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TodoItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const content = typeof o.content === 'string' ? o.content.trim() : '';
    if (!content) continue;
    const status: TodoStatus = o.status === 'in_progress' || o.status === 'completed' ? o.status : 'pending';
    const todo: TodoItem = { content: content.slice(0, MAX_CONTENT), status };
    if (typeof o.activeForm === 'string' && o.activeForm.trim()) {
      todo.activeForm = o.activeForm.trim().slice(0, MAX_CONTENT);
    }
    out.push(todo);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/** 待办渲染为文本（喂回模型 / 控制台展示共用） */
export function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return '(no todos)';
  const mark: Record<TodoStatus, string> = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };
  return todos.map((t) => `${mark[t.status]} ${t.content}`).join('\n');
}

/**
 * 注册 todo_write 工具。selfGranted：只写本工具自己的项目数据目录（不碰用户工程），
 * 无需每次权限确认——否则多步任务会被待办确认框打断，得不偿失。
 */
export function registerTodoTool(
  registry: Registry,
  opts: { cwd?: string; onTodos?: (todos: TodoItem[]) => void } = {},
): void {
  registry.register({
    name: 'todo_write',
    description:
      'Create and update a structured task list for your current work. Use it to plan multi-step ' +
      'tasks and track progress. Pass the FULL list each call (it replaces the previous list). ' +
      'Exactly one item should be in_progress at a time; mark completed as soon as it is done. ' +
      'status: pending | in_progress | completed.',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete todo list (replaces the existing one).',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Imperative task description' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'Task state',
              },
              activeForm: {
                type: 'string',
                description: 'Present-continuous form shown while in_progress (e.g. "Running tests")',
              },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    mode: 'write',
    kind: 'builtin',
    selfGranted: true, // 只写自身数据目录，无工程副作用
    handler: (input, ctx: RuntimeContext) => {
      const todos = normalizeTodos(input.todos);
      saveTodos(todos, opts.cwd);
      opts.onTodos?.(todos);
      ctx.onTodos?.(todos);
      return `Todos updated (${todos.length}):\n${renderTodos(todos)}`;
    },
  });
}
