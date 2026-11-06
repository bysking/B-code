import { test } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { createTestRenderer, KeyCodes } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { PromptInput, inputRows } from '../src/ui/views/input.js';
import { renderOtui } from './helpers/otui-test.js';
import { App } from '../src/ui/app.js';
import { AppController } from '../src/ui/controller.js';

/**
 * 主输入框（多行草稿）测试。
 *
 * ## 为什么要两种渲染器
 *
 * Shift+Enter 能不能区分出来，取决于终端有没有实现 Kitty 键盘协议：
 *   - `kittyKeyboard: true`  → 终端把修饰键显式编码进序列，Shift+Enter 可辨
 *   - 默认（legacy）         → Shift+Enter 与 Enter 发的是同一个 `\r`，**不可辨**
 *
 * 这正是真实的终端差异（Kitty/WezTerm/Ghostty 支持；传统终端不支持），
 * 所以两条路径都要锁：可辨时 Shift+Enter 换行，不可辨时靠 Ctrl+J 兜底
 * （LF，所有终端都发得出来）。
 */

type Recorder = {
  submits: string[];
  changes: string[];
  setValue: (v: string) => void;
};

/** 模拟 app.tsx 的受控用法：提交后清空草稿（app 的 handleSubmit 就是这么做的） */
function Harness({ rec }: { rec: Recorder }) {
  const [value, setValue] = React.useState('');
  rec.setValue = setValue;
  return React.createElement(
    'box',
    { flexDirection: 'column', width: '100%', height: '100%' },
    React.createElement('box', { key: 'spacer', flexGrow: 1 }),
    React.createElement(PromptInput, {
      key: 'input',
      value,
      onChange: (v: string) => {
        rec.changes.push(v);
        setValue(v);
      },
      onSubmit: (v: string) => {
        rec.submits.push(v);
        setValue('');
      },
    }),
  );
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount(opts: { kitty?: boolean; width?: number; height?: number } = {}) {
  const setup = await createTestRenderer({
    width: opts.width ?? 60,
    height: opts.height ?? 20,
    kittyKeyboard: opts.kitty ?? false,
  });
  const root = createRoot(setup.renderer as never);
  const rec: Recorder = { submits: [], changes: [], setValue: () => {} };
  root.render(React.createElement(Harness, { rec }));
  await setup.renderOnce();
  await wait(60);
  await setup.renderOnce();

  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  return {
    setup,
    rec,
    /** 当前画面（纯文本） */
    frame: () => stripAnsi(setup.captureCharFrame()),
    /** 画面非空行（去掉纯空白行，便于断言输入区内容） */
    lines: () =>
      stripAnsi(setup.captureCharFrame())
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l.trim() !== ''),
    /**
     * 按键。每个键之后让渲染落地：连续 emit 会被 React 批处理合并，
     * 受控输入框只能看到最后一个字符（表现为"输入 abc 只剩 c"）。
     */
    press: async (key: string, mods?: Record<string, boolean>) => {
      setup.mockInput.pressKey(key, mods);
      await setup.renderOnce();
      await wait(25);
      await setup.renderOnce();
    },
    type: async (text: string) => {
      for (const ch of text) {
        setup.mockInput.pressKey(ch);
        await setup.renderOnce();
      }
      await wait(25);
      await setup.renderOnce();
    },
    flush: async () => {
      await setup.renderOnce();
      await wait(40);
      await setup.renderOnce();
    },
    cleanup: async () => {
      try {
        root.unmount();
      } catch {
        // 已卸载
      }
      await setup.dispose();
    },
  };
}

// ── 纯函数：草稿 → 行数 ────────────────────────────────────────

test('inputRows：空草稿占 1 行', () => {
  assert.equal(inputRows('', 80), 1);
});

test('inputRows：逻辑行数 = \\n 数 + 1', () => {
  assert.equal(inputRows('a', 80), 1);
  assert.equal(inputRows('a\nb', 80), 2);
  assert.equal(inputRows('a\n\nb', 80), 3, '空行也占一行');
});

