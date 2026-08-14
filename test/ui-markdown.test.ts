import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, parseInline } from "../src/ui/markdown.js";

test("行内：code / bold / link 依次解析", () => {
  const parts = parseInline("用 `npm tsx` 跑 **dev**，见 [文档](https://x.dev) 结尾");
  assert.deepEqual(parts, [
    { t: "text", text: "用 " },
    { t: "code", text: "npm tsx" },
    { t: "text", text: " 跑 " },
    { t: "bold", text: "dev" },
    { t: "text", text: "，见 " },
    { t: "link", text: "文档", url: "https://x.dev" },
    { t: "text", text: " 结尾" },
  ]);
});

test("行内：未闭合标记按原文当文本（流式容错）", () => {
  const parts = parseInline("**半截加粗");
  assert.deepEqual(parts, [{ t: "text", text: "**半截加粗" }]);
  const parts2 = parseInline("`半截代码");
  assert.deepEqual(parts2, [{ t: "text", text: "`半截代码" }]);
});

test("块级：fence 代码块保留原样与语言", () => {
  const blocks = parseMarkdown("```ts\nconst a = 1;\n```\n");
  assert.equal(blocks.length, 1);
  const code = blocks[0]!;
  assert.equal(code.kind, "code");
  if (code.kind === "code") {
    assert.equal(code.lang, "ts");
    assert.deepEqual(code.raw, ["const a = 1;"]);
  }
});

test("块级：未闭合 fence 也按代码渲染到结尾（流式容错）", () => {
  const blocks = parseMarkdown("```js\nconst x");
  const code = blocks[0]!;
  assert.equal(code.kind, "code");
  if (code.kind === "code") assert.deepEqual(code.raw, ["const x"]);
});

test("块级：标题 / 列表（有序+无序）/ 引用 / 段落", () => {
  const blocks = parseMarkdown("## 标题\n\n- a\n- b\n\n1. 一\n2. 二\n\n> 引用\n\n普通段落");
  const kinds = blocks.map((b) => b.kind);
  assert.deepEqual(kinds, ["heading", "list", "list", "quote", "para"]);
  const list1 = blocks[1]!;
  if (list1.kind === "list") {
    assert.equal(list1.ordered, false);
    assert.equal(list1.items.length, 2);
  }
  const list2 = blocks[2]!;
  if (list2.kind === "list") {
    assert.equal(list2.ordered, true);
  }
});

test("块级：连续非特殊行合并为段落", () => {
  const blocks = parseMarkdown("第一行\n第二行\n");
  const para = blocks[0]!;
  assert.equal(para.kind, "para");
  if (para.kind === "para") {
    assert.equal(para.inline[0]?.t, "text");
  }
});