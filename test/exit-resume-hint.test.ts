import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 退出时 resume 提示必须打在**用户真实终端**上。
 *
 * OpenTUI 用备用屏（alternate screen）全屏渲染。在备用屏里打印的内容会随退出
 * 一起被丢弃——用户回到 shell 后什么都看不到，于是"session id 打不出来，
 * 没法 --resume"。
 *
 * 正确顺序：先 unmount（内部 await renderer.closed，等备用屏切回主屏），
 * 再 printResumeHint。用静态检查守住这个顺序——它很容易在重构时被改回去，
 * 而改回去后只有真实终端才看得出问题（测试里两个顺序都能过）。
 */
test('回归：quit 必须先 unmount 再打印 resume 提示', () => {
  const cli = readFileSync(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'utf-8');
  const iQuit = cli.indexOf('const quit = async');
  assert.ok(iQuit > 0, '找不到 quit 定义');

  // 取 quit 函数体（到下一个顶层声明前）
  const body = cli.slice(iQuit, iQuit + 1200);
  const iUnmount = body.indexOf('await unmount?.()');
  const iHint = body.indexOf('printResumeHint(sessionId)');

  assert.ok(iUnmount > 0, 'quit 里应 await unmount');
  assert.ok(iHint > 0, 'quit 里应调用 printResumeHint');
  assert.ok(
    iUnmount < iHint,
    `顺序错误：unmount 必须在 printResumeHint 之前（否则提示留在备用屏上，用户看不到）`,
  );
});
