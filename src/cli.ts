import * as readline from "node:readline";
import { Agent } from "./agent.js";
import { clearSessionFile, loadSession, saveSession } from "./session.js";
import { resolveSkill, discoverSkills } from "./skills.js";
import { saveMemory } from "./memory.js";
import { closeAllMcpConnections } from "./mcp.js";
import { AppController } from "./ui/controller.js";
import { mountTtyApp } from "./ui/render.js";
import { BUILTIN_SLASH_ITEMS } from "./ui/slash.js";
import { newSessionId } from "./session.js";
import type { SpinnerLike } from "./ui.js";
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
  /** --session <id>：恢复指定会话 */
  session: string;
  instruction: string;
}

const FLAG_ONLY = new Set(["--resume", "--plan", "--yolo", "--auto"]);

export function parseCliArgs(argv: string[]): CliArgs {
  let goal = "";
  let loop = 0;
  let session = "";
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
    } else if (a === "--session") {
      session = argv[i + 1] ?? "";
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
    session,
    instruction,
  };
}

function initialMode(args: Pick<CliArgs, "plan" | "yolo" | "auto">): Mode {
  // plan 的只读契约优先于一切；auto 用分类器代替确认框；bypass 跳过确认
  return args.plan ? "plan" : args.auto ? "auto" : args.yolo ? "bypass" : "default";
}

const CONFIRM_OPTIONS = [
  { label: "No", value: "no" },
  { label: "Yes", value: "yes" },
];

/** TTY 路径（ink）：处理交互/one-shot/goal/loop，全部渲染进组件树 */
async function runTtyCli(args: CliArgs, sessionId: string): Promise<void> {
  const ctrl = new AppController();

  const agent = new Agent({
    mode: initialMode(args),
    print: (t) => ctrl.streamText(t),
    askUser: async (question) => (await ctrl.ask(question, CONFIRM_OPTIONS)) === "yes",
    spinner: {
      start: (m) => ctrl.setBusy(m),
      update: () => {},
      stop: () => ctrl.setBusy(null),
    } satisfies SpinnerLike,
    events: (ev) => {
      switch (ev.type) {
        case "tool_start":
          ctrl.toolStart(ev.name, ev.input);
          break;
        case "tool_end":
          ctrl.toolEnd(ev.name);
          break;
        case "stream_end":
          ctrl.finishStream();
          break;
        case "thinking":
          ctrl.setBusy(ev.text);
          break;
      }
    },
  });

  await agent.initMcp();

  // 斜杠菜单候选：内置命令 + user-invocable 技能
  ctrl.setSlashItems([
    ...BUILTIN_SLASH_ITEMS,
    ...discoverSkills()
      .filter((s) => s.userInvocable)
      .map((s) => ({ name: s.name, description: s.description })),
  ]);

  const initialOutput: string[] = [];
  const saved = await (args.session ? loadSession(args.session) : args.resume ? loadSession() : null);
  if (saved && saved.length > 0) {
    agent.loadHistory(saved);
    initialOutput.push(`(resumed ${saved.length} messages)`);
  } else if (args.resume || args.session) {
    initialOutput.push("(no session to resume)");
  }
  if (args.plan) initialOutput.push("(plan mode: read-only)");
  if (args.auto) initialOutput.push("(auto mode: classifier gates write/shell)");
  if (args.goal) initialOutput.push(`(pursuing goal: ${args.goal})`);
  if (args.loop > 0 && args.instruction) initialOutput.push(`(loop every ${args.loop}s; Ctrl-C to stop)`);

  const oneShot = Boolean(args.instruction) && !args.goal && args.loop <= 0;

  let running = false;
  const quit = (code: number): void => {
    printResumeHint(sessionId);
    unmount?.();
    closeAllMcpConnections();
    process.exit(code);
  };
  let unmount: (() => void) | null = null;

  const { unmount: unmountApp } = mountTtyApp(
    ctrl,
    {
      onExit: () => quit(130),
      onInterrupt: () => agent.interrupt(), // Esc：软中断当前 chat
      onSubmit: (text) => void handle(text),
    },
    initialOutput,
  );
  unmount = unmountApp;

  async function handle(input: string) {
    if (running) return;
    running = true;
    try {
      const trimmed = input.trim();
      if (trimmed === "exit" || trimmed === "quit") {
        quit(0);
        return;
      }
      if (trimmed === "/clear") {
        agent.clearHistory();
        await clearSessionFile();
        ctrl.clearAll();
        ctrl.pushOutput("(history cleared)");
        return;
      }
      if (trimmed === "/plan" || trimmed === "/yolo" || trimmed === "/default") {
        agent.setMode(trimmed.slice(1) as Mode);
        ctrl.pushOutput(`(mode → ${trimmed.slice(1)})`);
        return;
      }
      if (trimmed === "/skills") {
        const skills = discoverSkills()
          .filter((s) => s.userInvocable)
          .map((s) => `/${s.name}: ${s.description}`)
          .join("\n");
        ctrl.pushOutput(skills ? `Available skills:\n${skills}` : "(no skills)");
        return;
      }
      if (trimmed.startsWith("/remember ")) {
        const fact = trimmed.slice("/remember ".length).trim();
        const name =
          fact.split(/\W+/).filter(Boolean).slice(0, 4).join("_").toLowerCase() || "fact";
        saveMemory(name, fact, "reference", fact);
        ctrl.pushOutput(`(saved to memory: ${name})`);
        return;
      }

      // 技能调用优先（含 $ARGUMENTS 替换），未命中走普通对话
      const effective = resolveSkill(trimmed) ?? trimmed;
      ctrl.pushUser(trimmed);

      if (args.goal) {
        await agent.pursueGoal(args.goal, effective || "Continue working toward the goal.");
        await saveSession(agent.history(), sessionId);
        quit(0);
        return;
      }
      await agent.chat(effective);
      await saveSession(agent.history(), sessionId);

      if (agent.interruptedByUser) {
        ctrl.pushOutput("(interrupted — 可以输入新指令或继续)");
      }

      if (args.loop > 0) {
        setTimeout(() => void handle(args.instruction ?? ""), args.loop * 1000);
      } else if (oneShot) {
        quit(0);
      }
    } finally {
      running = false;
    }
  }

  // 启动即执行模式（one-shot / goal / loop）；否则进入 REPL 等用户输入
  if (args.instruction || args.goal) {
    await handle(args.instruction || "Continue working toward the goal.");
  }
}

