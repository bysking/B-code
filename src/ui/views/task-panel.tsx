import type { TaskPanelState } from '../controller.js';
import { COLORS, TOOL_SYMBOL, TOOL_TONE, attrs, tone } from '../primitives/theme.js';

/**
 * 底部任务面板：正在执行的一批工具调用（即时视图）。
 *
 * 只展示"当前在跑什么"，完整输出走 Ctrl+O。因此条数有硬上限，
 * 超出折叠成一行提示——不追求全量。
 */

/** 条数上限：面板是即时视图，不需要全量 */
const MAX_VISIBLE = 8;

/** 子项状态文案：由 verb 派生（待读取 / 读取中 / 读取完成 …） */
function statusText(verb: string, status: TaskPanelState['items'][number]['status']): string {
  switch (status) {
    case 'queued':
      return `待${verb}`;
    case 'running':
      return `${verb}中`;
    case 'done':
      return `${verb}完成`;
  }
}

export function TaskPanel({ task }: { task: TaskPanelState | null }) {
  if (!task) return null;

  const visible = task.items.slice(0, MAX_VISIBLE);
  const hidden = task.items.length - visible.length;

  return (
    <box flexDirection="column" borderStyle="single" borderColor={COLORS.border} paddingX={1} flexShrink={0}>
      <text fg={COLORS.accent} attributes={attrs('bold')}>
        {task.title.startsWith(task.verb) ? `正在${task.title}` : `正在${task.verb} ${task.title}`}
      </text>
      {visible.map((it) => (
        <text key={it.id} fg={tone(TOOL_TONE[it.status] ?? 'muted')} wrapMode="none">
          {TOOL_SYMBOL[it.status] ?? '○'} {statusText(task.verb, it.status)} {it.label}
        </text>
      ))}
      {hidden > 0 ? (
        <text fg={COLORS.muted} attributes={attrs('dim')}>
          {' '}
          … 另有 {hidden} 项（Ctrl+O 查看）
        </text>
      ) : null}
    </box>
  );
}

/** 面板占用行数（布局预算用） */
export function taskPanelHeight(task: TaskPanelState | null): number {
  if (!task) return 0;
  const n = Math.min(task.items.length, MAX_VISIBLE);
  // 边框 2 + 标题 1 + 条目 + 可选折叠提示 1
  return 3 + n + (task.items.length > n ? 1 : 0);
}

export { MAX_VISIBLE as TASK_MAX_VISIBLE };
