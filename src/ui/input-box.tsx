import React, { useEffect, useRef, useState } from 'react';
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
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  focus?: boolean;
  placeholder?: string;
}) {
  const [cursor, setCursor] = useState(value.length);

  // 外部 value 变化时 cursor 同步到末尾
  const prevValueLen = useRef(value.length);
  useEffect(() => {
    if (value.length !== prevValueLen.current) {
      prevValueLen.current = value.length;
      // 外部 setInput("") 或 Tab 补全 · 光标回到末尾
      setCursor(value.length);
    }
  }, [value]);

  useInput((input, key) => {
    if (!focus) return;

    // Enter：提交
    if (key.return) {
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
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
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
        focus={!disabled}
        placeholder={disabled ? '……' : undefined}
      />
    </Box>
  );
}
