import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitIgnore } from '../src/ignore.js';

/** 便捷构造：root 层 .gitignore 内容 → 单例判定器 */
function gi(content: string): GitIgnore {
  const g = new GitIgnore();
  g.push('', content);
  return g;
}

test('basename 规则匹配任意层级（node_modules 命中 a/node_modules）', () => {
  const g = gi('node_modules\n');
  assert.equal(g.ignoring('node_modules', true), true);
  assert.equal(g.ignoring('a/b/node_modules', true), true);
  assert.equal(g.ignoring('src/index.ts', false), false);
});

test('锚定规则 /dist 只忽略根下，不忽略子目录里的同名目录', () => {
  const g = gi('/dist\n');
  assert.equal(g.ignoring('dist', true), true);
  assert.equal(g.ignoring('pkg/dist', true), false);
});

test('含中间斜杠的规则视为锚定（foo/bar 只匹配根下 foo/bar）', () => {
  const g = gi('build/output\n');
  assert.equal(g.ignoring('build/output', true), true);
  assert.equal(g.ignoring('x/build/output', true), false);
});

test('仅目录规则 dist/ 不忽略同名文件', () => {
  const g = gi('dist/\n');
  assert.equal(g.ignoring('dist', true), true);
  assert.equal(g.ignoring('dist', false), false, '同名普通文件不受 dist/ 影响');
});

test('通配 * 不跨目录：*.log 命中 a.log 但不命中 a/b.log……实际 git 前述是 basename 语义', () => {
  const g = gi('*.log\n');
  assert.equal(g.ignoring('app.log', false), true);
  // 无斜杠规则按 basename 任意层级匹配 → 子目录的 .log 同样命中
  assert.equal(g.ignoring('logs/app.log', false), true);
});

test('**/ 跨目录：**/temp 命中任意深度的 temp', () => {
  const g = gi('**/temp\n');
  assert.equal(g.ignoring('temp', true), true);
  assert.equal(g.ignoring('a/b/temp', true), true);
});

test('取反规则 !：!important.log 在 *.log 之后恢复', () => {
  const g = gi('*.log\n!important.log\n');
  assert.equal(g.ignoring('debug.log', false), true);
  assert.equal(g.ignoring('important.log', false), false, '取反规则最后匹配者胜');
});

test('规则顺序：后面的忽略规则可再次覆盖取反', () => {
  const g = gi('*.log\n!keep.log\nkeep.log\n');
  assert.equal(g.ignoring('keep.log', false), true, '最后一条 keep.log 重新忽略');
});

test('注释与空行被忽略', () => {
  const g = gi('# comment\n\n   \n/skip\n');
  assert.equal(g.ignoring('# comment', false), false);
  assert.equal(g.ignoring('skip', true), true);
});

test('目录级作用域：子目录 .gitignore 只在其子树生效', () => {
  const g = new GitIgnore();
  g.push('', 'root-ignored\n');
  // 进入 sub/ 追加局部规则
  const n = g.push('sub', 'local-ignored\n');
  assert.equal(g.ignoring('sub/local-ignored', false), true, '子目录规则命中');
  assert.equal(g.ignoring('root-ignored', false), true, '根规则仍生效');
  // 退出 sub/
  g.pop(n);
  assert.equal(g.ignoring('sub/local-ignored', false), false, '离开后子目录规则失效');
  assert.equal(g.ignoring('root-ignored', false), true, '根规则不受影响');
});

test('不同 .gitignore 目录的锚定各自独立（sub 内 /x 指 sub/x）', () => {
  const g = new GitIgnore();
  g.push('sub', '/x\n');
  assert.equal(g.ignoring('sub/x', true), true);
  assert.equal(g.ignoring('x', true), false, '根下 x 不受 sub/.gitignore 影响');
});

test('? 匹配单个非 / 字符', () => {
  const g = gi('a?.txt\n');
  assert.equal(g.ignoring('ab.txt', false), true);
  assert.equal(g.ignoring('a.txt', false), false);
  assert.equal(g.ignoring('a/.txt', false), false, '? 不跨 /');
});
