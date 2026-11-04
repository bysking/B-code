import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/app.js';
import { AppController } from '../src/ui/controller.js';
import type { ClipboardImage } from '../src/utils/clipboard.js';

function renderApp(
  ctrl: AppController,
  onSubmit: (text: string | { text: string; images?: ClipboardImage[] }) => void = () => {},
  onExit: () => void = () => {},
) {
  const frame = render(
    React.createElement(App, {
      ctrl,
      onSubmit,
      onInterrupt: () => {},
      onExit,
      onSetMode: () => {},
      initialOutput: undefined,
    }),
  );
  return frame;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 剥离 ANSI 色码：FORCE_COLOR 环境下渲染输出带颜色，断言只看纯文本 */
const stripAnsi = (out: string): string => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const frameText = (frame: { lastFrame: () => string | undefined }): string =>
  stripAnsi(frame.lastFrame() ?? '');

/**
 * 等待 frame 渲染出包含 needle 的内容。
 *
 * 轮询间隔刻意取 40ms 而不是 10ms：ink 8 的输入解析走 `readable` 事件，
 * 密集的 `setTimeout(10)` 轮询会持续抢占事件循环，导致紧接着写入的按键
 * 在解析前就被丢弃（实测表现为"↓ 收不到，下一击 Enter 提交了默认项"）。
 * 40ms 足够覆盖一次渲染提交，又给输入事件留出处理窗口。
 */
async function waitForFrame(
  frame: { lastFrame: () => string | undefined },
  needle: string,
  label: string,
  timeoutMs = 3000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const out = frameText(frame);
    if (out.includes(needle)) return out;
    if (Date.now() > deadline) throw new Error(`waitForFrame 超时（${label}）：\n${out}`);
    await wait(40);
  }
}

/**
 * 写一段按键序列后等 ink 处理完。
 *
 * ink 8 把 useInput 的回调包在 useEffectEvent + discreteUpdates 里，渲染提交要经过
 * 微任务与帧边界。20ms 在本机偶发不足——表现为"连按两个键时第一个丢失"，
 * 例如 ↓ 后紧接 Enter 会变成"↓ 没生效，Enter 提交了默认项"。
 * 取 50ms：足够覆盖一次提交，又不至于让整个套件变慢。
 */
const press = async (frame: { stdin: { write: (s: string) => void } }, keys: string) => {
  frame.stdin.write(keys);
  await wait(50);
};

test('渲染：用户消息 + assistant markdown 流式文本', async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  ctrl.pushUser('你好');
  ctrl.streamText('收到 **加粗** 与 `code`');
  await wait(30);
  const out = frame.lastFrame() ?? '';
  assert.ok(out.includes('你好'), '用户消息渲染');
  assert.ok(out.includes('加粗'), 'bold 文案渲染（样式由 ink 处理，文本在）');
  assert.ok(out.includes('code'));
  ctrl.finishStream();
  frame.cleanup();
});

test('渲染：工具调用块出现且标记完成', async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  ctrl.streamText('');
  ctrl.planTools([{ id: 't1', name: 'read_file', input: { file_path: 'x.ts' } }]);
  ctrl.toolStart('t1', 'read_file', { file_path: 'x.ts' }); // 首个工具开始 → 整批落地展示
  await wait(30);
  assert.ok((frame.lastFrame() ?? '').includes('read_file'));
  ctrl.toolEnd('t1');
  await wait(30);
  assert.ok((frame.lastFrame() ?? '').includes('read_file'));
  frame.cleanup();
});

