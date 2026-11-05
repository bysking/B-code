import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MouseParser, createMouseFilteredInput } from '../src/ui/mouse.js';

/**
 * 鼠标滚轮解析测试。
 *
 * 终端在开启 SGR 扩展模式后把鼠标事件作为转义序列写进 stdin：
 *   `\x1b[<B;X;YM`（按下）/ `m`（释放）
 * 其中 B=64 滚轮上、65 滚轮下，高位是修饰键。
 *
 * ink 8 会丢弃这些未识别序列，所以必须在喂给 ink 之前拦下——这是本模块存在的理由。
 */

/** 造一个滚轮事件序列（SGR 格式） */
const wheel = (up: boolean, x = 10, y = 5, mods = 0): string =>
  `\x1b[<${(up ? 64 : 65) + mods};${x};${y}M`;

test('MouseParser：识别滚轮上/下并摘除序列', () => {
  const p = new MouseParser();
  const { rest, events } = p.push(wheel(true) + wheel(false));
  assert.equal(rest, '', '鼠标序列不转发给 ink');
  assert.equal(events.length, 2);
  assert.equal(events[0]!.wheel, 'up');
  assert.equal(events[1]!.wheel, 'down');
  assert.equal(events[0]!.x, 10);
  assert.equal(events[0]!.y, 5);
});

test('MouseParser：普通输入原样转发（不吞字符）', () => {
  const p = new MouseParser();
  const { rest, events } = p.push('hello world');
  assert.equal(rest, 'hello world');
  assert.equal(events.length, 0);
});

test('MouseParser：鼠标序列与普通输入混在一起时都能正确处理', () => {
  const p = new MouseParser();
  const { rest, events } = p.push('ab' + wheel(true) + 'cd');
  assert.equal(rest, 'abcd', '文本保留、序列摘除');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.wheel, 'up');
});

test('MouseParser：修饰键（Shift 等）不影响滚轮方向判定', () => {
  const p = new MouseParser();
  // 64 + 4(Shift) = 68；实际终端常发 96（64 + 32）
  const { events } = p.push(wheel(true, 1, 1, 4) + wheel(true, 1, 1, 32));
  assert.equal(events.length, 2);
  assert.equal(events[0]!.wheel, 'up', 'Shift+滚轮上仍是上');
  assert.equal(events[1]!.wheel, 'up', '追加位不影响方向');
});

test('MouseParser：非滚轮鼠标事件（点击/移动）被摘除但不产生滚动', () => {
  const p = new MouseParser();
  // B=0 左键按下，B=35 移动
  const { rest, events } = p.push('\x1b[<0;3;4M\x1b[<35;3;4M');
  assert.equal(rest, '');
  assert.equal(events.length, 2);
  assert.equal(events[0]!.wheel, null, '点击不是滚轮');
  assert.equal(events[1]!.wheel, null);
});

test('MouseParser：跨 chunk 断裂的序列能拼接识别', () => {
  const p = new MouseParser();
  // 序列被切成两半（真实终端在高负载/慢速连接下会这样）
  const full = wheel(true);
  const a = p.push(full.slice(0, 6));
  assert.equal(a.events.length, 0, '半截序列先不解析');
  assert.equal(a.rest, '', '也不转发出去');
  const b = p.push(full.slice(6));
  assert.equal(b.events.length, 1, '补齐后识别成功');
  assert.equal(b.events[0]!.wheel, 'up');
});

test('MouseParser：flush 吐出残留，不吞用户最后的输入', () => {
  const p = new MouseParser();
  p.push('\x1b[<64;1'); // 不完整的序列
  assert.equal(p.flush(), '\x1b[<64;1', '残留原样吐出');
});

test('createMouseFilteredInput：滚轮走回调，其余输入转发到过滤流', async () => {
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream & EventEmitter;
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: () => {},
    ref: () => {},
    unref: () => {},
  });

  const events: number[] = [];
  const { input, dispose } = createMouseFilteredInput(stdin as NodeJS.ReadStream, (ev) => {
    events.push(ev.wheel === 'up' ? 1 : ev.wheel === 'down' ? -1 : 0);
  });

  const forwarded: string[] = [];
  (input as unknown as EventEmitter).on('data', (d: Buffer) => forwarded.push(String(d)));

  stdin.emit('data', Buffer.from('x' + wheel(true) + 'y'));
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(forwarded.join(''), 'xy', '只有文本转发给 ink');
  assert.deepEqual(events, [1], '滚轮上 → +1');

  dispose();
  // dispose 后不再接收
  stdin.emit('data', Buffer.from(wheel(false)));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events, [1], 'dispose 后不再回调');
});
