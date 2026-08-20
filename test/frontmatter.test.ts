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
