import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  backspaceSpan,
  charIndexToColumn,
  columnToCharIndex,
  deleteSpan,
  findPlaceholders,
} from '../src/ui/image-placeholder.js';

/**
 * 图片占位符的原子块判定（纯函数）。
 *
 * ## 这里最容易错的地方
 *
 * OpenTUI 的 `cursorOffset` / `setSelection` 用的是**显示列宽**（汉字占 2 列），
 * 而 `plainText` 的正则下标是**字符下标**。两者只在"占位符前面全是 ASCII"
 * 时相等——所以每个边界用例都必须带一个汉字前缀，否则测不出换算 bug
 * （我第一版就写成了直接比较，汉字前缀下会漏判，删不干净）。
 */

// ── 定位 ──────────────────────────────────────────────────────

test('findPlaceholders：找出全部占位符的字符下标', () => {
  assert.deepEqual(findPlaceholders('[image #1]'), [{ start: 0, end: 10 }]);
  assert.deepEqual(findPlaceholders('前[image #1]后[image #12]'), [
    { start: 1, end: 11 },
    { start: 12, end: 23 },
  ]);
  assert.deepEqual(findPlaceholders('没有图片'), []);
});

test('findPlaceholders：多次调用不互相污染（模块级正则 lastIndex 坑）', () => {
  const text = 'a[image #1]b[image #2]';
  // 连续调三次，结果必须一致；若复用带 g 的同一个 RegExp 会漏掉第二轮
  assert.equal(findPlaceholders(text).length, 2);
  assert.equal(findPlaceholders(text).length, 2);
  assert.equal(findPlaceholders(text).length, 2);
});

// ── 列宽 ↔ 字符下标换算 ───────────────────────────────────────

test('columnToCharIndex：ASCII 时列宽 == 字符下标', () => {
  assert.equal(columnToCharIndex('[image #1]', 10), 10);
  assert.equal(columnToCharIndex('abc', 2), 2);
});

test('columnToCharIndex：汉字占 2 列，要从列宽换算回字符下标', () => {
  // "前" 占 2 列，所以整串的列宽是 12，字符长度只有 11
  const text = '前[image #1]';
  assert.equal(text.length, 11);
  assert.equal(columnToCharIndex(text, 12), 11, '末尾（12 列）对应第 11 个字符');
  assert.equal(columnToCharIndex(text, 2), 1, '第 2 列之后是第 1 个字符');
});

test('columnToCharIndex：认识常见宽字符', () => {
  assert.equal(columnToCharIndex('中', 2), 1, '汉字');
  assert.equal(columnToCharIndex('ａ', 2), 1, '全角字母');
  assert.equal(columnToCharIndex('あ', 2), 1, '假名');
  assert.equal(columnToCharIndex('😀', 2), 2, 'emoji 占 2 列 + 2 个 UTF-16 单元');
});

test('charIndexToColumn：是 columnToCharIndex 的逆运算', () => {
  const text = '前中[image #1]'; // 2 汉字 + 10 ASCII = 12 字符 / 14 列
  assert.equal(text.length, 12);
  for (const charIdx of [0, 1, 2, 3, 12]) {
    const col = charIndexToColumn(text, charIdx);
    assert.equal(columnToCharIndex(text, col), charIdx, `charIdx=${charIdx} 往返应一致`);
  }
  // 两个汉字 → 4 列
  assert.equal(charIndexToColumn(text, 2), 4);
});

// ── Backspace 命中范围 ───────────────────────────────────────

test('backspaceSpan：光标在占位符右边界 → 命中整块', () => {
  const text = '前[image #1]';
  // 末尾：列宽 12，字符下标 11
  assert.deepEqual(backspaceSpan(text, 12), { start: 1, end: 11 });
});

test('backspaceSpan：光标在占位符内部 → 命中整块', () => {
  const text = '[image #1]abc';
  // 光标在 "a" 之前（列 10）→ 落在占位符右边界，仍算命中
  assert.deepEqual(backspaceSpan(text, 10), { start: 0, end: 10 });
  // 光标在占位符中间（列 5）
  assert.deepEqual(backspaceSpan(text, 5), { start: 0, end: 10 });
});

test('backspaceSpan：光标紧贴左边界 → 不命中（删的是前一个字符）', () => {
  const text = 'a[image #1]';
  // 列 1 是 '[' 之前，退格应删 'a' 而不是整块
  assert.equal(backspaceSpan(text, 1), null);
});

test('backspaceSpan：光标不在任何占位符上 → null', () => {
  assert.equal(backspaceSpan('纯文本', 3), null);
  assert.equal(backspaceSpan('[image #1]', 0), null);
});

test('backspaceSpan：多个占位符时只命中光标所在的那个', () => {
  const text = '[image #1][image #2]';
  // 第一个的右边界是列 10
  assert.deepEqual(backspaceSpan(text, 10), { start: 0, end: 10 });
  // 第二个的右边界是列 20
  assert.deepEqual(backspaceSpan(text, 20), { start: 10, end: 20 });
});

// ── Delete 命中范围（与 Backspace 镜像）─────────────────────

test('deleteSpan：光标在占位符左边界 → 命中整块', () => {
  const text = '[image #1]abc';
  assert.deepEqual(deleteSpan(text, 0), { start: 0, end: 10 });
});

test('deleteSpan：光标紧贴右边界 → 不命中（删的是后一个字符）', () => {
  const text = '[image #1]abc';
  // 列 10 是 ']' 之后、'a' 之前，Delete 删 'a'
  assert.equal(deleteSpan(text, 10), null);
});

test('deleteSpan：光标在占位符内部 → 命中整块', () => {
  const text = 'ab[image #1]';
  assert.deepEqual(deleteSpan(text, 4), { start: 2, end: 12 });
});

test('deleteSpan：汉字前缀下仍能正确命中（列宽换算）', () => {
  const text = '看[image #1]x';
  // "看" 占 2 列 → "[" 的列宽位置是 2
  assert.deepEqual(deleteSpan(text, 2), { start: 1, end: 11 });
});
