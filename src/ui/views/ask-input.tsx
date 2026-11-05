import { useRef } from 'react';
import type { TextareaRenderable } from '@opentui/core';
import { COLORS, attrs } from '../primitives/theme.js';

/**
 * 文本输入提问（controller.askText 的渲染端）。
 *
 * 用原生 `<textarea>` 拿光标/选区/undo；Enter 提交、Esc 取消。
 */
export function AskInput({
  question,
  onSubmit,
}: {
  question: string;
  onSubmit: (value: string) => void;
}) {
  const ref = useRef<TextareaRenderable | null>(null);

  return (
    <box flexDirection="column" marginTop={1} flexShrink={0}>
      <text fg={COLORS.warning}>? {question}</text>
      <box flexDirection="row">
        <text fg={COLORS.accent} attributes={attrs('bold')}>
          {'> '}
        </text>
        <textarea
          ref={ref}
          style={{ flexGrow: 1, height: 1 }}
          focused
          placeholder="输入后回车提交"
          placeholderColor={COLORS.muted}
          textColor={COLORS.text}
          onContentChange={() => void 0}
          onSubmit={() => {
            const v = ref.current?.plainText ?? '';
            onSubmit(v.trim());
          }}
        />
      </box>
    </box>
  );
}
