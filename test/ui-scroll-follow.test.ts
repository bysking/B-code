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

test('createScrollFollow：探测超时后不永久关闭——终端恢复应答仍能判定滚离', async () => {
  // 回归：曾在连续 3 轮超时后永久停止探测，此后永远判不出"用户滚离"，
  // 视口被永久拽回底部且无任何提示。终端忙/SSH/慢终端都会踩到。
  //
  // 这里必须模拟真实终端行为：只在收到 DSR 请求（ESC[6n）时才回 CPR——
  // 探测一旦停止就再也不会有应答。若像其它用例那样手工注入 CPR 序列，
  // 即使探测已停,CprParser 仍会解析它，测试就会假通过。
  const writes: string[] = [];
  let responsive = false; // 阶段一：终端忙，不应答
  let row = 999; // 应答报的光标行号（> rows 即"在视口下方"）
  const stdin = fakeStdin();
  const stdout = {
    isTTY: true,
    rows: 24,
    columns: 80,
    write: (s: string) => {
      writes.push(s);
      if (s.includes('\x1b[6n') && responsive) setTimeout(() => stdin.write(`\x1b[${row};1R`), 1);
      return true;
    },
  } as unknown as NodeJS.WriteStream;

  const follow = createScrollFollow({ stdout, stdin, intervalMs: 20 });
  follow.input.setRawMode(true);

  // 阶段一：连续多轮无应答。每轮 ≈ 20ms 间隔 + 200ms 超时，900ms 足够跨过
  // 旧的 3 次上限（旧实现会在此永久停止探测）
  await wait(900);
  assert.equal(follow.isFollowing(), true, '无应答期间维持跟随（不打扰用户）');

  // 阶段二：终端恢复应答并报告"光标在视口下方" → 必须能冻结。
  // 退避到 900ms 时探测间隔已放大到约 2.8s，因此等到 >3s 覆盖最坏情况。
  responsive = true;
  await wait(3200);
  assert.equal(follow.isFollowing(), false, '探测仍在运行 → 恢复应答即可判定滚离');

  // 阶段三：应答改为"回到视口内" → 收到应答即恢复跟随（间隔应已回落）
  row = 20;
  await wait(1200);
  assert.equal(follow.isFollowing(), true, '回底后恢复跟随');
  follow.dispose();
});

test('createScrollFollow：退避后仍会继续发探测（不是停止，只是放慢）', async () => {
  const { stdout, writes } = fakeTty(24);
  const follow = createScrollFollow({ stdout, stdin: fakeStdin(), intervalMs: 20 });
  follow.input.setRawMode(true);
  const probes = () => writes.filter((w) => w.includes('\x1b[6n')).length;

  // 每轮 ≈ 探测间隔 + 200ms 超时，700ms 内约 3~4 轮，已跨过退避阈值
  await wait(700);
  const mid = probes();
  assert.ok(mid >= 3, `退避前应正常探测（实际 ${mid} 次）`);

  await wait(2000); // 退避期：间隔放大，但必须仍在探测
  assert.ok(probes() > mid, '退避期间探测仍在继续（只是间隔变长）');
  follow.dispose();
});

