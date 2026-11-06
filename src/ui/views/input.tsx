import { useEffect, useMemo, useRef } from 'react';
import type { KeyBinding, TextareaRenderable } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/react';
import wrapAnsi from 'wrap-ansi';
import { COLORS, attrs } from '../primitives/theme.js';

/**
 * 输入框（OpenTUI 原生 `<textarea>`）：多行草稿 + Enter 提交。
 *
 * ## 键位（键位表见 KEY_BINDINGS）
 *
 * | 键 | 行为 | 终端依赖 |
 * |---|---|---|
 * | `Enter` | **提交** | 全终端 |
 * | `Shift+Enter` | 换行 | 需终端支持 Kitty 键盘协议/CSI-u |
 * | `Alt+Enter` | 换行 | ESC 前缀，传统终端可靠 |
 * | `Ctrl+J` | 换行 | LF，全终端可靠 |
 *
 * 裸 Enter 必须是提交：这个框的主要用法是"敲一句话发出去"，提交键改成
 * 修饰组合会让每一次发送都变别扭（`test/ui-app.test.tsx` 里那条 askText
 * 回归用例踩的就是这个坑——当初 textarea 默认 Enter=换行，用户回车"没反应"）。
 * 换行因此放在修饰键上，并对"终端不认 Shift+Enter"给出 Ctrl+J 这条万能退路。
 *
 * ## 受控同步：为什么不能只靠 props
 *
 * `TextareaRenderable` **没有**受控 `value` prop（那是单行 `InputRenderable` 的
 * 子类扩展）。传 `initialValue` 也不行——它的 setter 由 `_initialValueSet` 守卫，
 * 只在构造后第一次生效，之后再改等于没改。
 *
 * 所以外部改值（提交清空 / Tab 补全 / ↑↓ 历史导航）走下面的 effect：
 * `plainText` 与 props 不一致时 `setText()` 拉齐。编辑期两者恒等，effect 空转，
 * 不会出现"回声"式重复设值——这正是历史上"两次提交拼在一起""清空不生效"
 * 两个 bug 的来源，这里用等值守卫从根上避免。
 *
 * 注意副作用：`setText()` 会清空 undo 历史。只在外部改值时调用，编辑过程中
 * 不触发，所以撤销在连续打字时仍然正常。
 */

/** 键位表：模块级常量——react reconciler 按 `!==` 比对新旧 prop，内联数组会每帧重建键位表 */
const KEY_BINDINGS: KeyBinding[] = [
  // 裸 Enter 提交（覆盖默认的 return → newline）
  { name: 'return', action: 'submit' },
  { name: 'kpenter', action: 'submit' },
  // Shift+Enter 换行（覆盖上面：getKeyBindingKey 带 shift 位，是另一个键）
  { name: 'return', shift: true, action: 'newline' },
  { name: 'kpenter', shift: true, action: 'newline' },
  // Alt+Enter 换行（默认是 meta+return → submit，这里改掉：传统终端拿不到
  // Shift+Enter，但 ESC 前缀的 meta 是可靠的，它是第二选择）
  { name: 'return', meta: true, action: 'newline' },
  { name: 'kpenter', meta: true, action: 'newline' },
  // Ctrl+J（linefeed → newline）保留库默认值，不重写：全终端都可靠的换行兜底
];

/** 输入框最多长到几行，再高就由编辑器内部滚动接管（不然长草稿会把会话区顶没） */
const MAX_ROWS = 8;

/** 行首提示符宽度，参与宽度计算 */
const PROMPT_PREFIX = '> ';

/**
 * 草稿 → 输入框行数（1..MAX_ROWS）。
 *
 * 软换行（单行超宽）必须算进去：只按 `\n` 数逻辑行的话，一条 500 字的单行
 * 草稿只会得到 1 行高，后半截看不见。这里用 `wrapAnsi(hard)` 按终端列宽
 * 预演一次换行——宁可高估（多一行空白）也不能低估（内容被藏起来）。
 */
export function inputRows(value: string, cols: number): number {
  const avail = Math.max(1, cols - PROMPT_PREFIX.length);
  let rows = 0;
  for (const line of value.split('\n')) {
    if (line === '') {
      rows += 1;
      continue;
    }
    rows += wrapAnsi(line, avail, { hard: true, trim: false }).split('\n').length;
  }
  return Math.min(MAX_ROWS, Math.max(1, rows));
}

export function PromptInput({
  value,
  onChange,
  onSubmit,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onImagePaste?: () => string | null;
  disabled?: boolean;
}) {
  const ref = useRef<TextareaRenderable | null>(null);
  const { width } = useTerminalDimensions();
  const rows = useMemo(() => inputRows(value, width), [value, width]);

  // 外部值变化 → 同步进 textarea（提交清空、Tab 补全、历史导航）
  useEffect(() => {
    const el = ref.current;
    if (!el || el.plainText === value) return;
    el.setText(value);
    // setText 会把缓冲状态整个重置，光标得自己放回末尾
    el.cursorOffset = value.length;
  }, [value]);

  return (
    <box flexDirection="row" flexShrink={0}>
      <text fg={COLORS.accent} attributes={attrs('bold')}>
        {PROMPT_PREFIX}
      </text>
      <textarea
        ref={ref}
        style={{ flexGrow: 1, height: rows }}
        keyBindings={KEY_BINDINGS}
        placeholder={disabled ? '……' : '输入指令，/ 唤起命令'}
        placeholderColor={COLORS.placeholder}
        textColor={COLORS.text}
        focusedTextColor={COLORS.text}
        focusedBackgroundColor={COLORS.surfaceDeep}
        onContentChange={() => onChange(ref.current?.plainText ?? '')}
        onSubmit={() => {
          // SubmitEvent 是空对象，值从组件读（缓冲区就是当前草稿）
          const v = ref.current?.plainText ?? '';
          if (v.trim()) onSubmit(v);
        }}
        focused={!disabled}
      />
    </box>
  );
}
