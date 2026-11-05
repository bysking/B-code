import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { splitMath, hasMath } from '../src/ui/views/math-split.js';

/**
 * 数学公式切分。
 *
 * 背景：OpenTUI 的 `<markdown>` 不认识 LaTeX，公式会被当普通文本原样显示。
 * 这里先把 markdown 切成「文本段 + 公式段」，公式再转成 Unicode 后再并回，
 * 用户才能看到可读的数学符号。
 */

test('splitMath：纯文本不含公式', () => {
  const segs = splitMath('这是一段普通文本，没有任何公式。');
  assert.equal(segs.length, 1);
  assert.equal(segs[0]!.kind, 'text');
  assert.equal(hasMath('这是一段普通文本'), false);
});

test('splitMath：行内 $…$ 识别为 inline', () => {
  const segs = splitMath('含常数 $a>0$ 的形式');
  const math = segs.find((s) => s.kind === 'math');
  assert.ok(math, '应识别出行内公式');
  assert.equal(math!.value, 'a>0');
  assert.equal(math!.display, false, '行内公式不是 display');
});

test('splitMath：$$…$$ 识别为 display', () => {
  const segs = splitMath('公式：\n$$\\int e^{-x^2}dx$$\n结束');
  const math = segs.find((s) => s.kind === 'math');
  assert.ok(math);
  assert.equal(math!.display, true, '块级公式是 display');
  assert.ok(math!.value.includes('int'));
});

test('splitMath：```latex 围栏代码块识别为 display（模型最常用的写法）', () => {
  const md = 'LaTeX 写法：\n\n```latex\n\\int e^{-x^2}dx = \\sqrt{\\pi}\n```\n\n结束';
  const segs = splitMath(md);
  const math = segs.find((s) => s.kind === 'math');
  assert.ok(math, '```latex 代码块应被识别为公式');
  assert.equal(math!.display, true);
  assert.ok(math!.value.includes('sqrt'), '公式内容完整');
  assert.ok(!math!.value.includes('```'), '围栏标记不残留');
});

test('splitMath：```tex / ```math 别名同样识别', () => {
  for (const lang of ['tex', 'math']) {
    const segs = splitMath(`\`\`\`${lang}\nx^2\n\`\`\``);
    assert.ok(
      segs.some((s) => s.kind === 'math'),
      `\`\`\`${lang} 应被识别`,
    );
  }
});

test('splitMath：\\[…\\] 与 \\(…\\) 定界符', () => {
  const segs = splitMath('用 \\[a+b\\] 和 \\(c\\) 两种写法');
  const maths = segs.filter((s) => s.kind === 'math');
  assert.equal(maths.length, 2);
  assert.equal(maths[0]!.display, true, '\\[…\\] 是块级');
  assert.equal(maths[1]!.display, false, '\\(…\\) 是行内');
});

test('splitMath：转义的 \\$ 不算公式', () => {
  const segs = splitMath('价格是 \\$100 不是公式');
  assert.ok(segs.every((s) => s.kind === 'text'), '转义美元符号不应触发公式');
});

test('splitMath：未闭合公式（流式半截）整段当公式，不丢内容', () => {
  const segs = splitMath('正在输出：$x^2 + y');
  const math = segs.find((s) => s.kind === 'math');
  assert.ok(math, '半截公式也应识别');
  assert.equal(math!.value, 'x^2 + y', '剩余内容全部保留');
});

test('splitMath：空公式被忽略，不产生空白块', () => {
  const segs = splitMath('前 $$$$ 后');
  assert.ok(segs.every((s) => s.kind === 'text'), '空公式不产生 math 段');
});

test('splitMath：代码块里的 $ 不被误判为行内公式', () => {
  // ```latex 已抽走，代码块内部的 $ 不应触发切分
  const md = '```latex\n\\$x + \\$y\n```';
  const segs = splitMath(md);
  const maths = segs.filter((s) => s.kind === 'math');
  assert.equal(maths.length, 1, '整个代码块是一个公式段，不被内部 $ 拆碎');
});
