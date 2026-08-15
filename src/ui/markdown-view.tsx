import React from "react";
import { Text } from "ink";
import { marked } from "marked";
import TerminalRenderer from "marked-terminal";

/**
 * markdown 渲染：marked + marked-terminal。
 *
 * 替换原先手写的子集解析器（markdown.ts），获得完整 GFM 支持，
 * 重点是表格——marked-terminal 用 cli-table3 渲染对齐的表格框。
 *
 * 工作原理：
 * - marked-terminal 的 Renderer 不继承 marked.Renderer，运行时靠
 *   duck-typing 把每个块/行内 token 渲染成 ANSI 字符串
 *   （类型补丁见同目录 markdown-terminal.d.ts）。
 * - 整段文本 parse 成一条 ANSI 字符串，包进单个 <Text> 交给 Ink。
 *
 * 流式容错（模型逐 token 输出，每帧对累计全文重新 parse）：
 * - 未闭合代码块     → marked 按缩进代码块渲染到结尾
 * - 未闭合粗体/斜体   → 按原文文本显示
 * - 半截表格（还没到分隔行）→ 按普通段落文本降级；分隔行一到即"拼"成表格
 * 不会闪断、不吞字。
 */

const renderer = new TerminalRenderer({});

/** markdown 全文渲染（流式文本直接喂入，未闭合标记由 marked 兜底降级） */
export function Markdown({ text }: { text: string }) {
  const out = marked.parse(text, { renderer }).trim();
  return <Text>{out}</Text>;
}
