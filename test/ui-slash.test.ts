import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_SLASH_ITEMS,
  buildSlash,
  buildSubmitLine,
  clampIndex,
  filterSlash,
  slashArgs,
  slashBaseName,
  defaultPick,
} from '../src/ui/slash.js';
import type { SlashItem } from '../src/ui/controller.js';

const items: SlashItem[] = [
  ...BUILTIN_SLASH_ITEMS,
  { name: 'commit', description: 'git commit' },
  { name: 'code-review', description: 'review' },
];

test('slashBaseName：/name 参数 形态取基础名', () => {
  assert.equal(slashBaseName('/commit 新功能'), 'commit');
  assert.equal(slashBaseName('com'), 'com');
  assert.equal(slashBaseName(''), '');
});

test('filterSlash：前后缀不区分大小写，空查询全量', () => {
  assert.equal(filterSlash('', items).length, items.length);
  assert.deepEqual(
    filterSlash('/code', items).map((i) => i.name),
    ['code-review'],
  );
  assert.deepEqual(
    filterSlash('/cle', items).map((i) => i.name),
    ['clear'],
  );
  assert.equal(filterSlash('/nope', items).length, 0);
});

test('clampIndex / defaultPick：边界安全', () => {
  assert.equal(clampIndex(0, 0), 0);
  assert.equal(clampIndex(-1, 3), 2);
  assert.equal(clampIndex(3, 3), 0);
  assert.equal(defaultPick(items)?.name, 'clear');
  assert.equal(defaultPick([]), null);
});

test('BUILTIN_SLASH_ITEMS 含 /mcp（与 cli 分发一致）', () => {
  assert.ok(BUILTIN_SLASH_ITEMS.some((i) => i.name === 'mcp'));
});

test('buildSlash：Tab 补全写回输入框文本（恒带 / 前缀、尾空格续参、幂等）', () => {
  assert.equal(buildSlash('/co', 'commit'), '/commit ');
  assert.equal(buildSlash('co', 'commit'), '/commit ');
  assert.equal(buildSlash('/commit ', 'commit'), '/commit '); // 已补全再 Tab 结果不变
});

test('slashArgs：取出 /name 之后的参数字符串（带不带 / 都接受）', () => {
  assert.equal(slashArgs('/red-line-check 分支a 分支b'), '分支a 分支b');
  assert.equal(slashArgs('red-line-check 分支a 分支b'), '分支a 分支b');
  assert.equal(slashArgs('/commit'), '');
  assert.equal(slashArgs('/commit '), '');
  assert.equal(slashArgs(''), '');
});

test('buildSubmitLine：Enter 选中候选时参数必须一起提交（回归：曾被整段丢弃）', () => {
  // 用户敲了参数、菜单按基础名命中候选——参数不能因为"选中"而消失
  assert.equal(
    buildSubmitLine('/red-line-check 分支a 分支b', 'red-line-check'),
    '/red-line-check 分支a 分支b',
  );
  // 内置命令同理：/model 带参数不能被截成 /model
  assert.equal(buildSubmitLine('/model claude-opus-5-5', 'model'), '/model claude-opus-5-5');
  // 无参数时保持原样，不产生尾空格
  assert.equal(buildSubmitLine('/commit', 'commit'), '/commit');
});

test('buildSlash：补全不抹掉已输入的参数', () => {
  assert.equal(buildSlash('/commit 修复登录 bug', 'commit'), '/commit 修复登录 bug');
  // 前缀匹配换到别的候选时，参数跟着走而不是留在旧名字后面
  assert.equal(buildSlash('/co 修复登录 bug', 'commit'), '/commit 修复登录 bug');
});
