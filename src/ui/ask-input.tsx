import React, { useState } from "react";
import { Box, Text } from "ink";
import { SimpleTextInput } from "./input-box.js";

/**
 * 文本输入提问（controller.askText 的渲染端）。
 * Enter 提交；Esc 取消（上交给上级处理，同时 Esc 键在此不消费）。
 */

export function AskInput({
  question,
  onSubmit,
}: {
  question: string;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="yellow">? {question}</Text>
      <Box>
        <Text color="cyan" bold>
          {"> "}
        </Text>
        <SimpleTextInput value={value} onChange={setValue} onSubmit={onSubmit} />
      </Box>
    </Box>
  );
}