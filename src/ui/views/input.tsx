import { useEffect, useRef } from 'react';
import type { InputRenderable } from '@opentui/core';
import { COLORS, attrs } from '../primitives/theme.js';

/**
 * 输入框（OpenTUI 原生 `<input>`）。
 *
 * ## 为什么用 input 而不是 textarea
 *
 * 试过 textarea，但它的模型是**非受控**的：
 *   - 只有 `initialValue` + 手动 `setText()`，没有受控 `value` setter
 *   - 默认绑定 `Enter=插入换行`，想用 Enter 提交就得自己剥掉那个 `\n`，
 *     而它的换行在监听器之前就已写进缓冲 → 提交拿到的总是 `"xxx\n"`
 *   - 提交后清空还得手动 `setText('')`，且要防 `onContentChange` 回声
 *
 * 结果是受控同步极其易错（实测反复出现"两次提交拼在一起"、"清空不生效"）。
 *
 * `<input>` 是 textarea 的单行子类，**原生行为正是我们要的**：
 *   - `Enter` 触发 `ENTER` 事件提交，不插入换行
 *   - `value` 有 getter/setter（受控），外部改值直接生效
 *   - 继承全部编辑能力（光标、选区、undo、单词跳转）
 *
 * 代价：不支持多行草稿（`newlines are stripped`）。对 CLI 输入这是合理取舍——
 * 长 prompt 可以粘贴，换行会被压平，文本内容依然完整。
 */
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
  const ref = useRef<InputRenderable | null>(null);

  // 外部值变化 → 同步进 input（提交清空、Tab 补全、历史导航）
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.value !== value) el.value = value;
  }, [value]);

  return (
    <box flexDirection="row" flexShrink={0}>
      <text fg={COLORS.accent} attributes={attrs('bold')}>
        {'> '}
      </text>
      <input
        ref={ref}
        style={{ flexGrow: 1 }}
        value={value}
        placeholder={disabled ? '……' : '输入指令，/ 唤起命令'}
        placeholderColor={COLORS.placeholder}
        textColor={COLORS.text}
        focusedTextColor={COLORS.text}
        focusedBackgroundColor={COLORS.surfaceDeep}
        onInput={(v: string) => onChange(v)}
        onSubmit={() => {
          // SubmitEvent 是空对象，值从组件读（受控 value 就是当前值）
          const v = ref.current?.value ?? '';
          if (v.trim()) onSubmit(v);
        }}
        focused={!disabled}
      />
    </box>
  );
}
