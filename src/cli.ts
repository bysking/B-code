import * as readline from "node:readline";
import { Agent } from "./agent.js";
import { clearSessionFile, loadSession, saveSession } from "./session.js";
import type { Mode } from "./permissions.js";

/**
 * CLI 外壳（施工图 L1 cli.ts）
 *
 *   pnpm dev "Read x"            one-shot：执行一条指令后保存退出（可含权限确认）
 *   pnpm dev                     REPL：交互式多轮，每轮自动保存
 *   pnpm dev --resume            REPL，先恢复上次会话
 *   pnpm dev --plan "..."        Plan 模式：写/编辑/shell 全部拦截（只读规划）
 *   pnpm dev --yolo "..."        bypass：跳过 confirm（危险命令 deny 仍拦得住）
 *
 * readline 延迟创建：one-shot 只有在权限确认真正发生时（askUser 第一次被调用）
 * 才挂到 stdin——否则脚本管道提前到达的 y/n 会被过早消费掉，confirm 就永远等不到答案。
 */

export interface CliArgs {
  resume: boolean;
  plan: boolean;
  yolo: boolean;
  instruction: string;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const resume = argv.includes("--resume");
  const plan = argv.includes("--plan");
  const yolo = argv.includes("--yolo");
  const rest = argv.filter((a) => !["--resume", "--plan", "--yolo"].includes(a));
  return { resume, plan, yolo, instruction: rest.join(" ").trim() };
}

function initialMode(plan: boolean, yolo: boolean): Mode {
  // plan 的只读契约优先于 yolo：deny 阶段目标是"能拦的都拦"
  return plan ? "plan" : yolo ? "bypass" : "default";
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { resume, plan, yolo, instruction } = parseCliArgs(argv);
  const replMode = !instruction;

  let rl: readline.Interface | null = null;
  let awaitingAnswer: ((ok: boolean) => void) | null = null;
  let busy = false;
  let closing = false;

  /** 待答优先：确认框只吃 y/n；返回 true 表示消费了该行 */
  const consumeAnswer = (raw: string): boolean => {
    if (!awaitingAnswer) return false;
    const resolve = awaitingAnswer;
    awaitingAnswer = null;
    resolve(/^y(es)?$/i.test(raw.trim()));
    return true;
  };

  const finish = () => process.exit(0);

  /** 读取当前 rl（getter 形式避免 TS 控制流把闭包赋值的 rl 收窄成 never） */
  const currentRl = () => rl;

  /** 延迟创建共享 readline（REPL 一上来就建；one-shot 等首次 confirm 才建） */
  const getRl = (): readline.Interface => {
    const existing = currentRl();
    if (existing) return existing;
    const created = readline.createInterface({ input: process.stdin, output: process.stdout });
    created.on("line", async (raw) => {
      if (consumeAnswer(raw)) return;
      // 仅 REPL 模式处理命令行输入；one-shot 里到达的 stray 输入直接忽略
      if (!replMode) return;

      const input = raw.trim();
      if (!input) {
        created.prompt();
        return;
      }
      if (input === "exit" || input === "quit") {
        created.close();
        return;
      }
      if (input === "/clear") {
        agent.clearHistory();
        await clearSessionFile();
        process.stdout.write("(history cleared)\n");
        created.prompt();
        return;
      }
      if (input === "/plan" || input === "/yolo" || input === "/default") {
        agent.setMode(input.slice(1) as Mode);
        process.stdout.write(`(mode → ${input.slice(1)})\n`);
        created.prompt();
        return;
      }
      // TODO(P4): 以 / 开头的输入先尝试解析技能（resolveSkill），未命中再走普通对话
      busy = true;
      try {
        await agent.chat(input);
        await saveSession(agent.history());
      } finally {
        busy = false;
        if (closing) finish();
        else created.prompt();
      }
    });
    created.on("close", () => {
      closing = true;
      process.stdout.write("\n");
      if (!busy) finish();
    });
    rl = created;
    return created;
  };

  const agent = new Agent({
    mode: initialMode(plan, yolo),
    askUser: (question) =>
      new Promise<boolean>((resolve) => {
        getRl(); // 首次确认时才挂 stdin
        process.stdout.write(`  ${question} `);
        awaitingAnswer = resolve;
      }),
  });

  if (resume) {
    const saved = await loadSession();
    if (saved && saved.length > 0) {
      agent.loadHistory(saved);
      process.stdout.write(`(resumed ${saved.length} messages)\n`);
    } else {
      process.stdout.write("(no session to resume)\n");
    }
  }

  // ── one-shot ────────────────────────────────────────────────
  if (instruction) {
    busy = true; // 中途 stdin 可能 EOF（管道押完 y 就断），close 只标记不退出
    try {
      await agent.chat(instruction);
    } finally {
      await saveSession(agent.history());
      busy = false;
    }
    process.stdout.write("\n(done)\n");
    if (closing) finish(); // chat 期间 EOF：现在补退出
    else currentRl()?.close();
    return;
  }

  // ── REPL ────────────────────────────────────────────────────
  getRl().prompt();
}