test('渲染：底部固定任务面板展示标题、三态与 loading，随事件推进', async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  ctrl.planTools([
    { id: 'a', name: 'read_file', input: { file_path: 'src/a.ts' } },
    { id: 'b', name: 'read_file', input: { file_path: 'src/b.ts' } },
  ]);
  await wait(30);
  let out = frame.lastFrame() ?? '';
  assert.ok(out.includes('正在读取 2 个文件'), 'loading 态标题');
  assert.ok(out.includes('待读取'), 'queued → 待读取');
  assert.ok(out.includes('src/a.ts'), '子项标签（文件路径）');

  ctrl.toolStart('a', 'read_file', { file_path: 'src/a.ts' });
  await wait(30);
  out = frame.lastFrame() ?? '';
  assert.ok(out.includes('读取中'), 'running → 读取中');

  ctrl.toolEnd('a');
  ctrl.toolStart('b', 'read_file', { file_path: 'src/b.ts' });
  ctrl.toolEnd('b');
  await wait(30);
  out = frame.lastFrame() ?? '';
  assert.ok(!out.includes('正在读取 2 个文件'), '全部完成 → 面板消失');
  assert.ok(!out.includes('读取中'), '面板消失不再展示状态');
  frame.cleanup();
});

test('渲染：busy 行展示 thinking 文案', async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  ctrl.setBusy('thinking…');
  await wait(30);
  assert.ok((frame.lastFrame() ?? '').includes('thinking…'));
  ctrl.setBusy(null);
  frame.cleanup();
});

test('渲染：busy 状态行展示 ✽ 前缀、耗时、token 与 thinking 标签', async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  ctrl.setBusy('thinking…');
  ctrl.setBusyThinking(true);
  ctrl.setBusyTokens(1234);
  await wait(30);
  const out = frame.lastFrame() ?? '';
  // elapsed 由挂载时刻决定（跨秒边界时为 1s），断言形态而非精确秒数
  assert.match(out, /✽ thinking… \(\d+s · ↓ 1\.2k tokens · thinking\)/, '完整状态行');
  ctrl.setBusy(null);
  frame.cleanup();
});

test('渲染：模型调用完成后显示真实用量元信息行', async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  ctrl.pushUser('hi');
  ctrl.streamText('done');
  // 生产顺序：usage 事件先于 stream_end（agent.ts），用量行须在 finishStream 前回填
  ctrl.setTurnUsage({ input_tokens: 1000, output_tokens: 200 }, 3400);
  ctrl.finishStream();
  await wait(30);
  const out = frame.lastFrame() ?? '';
  assert.ok(out.includes('(⏱ 3s · ↓ 1k · ↑ 200 tokens)'), '真实用量行（耗时 3s，整千去 .0）');
  frame.cleanup();
});

test('回归：用户消息单独 push 后立刻展示（模型回答前不丢失）', async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  // 真实时序：提交后模型尚未返回（甚至 busy thinking 中），期间只有 user turn 一次渲染
  ctrl.setBusy('thinking…');
  ctrl.pushUser('帮我读一下 src/index.ts');
  await wait(30);
  let out = frame.lastFrame() ?? '';
  assert.ok(out.includes('帮我读一下 src/index.ts'), '模型回答前用户消息已展示');

  // 模型随后开始流式回复：历史 + 新回复都应可见
  ctrl.streamText('好的，正在读取');
  await wait(30);
  out = frame.lastFrame() ?? '';
  assert.ok(out.includes('帮我读一下 src/index.ts'), '流式期间用户消息仍在');
  assert.ok(out.includes('好的，正在读取'), '模型回复渲染');
  ctrl.finishStream();
  frame.cleanup();
});

test('回归：完整一轮结束后再输入，新一轮用户消息仍展示', async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  ctrl.pushUser('第一轮');
  ctrl.streamText('回复一');
  ctrl.setTurnUsage({ input_tokens: 10, output_tokens: 20 }, 100);
  ctrl.finishStream();
  await wait(30);
  ctrl.pushUser('第二轮');
  await wait(30);
  const out = frame.lastFrame() ?? '';
  assert.ok(out.includes('第一轮'), '上一轮用户消息保留');
  assert.ok(out.includes('第二轮'), '新一轮用户消息展示');
  frame.cleanup();
});

test('渲染：斜杠菜单打开显示候选', async () => {
  const ctrl = new AppController();
  const submitted: (string | { text: string; images?: ClipboardImage[] })[] = [];
  const frame = renderApp(ctrl, (t) => submitted.push(t));
  ctrl.setSlashItems([
    ...(await import('../src/ui/slash.js')).BUILTIN_SLASH_ITEMS,
    { name: 'commit', description: 'git commit' },
  ]);
  // 空查询候选超过可视上限，菜单滚动显示；用查询把内置命令与技能都收进窗口
  ctrl.openSlash('c');
  // 等菜单真正渲染出来：菜单会先用估算高度渲染、再用 useBoxMetrics 实测收敛一次，
  // 固定 wait(30) 在串行跑全套时可能读到收敛前的帧。
  const out = await waitForFrame(frame, '/clear', '菜单渲染');
  frame.cleanup();
});