test('inputRows：超过 MAX_ROWS(8) 封顶，交给编辑器内部滚动', () => {
  assert.equal(inputRows('1\n2\n3\n4\n5\n6\n7\n8', 80), 8);
  assert.equal(inputRows('1\n2\n3\n4\n5\n6\n7\n8\n9\n10', 80), 8);
});

test('inputRows：软换行算进高度（超宽单行不能只给 1 行）', () => {
  // cols=12 → 可用宽度 10（扣掉 "> "），30 个字符 → 3 行
  assert.equal(inputRows('x'.repeat(30), 12), 3);
});

test('inputRows：中文按双宽计算', () => {
  // 可用宽度 10 → 每个汉字占 2 列 → 8 个汉字 = 16 列 = 2 行
  assert.equal(inputRows('中'.repeat(8), 12), 2);
});

// ── 提交键（Enter）─────────────────────────────────────────────

test('Enter 提交：内容原样交给 onSubmit，且草稿清空', async () => {
  const f = await mount();
  await f.type('hello world');
  assert.ok(f.frame().includes('hello world'), '输入回显');

  await f.press(KeyCodes.RETURN);
  assert.deepEqual(f.rec.submits, ['hello world'], 'Enter 必须提交');
  assert.ok(!f.frame().includes('hello world'), '提交后草稿清空');
  await f.cleanup();
});

test('Enter 提交：小键盘回车（kpenter）同效', async () => {
  // 只有 Kitty 协议会把小键盘回车单独编码（codepoint 57414）；传统终端发的是 `\r`，
  // 走的就是上面的 return 分支。这里直接发原生序列，覆盖 kpenter 那条绑定。
  const f = await mount({ kitty: true });
  await f.type('via kpenter');
  await f.press('\x1B[57414u');
  assert.deepEqual(f.rec.submits, ['via kpenter']);
  await f.cleanup();
});

// ── 换行键 ────────────────────────────────────────────────────

test('Kitty 终端：Shift+Enter 换行，不提交', async () => {
  const f = await mount({ kitty: true });
  await f.type('first');
  await f.press(KeyCodes.RETURN, { shift: true });
  await f.type('second');

  assert.deepEqual(f.rec.submits, [], 'Shift+Enter 不应提交');
  const lines = f.lines();
  assert.ok(
    lines.some((l) => l.includes('first')) && lines.some((l) => l.includes('second')),
    `两行都应可见：${JSON.stringify(lines)}`,
  );
  await f.cleanup();
});

test('Kitty 终端：Alt+Enter 换行，不提交', async () => {
  const f = await mount({ kitty: true });
  await f.type('first');
  await f.press(KeyCodes.RETURN, { meta: true });
  await f.type('second');

  assert.deepEqual(f.rec.submits, [], 'Alt+Enter 不应提交');
  const lines = f.lines();
  assert.ok(
    lines.some((l) => l.includes('first')) && lines.some((l) => l.includes('second')),
    `两行都应可见：${JSON.stringify(lines)}`,
  );
  await f.cleanup();
});

test('传统终端：Shift+Enter 与 Enter 不可辨（退化为提交）——Ctrl+J 才是可靠换行', async () => {
  const f = await mount({ kitty: false });
  await f.type('legacy');
  await f.press(KeyCodes.RETURN, { shift: true });

  // 记录终端的真实局限：没有 Kitty 协议时 Shift 位传不过来，这就是库默认
  // 把"提交"放在 meta+Enter 上的原因，也是我们必须提供 Ctrl+J 退路的原因
  assert.deepEqual(f.rec.submits, ['legacy'], 'legacy 终端下 Shift+Enter 等同 Enter');
  await f.cleanup();
});

