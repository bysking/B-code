/**
 * Markdown 里的数学公式切分。
 *
 * ## 为什么要自己切
 *
 * OpenTUI 的 `<markdown>` 用 tree-sitter 解析 GFM，**不认识 LaTeX**——
 * `$\int e^{-x^2}dx$` 会被原样当普通文本显示（用户看到一堆反斜杠）。
 *
 * `opentui-math` 提供 `<latex>` 原生标签做二维排版，但它只负责"渲染一个公式"，
 * 不负责"从 markdown 里找出公式"。所以中间要有一层切分：
 *
 *   markdown 文本 → [文本段, 公式段, 文本段, …] → 分别用 <text>/<markdown> 与 <latex> 渲染
 *
 * ## 支持的定界符
 *
 * | 形式 | 含义 | 渲染模式 |
 * |---|---|---|
 * | `$$…$$`（独占行） | 显示公式 | displayMode（独立成块、居中） |
 * | `\[…\]` | 显示公式 | displayMode |
 * | `$…$` | 行内公式 | inline |
 * | `\(…\)` | 行内公式 | inline |
 * | ` ```latex … ``` ` | 代码块公式 | displayMode |
 *
 * 最后一种很常见：模型倾向把公式写成 `latex` 围栏代码块（"LaTeX 的写法"这种表述下尤其如此）。
 * 如果不特殊处理，它会被 markdown 当普通代码块原样显示——用户看到的是一堆反斜杠，
 * 而不是渲染后的公式。
 *
 * ## 流式容错
 *
 * 模型逐 token 输出时公式常常是半截的（`$x^2 + y`）。切分器**不要求闭合**：
 * 找不到结束符就把剩余部分整段当公式交给 `<latex>`。
 * `opentui-math` 内部有 `completeLatexPrefix`，能对不完整输入做合理排版，
 * 总比显示一坨反斜杠好。
 */

export interface MathSegment {
  kind: 'text' | 'math';
  /** 文本段的内容，或公式段的 LaTeX 源码 */
  value: string;
  /** 公式是否按块级（display）渲染 */
  display: boolean;
}

/** 定界符配置：先匹配长的（`$$` 先于 `$`），避免 `$$x$$` 被拆成两个空行内公式 */
const DELIMITERS: { open: string; close: string; display: boolean }[] = [
  { open: '$$', close: '$$', display: true },
  { open: '\\[', close: '\\]', display: true },
  { open: '\\(', close: '\\)', display: false },
  { open: '$', close: '$', display: false },
];

/**
 * 把 markdown 文本切成「文本段 + 公式段」的序列。
 *
 * 只识别**成对**或**到结尾**的定界符，不做嵌套（数学公式里套 markdown 没有意义）。
 */
/** ````latex ... ```` 围栏代码块（也匹配 tex / math 别名） */
const LATEX_FENCE_RE = /```(?:latex|tex|math)\s*\n([\s\S]*?)```/g;

export function splitMath(input: string): MathSegment[] {
  // 先把 ```latex 代码块抽出来换成占位符，剩下的按定界符切分，
  // 最后再把占位符还原成公式段。
  //
  // 为什么不在主循环里直接匹配围栏：定界符（$$ / $）可能出现在代码块内部，
  // 先抽走能避免"代码块里的 $ 被误判成行内公式"。
  const fences: string[] = [];
  const masked = input.replace(LATEX_FENCE_RE, (_m, body: string) => {
    fences.push(body.trim());
    return `\u0000LATEX${fences.length - 1}\u0000`;
  });

  const out: MathSegment[] = [];
  let i = 0;
  let textStart = 0;
  const raw = masked;

  const flushText = (end: number) => {
    if (end <= textStart) return;
    const chunk = raw.slice(textStart, end);
    // 还原占位符：含公式的位置再切一刀，保证顺序正确
    const parts = chunk.split(/\u0000LATEX(\d+)\u0000/);
    for (let k = 0; k < parts.length; k++) {
      const part = parts[k] ?? '';
      if (k % 2 === 1) {
        const idx = Number.parseInt(part, 10);
        out.push({ kind: 'math', value: fences[idx] ?? '', display: true });
      } else if (part) {
        out.push({ kind: 'text', value: part, display: false });
      }
    }
  };

  while (i < raw.length) {
    // 找最近的定界符起点
    let matched: (typeof DELIMITERS)[number] | null = null;
    let openAt = -1;
    for (const d of DELIMITERS) {
      const at = raw.indexOf(d.open, i);
      if (at === -1) continue;
      if (openAt === -1 || at < openAt) {
        openAt = at;
        matched = d;
      }
    }
    if (!matched || openAt === -1) break;

    // `$` 的特殊处理：转义的 `\$` 不算定界符
    if (matched.open === '$' && openAt > 0 && raw[openAt - 1] === '\\') {
      i = openAt + 1;
      continue;
    }

    const bodyStart = openAt + matched.open.length;
    const closeAt = raw.indexOf(matched.close, bodyStart);

    if (closeAt === -1) {
      // 未闭合（流式输出的半截公式）：剩余全部当公式，交给 opentui-math 兜底
      flushText(openAt);
      out.push({ kind: 'math', value: raw.slice(bodyStart), display: matched.display });
      return out;
    }

    // 空公式（`$$$$` 或 `$ $`）当普通文本，避免渲染出空白块
    const body = raw.slice(bodyStart, closeAt);
    if (!body.trim()) {
      i = closeAt + matched.close.length;
      continue;
    }

    flushText(openAt);
    out.push({ kind: 'math', value: body, display: matched.display });
    i = closeAt + matched.close.length;
    textStart = i;
  }

  flushText(raw.length);
  return out;
}

/** 文本里是否含数学公式（快速判断，避免无谓的切分与多组件渲染） */
export function hasMath(input: string): boolean {
  return splitMath(input).some((s) => s.kind === 'math');
}