test('回归：ctrl.pushOutput 的固定输出行必须真实渲染（曾被第二个 <Static> 吞掉）', async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  // ink 7 的 root.staticNode 是单指针：挂两个 <Static> 时后挂载的 MessageList 会覆盖
  // app 层的输出行 <Static>，且 live 区会跳过所有 static 节点 → pushOutput 内容凭空消失。
  // 修复后输出行与消息流共用同一个 <Static>，此处断言它确实渲染出来。
  ctrl.pushOutput('(mode → plan)');
  await waitForFrame(frame, '(mode → plan)', 'pushOutput 渲染');
  frame.cleanup();
});

test('回归：pushOutput 输出行与消息流按时序交织（不挤在最前/最后）', async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  ctrl.pushUser('第一条');
  ctrl.streamText('回复一');
  ctrl.finishStream();
  ctrl.pushOutput('(middle marker)');
  ctrl.pushUser('第二条');
  ctrl.streamText('回复二');
  ctrl.finishStream();
  await waitForFrame(frame, '回复二', '第二轮渲染');
  const out = stripAnsi(frame.lastFrame() ?? '');
  const iFirst = out.indexOf('第一条');
  const iMarker = out.indexOf('(middle marker)');
  const iSecond = out.indexOf('第二条');
  assert.ok(iFirst >= 0 && iMarker >= 0 && iSecond >= 0, '三者都渲染');
  assert.ok(iFirst < iMarker && iMarker < iSecond, '输出行落在它发生的那一刻（两条消息之间）');
  frame.cleanup();
});

test('回归：/技能 参数 回车必须提交，且参数随命令一起带上', async () => {
  const ctrl = new AppController();
  const submitted: (string | { text: string; images?: ClipboardImage[] })[] = [];
  const frame = renderApp(ctrl, (t) => submitted.push(t));
  ctrl.setSlashItems([...(await import('../src/ui/slash.js')).BUILTIN_SLASH_ITEMS]);
  await wait(30);

  // 无匹配候选：Enter 曾被 SlashMenu 静默吞掉（picked 为 undefined 就什么都不做），
  // 表现就是"回车后界面毫无变化"。现在应原样提交，交给 cli 决定怎么处理。
  await press(frame, '/red-line-check 分支a 分支b');
  await wait(30);
  await press(frame, '\r');
  await wait(50);
  assert.deepEqual(submitted, ['/red-line-check 分支a 分支b'], '无匹配候选也不吞键');

  // 有匹配候选：选中时参数不能丢（曾提交成 "/model"，参数整段消失）
  submitted.length = 0;
  await press(frame, '/model claude-opus-5-5');
  await wait(30);
  await press(frame, '\r');
  await wait(50);
  assert.deepEqual(submitted, ['/model claude-opus-5-5'], '选中候选时保留参数');

  frame.cleanup();
});

test('渲染：斜杠菜单超出可视上限时滚动跟随选中项', async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  ctrl.setSlashItems([
    ...(await import('../src/ui/slash.js')).BUILTIN_SLASH_ITEMS,
    { name: 'zzz-last', description: '最后一项' },
  ]);
  ctrl.openSlash('');
  const init = await waitForFrame(frame, '↑↓ 滚动', '滚动位置提示');
  assert.ok(!init.includes('zzz-last'), '初始窗口看不到最后一项');
  // 按 ↑（环绕到末尾）后最后一项滚入窗口
  await press(frame, '\x1b[A');
  const out = await waitForFrame(frame, 'zzz-last', '滚动后选中项可见');
  assert.ok(out.includes('zzz-last'), '滚动后选中项可见');
  frame.cleanup();
});