test('传统终端：Ctrl+J（linefeed）换行，不提交', async () => {
  const f = await mount({ kitty: false });
  await f.type('aa');
  await f.press(KeyCodes.LINEFEED);
  await f.type('bb');

  assert.deepEqual(f.rec.submits, [], 'Ctrl+J 只换行');
  const lines = f.lines();
  assert.ok(
    lines.some((l) => l.includes('aa')) && lines.some((l) => l.includes('bb')),
    `两行都应可见：${JSON.stringify(lines)}`,
  );
  await f.cleanup();
});

// ── 多行草稿整体提交 ──────────────────────────────────────────

test('多行草稿：提交内容含完整 \\n，不被压平', async () => {
  const f = await mount({ kitty: true });
  await f.type('line1');
  await f.press(KeyCodes.RETURN, { shift: true });
  await f.type('line2');
  await f.press(KeyCodes.RETURN, { shift: true });
  await f.type('line3');
  await f.press(KeyCodes.RETURN);

  assert.deepEqual(f.rec.submits, ['line1\nline2\nline3']);
  await f.cleanup();
});

// ── 外部改值（Tab 补全 / 历史导航 / 清空）─────────────────────

test('外部改值：setValue 后草稿同步（历史导航/Tab 补全路径）', async () => {
  const f = await mount();
  await f.type('draft');
  f.rec.setValue('/mcp ');
  await f.flush();

  const out = f.frame();
  assert.ok(out.includes('/mcp'), '外部值写入输入框');
  assert.ok(!out.includes('draft'), '旧草稿被替换而不是追加');
  await f.cleanup();
});

test('外部清空：提交后不残留、也不重复计数', async () => {
  const f = await mount();
  await f.type('once');
  await f.press(KeyCodes.RETURN);
  await f.flush();
  // 提交后连续回车：草稿已空，不应再产生提交
  await f.press(KeyCodes.RETURN);
  await f.press(KeyCodes.RETURN);

  assert.deepEqual(f.rec.submits, ['once'], '空草稿不提交，且没有"两次提交拼一起"');
  await f.cleanup();
});

// ── 高度自适应 ────────────────────────────────────────────────

test('高度：多行草稿逐行撑高，最多 8 行后内部滚动', async () => {
  const f = await mount({ width: 40, height: 24, kitty: true });
  for (let i = 1; i <= 10; i++) {
    if (i > 1) await f.press(KeyCodes.RETURN, { shift: true });
    await f.type(`L${i}`);
  }
  await f.flush();

  const lines = f.lines();
  // 封顶后草稿尾部仍可见（编辑器内部滚动跟着光标走）
  assert.ok(
    lines.some((l) => l.includes('L10')),
    `最后一行必须可见：${JSON.stringify(lines)}`,
  );
  assert.ok(
    !lines.some((l) => l.includes('L1') && !l.includes('L10')),
    `超出 8 行的早期内容应滚出可视区：${JSON.stringify(lines)}`,
  );
  await f.cleanup();
});

// ── 与 App 的集成（真实 onSubmit / 粘贴 / 历史导航路径）────────

/** 挂载真实 App（kind 传 kitty 才能用 Shift+Enter 造多行草稿） */
async function mountApp(opts: { kitty?: boolean } = {}) {
  const ctrl = new AppController();
  const submits: string[] = [];
  const frame = await renderOtui(
    React.createElement(App, {
      ctrl,
      onSubmit: (t) => {
        if (typeof t === 'string') submits.push(t);
      },
      onInterrupt: () => {},
      onExit: () => {},
      onSetMode: () => {},
    }),
    { width: 70, height: 24, kitty: opts.kitty ?? true },
  );
  const press = async (keys: string, mods?: Record<string, boolean>) => {
    if (mods) {
      (frame.raw.mockInput as { pressKey: (k: string, m?: Record<string, boolean>) => void }).pressKey(
        keys,
        mods,
      );
    } else {
      await frame.press(keys);
    }
    await frame.flush();
  };
  return { ctrl, submits, frame, press };
}

