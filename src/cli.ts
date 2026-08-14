import * as readline from "node:readline";
import { Agent } from "./agent.js";
import { clearSessionFile, loadSession, saveSession } from "./session.js";

/**
 * CLI 外壳（施工图 L1 cli.ts）
 *
 * 三种形态：
 *   pnpm dev "Read x"        one-shot：执行一条指令后保存退出
 *   pnpm dev                  REPL：交互式多轮，每轮自动保存
 *   pnpm dev --resume         REPL，先恢复上次会话（显示 (resumed N messages)）
 */

export interface CliArgs {
  resume: boolean;
  instruction: string;
}

/** 纯函数参数解析（导出供测试）；未来 --plan/--yolo/--goal 等在此追加 */
export function parseCliArgs(argv: string[]): CliArgs {
  const resume = argv.includes("--resume");
  const rest = argv.filter((a) => a !== "--resume");
  return { resume, instruction: rest.join(" ").trim() };
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { resume, instruction } = parseCliArgs(argv);
  // 模型文本经 Agent 默认 print 直写：后端 SSE 来多少块就实时打多少（不做人为节流）
  const agent = new Agent();

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
    await agent.chat(instruction);
    await saveSession(agent.history());
    process.stdout.write("\n(done)\n");
    return;
  }

  // ── REPL ────────────────────────────────────────────────────
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // bug 根源：管道（或脚本）喂入 stdin 时，readline 会在输入流结束后立刻发 close；
  // 若此时直接 process.exit，会掐死仍在飞行的模型调用（流式输出永远不打印）。
  // 修正：close 只标记"要退出"，等当前 chat 落袋（busy=false）再退出。
  let busy = false;
  let closing = false;
  const finish = () => process.exit(0);

  rl.on("line", async (raw) => {
    const input = raw.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    if (input === "exit" || input === "quit") {
      rl.close();
      return;
    }
    if (input === "/clear") {
      agent.clearHistory();
      await clearSessionFile();
      process.stdout.write("(history cleared)\n");
      rl.prompt();
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
      else rl.prompt();
    }
  });

  rl.on("close", () => {
    closing = true;
    process.stdout.write("\n");
    if (!busy) finish();
  });

  rl.prompt();
}