test('渲染：askText 文本输入提问渲染，交付后关闭', async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  const p = ctrl.askText('请输入分支名:');
  await wait(30);
  const open = frame.lastFrame() ?? '';
  assert.ok(open.includes('请输入分支名:'), '问题渲染');
  ctrl.resolveAskText('feature/x');
  assert.equal(await p, 'feature/x');
  assert.equal(ctrl.askTextState, null);
  frame.cleanup();
});

test('渲染：Ctrl+O 面板打开展示工具真实输出，关闭后消失', async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  ctrl.streamText('');
  ctrl.planTools([{ id: 't1', name: 'read_file', input: { file_path: 'x.ts' } }]);
  ctrl.toolStart('t1', 'read_file', { file_path: 'x.ts' });
  ctrl.toolEnd('t1', 'export const x = 1;\nline2\nline3\n');
  await wait(30);
  // 未打开面板时不显示输出
  assert.ok(!(frame.lastFrame() ?? '').includes('line2'));

  ctrl.toggleOutputPanel(true);
  await wait(30);
  const open = frame.lastFrame() ?? '';
  assert.ok(open.includes('工具输出'), '面板标题');
  assert.ok(open.includes('line2'), '真实输出渲染');
  assert.ok(open.includes('read_file'));

  ctrl.toggleOutputPanel(false);
  await wait(30);
  assert.ok(!(frame.lastFrame() ?? '').includes('line2'), '关闭后回主视图');
  frame.cleanup();
});

test('渲染：权限确认（ask）显示选项', async () => {
  const ctrl = new AppController();
  const frame = renderApp(ctrl);
  const p = ctrl.ask('Allow write_file?', [
    { label: 'No', value: 'no' },
    { label: 'Yes', value: 'yes' },
  ]);
  await wait(30);
  const out = frame.lastFrame() ?? '';
  assert.ok(out.includes('Allow write_file?'), '问题渲染');
  assert.ok(out.includes('Yes') && out.includes('No'), '选项渲染');
  ctrl.resolveAsk('no');
  assert.equal(await p, 'no');
  frame.cleanup();
});

test('回归：向导打开时 Esc 不触发 onInterrupt（提交后模型才能继续）', async () => {
  const ctrl = new AppController();
  let interrupted = 0;
  const frame = render(
    React.createElement(App, {
      ctrl,
      onSubmit: () => {},
      onInterrupt: () => interrupted++,
      onExit: () => {},
      onSetMode: () => {},
      initialOutput: undefined,
    }),
  );
  // 模拟执行中（execTool 设 busy）：向导打开期间 busy 非空
  ctrl.setBusy('running ask_user…');
  const p = ctrl.askWizard('选方案?', [
    { title: '方案', question: '用哪个?', options: [{ label: 'React', value: 'react' }] },
  ]);
  await wait(30);
  // 向导未处于输入态时按 Esc：由 Wizard 自行取消，不应再软中断 agent
  frame.stdin.write('\x1b');
  await wait(30);
  assert.equal(interrupted, 0, '向导打开时 Esc 不应触发 agent 软中断');
  assert.equal(await p, '__cancel__', 'Esc 由 Wizard 交付取消');
  assert.equal(ctrl.askWizardState, null);
  frame.cleanup();
});

test('回归：向导输入态按 Esc 返回选项不中断 agent，Ctrl+C 可取消向导', async () => {
  const ctrl = new AppController();
  let interrupted = 0;
  const frame = render(
    React.createElement(App, {
      ctrl,
      onSubmit: () => {},
      onInterrupt: () => interrupted++,
      onExit: () => {},
      onSetMode: () => {},
      initialOutput: undefined,
    }),
  );
  ctrl.setBusy('running ask_user…');
  const p = ctrl.askWizard('选方案?', [
    { title: '方案', question: '用哪个?', options: [{ label: 'React', value: 'react' }] },
  ]);
  // 等"选中项"出现再按键：向导的标题文本在 React 首次渲染时就有，但 useInput
  // 的监听器是在 effect 里挂的——只等标题会抢在监听器之前按键，那一击就丢了
  // （表现为"↓ 没生效，Enter 直接提交了默认项"）。
  await waitForFrame(frame, '❯ 1. React', '向导就绪');

  // ↓ 移到自定义项 → Enter 进入输入态，Esc"返回选项"
  await press(frame, '\x1b[B');
  await waitForFrame(frame, '❯ 2. ✎', '↓ 移到自定义项');
  await press(frame, '\r');
  await waitForFrame(frame, '输入你的答案', '进入输入态');

  await press(frame, '\x1b');
  assert.equal(interrupted, 0, '输入态按 Esc 返回选项不应触发软中断');
  assert.ok(ctrl.askWizardState, '向导保持打开');

  // Ctrl+C 取消向导（App 层拦截 → resolveAskWizard('__cancel__')）
  await press(frame, '\x03');
  assert.equal(ctrl.askWizardState, null, 'Ctrl+C 应取消向导');
  assert.equal(await p, '__cancel__');
  frame.cleanup();
});

