import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_SLASH_ITEMS,
  buildSlash,
  clampIndex,
  filterSlash,
  slashBaseName,
  defaultPick,
} from "../src/ui/slash.js";
import type { SlashItem } from "../src/ui/controller.js";

const items: SlashItem[] = [
  ...BUILTIN_SLASH_ITEMS,
  { name: "commit", description: "git commit" },
  { name: "code-review", description: "review" },
];

test("slashBaseName：/name 参数 形态取基础名", () => {
  assert.equal(slashBaseName("/commit 新功能"), "commit");
  assert.equal(slashBaseName("com"), "com");
  assert.equal(slashBaseName(""), "");
});

test("filterSlash：前后缀不区分大小写，空查询全量", () => {
  assert.equal(filterSlash("", items).length, items.length);
  assert.deepEqual(filterSlash("/co", items).map((i) => i.name), ["commit", "code-review"]);
  assert.deepEqual(filterSlash("/cle", items).map((i) => i.name), ["clear"]);
  assert.equal(filterSlash("/nope", items).length, 0);
});

test("clampIndex / defaultPick：边界安全", () => {
  assert.equal(clampIndex(0, 0), 0);
  assert.equal(clampIndex(-1, 3), 2);
  assert.equal(clampIndex(3, 3), 0);
  assert.equal(defaultPick(items)?.name, "clear");
  assert.equal(defaultPick([]), null);
});

test("BUILTIN_SLASH_ITEMS 含 /mcp（与 cli 分发一致）", () => {
  assert.ok(BUILTIN_SLASH_ITEMS.some((i) => i.name === "mcp"));
});

test("buildSlash：Tab 补全写回输入框文本（恒带 / 前缀、尾空格续参、幂等）", () => {
  assert.equal(buildSlash("/co", "commit"), "/commit ");
  assert.equal(buildSlash("co", "commit"), "/commit ");
  assert.equal(buildSlash("/commit ", "commit"), "/commit "); // 已补全再 Tab 结果不变
});