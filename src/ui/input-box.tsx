import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

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
        {"> "}
      </Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        focus={!disabled}
        placeholder={disabled ? "……" : undefined}
      />
    </Box>
  );
}