// ── 底栏压缩回归 ────────────────────────────────────────────────
//
// 踩过的两个坑（都会让"第一项看不到"）：
//   1. 视口与底栏兄弟节点都用默认 flexShrink=1 → 总高超出时 Yoga 按比例让
//      **每个**子节点都缩，菜单被压掉顶部几行，且内部行叠在一起（渲染乱码）。
//   2. 菜单固定 MAX_VISIBLE=12 条，超出可用高度后仍按 12 条计算滚动窗口，
//      被裁掉的顶部与"选中第 1 项"矛盾 → 看到的是第 8 项。

test('回归：历史撑满视口后，斜杠菜单第一项仍可见且选中态正确', async () => {
  const ctrl = new AppController();
  ctrl.setSlashItems([...(await import('../src/ui/slash.js')).BUILTIN_SLASH_ITEMS]);
  // 撑满视口（模拟 /help 打出大量输出）
  for (let i = 0; i < 40; i++) ctrl.pushOutput(`帮助行 ${i}`);

  const frame = renderApp(ctrl);
  await wait(50);
  ctrl.openSlash('');
  await waitForFrame(frame, '/clear', '菜单渲染');

  const out = frameText(frame);
  assert.ok(out.includes('/clear'), '第一项 /clear 必须可见');
  assert.ok(/❯\s*\/clear/.test(out), '选中态落在第一项上');
  // 内容不能重叠：每行只有一个菜单项（曾出现两行内容叠在同一行）
  const menuLines = out.split('\n').filter((l) => l.includes('/') && l.includes('—'));
  assert.ok(menuLines.length >= 3, '至少渲染出几项');
  for (const line of menuLines) {
    const cmdCount = (line.match(/\/[a-z]+/g) ?? []).length;
    assert.ok(cmdCount <= 2, `单行不应混入多个命令（实际 ${cmdCount} 个）: ${line}`);
  }
  frame.cleanup();
});

test('回归：斜杠菜单可见条数随终端高度自适应（不硬编码 12）', async () => {
  const ctrl = new AppController();
  ctrl.setSlashItems([...(await import('../src/ui/slash.js')).BUILTIN_SLASH_ITEMS]);
  const frame = renderApp(ctrl);
  await wait(50);
  ctrl.openSlash('');
  await waitForFrame(frame, '滚动', '菜单滚动提示');

  // 可见项数应小于候选总数（在测试终端高度下装不下 15 项），
  // 且必须给出滚动位置提示，否则用户不知道还有更多
  const out = frameText(frame);
  assert.match(out, /… \d+\/15/, '有滚动位置提示');
  frame.cleanup();
});

// ── 命令执行后菜单必须收起 ──────────────────────────────────────
//
// /skills、/mcp 会打开交互面板。若斜杠菜单没跟着收起，面板上方会残留一条
// 候选（看起来像"输入没被消费"）。由 controller.openCapability 统一负责，
// 不依赖每个调用方记得调 closeSlash。
test('回归：打开能力面板时斜杠菜单自动收起，输入框清空', async () => {
  const ctrl = new AppController();
  ctrl.setSlashItems([...(await import('../src/ui/slash.js')).BUILTIN_SLASH_ITEMS]);
  const frame = renderApp(ctrl);
  await wait(60);
  ctrl.openSlash('skills');
  await waitForFrame(frame, '/skills', '菜单渲染');

  // 模拟 cli 执行 /skills：只调 openCapability
  ctrl.openCapability('skill', [{ name: 'commit', enabled: true, detail: 'git 提交' }]);
  await waitForFrame(frame, '🔧 技能', '面板打开');

  assert.equal(ctrl.slashOpen, false, '斜杠菜单已收起');
  const out = frameText(frame);
  assert.ok(!/❯\s*\/skills/.test(out), '不再残留斜杠候选');
  frame.cleanup();
});

