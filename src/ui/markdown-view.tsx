import React from "react";
import { Box, Text } from "ink";
import { parseInline, parseMarkdown, type MdBlock, type MdInline } from "./markdown.js";

/** 行内片段渲染 */
function Inline({ parts }: { parts: MdInline[] }) {
  return (
    <Text>
      {parts.map((p, i) => {
        switch (p.t) {
          case "code":
            return (
              <Text key={i} inverse color="cyan">
                {p.text}
              </Text>
            );
          case "bold":
            return (
              <Text key={i} bold>
                {p.text}
              </Text>
            );
          case "link":
            return (
              <Text key={i} underline color="blue">
                {p.text}
              </Text>
            );
          default:
            return <Text key={i}>{p.text}</Text>;
        }
      })}
    </Text>
  );
}

/** 块级渲染 */
function BlockView({ block }: { block: MdBlock }) {
  switch (block.kind) {
    case "code":
      return (
        <Box borderStyle="round" borderColor="gray" paddingX={1} marginY={1}>
          <Box flexDirection="column">
            {block.lang ? (
              <Text dimColor>
                {block.lang}
              </Text>
            ) : null}
            {block.raw.length === 0 ? (
              <Text dimColor>(empty)</Text>
            ) : (
              block.raw.map((l, i) => (
                <Text key={i}>
                  {l === "" ? " " : l}
                </Text>
              ))
            )}
          </Box>
        </Box>
      );
    case "heading":
      return (
        <Text bold color="cyan">
          {" ".repeat(block.level - 1)}
          <Inline parts={block.inline} />
        </Text>
      );
    case "list":
      return (
        <Box flexDirection="column">
          {block.items.map((item, i) => (
            <Text key={i}>
              {block.ordered ? `  ${i + 1}. ` : "  • "}
              <Inline parts={item} />
            </Text>
          ))}
        </Box>
      );
    case "quote":
      return (
        <Text dimColor>
          {"┃ "}
          <Inline parts={block.inline} />
        </Text>
      );
    default:
      return (
        <Text>
          <Inline parts={block.inline} />
        </Text>
      );
  }
}

/** markdown 全文渲染（流式文本直接喂入，未闭合标记按原文显示） */
export function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </Box>
  );
}