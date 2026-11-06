import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 给"要经过 shell 执行"的测试命令一个**跨平台**写法：把 JS 落成临时脚本文件，
 * 再返回 `"<execPath>" "<file>"`。
 *
 * 两个调用场景：
 *   1. hook 命令（`src/hooks.ts` 用 `spawn(cmd, { shell: true })`）
 *   2. run_shell 工具的命令（`src/tools.ts` 同样 `spawn(cmd, { shell: true })`）
 *
 * ## 为什么不写 `node -e '...'`
 *
 * Windows 上 `shell: true` 走的是 **cmd.exe，而它不把单引号当引号**——引号被原样
 * 传给 node。同一个命令在 macOS/Linux 正常、在 Windows 上分两种翻车方式：
 *
 *   - `'process.exit(3)'` 恰好是**合法 JS**（一个字符串字面量表达式）
 *     → 静默什么都不做、exit 0。最阴的是：只断言 `blocked === false` 的用例
 *       照样通过——它在测"未拦截"，而 0 和 3 都 fail-open，于是变成**假绿**。
 *   - `'let s="";…'` 是语法错误 → exit 1（Unterminated string constant）。
 *
 * ## 为什么不做"按平台换引号"
 *
 * cmd 里双引号内部的 `"` 会被吃掉、`\"` 也不是转义（转义符是 `^`），
 * 而且 `%VAR%` 仍会展开——拼引号这条路怎么修都脆。
 * 绕开 shell 引号语义才是稳的：命令里只出现路径。
 *
 * 注意命令本身仍要经过 shell 跑，所以**路径加双引号**（Windows 的临时目录
 * 可能带空格）；引号内只有路径，不涉及上面的转义坑。
 *
 * ## 顺带一条：别依赖 Unix 专属二进制
 *
 * 曾经用 `sleep 30` 造"长命令"，但 `sleep.exe` 来自 **Git for Windows 的
 * `usr\bin`**，只有从 Git Bash 启动的进程 PATH 里才有；用 PowerShell / cmd /
 * VS Code 终端跑 `bun test` 就找不到 → 子进程瞬间退出（"'sleep' is not
 * recognized…"）→ 中断类用例拿不到 `interrupted` 标记而失败。
 * 要"跑得久"就用脚本文件跑 `setTimeout`，全平台一致。
 */
let seq = 0;

/** 在 dir 下写一个临时脚本，返回可直接当命令用的命令行（hook command / run_shell 命令） */
export async function writeScriptCommand(dir: string, body: string): Promise<string> {
  const file = join(dir, `script-${++seq}.mjs`);
  await writeFile(file, body);
  return `"${process.execPath}" "${file}"`;
}

/** 跨平台"长时间运行的命令"（替代 `sleep N`，见上面那条说明） */
export function writeSleepCommand(dir: string, ms = 30_000): Promise<string> {
  return writeScriptCommand(dir, `setTimeout(() => {}, ${ms});`);
}