/** 恢复会话命令提示（带会话 id），供退出口调用 */
function printResumeHint(sessionId: string): void {
  process.stdout.write(`\n想恢复本次会话，执行:\n  pnpm dev --resume --session ${sessionId}\n`);
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { resume, plan, yolo, auto, goal, loop, session, instruction } = parseCliArgs(argv);
  const replMode = !instruction && !goal && !(loop > 0);
  const sessionId = newSessionId(); // 本次会话 id（退出时打印恢复命令用）

  // TTY 交互路径：ink 声明式渲染（思考/工具块/markdown/选择/斜杠菜单）。
  // 非 TTY（管道/CI/脚本）走下方 readline 分支，语义保持不变。
  if (process.stdout.isTTY && process.stdin.isTTY) {
    await runTtyCli({ resume, plan, yolo, auto, goal, loop, session, instruction }, sessionId);
    return;
  }

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

  const finish = () => {
    printResumeHint(sessionId);
    process.exit(0);
  };

  /** 读取当前 rl（getter 形式避免 TS 控制流把闭包赋值的 rl 收窄成 never） */
  const currentRl = () => rl;

  /**
   * chat 结束后的提示符刷新：先补换行再 prompt。
   * 模型回复不保证以 \n 结尾，若 `> ` 贴着回复尾，readline 下一个输入触发的
   * 行重绘（clearLine）会把同行内容整行擦掉——表现为"回复刚出来就消失一块"。
   */
  const nextPrompt = (rl: readline.Interface) => {
    process.stdout.write("\n");
    rl.prompt();
  };

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
          await saveSession(agent.history(), sessionId);
        } finally {
          busy = false;
          if (closing) finish();
          else nextPrompt(created);
        }
        return;
      }
      busy = true;
      try {
        await agent.chat(input);
        await saveSession(agent.history(), sessionId);
      } finally {
        busy = false;
        if (closing) finish();
        else nextPrompt(created);
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

  const saved = await (session ? loadSession(session) : resume ? loadSession() : null);
  if (saved && saved.length > 0) {
    agent.loadHistory(saved);
    process.stdout.write(`(resumed ${saved.length} messages)\n`);
  } else if (resume || session) {
    process.stdout.write("(no session to resume)\n");
  }

  // ── goal 模式：无人值守追条件（评估器回灌直到达成）────────────
  if (goal) {
    busy = true;
    try {
      await agent.pursueGoal(goal, instruction || "Continue working toward the goal.");
    } finally {
      await saveSession(agent.history(), sessionId);
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
      await saveSession(agent.history(), sessionId);
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