test('回归：/mcp 面板同样不残留斜杠候选', async () => {
  const ctrl = new AppController();
  ctrl.setSlashItems([...(await import('../src/ui/slash.js')).BUILTIN_SLASH_ITEMS]);
  const frame = renderApp(ctrl);
  await wait(60);
  ctrl.openSlash('mcp');
  await waitForFrame(frame, '/mcp', '菜单渲染');

  ctrl.openCapability('mcp', [{ name: 'github', enabled: true, detail: '12 工具', connected: true }]);
  await waitForFrame(frame, 'MCP Server', '面板打开');

  assert.equal(ctrl.slashOpen, false);
  assert.ok(!/❯\s*\/mcp/.test(frameText(frame)), '不残留斜杠候选');
  frame.cleanup();
});

// ── Tab 补全路径的菜单收起 ──────────────────────────────────────
//
// 用 Tab 补全时输入框是 "/mcp "（带尾随空格，方便继续输参数）。此时按 Enter：
// InputBox 因 slashOpen=true 不提交，交给 SlashMenu.onPick。若 InputBox 的
// Enter 分支写成 `if (key.return && !slashOpen) {...}` 而不 return，就会继续
// 落到"插入普通字符"分支——`\r` 被插进 value 变成 "/mcp \r"，触发 handleChange
// → openSlash，把刚关掉的菜单又打开（面板下方残留一条候选）。
test('回归：Tab 补全（带尾随空格）+ Enter 后菜单收起，不留 /mcp\\r', async () => {
  const ctrl = new AppController();
  ctrl.setSlashItems([...(await import('../src/ui/slash.js')).BUILTIN_SLASH_ITEMS]);
  const submitted: string[] = [];
  const frame = renderApp(ctrl, (t) => {
    const s = typeof t === 'string' ? t.trim() : '';
    submitted.push(s);
    if (s === '/mcp') ctrl.openCapability('mcp', [{ name: 'github', enabled: true, detail: '12 工具' }]);
  });
  await wait(60);

  // 逐字输入 /mc → Tab 补全成 "/mcp "
  for (const ch of '/mc') {
    await press(frame, ch);
  }
  await waitForFrame(frame, '/mcp', '候选出现');
  await press(frame, '\t');
  await wait(120);

  await press(frame, '\r');
  await waitForFrame(frame, 'MCP Server', '面板打开');

  assert.deepEqual(submitted, ['/mcp'], '只提交一次，且不带 \\r 脏字符');
  assert.equal(ctrl.slashOpen, false, '斜杠菜单已收起');
  const out = frameText(frame);
  assert.ok(!/❯\s*\/mcp/.test(out), '不残留斜杠候选');
  frame.cleanup();
});

test('回归：输入框不接收控制字符（\\r / \\t / ESC 不落进草稿）', async () => {
  const ctrl = new AppController();
  ctrl.setSlashItems([...(await import('../src/ui/slash.js')).BUILTIN_SLASH_ITEMS]);
  const frame = renderApp(ctrl);
  await wait(60);

  await press(frame, 'abc');
  await waitForFrame(frame, 'abc', '文本输入');
  // 菜单关闭状态下按 Esc（不应插入任何字符）
  await press(frame, '\x1b');
  await wait(60);
  const out = frameText(frame);
  // 输入行仍应只有 abc
  const line = out.split('\n').find((l) => l.trimStart().startsWith('>'));
  assert.ok(line && line.includes('abc'), '文本保留');
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(line ?? ''), '没有控制字符混入');
  frame.cleanup();
});
