import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

/**
 * 自定义文本输入 — 替代 ink-text-input。
 *
 * ink-text-input 的问题：Ctrl+key 组合键（如 Ctrl+O）会同时触发快捷键和
 * 在输入框插入字符 'o' —— 因为 Ink 的 useInput 对所有 handler 广播事件，
 * ink-text-input 不检查 key.ctrl，直接插入字符。
 *
 * 本组件通过 useInput 自行处理全部键盘输入，严格检查 key.ctrl/key.meta，
 * 只在非修饰键按下时插入字符。
 */
export function SimpleTextInput({
  value,
  onChange,
  onSubmit,
  focus = true,
  placeholder,
  onPaste,
  slashOpen = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  focus?: boolean;
  placeholder?: string;
  onPaste?: () => string | null;
  /** slash 菜单打开时，InputBox 不处理 Enter（由 SlashMenu 接管） */
  slashOpen?: boolean;
}) {
  const [cursor, setCursor] = useState(value.length);
  // 光标位置由内部维护：插入/删除/左右移动都在此处更新，不随 value 长度变化重置。
  // 外部需要重置光标的路径（历史导航、Tab 补全、提交清空）统一通过 App 层
  // 递增 inputNonce 强制重挂组件（key={inputNonce}），重挂后 useState(value.length) 即回到末尾。

  useInput((input, key) => {
    if (!focus) return;

    // Enter：提交（slash 菜单打开时交给 SlashMenu 处理，避免双发）
    if (key.return && !slashOpen) {
      onSubmit(value);
      return;
    }

    // Backspace / Delete
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        onChange(value.slice(0, cursor - 1) + value.slice(cursor));
        setCursor(cursor - 1);
      }
      return;
    }

    // Ctrl+V / Cmd+V：粘贴检测（图片 → [image #N] 占位符；文本 → 直接插入）
    if ((key.ctrl && input === 'v') || (key.meta && input === 'v')) {
      if (onPaste) {
        const pasteText = onPaste();
        if (pasteText) {
          onChange(value.slice(0, cursor) + pasteText + value.slice(cursor));
          setCursor(cursor + pasteText.length);
        }
      }
      return;
    }

    // 左箭头：光标左移
    if (key.leftArrow) {
      setCursor(Math.max(0, cursor - 1));
      return;
    }

    // 右箭头：光标右移
    if (key.rightArrow) {
      setCursor(Math.min(value.length, cursor + 1));
      return;
    }

    // Ctrl / Meta 修饰键：不插入字符（ink-text-input 在这里误插）
    if (key.ctrl || key.meta) return;

    // 普通字符：插入当前光标位置
    if (input) {
      onChange(value.slice(0, cursor) + input + value.slice(cursor));
      setCursor(cursor + input.length);
    }
  });

  // 渲染文本 + 光标
  const before = value.slice(0, cursor);
  const cursorChar = value[cursor] || ' ';
  const after = value.slice(cursor + 1);

  return (
    <Text>
      {before}
      <Text inverse>{cursorChar}</Text>
      {after}
      {cursor >= value.length && !value && placeholder ? <Text dimColor>{placeholder}</Text> : null}
    </Text>
  );
}

/**
 * 底部输入行（受控：文本由 App 持有，Tab 补全才能写回输入框）。
 * onChange 只上报变化；slash 开合/补全等逻辑在 App 层。
 */
export function InputBox({
  value,
  onChange,
  onSubmit,
  disabled,
  onPaste,
  slashOpen = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
  onPaste?: () => string | null;
  slashOpen?: boolean;
}) {
  return (
    <Box>
      <Text color="cyan" bold>
        {'> '}
      </Text>
      <SimpleTextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        onPaste={onPaste}
        focus={!disabled}
        placeholder={disabled ? '……' : undefined}
        slashOpen={slashOpen}
      />
    </Box>
  );
}
