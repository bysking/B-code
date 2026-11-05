import { COLORS, TODO_SYMBOL, TODO_TONE, attrs, tone } from '../primitives/theme.js';

/**
 * 模型自管待办面板（todo_write 更新）。
 *
 * OpenTUI 没有"按行数裁剪"的内置能力，但 `<scrollbox>` 可以限高 + 裁剪。
 * 这里用固定最大行数 + 折叠提示，比 paper 更简单可靠。
 */

/** 展示上限：太多会挤占正文 */
const MAX_VISIBLE = 10;
/** 矮终端下的上限 */
const MAX_VISIBLE_COMPACT = 3;

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  if (todos.length === 0) return null;

  const limit = MAX_VISIBLE; // 调用方可用布局挤压，这里给个宽松上限
  const visible = todos.slice(0, limit);
  const hidden = todos.length - visible.length;

  return (
    <box flexDirection="column" flexShrink={0}>
      {visible.map((t, i) => (
        <text key={i} fg={tone(TODO_TONE[t.status] ?? 'muted')} wrapMode="none">
          {TODO_SYMBOL[t.status] ?? '☐'} {t.content}
        </text>
      ))}
      {hidden > 0 ? (
        <text fg={COLORS.muted} attributes={attrs('dim')}>
          {' '}
          … 另有 {hidden} 项（/todos 查看全部）
        </text>
      ) : null}
    </box>
  );
}

/** 供上层估算占用行数（布局预算用） */
export function todoPanelRows(todos: TodoItem[]): number {
  if (todos.length === 0) return 0;
  const n = Math.min(todos.length, MAX_VISIBLE);
  return n + (todos.length > n ? 1 : 0);
}

export { MAX_VISIBLE as TODO_MAX_VISIBLE, MAX_VISIBLE_COMPACT as TODO_MAX_VISIBLE_COMPACT };