test('集成：Enter 提交多行草稿，onSubmit 拿到完整 \\n', async () => {
  const { submits, frame, press } = await mountApp();
  await press('第一行');
  await press(KeyCodes.RETURN, { shift: true });
  await press('第二行');
  await press(KeyCodes.RETURN);
  await frame.flush();

  assert.deepEqual(submits, ['第一行\n第二行'], '多行草稿整体提交，不被压平');
  await frame.cleanup();
});

test('集成：粘贴多行文本只插入一次（原生粘贴 + usePaste 不重复）', async () => {
  const { frame } = await mountApp();
  await frame.raw.mockInput.pasteBracketedText('AAA\nBBB');
  await frame.flush();
  await frame.flush();

  const out = frame.frame();
  // 两条路径都会收到 paste：textarea 原生 insertText + App 的 usePaste 追加。
  // 实测收敛成一份（App 的监听先跑，原生插入随后落地，末值一致），这里锁住它。
  assert.equal(out.split('AAA').length - 1, 1, `AAA 只应出现一次：\n${out.slice(-300)}`);
  assert.equal(out.split('BBB').length - 1, 1, `BBB 只应出现一次：\n${out.slice(-300)}`);
  await frame.cleanup();
});

/**
 * 输入框区域当前渲染的文本行。
 *
 * 只有草稿首行带 "> " 前缀，续行是缩进对齐的普通行——所以不能按前缀过滤，
 * 要从首行取到底部模式栏之前（模式栏是输入区结束的标志）。
 */
function inputLines(frame: { frame: () => string }): string[] {
  const all = frame
    .frame()
    .split('\n')
    .map((l) => l.trimEnd());
  const start = all.findIndex((l) => l.trimStart().startsWith('>'));
  if (start === -1) return [];
  const end = all.findIndex((l, i) => i > start && l.includes('当前权限审批模式'));
  return all.slice(start, end === -1 ? undefined : end);
}

test('集成：草稿为空时 ↑ 回填输入历史', async () => {
  const { frame, press } = await mountApp();
  await press('上一条指令');
  await press(KeyCodes.RETURN);
  await frame.flush();

  await press(KeyCodes.ARROW_UP);
  await frame.flush();

  assert.ok(
    inputLines(frame).some((l) => l.includes('上一条指令')),
    `↑ 应把历史回填进输入框：${JSON.stringify(inputLines(frame))}`,
  );
  await frame.cleanup();
});

test('集成：多行草稿时 ↑ 不翻历史（↑ 归编辑器移光标）', async () => {
  const { frame, press } = await mountApp();
  // 先建立历史
  await press('历史条目');
  await press(KeyCodes.RETURN);
  await frame.flush();

  // 敲两行草稿
  await press('ZZZONE');
  await press(KeyCodes.RETURN, { shift: true });
  await press('ZZZTWO');
  await frame.flush();

  await press(KeyCodes.ARROW_UP);
  await frame.flush();

  const lines = inputLines(frame);
  assert.ok(
    lines.some((l) => l.includes('ZZZONE')) && lines.some((l) => l.includes('ZZZTWO')),
    `草稿必须原样保留：${JSON.stringify(lines)}`,
  );
  assert.ok(
    !lines.some((l) => l.includes('历史条目')),
    `有草稿时 ↑ 不得被历史覆盖：${JSON.stringify(lines)}`,
  );
  await frame.cleanup();
});

test('高度：超宽单行不丢内容（软换行占的行数被算进高度）', async () => {
  const f = await mount({ width: 40, height: 24 });
  // 40 列 → 可用 38 列；这一条 ~120 字符 → 约 4 个视觉行
  await f.type('w'.repeat(120));
  await f.flush();

  const lines = f.lines();
  const joined = lines.join('');
  assert.ok(joined.replace(/\s/g, '').length >= 120, `120 个字符应全部可见：${JSON.stringify(lines)}`);
  await f.cleanup();
});
