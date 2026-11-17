import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  addUserTodo,
  clearAllUserTodos,
  clearDoneUserTodos,
  normalizeUserTodos,
  type UserTodo,
} from '../src/user-todo.js';

/**
 * `/todo_clear`：清空**用户自管**待办（user-todo.json 那份）。
 *
 * 与 `/todo clear`（只摘已完成）语义不同，这里必须能分清：
 *   - `/todo clear`      → clearDoneUserTodos，保留未完成项
 *   - `/todo_clear`      → clearAllUserTodos，整体归零
 */

const seed = (): UserTodo[] => [
  { id: 'a', content: '未完成的活', done: false, createdAt: 1 },
  { id: 'b', content: '已经做完的', done: true, createdAt: 2 },
];

test('clearAllUserTodos：全部清空（含未完成项）', () => {
  assert.deepEqual(clearAllUserTodos(seed()), []);
});

test('clearAllUserTodos：已空时返回同一个引用（调用方可据此跳过落盘）', () => {
  const empty: UserTodo[] = [];
  assert.equal(clearAllUserTodos(empty), empty, '返回原引用，不新建数组');
});

test('与 /todo clear 的区别：后者保留未完成项', () => {
  const todos = seed();
  const cleared = clearDoneUserTodos(todos);
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0]?.content, '未完成的活');
  // 而 todo_clear 是全清
  assert.equal(clearAllUserTodos(todos).length, 0);
});

test('清空后可以继续新增（不影响后续写入）', () => {
  const after = addUserTodo(clearAllUserTodos(seed()), '新的一条');
  assert.equal(after.length, 1);
  assert.equal(after[0]?.content, '新的一条');
  assert.equal(after[0]?.done, false);
});

test('normalizeUserTodos 对空数组/垃圾输入返回空清单（清空后可安全落盘）', () => {
  assert.deepEqual(normalizeUserTodos([]), []);
  assert.deepEqual(normalizeUserTodos(null), []);
});
