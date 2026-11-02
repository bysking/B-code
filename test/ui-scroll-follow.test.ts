import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import React from 'react';
import { render } from 'ink-testing-library';
import { CprParser, createScrollFollow } from '../src/ui/scroll-follow.js';
import { AppController } from '../src/ui/controller.js';
import { App } from '../src/ui/app.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── CprParser：从输入流剥离 CPR 响应 ─────────────────────────────

test('CprParser：剥离完整 CPR 响应，其余输入原样透传', () => {
  const p = new CprParser();
  const { rest, rows } = p.push('abc\x1b[12;3Rdef');
  assert.equal(rest, 'abcdef', 'CPR 被剥掉，普通输入不丢');
  assert.deepEqual(rows, [12], '解析出光标行号');
});

test('CprParser：剥掉 CPR 后普通按键仍是普通按键（不被吃进草稿）', () => {
  const p = new CprParser();
  // 回归：CPR 若不剥离，会被输入框当普通字符插入 → 每 600ms 灌入 "[12;3R" 垃圾
  const { rest } = p.push('\x1b[40;1R\r');
  assert.equal(rest, '\r', '回车保留，CPR 不残留');
});

test('CprParser：跨 chunk 断开的响应要拼起来再剥离', () => {
  const p = new CprParser();
  const a = p.push('x\x1b[1');
  assert.equal(a.rest, 'x', '未收全的尾部先扣住');
  assert.deepEqual(a.rows, []);
  const b = p.push('2;3R');
  assert.equal(b.rest, '', '补全后整段被剥离');
  assert.deepEqual(b.rows, [12]);
});

test('CprParser：同一 chunk 内多条响应都能解析', () => {
  const p = new CprParser();
  const { rest, rows } = p.push('\x1b[5;1R\x1b[24;1R');
  assert.equal(rest, '');
  assert.deepEqual(rows, [5, 24]);
});

test('CprParser：普通方向键不被误判为 CPR 前缀', () => {
  const p = new CprParser();
  // ↑ 是 \x1b[A，不属于 CPR 前缀，必须原样转发（否则历史导航失效）
  const { rest } = p.push('\x1b[A');
  assert.equal(rest, '\x1b[A');
});

test('CprParser：畸形/超长前缀不再无限扣留（转发出去，不卡输入）', () => {
  const p = new CprParser();
  const junk = '\x1b[123456789012345678901234567890123456789;';
  const { rest } = p.push(junk);
  assert.ok(rest.length > 0, '超长疑似前缀必须被转发，不能吞掉用户输入');
});

// ── createScrollFollow：探测与跟随状态 ───────────────────────────

