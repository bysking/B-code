import { useMemo } from 'react';
import { useRenderer } from '@opentui/react';
import { SyntaxStyle } from '@opentui/core';
import { latexToUnicode } from '@devhub-io/latex-to-unicode';
import { COLORS } from '../primitives/theme.js';
import { splitMath, type MathSegment } from './math-split.js';

/**
 * Markdown 渲染（OpenTUI 原生 `<markdown>` + LaTeX → Unicode 预处理）。
 *
 * ## 数学公式怎么处理
 *
 * OpenTUI 的 `<markdown>` 基于 tree-sitter 的 GFM 语法，**不认识 LaTeX**——
 * 公式会被当普通文本原样显示（用户看到一堆反斜杠）。
 *
 * 处理链路：
 *   1. `splitMath()` 按定界符把文本切成「文本段 + 公式段」（见 math-split.ts）
 *   2. 公式段用 `latexToUnicode()` 转成 Unicode 数学符号
 *   3. 文本段仍交给 `<markdown>`（保留标题/列表/表格等 GFM 能力）
 *
 * 转换示例：
 *   `\frac{-b \pm \sqrt{b^2-4ac}}{2a}`  → `(-b ± √(b² - 4ac))/2a`
 *   `\int_{-\infty}^{+\infty}`          → `∫₍-∞₎⁽+∞⁾`
 *   `\sum_{i=1}^{n}`                    → `∑ᵢ₌₁ⁿ`
 *
 * ## 为什么不用 opentui-math（能做二维排版的那个）
 *
 * `opentui-math@0.1.0` 能画出真正的分数线与根号，但它发布于 2026-07，只兼容
 * OpenTUI ≤0.4.x——它调用 `this.yogaNode.setMeasureFunc()`，而 0.8.x 已经
 * 移除了 `yogaNode`（改成 `yogaSetFloat` 等封装）。实测直接抛
 * `TypeError: undefined is not an object`。
 *
 * 等它支持 0.8.x 后，只需把 `renderMath()` 换成 `<latex>` 渲染，
 * 切分与布局逻辑都不用动。
 *
 * ## syntaxStyle 的归属（踩过的坑）
 *
 * `<markdown>` 要求传 `SyntaxStyle`，它绑定**创建时那个渲染器**的原生资源。
 * 不能在模块级共享——测试里每次渲染都新建渲染器，第一个销毁后共享的 style
 * 就变成 `Resource Context is destroyed`。所以按渲染器实例缓存（WeakMap）。
 */
const styleCache = new WeakMap<object, SyntaxStyle>();

/**
 * LaTeX → Unicode。
 *
 * `latexToUnicode` 对畸形输入可能抛错（未闭合的花括号等，流式输出常见），
 * 转换失败时**退回原始源码**——显示 LaTeX 总比让整个 markdown 渲染崩掉好。
 */
function mathToUnicode(latex: string): string {
  try {
    const out = latexToUnicode(latex);
    return out.trim() || latex.trim();
  } catch {
    return latex.trim();
  }
}

/**
 * 把**行内**公式并回相邻文本段。
 *
 * 块级公式（display）保持独立——它本来就是独立段落，视觉上要成块。
 * 行内公式必须留在句子里："含常数 $a>0$ 的形式" 拆成三个节点会断成三行。
 */
function inlineMathMerged(segs: MathSegment[]): MathSegment[] {
  const out: MathSegment[] = [];
  for (const seg of segs) {
    if (seg.kind === 'math' && !seg.display) {
      // 行内公式：转 Unicode 后作为文本并入上一段（没有上一段就新建）
      const text = mathToUnicode(seg.value);
      const last = out[out.length - 1];
      if (last && last.kind === 'text') {
        out[out.length - 1] = { ...last, value: last.value + text };
      } else {
        out.push({ kind: 'text', value: text, display: false });
      }
    } else {
      out.push(seg);
    }
  }
  return out;
}

export function MarkdownText({
  content,
  selectable = true,
}: {
  content: string;
  /** 是否允许鼠标拖选复制（默认开：用户要能复制 AI 的回复） */
  selectable?: boolean;
}) {
  const renderer = useRenderer();

  const style = useMemo(() => {
    const key = renderer as unknown as object;
    let cached = styleCache.get(key);
    if (!cached) {
      cached = SyntaxStyle.create(
        (renderer as unknown as { nativeScene: never }).nativeScene,
      );
      styleCache.set(key, cached);
    }
    return cached;
  }, [renderer]);

  const segments = useMemo(() => inlineMathMerged(splitMath(content)), [content]);

  if (!content.trim()) return null;

  // 没有公式：直接走原生 markdown，省掉额外的 box 层级
  if (segments.every((s) => s.kind === 'text')) {
    // 注：`selectable` 在 Markdown 组件的类型声明里没暴露，但运行时支持
  // （它是 NonStyledProps 的成员，所有 renderable 都有）。这里用展开绕过类型收窄。
  return (
    <markdown
      content={content}
      syntaxStyle={style}
      fg={COLORS.text}
      {...({ selectable } as Record<string, unknown>)}
    />
  );
  }

  // 有公式：按段渲染。
  //
  // **块级公式（display）单独成行并缩进**——它原本是 ```latex 代码块或 $$...$$，
  // 视觉上就该是独立的公式块；并回普通文本会被 markdown 当段落折行，失去层次。
  //
  // 行内公式（inline）仍并回相邻文本，保持句子的连续性
  // （"含常数 $a>0$ 的形式" → "含常数 a>0 的形式" 读起来是通顺的一句话）。
  return (
    <box flexDirection="column">
      {segments.map((seg, i) => {
        if (seg.kind === 'text') {
          return seg.value.trim() ? (
            <markdown key={i} content={seg.value} syntaxStyle={style} fg={COLORS.text} />
          ) : null;
        }
        const text = mathToUnicode(seg.value);
        if (!text) return null;
        // 只有**块级**公式单独成块（它原本就是独立段落/代码块）。
        // 行内公式不能拆成独立节点——那样会把一句话切成好几行
        // （实测："带参数的一般形式（$a>0$）：" 被断成三行）。
        // 行内公式与相邻文本**合并**后再交给 markdown，保持段落流完整。
        if (!seg.display) return null; // 行内已在下面合并
        return (
          <box key={i} flexDirection="column" paddingLeft={2}>
            <text fg={COLORS.accent}>{text}</text>
          </box>
        );
      })}
    </box>
  );
}
