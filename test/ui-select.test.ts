import { test } from "node:test";
import assert from "node:assert/strict";
import { moveIndex } from "../src/ui/select.js";

test("moveIndex：上下左右/vim 键共用的循环移动逻辑", () => {
  // 正向/反向/环绕/越界
  assert.equal(moveIndex(0, 1, 3), 1);
  assert.equal(moveIndex(2, 1, 3), 0, "右移到末尾环绕到开头");
  assert.equal(moveIndex(0, -1, 3), 2, "左移到开头环绕到末尾");
  assert.equal(moveIndex(0, 1, 1), 0, "单选项原地");
  assert.equal(moveIndex(0, 1, 0), 0, "空列表不越界");
});