test('createScrollFollow：用户按键即恢复跟随（人还在终端前，不必等 CPR）', async () => {
  const { stdout } = fakeTty(24);
  const realStdin = fakeStdin();
  const follow = createScrollFollow({ stdout, stdin: realStdin, intervalMs: 10_000 });
  follow.input.setRawMode(true);
  realStdin.write('\x1b[999;1R'); // 报告滚离 → 冻结
  await wait(20);
  assert.equal(follow.isFollowing(), false);

  realStdin.write('a'); // 普通按键（非 CPR 响应）
  await wait(20);
  assert.equal(follow.isFollowing(), true, '按键 = 用户在场 → 恢复跟随');
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

test('渲染：工具调用期间冻结不破功（busy 文案反复切换也不重绘）', async () => {
  // 回归：agent 每批工具都会 spinner.stop()/start()，busy 文案在
  // "thinking…"/"running X…" 之间来回切换。若冻结快照只冻文案、不冻 busySince，
  // 冻结的文案配实时起点 → 一重渲染就整屏重绘，视口被拽回底部（用户回看被打断）。
  const ctrl = new AppController();
  const frame = render(
    React.createElement(App, {
      ctrl,
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
      onSetMode: () => {},
      scrollFollow: fakeFollow(true),
    } as never),
  );
  ctrl.pushUser('读几个文件');
  ctrl.streamText('好的，我来读。');
  ctrl.setBusy('thinking…');
  await wait(40);

  setFollow!(false); // 用户滚离
  await wait(40);
  const frozen = frame.lastFrame() ?? '';

  // 逐事件断言：任一步重绘都会把视口拽回底部，中断用户回看
  const step = async (label: string, act: () => void) => {
    act();
    await wait(40);
    assert.equal(frame.lastFrame() ?? '', frozen, `冻结期间「${label}」不得重绘`);
  };

  await step('busy 停止（工具执行前 spinner.stop）', () => ctrl.setBusy(null));
  await step('宣布工具批（任务面板出现）', () =>
    ctrl.planTools([{ id: 't1', name: 'read_file', input: { file_path: 'a.ts' } }]),
  );
  await step('工具开始（三态 queued→running）', () =>
    ctrl.toolStart('t1', 'read_file', { file_path: 'a.ts' }),
  );
  await step('busy 换文案（running read_file…）', () => ctrl.setBusy('running read_file…'));
  await step('工具结束（running→done，面板移除）', () => ctrl.toolEnd('t1', 'ok'));
  await step('待办更新', () => ctrl.setTodos([{ content: '读文件', status: 'in_progress' }]));
  await step('用量回填', () => ctrl.setTurnUsage({ input_tokens: 100, output_tokens: 50 }, 1000));
  await step('流式收尾', () => ctrl.finishStream());
  await step('busy 换回 thinking…（下一轮模型调用）', () => ctrl.setBusy('thinking…'));

  assert.ok(ctrl.turns.at(-1)!.tools[0]!.status === 'done', '工具状态本身照常推进（回到底部后补齐）');
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

test('工具块提前提交：一批 30 个工具不会把 live 帧撑爆（避免 ink 整屏清屏）', async () => {
  // 回归：turn 里只要有工具没完成，整个 turn 就不能提交 → 所有工具块（含已完成的）
  // 都滞留在 live 区。一批 30 个工具能把 live 帧撑到 48 行（终端 30 行）→
  // ink 整屏清屏（ESC[3J 连 scrollback 一起清）→ 用户回看位置被重置。
  const ctrl = new AppController();
  const frame = render(
    React.createElement(App, {
      ctrl,
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
      onSetMode: () => {},
      scrollFollow: fakeFollow(true),
    } as never),
  );
  ctrl.pushUser('批量读文件');
  const tools = Array.from({ length: 30 }, (_, i) => ({
    id: `t${i}`,
    name: 'read_file',
    input: { file_path: `f${i}.ts` },
  }));
  ctrl.planTools(tools);
  // 29 个完成、1 个仍在跑 → 整 turn 不可提交，但已完成的前缀应已进 <Static>
  for (let i = 0; i < 29; i++) {
    ctrl.toolStart(tools[i]!.id, tools[i]!.name, tools[i]!.input);
    ctrl.toolEnd(tools[i]!.id, 'ok');
  }
  ctrl.toolStart(tools[29]!.id, tools[29]!.name, tools[29]!.input);
  await wait(60);

  const turn = ctrl.turns.at(-1)!;
  assert.equal(turn.toolsCommitted, 29, '已完成的连续前缀应被提交计数');
  assert.equal(turn.tools[29]!.status, 'running', '最后一个仍在跑');
  // 只应有 1 个工具块留在 live 区（其余 29 个已进 <Static>）。
  // 注：不在这里断帧高——ink-testing-library 不实现 <Static> 语义（内容仍留在帧里），
  // 真实帧高由 test 里的"帧高始终小于终端行数"用例在真实 ink 下覆盖。
  assert.equal(turn.tools.length - turn.toolsCommitted, 1, 'live 区只剩未完成的 1 个工具块');
  frame.cleanup();
});

test('工具块提交只推进连续前缀（中间夹 running 就停，保证 <Static> 顺序）', async () => {
  const ctrl = new AppController();
  ctrl.pushUser('x');
  ctrl.planTools([
    { id: 'a', name: 'read_file', input: { file_path: 'a.ts' } },
    { id: 'b', name: 'read_file', input: { file_path: 'b.ts' } },
    { id: 'c', name: 'read_file', input: { file_path: 'c.ts' } },
  ]);
  ctrl.toolStart('a', 'read_file', { file_path: 'a.ts' });
  ctrl.toolEnd('a', 'ok');
  ctrl.toolStart('b', 'read_file', { file_path: 'b.ts' }); // b 还没完成
  ctrl.toolStart('c', 'read_file', { file_path: 'c.ts' });
  ctrl.toolEnd('c', 'ok'); // c 完成了，但 b 夹在中间

  const turn = ctrl.turns.at(-1)!;
  assert.equal(turn.toolsCommitted, 1, '只提交连续 done 的前缀（a），c 不能越过 b 提前提交');
});

test('真实 ink：30 个工具时 live 帧不超过终端行数（不触发整屏清屏）', async () => {
  // 用真实 ink（而非 ink-testing-library）：只有真实 ink 才有 <Static> 语义，
  // 才能验证"已完成工具进 Static、live 区只剩未完成的"这一行为。
  const { render: realRender } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const rows = 30;
  const writes: string[] = [];
  const stdout = new PassThrough() as never as NodeJS.WriteStream;
  (stdout as { isTTY: boolean }).isTTY = true;
  (stdout as { rows: number }).rows = rows;
  Object.defineProperty(stdout, 'columns', { value: 100, configurable: true });
  (stdout as { write: (s: string) => boolean }).write = (s: string) => {
    writes.push(s);
    return true;
  };
  const stdin = new PassThrough() as never as NodeJS.ReadStream;
  Object.defineProperty(stdin, 'isTTY', { value: true, configurable: true });
  (stdin as { setRawMode: (m: boolean) => void }).setRawMode = () => {};
  (stdin as { ref: () => void }).ref = () => {};
  (stdin as { unref: () => void }).unref = () => {};

  const ctrl = new AppController();
  const inst = realRender(
    React.createElement(App, {
      ctrl,
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
      onSetMode: () => {},
      scrollFollow: fakeFollow(true),
    } as never),
    { stdout, stdin, exitOnCtrlC: false } as never,
  );
  await wait(120);
  writes.length = 0;

  ctrl.pushUser('批量读文件');
  const tools = Array.from({ length: 30 }, (_, i) => ({
    id: `t${i}`,
    name: 'read_file',
    input: { file_path: `f${i}.ts` },
  }));
  ctrl.planTools(tools);
  for (let i = 0; i < 29; i++) {
    ctrl.toolStart(tools[i]!.id, tools[i]!.name, tools[i]!.input);
    ctrl.toolEnd(tools[i]!.id, 'ok');
  }
  ctrl.toolStart(tools[29]!.id, tools[29]!.name, tools[29]!.input);
  await wait(400);

  const raw = writes.join('');
  assert.ok(
    !raw.includes('\x1b[2J') && !raw.includes('\x1b[3J'),
    '不得整屏清屏（ESC[3J 会连 scrollback 一起清，用户回看位置丢失）',
  );
  inst.unmount();
});

// ── live 帧高度：任何场景都不得触发 ink 整屏清屏 ─────────────────
// 注意：这些用例必须设**全局** process.stdout.rows/columns，
// 因为 budget 相关函数运行时读取 process.stdout，不认 render() 传入的流。

/** 临时改全局终端尺寸，返回还原函数 */
function withTerminal(rows: number, cols: number): () => void {
  const r = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  const c = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
  return () => {
    if (r) Object.defineProperty(process.stdout, 'rows', r);
    else delete (process.stdout as { rows?: number }).rows;
    if (c) Object.defineProperty(process.stdout, 'columns', c);
    else delete (process.stdout as { columns?: number }).columns;
  };
}

/** 用真实 ink 跑一段场景，返回是否出现整屏清屏与末帧高度 */
async function measureFrame(rows: number, cols: number, setup: (c: AppController) => void) {
  const { render: realRender } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const restore = withTerminal(rows, cols);
  const writes: string[] = [];
  const stdout = new PassThrough() as never as NodeJS.WriteStream;
  (stdout as { isTTY: boolean }).isTTY = true;
  (stdout as { rows: number }).rows = rows;
  Object.defineProperty(stdout, 'columns', { value: cols, configurable: true });
  (stdout as { write: (s: string) => boolean }).write = (s: string) => {
    writes.push(s);
    return true;
  };
  const stdin = new PassThrough() as never as NodeJS.ReadStream;
  Object.defineProperty(stdin, 'isTTY', { value: true, configurable: true });
  (stdin as { setRawMode: (m: boolean) => void }).setRawMode = () => {};
  (stdin as { ref: () => void }).ref = () => {};
  (stdin as { unref: () => void }).unref = () => {};

  const ctrl = new AppController();
  const inst = realRender(
    React.createElement(App, {
      ctrl,
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
      onSetMode: () => {},
      scrollFollow: {
        input: stdin,
        isFollowing: () => true,
        subscribe: () => () => {},
        follow: () => {},
        dispose: () => {},
      } as never,
    } as never),
    { stdout, stdin, exitOnCtrlC: false } as never,
  );
  await wait(120);
  writes.length = 0;
  setup(ctrl);
  await wait(400);
  inst.unmount();
  restore();

  const raw = writes.join('');
  const contents = writes.filter((w) => w.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trim());
  return {
    cleared: raw.includes('\x1b[2J') || raw.includes('\x1b[3J'),
    height: contents.length ? contents[contents.length - 1]!.split('\n').length : 0,
  };
}

const longTodo = (i: number) =>
  `这是第 ${i} 个相当长的待办描述文本，用来测试窄终端下折行后是否仍然不会撑爆整个 live 帧`;

test('live 帧：宽终端下"正文 + 长待办 + 一批工具"不清屏', async () => {
  const { cleared, height } = await measureFrame(40, 100, (c) => {
    c.pushUser('全场景');
    c.setBusy('thinking…');
    for (let i = 0; i < 60; i++) c.streamText(`正文 ${i}\n`);
    c.setTodos(Array.from({ length: 10 }, (_, i) => ({ content: longTodo(i), status: 'pending' as const })));
    const tools = Array.from({ length: 20 }, (_, i) => ({
      id: `t${i}`,
      name: 'read_file',
      input: { file_path: `/a/b/c/deep/file-${i}.tsx` },
    }));
    c.planTools(tools);
    for (const x of tools) c.toolStart(x.id, x.name, x.input);
  });
  assert.equal(cleared, false, `不得整屏清屏（末帧 ${height} 行）`);
});

test('live 帧：矮终端（24 行）下收起任务面板，仍不清屏', async () => {
  const { cleared, height } = await measureFrame(24, 50, (c) => {
    c.pushUser('全场景');
    c.setBusy('thinking…');
    for (let i = 0; i < 60; i++) c.streamText(`正文 ${i}\n`);
    c.setTodos(Array.from({ length: 10 }, (_, i) => ({ content: longTodo(i), status: 'pending' as const })));
    const tools = Array.from({ length: 20 }, (_, i) => ({
      id: `t${i}`,
      name: 'read_file',
      input: { file_path: `/a/b/c/deep/file-${i}.tsx` },
    }));
    c.planTools(tools);
    for (const x of tools) c.toolStart(x.id, x.name, x.input);
  });
  assert.equal(cleared, false, `矮终端也不得整屏清屏（末帧 ${height} 行 / 终端 24 行）`);
  assert.ok(height < 24, `末帧 ${height} 行须小于终端 24 行`);
});

test('live 帧：60 行流式正文被切走，不会整屏清屏', async () => {
  const { cleared, height } = await measureFrame(24, 60, (c) => {
    c.pushUser('x');
    for (let i = 0; i < 60; i++) c.streamText(`正文第 ${i} 行内容\n`);
  });
  assert.equal(cleared, false, `不得整屏清屏（末帧 ${height} 行）`);
});

test('live 帧：正文流式期间待办突然出现，也要重新收敛（reflowLive）', async () => {
  const { cleared } = await measureFrame(24, 60, (c) => {
    c.pushUser('x');
    for (let i = 0; i < 60; i++) c.streamText(`正文第 ${i} 行\n`);
    // 面板出现 → live 预算变小 → 必须重估已渲染内容
    c.setTodos(Array.from({ length: 10 }, (_, i) => ({ content: longTodo(i), status: 'pending' as const })));
  });
  assert.equal(cleared, false, '面板变高后残留正文必须被切走，否则整帧溢出');
});
