import { useRef } from 'react';
import type { InputRenderable } from '@opentui/core';
import { COLORS, attrs } from '../primitives/theme.js';

/**
 * 文本输入提问（controller.askText 的渲染端）。
 *
 * ## 为什么用 `<input>` 而不是 `<textarea>`
 *
 * textarea 的默认键绑定是 **`Enter = 插入换行`**、`Meta+Enter = 提交`。
 * 也就是说裸 Enter 根本不会触发 `onSubmit`——用户输入后回车"没反应"，
 * 光标只是换了一行（而这个框只有 1 行高，连换行都看不见）。
 *
 * `<input>` 是 textarea 的单行子类，原生行为就是我们要的：
 *   - 裸 `Enter` → 触发 `onSubmit`
 *   - 换行被自动剥掉（`newlines are stripped`）
 *   - 继承全部编辑能力（光标、选区、undo）
 */
export function AskInput({
  question,
  onSubmit,
}: {
  question: string;
  onSubmit: (value: string) => void;
}) {
  const ref = useRef<InputRenderable | null>(null);

  return (
    <box flexDirection="column" marginTop={1} flexShrink={0}>
      <text fg={COLORS.warning}>? {question}</text>
      <box flexDirection="row">
        <text fg={COLORS.accent} attributes={attrs('bold')}>
          {'> '}
        </text>
        <input
          ref={ref}
          style={{ flexGrow: 1 }}
          focused
          placeholder="输入后回车提交"
          placeholderColor={COLORS.placeholder}
          textColor={COLORS.text}
          focusedTextColor={COLORS.text}
          focusedBackgroundColor={COLORS.surfaceDeep}
          onSubmit={() => {
            const v = ref.current?.value ?? '';
            onSubmit(v.trim());
          }}
        />
      </box>
    </box>
  );
}
