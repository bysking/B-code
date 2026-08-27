import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, formatFrontmatter } from '../src/frontmatter.js';

test('标准 frontmatter 解析', () => {
  const { meta, body } = parseFrontmatter(
    '---\nname: commit\ndescription: Create a git commit\nuser-invocable: true\n---\n\nRun the commit logic.\n',
  );
  assert.equal(meta.name, 'commit');
  assert.equal(meta['user-invocable'], 'true');
  assert.ok(body.includes('Run the commit logic'));
  assert.ok(!body.includes('---'), '正文不含 frontmatter');
});

test('无 frontmatter → 整篇当正文', () => {
  const { meta, body } = parseFrontmatter('just plain text');
  assert.deepEqual(meta, {});
  assert.equal(body, 'just plain text');
});

test('首行非 --- → 不当 frontmatter', () => {
  const { meta, body } = parseFrontmatter('hello\n---\nx: 1\n---\nbody');
  assert.equal(meta.x, undefined);
  assert.equal(body, 'hello\n---\nx: 1\n---\nbody');
});

test('损坏（有开头没结尾）→ 兜底整篇为正文', () => {
  const { meta, body } = parseFrontmatter('---\nname: x\n');
  assert.deepEqual(meta, {});
  assert.ok(body.includes('name: x'));
});

test('formatFrontmatter → parseFrontmatter 往返', () => {
  const raw = formatFrontmatter({ name: 'a', description: 'b c' }, 'content here');
  const { meta, body } = parseFrontmatter(raw);
  assert.equal(meta.name, 'a');
  assert.equal(meta.description, 'b c');
  assert.equal(body, 'content here');
});

test('块标量 >-：多行折叠成一行（SKILL.md 的 description 常用写法）', () => {
  const raw =
    '---\nname: changelog\ndescription: >-\n  用于初始化、生成或更新 CHANGELOG.md\n  文件的技能。当用户提到 changelog 时使用。\nuser-invocable: true\n---\nbody here\n';
  const { meta, body } = parseFrontmatter(raw);
  assert.equal(meta.name, 'changelog');
  assert.equal(
    meta.description,
    '用于初始化、生成或更新 CHANGELOG.md 文件的技能。当用户提到 changelog 时使用。',
  );
  assert.equal(meta['user-invocable'], 'true', '块标量后的下一个 key 正常解析');
  assert.equal(body, 'body here');
});

test('块标量 |：保留换行', () => {
  const raw = '---\ndescription: |\n  line one\n  line two\n---\nbody\n';
  const { meta } = parseFrontmatter(raw);
  assert.equal(meta.description, 'line one\nline two');
});

test('块标量后跟下一个 key 正常解析', () => {
  const raw = '---\ndescription: >\n  folded text\nother: plain\n---\nb\n';
  const { meta } = parseFrontmatter(raw);
  assert.equal(meta.description, 'folded text');
  assert.equal(meta.other, 'plain');
});

test('块标量值里含空行：折叠时空行折成空格', () => {
  const raw = '---\ndescription: >-\n  first para\n\n  second para\n---\nbody\n';
  const { meta } = parseFrontmatter(raw);
  assert.equal(meta.description, 'first para second para');
});
