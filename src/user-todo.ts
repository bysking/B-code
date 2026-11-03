import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { dirs } from './utils/paths.js';
import { projectKey } from './memory.js';

/**
 * 用户自管待办清单（/todo 交互编辑）。
 *
 * 与 todo.ts 的**模型自管**清单（todo_write，描述"要做什么、做到哪了"）刻意分开：
 * 这份是**用户自己**的待办——用户手动新增/勾选/删除，与模型无关，也绝不喂给模型。
 * 两者存不同文件（user-todo.json / todo.json），互不干扰。
 *
 * 存储：{B_CODE_HOME}/projects/{sha256(cwd)前16}/user-todo.json（按项目隔离，跨会话存续）。
 */

export interface UserTodo {
  id: string;
  content: string;
  done: boolean;
  /** 创建时间戳（ms）；仅用于稳定排序/展示，不做业务判断 */
  createdAt: number;
}

const MAX_ITEMS = 200;
const MAX_CONTENT = 300;

export function userTodoFile(cwd: string = process.cwd()): string {
  return join(dirs.projectsDir(), projectKey(cwd), 'user-todo.json');
}

/** 读取用户待办（缺失/损坏 → []；不阻断启动） */
export function loadUserTodos(cwd: string = process.cwd()): UserTodo[] {
  const file = userTodoFile(cwd);
  if (!existsSync(file)) return [];
  try {
    return normalizeUserTodos(JSON.parse(readFileSync(file, 'utf-8')));
  } catch {
    return [];
  }
}

/** 写入用户待办（重建目录；失败静默——清单不是关键路径） */
export function saveUserTodos(todos: UserTodo[], cwd: string = process.cwd()): void {
  const file = userTodoFile(cwd);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(todos, null, 2), 'utf-8');
  } catch {
    // 写失败不影响本轮
  }
}

/** 生成待办 id（唯一即可，不参与排序） */
export function newUserTodoId(): string {
  return randomUUID().slice(0, 8);
}

