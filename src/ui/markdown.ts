/**
 * markdown 子集解析器（纯 TS，供 markdown.tsx 渲染）。
 *
 * 覆盖：fence 代码块 / ## 标题 / - 与 1. 列表 / > 引用 / 段落 /
 * 行内：`code`、**bold**、[text](url)。
 *
 * 流式容错优先：任何未闭合的标记按原样当文本展示（不闪断、不吞字），
 * 不做完整 GFM——能用、可控、够稳。
 */

export type MdInline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "bold"; text: string }
  | { t: "link"; text: string; url: string };

export type MdBlock =
  | { kind: "code"; lang: string; raw: string[] }
  | { kind: "heading"; level: number; inline: MdInline[] }
  | { kind: "list"; ordered: boolean; items: MdInline[][] }
  | { kind: "quote"; inline: MdInline[] }
  | { kind: "para"; inline: MdInline[] };

const INLINE_RE =
  /(`[^`]*`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))/g;

/** 行内解析：code / bold / link 顺序匹配，未匹配段留作纯文本 */
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ t: "text", text: text.slice(last, idx) });
    if (m[1]) out.push({ t: "code", text: m[1].slice(1, -1) });
    else if (m[2]) out.push({ t: "bold", text: m[2].slice(2, -2) });
    else if (m[3]) {
      const inner = m[3];
      const linkEnd = inner.lastIndexOf("]");
      out.push({
        t: "link",
        text: inner.slice(1, linkEnd),
        url: inner.slice(linkEnd + 2, -1),
      });
    }
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ t: "text", text: text.slice(last) });
  return out;
}

/** 块级解析：逐行分流 + 段落归组。 */
export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.split("\n");
  const blocks: MdBlock[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      // 连续行合并进同一段落（inline 解析按整段）
      blocks.push({ kind: "para", inline: parseInline(para.join(" ")) });
      para = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    // fence 代码块（含未闭合：缺关闭 fence 也按代码渲染到结尾）
    if (line.startsWith("```")) {
      flushPara();
      const lang = line.slice(3).trim();
      const raw: string[] = [];
      i++;
      for (; i < lines.length; i++) {
        const l = lines[i] ?? "";
        if (l.startsWith("```")) {
          i++;
          break;
        }
        raw.push(l);
      }
      blocks.push({ kind: "code", lang, raw });
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ kind: "heading", level: heading[1]!.length, inline: parseInline(heading[2]!) });
      i++;
      continue;
    }

    const listMatch = /^(\s*)([-*]|\d+[.)])\s+(.*)$/.exec(line);
    if (listMatch) {
      flushPara();
      const ordered = /\d/.test(listMatch[2]!);
      const items: MdInline[][] = [parseInline(listMatch[3]!)];
      i++;
      // 连续列表行归组
      while (i < lines.length) {
        const nxt = lines[i] ?? "";
        const m2 = /^(\s*)([-*]|\d+[.)])\s+(.*)$/.exec(nxt);
        if (!m2) break;
        items.push(parseInline(m2[3]!));
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    if (line.startsWith(">")) {
      flushPara();
      blocks.push({ kind: "quote", inline: parseInline(line.replace(/^>\s?/, "")) });
      i++;
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      i++;
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flushPara();
  return blocks;
}