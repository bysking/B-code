import { useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { COLORS, attrs } from '../primitives/theme.js';
import {
  addUserTodo,
  clearDoneUserTodos,
  doneCount,
  editUserTodo,
  removeUserTodo,
  toggleUserTodo,
  type UserTodo,
} from '../../user-todo.js';

/** 展示数上限 */
const MAX_VISIBLE = 12;

type Editing = { kind: 'add' } | { kind: 'edit'; id: string };

/**
 * /todo 交互编辑器（用户自管清单，与模型自管的 TodoPanel 无关）。
 *
 * 键位：↑↓/jk 选择 · 空格/Enter 勾选 · a 新增 · e 编辑 · d 删除 · x 清已完成 · Esc 退出。
 * 变更经 onChange 回写 controller.setUserTodos（内存 + 落盘）；组件本身不持有清单（受控）。
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

  const clamped = todos.length === 0 ? 0 : Math.min(idx, todos.length - 1);
  const visibleStart = Math.max(
    0,
    Math.min(clamped - Math.floor(MAX_VISIBLE / 2), todos.length - MAX_VISIBLE),
  );
  const visible = todos.slice(visibleStart, visibleStart + MAX_VISIBLE);
  const done = doneCount(todos);

  const commit = () => {
    if (!editing) return;
    onChange(
      editing.kind === 'add' ? addUserTodo(todos, draft) : editUserTodo(todos, editing.id, draft),
    );
    setEditing(null);
    setDraft('');
  };

  useKeyboard(
    (e) => {
      if (e.name === 'escape') {
        onClose();
        return;
      }
      if (e.name === 'up' || e.name === 'k') {
        setIdx(todos.length === 0 ? 0 : (clamped - 1 + todos.length) % todos.length);
        return;
      }
      if (e.name === 'down' || e.name === 'j') {
        setIdx(todos.length === 0 ? 0 : (clamped + 1) % todos.length);
        return;
      }
      if (e.name === 'return' || e.name === 'space') {
        const cur = todos[clamped];
        if (cur) onChange(toggleUserTodo(todos, cur.id));
        return;
      }
      if (e.name === 'a') {
        setDraft('');
        setEditing({ kind: 'add' });
        return;
      }
      if (e.name === 'e') {
        const cur = todos[clamped];
        if (cur) {
          setDraft(cur.content);
          setEditing({ kind: 'edit', id: cur.id });
        }
        return;
      }
      if (e.name === 'd') {
        const cur = todos[clamped];
        if (cur) onChange(removeUserTodo(todos, cur.id));
        return;
      }
      if (e.name === 'x') {
        onChange(clearDoneUserTodos(todos));
      }
    },
    { release: false },
  );

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={COLORS.accent}
      paddingX={1}
      marginTop={1}
      flexShrink={0}
    >
      <text fg={COLORS.accent} attributes={attrs('bold')}>
        📋 我的待办 {done}/{todos.length}
      </text>

      {todos.length === 0 ? (
        <text fg={COLORS.muted}>（空 — 按 a 新增一条）</text>
      ) : (
        visible.map((t, i) => {
          const realIdx = visibleStart + i;
          const active = realIdx === clamped;
          return (
            <text key={t.id} fg={active ? COLORS.accent : undefined} wrapMode="none">
              {active ? '❯ ' : '  '}
              <span fg={t.done ? COLORS.success : COLORS.muted}>{t.done ? '☑' : '☐'}</span>{' '}
              <span attributes={t.done ? attrs('strikethrough', 'dim') : 0}>{t.content}</span>
            </text>
          );
        })
      )}

      {todos.length > visible.length ? (
        <text fg={COLORS.muted} attributes={attrs('dim')}>
          {' '}
          … {clamped + 1}/{todos.length}
        </text>
      ) : null}

      {editing ? (
        <box flexDirection="row" marginTop={1}>
          <text fg={COLORS.accent} attributes={attrs('bold')}>
            {editing.kind === 'add' ? '+ ' : '✎ '}
          </text>
          {/* 用 <input> 而非 textarea：textarea 的裸 Enter 是"插入换行"，
              不会触发 onSubmit（用户会觉得回车没反应）。<input> 的 Enter 直接提交。 */}
          <input
            key={editing.kind === 'add' ? 'add' : editing.id}
            style={{ flexGrow: 1 }}
            value={draft}
            focused
            placeholder="输入待办内容"
            placeholderColor={COLORS.muted}
            textColor={COLORS.text}
            focusedTextColor={COLORS.text}
            onInput={(v: string) => setDraft(v)}
            onSubmit={() => commit()}
          />
        </box>
      ) : null}

      <text fg={COLORS.muted} attributes={attrs('dim')}>
        {editing
          ? 'Enter 确认 · Esc 退出编辑'
          : '↑↓ 选择 · 空格 勾选 · a 新增 · e 编辑 · d 删除 · x 清已完成 · Esc 退出'}
      </text>
    </box>
  );
}
