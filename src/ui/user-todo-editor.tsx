import React, { useState } from 'react';
import { Box, Text, useInput } from './ui/index.js';
import { SimpleTextInput } from './input-box.js';
import {
  addUserTodo,
  clearDoneUserTodos,
  doneCount,
  editUserTodo,
  removeUserTodo,
  toggleUserTodo,
  type UserTodo,
} from '../user-todo.js';

/** 展示数封顶：面板撑超终端行数会触发 Ink 整屏清屏（滚动位置被重置） */
const MAX_VISIBLE = 12;

/** 编辑态：新增 / 编辑某条（携带该条 id） */
type Editing = { kind: 'add' } | { kind: 'edit'; id: string };

/**
 * /todo 交互编辑器（TTY）。用户自管待办清单 —— 与模型自管（TodoPanel）无关。
 * 打开时 App 让出键盘（不处理 ↑↓/Enter），全部按键在此消费。
 *
 * 键位：↑↓/jk 选择 · 空格/Enter 勾选 · a 新增 · e 编辑 · d 删除 · x 清已完成 · Esc 退出。
 * 变更经 onChange 回写 controller.setUserTodos（内存 + 落盘）；本组件不持有清单（受控）。
 */
export function UserTodoEditor({
  todos,
  onChange,
  onClose,
}: {
  todos: UserTodo[];
  onChange: (todos: UserTodo[]) => void;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState('');

  // 选择收敛在 [0, len)：清单长度变化（删除/清空）后光标不越界
  const clamped = todos.length === 0 ? 0 : Math.min(idx, todos.length - 1);
  const visibleStart = Math.max(
    0,
    Math.min(clamped - Math.floor(MAX_VISIBLE / 2), todos.length - MAX_VISIBLE),
  );
  const visible = todos.slice(visibleStart, visibleStart + MAX_VISIBLE);
  const done = doneCount(todos);

  const startEdit = () => {
    const cur = todos[clamped];
    if (!cur) return;
    setDraft(cur.content);
    setEditing({ kind: 'edit', id: cur.id });
  };

  const commit = () => {
    if (!editing) return;
    onChange(editing.kind === 'add' ? addUserTodo(todos, draft) : editUserTodo(todos, editing.id, draft));
    setEditing(null);
    setDraft('');
  };

  // 浏览态按键（编辑态交由 SimpleTextInput 处理：Enter 提交 / 其余编辑文本）
  useInput(
    (input, key) => {
      if (key.escape) {
        onClose();
        return;
      }
      if (key.upArrow || input === 'k') {
        setIdx(todos.length === 0 ? 0 : (clamped - 1 + todos.length) % todos.length);
        return;
      }
      if (key.downArrow || input === 'j') {
        setIdx(todos.length === 0 ? 0 : (clamped + 1) % todos.length);
        return;
      }
      if (key.return || input === ' ') {
        const cur = todos[clamped];
        if (cur) onChange(toggleUserTodo(todos, cur.id));
        return;
      }
      if (input === 'a') {
        setDraft('');
        setEditing({ kind: 'add' });
        return;
      }
      if (input === 'e') {
        startEdit();
        return;
      }
      if (input === 'd') {
        const cur = todos[clamped];
        if (cur) onChange(removeUserTodo(todos, cur.id));
        return;
      }
      if (input === 'x') {
        onChange(clearDoneUserTodos(todos));
        return;
      }
    },
    { isActive: editing === null },
  );

  // 编辑态 Esc：退回浏览态（SimpleTextInput 不消费 Esc，需在此单独接管）
  useInput(
    (_input, key) => {
      if (key.escape) {
        setEditing(null);
        setDraft('');
      }
    },
    { isActive: editing !== null },
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1}>
      <Text bold color="magenta">
        📋 我的待办 {done}/{todos.length}
      </Text>
      {todos.length === 0 ? (
        <Text dimColor>(空 — 按 a 新增一条)</Text>
      ) : (
        visible.map((t, i) => {
          const realIdx = visibleStart + i;
          const active = realIdx === clamped;
          return (
            <Box key={t.id}>
              <Text color={active ? 'magenta' : undefined} bold={active}>
                {active ? '❯ ' : '  '}
              </Text>
              <Text color={t.done ? 'green' : undefined}>{t.done ? '☑' : '☐'} </Text>
              <Text color={active ? 'magenta' : undefined} dimColor={t.done} strikethrough={t.done}>
                {t.content}
              </Text>
            </Box>
          );
        })
      )}
      {todos.length > visible.length ? (
        <Text dimColor>
          {' '}
          … {clamped + 1}/{todos.length}
        </Text>
      ) : null}

      {editing ? (
        <Box marginTop={1}>
          <Text color="cyan" bold>
            {editing.kind === 'add' ? '+ ' : '✎ '}
          </Text>
          {/* key：add ↔ edit 切换时重挂，光标重置到文本末尾 */}
          <SimpleTextInput
            key={editing.kind === 'add' ? 'add' : editing.id}
            value={draft}
            onChange={setDraft}
            onSubmit={commit}
          />
        </Box>
      ) : null}

      <Text dimColor>
        {editing
          ? 'Enter 确认 · Esc 退出编辑'
          : '↑↓ 选择 · 空格/Enter 勾选 · a 新增 · e 编辑 · d 删除 · x 清已完成 · Esc 退出'}
      </Text>
    </Box>
  );
}
