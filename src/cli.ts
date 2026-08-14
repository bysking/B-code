import * as readline from "node:readline";
import { Agent } from "./agent.js";
import { clearSessionFile, loadSession, saveSession } from "./session.js";
import { resolveSkill, discoverSkills } from "./skills.js";
import { saveMemory } from "./memory.js";
import { closeAllMcpConnections } from "./mcp.js";
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
  auto: boolean;
  /** --goal <条件>：pursueGoal 的达成条件 */
  goal: string;
  /** --loop <秒>：定时重投间隔（0 = 不启用） */
  loop: number;
  instruction: string;
}

const FLAG_ONLY = new Set(["--resume", "--plan", "--yolo", "--auto"]);

export function parseCliArgs(argv: string[]): CliArgs {
  let goal = "";
  let loop = 0;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (FLAG_ONLY.has(a)) {
      rest.push(a); // 留给下方 boolean 判断（也保留在原位，避免丢失语义）
    } else if (a === "--goal") {
      goal = argv[i + 1] ?? "";
      i++;
    } else if (a === "--loop") {
      const n = Number(argv[i + 1] ?? 0);
      loop = Number.isFinite(n) && n > 0 ? n : 0;
      i++;
    } else {
      rest.push(a);
    }
  }
  const instruction = rest
    .filter((a) => !FLAG_ONLY.has(a))
    .join(" ")
    .trim();
  return {
    resume: rest.includes("--resume"),
    plan: rest.includes("--plan"),
    yolo: rest.includes("--yolo"),
    auto: rest.includes("--auto"),
    goal,
    loop,
    instruction,
  };
}

function initialMode(args: Pick<CliArgs, "plan" | "yolo" | "auto">): Mode {
  // plan 的只读契约优先于一切；auto 用分类器代替确认框；bypass 跳过确认
  return args.plan ? "plan" : args.auto ? "auto" : args.yolo ? "bypass" : "default";
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { resume, plan, yolo, auto, goal, loop, instruction } = parseCliArgs(argv);
  const replMode = !instruction && !goal && !(loop > 0);

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
      if (input === "/skills") {
        const skills = discoverSkills()
          .filter((s) => s.userInvocable)
          .map((s) => `/${s.name}: ${s.description}`)
          .join("\n");
        process.stdout.write(skills ? `Available skills:\n${skills}\n` : "(no skills)\n");
        created.prompt();
        return;
      }
      if (input.startsWith("/remember ")) {
        const fact = input.slice("/remember ".length).trim();
        const name =
          fact.split(/\W+/).filter(Boolean).slice(0, 4).join("_").toLowerCase() || "fact";
        saveMemory(name, fact, "reference", fact);
        process.stdout.write(`(saved to memory: ${name})\n`);
        created.prompt();
        return;
      }
      // 技能调用优先："/commit 参数" → 技能正文（含替换后的 $ARGUMENTS）
      const skillPrompt = resolveSkill(input);
      if (skillPrompt) {
        busy = true;
        try {
          await agent.chat(skillPrompt);
          await saveSession(agent.history());
        } finally {
          busy = false;
          if (closing) finish();
          else created.prompt();
        }
        return;
      }
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

  // 非交互下 EOF 兜底：管道押完输入就断（或 stdin 为空），confirm 的答案可能永远等不来。
// 持久监听 stdin end：记录 stdinEnded（可能早于 confirm 发生）+ 顺手解决当场 pending 的回答。
// 交互终端（TTY）不监听——退出是用户主动 quit，不该被主动 deny（fail-closed 也不适用于 TTY）。
let eofDenyInstalled = false;
let stdinEnded = false;

const agent = new Agent({
    mode: initialMode({ plan, yolo, auto }),
    askUser: (question) =>
      new Promise<boolean>((resolve) => {
        process.stdout.write(`  ${question} `);
        if (!process.stdin.isTTY && !eofDenyInstalled) {
          eofDenyInstalled = true;
          process.stdin.on("end", () => {
            stdinEnded = true;
            if (awaitingAnswer) {
              const deny = awaitingAnswer;
              awaitingAnswer = null;
              deny(false);
            }
          });
        }
        // stdin 已 EOF → 没有还会来的答案，fail-closed 拒绝（覆盖"end 先于 confirm"的时序）
        if (stdinEnded) {
          process.stdout.write("(no input — denied)\n");
          resolve(false);
          return;
        }
        getRl(); // 首次确认时才挂 stdin
        awaitingAnswer = resolve;
      }),
  });

  // P5：启动时挂载 mcp.json 配置的服务器（失败仅记日志，不阻塞）
  await agent.initMcp();

  if (resume) {
    const saved = await loadSession();
    if (saved && saved.length > 0) {
      agent.loadHistory(saved);
      process.stdout.write(`(resumed ${saved.length} messages)\n`);
    } else {
      process.stdout.write("(no session to resume)\n");
    }
  }

  // ── goal 模式：无人值守追条件（评估器回灌直到达成）────────────
  if (goal) {
    busy = true;
    try {
      await agent.pursueGoal(goal, instruction || "Continue working toward the goal.");
    } finally {
      await saveSession(agent.history());
      busy = false;
    }
    closeAllMcpConnections();
    if (closing) finish();
    else currentRl()?.close();
    return;
  }

  // ── loop 模式：定时重投 ────────────────────────────────────
  if (loop > 0 && instruction) {
    process.stdout.write(`(loop every ${loop}s; Ctrl-C to stop)\n`);
    const stop = () => {
      process.stdout.write("\n(loop stopped)\n");
      closeAllMcpConnections();
      process.exit(130);
    };
    process.on("SIGINT", stop);
    busy = true;
    try {
      for (;;) {
        await agent.chat(instruction);
        await new Promise((r) => setTimeout(r, loop * 1000));
      }
    } finally {
      busy = false;
      closeAllMcpConnections();
      currentRl()?.close();
    }
  }

  // ── one-shot ────────────────────────────────────────────────
  if (instruction) {
    busy = true; // 中途 stdin 可能 EOF（管道押完 y 就断），close 只标记不退出
    const effective = resolveSkill(instruction) ?? instruction; // 支持 one-shot 技能调用
    try {
      await agent.chat(effective);
    } finally {
      await saveSession(agent.history());
      busy = false;
    }
    process.stdout.write("\n(done)\n");
    closeAllMcpConnections(); // MCP 子进程不杀则进程永不退出
    if (closing) finish(); // chat 期间 EOF：现在补退出
    else currentRl()?.close();
    return;
  }

  // ── REPL ────────────────────────────────────────────────────
  getRl().prompt();
}