/** 清洗落盘/外部输入：过滤非法项、钳制长度与条数，缺失字段补默认 */
export function normalizeUserTodos(raw: unknown): UserTodo[] {
  if (!Array.isArray(raw)) return [];
  const out: UserTodo[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const content = typeof o.content === 'string' ? o.content.trim() : '';
    if (!content) continue;
    let id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : newUserTodoId();
    if (seen.has(id)) id = newUserTodoId(); // 去重，避免同 id 导致勾选/删除错乱
    seen.add(id);
    out.push({
      id,
      content: content.slice(0, MAX_CONTENT),
      done: o.done === true,
      createdAt: typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : Date.now(),
    });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

// ── 纯变更（返回新数组，不改原数组；便于单测与 React 状态更新）──────

/** 追加一条待办（空内容 → 原样返回） */
export function addUserTodo(
  todos: UserTodo[],
  content: string,
  opts: { id?: string; now?: number } = {},
): UserTodo[] {
  const text = content.trim().slice(0, MAX_CONTENT);
  if (!text) return todos;
  if (todos.length >= MAX_ITEMS) return todos;
  const item: UserTodo = {
    id: opts.id?.trim() || newUserTodoId(),
    content: text,
    done: false,
    createdAt: opts.now ?? Date.now(),
  };
  return [...todos, item];
}

/** 勾选/取消某条（按 id；未命中 → 原样返回） */
export function toggleUserTodo(todos: UserTodo[], id: string): UserTodo[] {
  let hit = false;
  const next = todos.map((t) => {
    if (t.id !== id || hit) return t;
    hit = true;
    return { ...t, done: !t.done };
  });
  return hit ? next : todos;
}

/** 删除某条（按 id） */
export function removeUserTodo(todos: UserTodo[], id: string): UserTodo[] {
  const next = todos.filter((t) => t.id !== id);
  return next.length === todos.length ? todos : next;
}

/** 编辑某条内容（按 id；空内容视为无效 → 原样返回） */
export function editUserTodo(todos: UserTodo[], id: string, content: string): UserTodo[] {
  const text = content.trim().slice(0, MAX_CONTENT);
  if (!text) return todos;
  let hit = false;
  const next = todos.map((t) => {
    if (t.id !== id || hit) return t;
    hit = true;
    return { ...t, content: text };
  });
  return hit ? next : todos;
}

/** 清除所有已完成项 */
export function clearDoneUserTodos(todos: UserTodo[]): UserTodo[] {
  const next = todos.filter((t) => !t.done);
  return next.length === todos.length ? todos : next;
}

// ── 展示 ────────────────────────────────────────────────────────────

export function doneCount(todos: UserTodo[]): number {
  return todos.filter((t) => t.done).length;
}

/** 待办渲染为文本（非 TTY / 帮助信息共用） */
export function renderUserTodos(todos: UserTodo[]): string {
  if (todos.length === 0) return '(待办为空)';
  return todos
    .map((t, i) => {
      const mark = t.done ? '[x]' : '[ ]';
      // 序号按展示顺序给（1-based，供 /todo done|rm <n> 引用）
      const idx = String(i + 1).padStart(2, ' ');
      return `${idx}. ${mark} ${t.content}`;
    })
    .join('\n');
}

// ── 命令解析（/todo 子命令，TTY 与非 TTY 共用）──────────────────────

export type UserTodoCommand =
  | { kind: 'open' }
  | { kind: 'list' }
  | { kind: 'add'; text: string }
  | { kind: 'toggle'; index: number }
  | { kind: 'remove'; index: number }
  | { kind: 'clear-done' }
  | { kind: 'help' };

/** 1-based 序号 → 数组下标（越界返回 -1） */
export function indexToId(todos: UserTodo[], index: number): string | null {
  if (!Number.isInteger(index) || index < 1 || index > todos.length) return null;
  return todos[index - 1]?.id ?? null;
}

/**
 * 解析 `/todo` 之后的参数串。
 *   ''            → open（TTY 进交互编辑器；非 TTY 退化为 list）
 *   'list'        → list
 *   'add <文本>'  → add
 *   'done|check <n>' → toggle
 *   'rm|del|remove <n>' → remove
 *   'clear'       → clear-done
 *   'help'        → help
 * 其它未知子命令 → 视为 add 整串（容错：`/todo 买牛奶` 直接新增）。
 */
export function parseUserTodoCommand(args: string): UserTodoCommand {
  const trim = args.trim();
  if (!trim) return { kind: 'open' };
  const sp = trim.search(/\s/);
  const head = (sp === -1 ? trim : trim.slice(0, sp)).toLowerCase();
  const rest = sp === -1 ? '' : trim.slice(sp + 1).trim();
  switch (head) {
    case 'list':
    case 'ls':
      return { kind: 'list' };
    case 'add':
      return rest ? { kind: 'add', text: rest } : { kind: 'help' };
    case 'done':
    case 'check':
    case 'toggle':
      return rest ? { kind: 'toggle', index: Number(rest) } : { kind: 'help' };
    case 'rm':
    case 'del':
    case 'remove':
      return rest ? { kind: 'remove', index: Number(rest) } : { kind: 'help' };
    case 'clear':
      return { kind: 'clear-done' };
    case 'help':
      return { kind: 'help' };
    default:
      return { kind: 'add', text: trim };
  }
}

export const USER_TODO_HELP = [
  '用法:',
  '  /todo             打开待办清单（交互：↑↓ 选择 · 空格/Enter 勾选 · a 新增 · d 删除 · x 清已完成 · Esc 退出）',
  '  /todo add <文本>  新增一条待办',
  '  /todo done <序号> 勾选/取消第 <序号> 条',
  '  /todo rm <序号>   删除第 <序号> 条',
  '  /todo clear       清除所有已完成',
  '  /todo list        仅列出（非交互）',
].join('\n');