/** 可控的假 TTY stdout：捕获写入（断言 CPR 请求确实发出） */
function fakeTty(rows = 24) {
  const writes: string[] = [];
  const stdout = {
    isTTY: true,
    rows,
    columns: 80,
    write: (s: string) => {
      writes.push(s);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stdout, writes };
}

/** 假 TTY stdin：真实 PassThrough（有 on/off/write），只补 isTTY 标记 */
function fakeStdin(): NodeJS.ReadStream {
  const s = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.defineProperty(s, 'isTTY', { value: true, configurable: true });
  return s;
}

/** 非 TTY 的 stdin */
function fakePipeStdin(): NodeJS.ReadStream {
  const s = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.defineProperty(s, 'isTTY', { value: false, configurable: true });
  return s;
}

test('createScrollFollow：非 TTY 恒跟随且不探测（行为与改动前一致）', () => {
  const follow = createScrollFollow({
    stdout: { isTTY: false, write: () => true } as unknown as NodeJS.WriteStream,
    stdin: fakePipeStdin(),
  });
  assert.equal(follow.isFollowing(), true, '管道/CI 环境恒跟随');
  follow.dispose();
});

test('createScrollFollow：只有进入 raw mode（ink 接管终端）后才开始探测', async () => {
  const { stdout, writes } = fakeTty(24);
  const realStdin = fakeStdin();
  const follow = createScrollFollow({ stdout, stdin: realStdin, intervalMs: 20 });

  // 回归：创建即探测会在 cooked 模式下把 CPR 应答回显到屏幕（用户看到 "[37;1R"）
  await wait(60);
  assert.ok(!writes.some((w) => w.includes('\x1b[6n')), 'raw mode 之前不得发探测');

  follow.input.setRawMode(true); // ink 接管终端的信号
  await wait(60);
  assert.ok(
    writes.some((w) => w.includes('\x1b[6n')),
    '进入 raw mode 后才发 CPR 请求',
  );
  follow.dispose();
});

test('createScrollFollow：光标在视口内 → 跟随；被滚到下方 → 冻结', async () => {
  const { stdout, writes } = fakeTty(24);
  const realStdin = fakeStdin();
  const follow = createScrollFollow({
    stdout,
    stdin: realStdin,
    intervalMs: 20,
  });
  follow.input.setRawMode(true); // 模拟 ink 接管终端
  await wait(30);
  assert.ok(
    writes.some((w) => w.includes('\x1b[6n')),
    '悬空探测确实发了 CPR 请求',
  );

  // 光标行号 ≤ rows → 视口在底部 → 跟随
  realStdin.write('\x1b[24;1R');
  await wait(10);
  assert.equal(follow.isFollowing(), true);

  // 光标行号超出终端行数 → 用户滚离底部 → 冻结
  realStdin.write('\x1b[40;1R');
  await wait(10);
  assert.equal(follow.isFollowing(), false, '滚离底部后应冻结');
  follow.dispose();
});

test('createScrollFollow：follow() 主动回到底部并恢复跟随', async () => {
  const { stdout } = fakeTty(24);
  const realStdin = fakeStdin();
  const follow = createScrollFollow({
    stdout,
    stdin: realStdin,
    intervalMs: 1000, // 拉长间隔：确保状态变化只来自 follow()，不受下一轮探测干扰
  });
  follow.input.setRawMode(true);
  realStdin.write('\x1b[60;1R');
  await wait(10);
  assert.equal(follow.isFollowing(), false);
  follow.follow();
  assert.equal(follow.isFollowing(), true, '提交新消息/弹确认框时强制回到底部');
  follow.dispose();
});

test('createScrollFollow：状态变化才通知订阅者（避免高频重渲染）', async () => {
  const { stdout } = fakeTty(24);
  const realStdin = fakeStdin();
  const follow = createScrollFollow({
    stdout,
    stdin: realStdin,
    intervalMs: 1000,
  });
  follow.input.setRawMode(true);
  let n = 0;
  follow.subscribe(() => n++);
  realStdin.write('\x1b[20;1R'); // 仍在底部 → 无变化
  await wait(10);
  assert.equal(n, 0, '状态未变不通知');
  realStdin.write('\x1b[40;1R'); // 滚离 → 一次变化
  await wait(10);
  assert.equal(n, 1);
  follow.dispose();
});

test('createScrollFollow：未收到响应（终端不支持）时恒跟随，不干扰用户', async () => {
  const { stdout } = fakeTty(24);
  const follow = createScrollFollow({
    stdout,
    stdin: fakeStdin(),
    intervalMs: 10,
  });
  follow.input.setRawMode(true);
  await wait(1200); // 跨过若干探测 + 超时
  assert.equal(follow.isFollowing(), true, '探测失败退化为始终跟随');
  follow.dispose();
});

test('createScrollFollow：CPR 响应不会泄漏进普通输入（否则输入框被灌垃圾）', async () => {
  const realStdin = fakePipeStdin();
  const follow = createScrollFollow({
    stdout: { isTTY: false, write: () => true } as unknown as NodeJS.WriteStream,
    stdin: realStdin,
  });
  const seen: string[] = [];
  follow.input.on('data', (d: Buffer) => seen.push(d.toString()));
  // 从"真实终端"侧注入：CPR 响应 + 普通输入
  realStdin.write('\x1b[12;3Rhello');
  await wait(10);
  assert.deepEqual(seen, ['hello'], '过滤流只吐普通输入');
  follow.dispose();
});

// ── 渲染集成：冻结快照保持不变 ───────────────────────────────────

/** 可控的 ScrollFollow 替身：手动切换跟随状态，能真正挂到 App 上 */
let setFollow: ((v: boolean) => void) | null = null;
function fakeFollow(initial: boolean) {
  const listeners = new Set<() => void>();
  setFollow = (v: boolean) => {
    if (following === v) return;
    following = v;
    for (const l of listeners) l();
  };
  let following = initial;
  // 方法必须是稳定引用：App 的 useEffect 以对象为依赖，若每次渲染都换新函数，
  // effect 会反复重订阅（并重算 follow 状态），冻结断言随之失真。
  const api = {
    input: { on: () => {}, write: () => true } as never,
    isFollowing: () => following,
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    follow: () => setFollow?.(true),
    dispose: () => {},
  };
  return api;
}

test('渲染：冻结期间画面不变，内容继续生成', async () => {
  const ctrl = new AppController();
  const frame = render(
    React.createElement(App, {
      ctrl,
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
      onSetMode: () => {},
      initialOutput: undefined,
      scrollFollow: fakeFollow(false),
    } as never),
  );
  ctrl.streamText('冻结前的内容');
  await wait(40);
  // 首次渲染前就已冻结：快照为空 → 直接采用当前内容建快照（不会渲染出空屏）
  const frozenFrame = frame.lastFrame() ?? '';
  assert.ok(frozenFrame.includes('冻结前的内容'), '冻结态首次渲染也要有内容');

  // 冻结期间继续输出：controller 状态照常变化（内容不丢），但渲染帧不变
  ctrl.streamText('\n冻结期间新增的内容');
  await wait(40);
  assert.equal(frame.lastFrame() ?? '', frozenFrame, '冻结期间不重渲染 → 视口不动');
  assert.ok(
    ctrl.turns.at(-1)!.text.includes('冻结期间新增的内容'),
    '内容本身照常生成（不丢数据，回到底部后补齐）',
  );
  frame.cleanup();
});

test('渲染：follow 由 false 回到 true 后补齐冻结期间的内容', async () => {
  const ctrl = new AppController();
  const props = {
    ctrl,
    onSubmit: () => {},
    onInterrupt: () => {},
    onExit: () => {},
    onSetMode: () => {},
    initialOutput: undefined,
  };
  const frame = render(React.createElement(App, { ...props, scrollFollow: fakeFollow(true) } as never));
  ctrl.streamText('第一条');
  await wait(40);
  assert.ok((frame.lastFrame() ?? '').includes('第一条'));

  // 冻结（真实时序：CPR 定时器判定滚离 → 先冻结，之后流的 chunk 才陆续到达）
  setFollow!(false);
  await wait(20);
  ctrl.streamText('\n第二条');
  await wait(40);
  assert.ok(!(frame.lastFrame() ?? '').includes('第二条'), '冻结期间不渲染新内容');

  // 回到底部：补齐
  setFollow!(true);
  await wait(40);
  assert.ok((frame.lastFrame() ?? '').includes('第二条'), '恢复跟随后补齐');
  frame.cleanup();
});

test('createScrollFollow：交还终端（setRawMode(false)）后停止探测，不再回显乱码', async () => {
  const { stdout, writes } = fakeTty(24);
  const realStdin = fakeStdin();
  const follow = createScrollFollow({ stdout, stdin: realStdin, intervalMs: 20 });
  follow.input.setRawMode(true);
  await wait(60);
  const probedBefore = writes.filter((w) => w.includes('\x1b[6n')).length;
  assert.ok(probedBefore > 0, 'raw mode 期间有探测');

  follow.input.setRawMode(false); // ink 交还终端（退出/挂起）
  await wait(80);
  const probedAfter = writes.filter((w) => w.includes('\x1b[6n')).length;
  assert.equal(probedAfter, probedBefore, '交还终端后不再发探测（否则应答被回显到屏幕）');
  follow.dispose();
});
