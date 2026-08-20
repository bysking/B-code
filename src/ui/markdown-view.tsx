import React from 'react';
import { Text } from 'ink';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import { latexToUnicode } from '@devhub-io/latex-to-unicode';

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
 *
 * 数学公式预处理：marked 不原生支持 LaTeX 数学公式，`\[ ... \]`、`$$ ... $$`
 * 等显示数学以及 `\( ... \)` 、`$...$` 等行内数学会被误解析为 markdown 语法
 * （如 `_` 被当作斜体、`[ ... ]` 被当作链接引用）。预处理把 LaTeX 数学块
 * 包裹进代码块，同时通过 latex2unicode 将 LaTeX 命令转译为 Unicode 符号，
 * 使其在终端中可读。
 */

const renderer = new TerminalRenderer({});

/** 预处理 \boxed{...}：去掉外壳，保留内容（latex2unicode 不处理 \boxed 命令） */
function stripBoxed(text: string): string {
  // 用平衡括号匹配，去掉 \boxed 外壳，保留内部内容
  let result = text;
  const re = /\\boxed\{/;
  let m: RegExpExecArray | null;
  while ((m = re.exec(result)) !== null) {
    const start = m.index + m[0].length - 1; // 指向 {
    let depth = 1;
    let end = start;
    while (depth > 0 && end < result.length - 1) {
      end++;
      if (result[end] === '{') depth++;
      else if (result[end] === '}') depth--;
    }
    // 替换 \boxed{...} 为内部内容
    result = result.slice(0, m.index) + result.slice(start + 1, end) + result.slice(end + 1);
  }
  return result;
}

/**
 * 预处理数学公式：
 * 1. 将 LaTeX 命令转译为 Unicode 符号（通过 latex2unicode）
 * 2. 将数学块包裹进代码块，避免 marked 误解析
 */
function preprocessMath(text: string): string {
  // 先剥离 \boxed 外壳
  let result = stripBoxed(text);

  // 对整个文本应用 LaTeX → Unicode 转换（包括表格中的非数学 LaTeX）
  result = latexToUnicode(result);

  // 1. $$ ... $$ 显示数学 → 围栏代码块
  result = result.replace(/\$\$([\s\S]*?)\$\$/g, (_, inner: string) => {
    return `\`\`\`\n${inner.trim()}\n\`\`\``;
  });

  // 2. \[ ... \] 显示数学 → 围栏代码块
  result = result.replace(/\\\[([\s\S]*?)\\\]/g, (_, inner: string) => {
    return `\`\`\`\n${inner.trim()}\n\`\`\``;
  });

  // 3. 独行 [ ... ] 显示数学（无反斜杠简写）→ 围栏代码块
  result = result.replace(/^\[\s*$/gm, '```');
  result = result.replace(/^\]\s*$/gm, '```');

  // 4. \( ... \) 行内数学 → 反引号行内代码
  result = result.replace(/\\\(([\s\S]*?)\\\)/g, (_, inner: string) => {
    return `\`${inner.trim()}\``;
  });

  // 5. $...$ 行内数学（不匹配 $$）→ 反引号行内代码
  result = result.replace(/(?<!\$)\$(?!\$)([\s\S]*?)(?<!\$)\$(?!\$)/g, (_, inner: string) => {
    return `\`${inner.trim()}\``;
  });

  return result;
}

/** markdown 全文渲染（流式文本直接喂入，未闭合标记由 marked 兜底降级） */
export function Markdown({ text }: { text: string }) {
  const safe = preprocessMath(text);
  const out = marked.parse(safe, { renderer }).trim();
  return <Text>{out}</Text>;
}
