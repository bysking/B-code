import * as readline from 'node:readline';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { Agent } from './agent.js';
import type { Registry } from './registry.js';
import { clearSessionFile, loadSession, saveSession } from './session.js';
import { resolveSkill, discoverSkills } from './skills.js';
import { saveMemory } from './memory.js';
import { closeAllMcpConnections } from './mcp.js';
import { formatMcpList, resolveMcpConfigs } from './mcp-config.js';
import { AppController } from './ui/controller.js';
import type { WizardStep } from './ui/controller.js';
import { createSettingsAllowlistStore, loadSettings } from './config.js';
import { formatCost } from './cost.js';
import { renderTodos } from './todo.js';
import { loadHooks } from './hooks.js';
import { mountTtyApp } from './ui/render.js';
import { BUILTIN_SLASH_ITEMS } from './ui/slash.js';
import { newSessionId, recentTurns, renderRecentTurns } from './session.js';
import type { SpinnerLike } from './ui.js';
import type { Mode } from './permissions.js';
import { readClipboardImage, type ClipboardImage } from './utils/clipboard.js';
import { checkForUpdate } from './version-check.js';

/**
 * 聊天输入封装：自动检测剪贴板图片，如果存在则与文本一起发送给模型。
 * 纯文本（无图片）时行为与直接调用 agent.chat(text) 一致。
 */
async function chatWithClipboard(agent: Agent, text: string): Promise<void> {
  const clipboardImage = readClipboardImage();
  if (clipboardImage) {
    await agent.chat({ text, images: [clipboardImage] });
  } else {
    await agent.chat(text);
  }
}

/**
 * CLI 外壳（施工图 L1 cli.ts）
 *
 * 全局安装后 bcode 即当前工具（开发态等价于 pnpm dev）：
 *   bcode "Read x"               one-shot：执行一条指令后保存退出（可含权限确认）
 *   bcode                        REPL：交互式多轮，每轮自动保存
 *   bcode --resume               REPL，先恢复上次会话（--session <id> 恢复指定会话）
 *   bcode --plan "..."           Plan 模式：写/编辑/shell 全部拦截（只读规划）
 *   bcode --yolo "..."           bypass：跳过 confirm（危险命令 deny 仍拦得住）
 *   bcode --goal <条件> "p"      Auto 追目标；--auto/--loop <秒> 自治
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
  /** --output-format text|json（json = 结构化结果，供 CI/脚本消费；强制 headless） */
  outputFormat: 'text' | 'json';
  instruction: string;
}

const FLAG_ONLY = new Set(['--resume', '--plan', '--yolo', '--auto']);

export function parseCliArgs(argv: string[]): CliArgs {
  let goal = '';
  let loop = 0;
  let session = '';
  let outputFormat: 'text' | 'json' = 'text';
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (FLAG_ONLY.has(a)) {
      rest.push(a); // 留给下方 boolean 判断（也保留在原位，避免丢失语义）
    } else if (a === '--goal') {
      goal = argv[i + 1] ?? '';
      i++;
    } else if (a === '--loop') {
      const n = Number(argv[i + 1] ?? 0);
      loop = Number.isFinite(n) && n > 0 ? n : 0;
      i++;
    } else if (a === '--session') {
      session = argv[i + 1] ?? '';
      i++;
    } else if (a === '--output-format') {
      outputFormat = argv[i + 1] === 'json' ? 'json' : 'text';
      i++;
    } else {
      rest.push(a);
    }
  }
  const instruction = rest
    .filter((a) => !FLAG_ONLY.has(a))
    .join(' ')
    .trim();
  return {
    resume: rest.includes('--resume'),
    plan: rest.includes('--plan'),
    yolo: rest.includes('--yolo'),
    auto: rest.includes('--auto'),
    goal,
    loop,
    session,
    outputFormat,
    instruction,
  };
}

function initialMode(args: Pick<CliArgs, 'plan' | 'yolo' | 'auto'>): Mode {
  // plan 的只读契约优先于一切；auto 用分类器代替确认框；bypass 跳过确认
  return args.plan ? 'plan' : args.auto ? 'auto' : args.yolo ? 'bypass' : 'default';
}

const CONFIRM_OPTIONS = [
  { label: 'Yes', value: 'yes' },
  { label: '本轮会话自动审批通过', value: 'allow_all' },
  { label: 'No', value: 'no' },
];

/** /help 文本：命令 + 快捷键（TTY / 非 TTY 共用） */
const HELP_TEXT = [
  '命令:',
  '  /clear           清空对话历史',
  '  /help            显示本帮助',
  '  /cost            本次会话 token 用量与估算成本',
  '  /model [名]      查看/切换模型',
  '  /compact         立即压缩上下文',
  '  /rewind          回退本次会话的文件改动',
  '  /todos           查看任务清单',
  '  /plan /auto /yolo /default   切换权限模式',
  '  /skills /mcp     列出技能 / MCP server',
  '  /remember <事实> 保存长期记忆',
  '  exit | quit      退出',
  '快捷键:',
  '  Esc              硬中断当前对话（取消在飞请求/终止 shell）',
  '  Ctrl+O           工具输出面板',
  '  Shift+Tab        循环切换模式',
  '  ↑ / ↓            输入历史导航',
  '  Ctrl+V           粘贴图片/文本',
].join('\n');

/** choice → 单步向导（模型驱动选择统一为 Wizard 的适配） */
export function choiceAsWizard(
  question: string,
  options: Array<{ label: string; value: string }>,
): WizardStep[] {
  return [
    {
      title: '选择',
      question,
      options: options.map((o) => ({ label: o.label, value: o.value })),
    },
  ];
}

/** tabs/grouped → 多步向导（每组一步） */
export function groupsAsWizard(
  question: string,
  groups: Array<{
    title: string;
    options: Array<{ label: string; value: string }>;
  }>,
): WizardStep[] {
  return groups.map((g) => ({
    title: g.title,
    question,
    options: g.options.map((o) => ({ label: o.label, value: o.value })),
  }));
}

/** /mcp：某 MCP server 在 registry 中已挂载的工具数（0 = 启动时连接失败，fail-open） */
function countMcpTools(registry: Registry, serverName: string): number | null {
  const n = registry.list().filter((mp) => mp.name.startsWith(`mcp__${serverName}__`)).length;
  return n > 0 ? n : null;
}

/** TTY 路径（ink）：处理交互/one-shot/goal/loop，全部渲染进组件树 */
async function runTtyCli(args: CliArgs, sessionId: string): Promise<void> {
  const ctrl = new AppController();
  ctrl.mode = initialMode(args);
  // 审批"本轮会话自动审批通过"：选中后后续确认直接放行（/clear 重置）
  let autoApprove = false;

  const agent = new Agent({
    mode: initialMode(args),
    allowlistStore: createSettingsAllowlistStore(), // "记住不再问"跨会话生效（写 settings.json）
    hooks: loadHooks(loadSettings()), // 生命周期钩子（settings.json hooks）
    onTodos: (todos) => ctrl.setTodos(todos), // 模型自管待办 → 底部清单视图
    print: (t) => ctrl.streamText(t),
    askUser: async (question) => {
      if (autoApprove) return true;
      const choice = await ctrl.ask(question, CONFIRM_OPTIONS);
      if (choice === 'allow_all') autoApprove = true;
      return choice === 'yes' || choice === 'allow_all';
    },
    // 模型主动询问（ask_user 工具）：选择统一转 Wizard（模型驱动选择的唯一形态）、文本走 AskInput
    askChoice: (question, options) => ctrl.askWizard(question, choiceAsWizard(question, options)),
    askTextInput: (question) => ctrl.askText(question),
    askGroupedInput: (question, groups) => ctrl.askWizard(question, groupsAsWizard(question, groups)),
    askWizardInput: (question, steps, multi) => ctrl.askWizard(question, steps, multi),
    spinner: {
      start: (m) => ctrl.setBusy(m),
      update: () => {},
      stop: () => ctrl.setBusy(null),
    } satisfies SpinnerLike,
    events: (ev) => {
      switch (ev.type) {
        case 'tools_planned':
          ctrl.planTools(ev.tools);
          break;
        case 'tool_start':
          ctrl.toolStart(ev.id, ev.name, ev.input);
          break;
        case 'tool_end':
          ctrl.toolEnd(ev.id, ev.output);
          break;
        case 'stream_end':
          ctrl.finishStream();
          break;
        case 'thinking':
          if (ev.text) ctrl.streamThinking(ev.text);
          break;
        case 'busy_think':
          ctrl.setBusyThinking(true);
          break;
        case 'busy_tokens':
          ctrl.setBusyTokens(ev.input_tokens);
          break;
        case 'usage':
          // 真实用量：回填 busy 行 input token + 落 turn 元信息（耗时从 busy 开始算）
          ctrl.setBusyTokens(ev.usage.input_tokens);
          ctrl.setTurnUsage(ev.usage, Date.now() - (ctrl.busySince ?? Date.now()));
          break;
      }
    },
  });

  // 绿色欢迎文案
  process.stderr.write(
    '\x1b[32m🚀 每一个伟大的背后，都来源于一次勇敢的尝试。您的AI编程助手，B Code 已就绪\x1b[0m\n\n',
  );

  await agent.initMcp();

  // 启动即回填已载入的待办清单（跨会话存续的进度视图）
  ctrl.setTodos(agent.todoList());

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
    // 最近 5 轮灌进消息流，回看上下文（tool 块只显示名字、标完成）
    const recent = recentTurns(saved);
    ctrl.loadTurns(
      recent.map((r) => ({
        role: r.role,
        text: r.text,
        tools: r.tools.map((name, i) => ({
          id: `r-${i}`,
          name,
          input: '',
          status: 'done',
        })),
        streaming: false,
      })),
    );
    const rounds = recent.filter((r) => r.role === 'user').length;
    initialOutput.push(`(resumed ${saved.length} messages · 最近 ${rounds} 轮)`);
  } else if (args.resume || args.session) {
    initialOutput.push('(no session to resume)');
  }
  if (args.plan) initialOutput.push('(plan mode: read-only)');
  if (args.auto) initialOutput.push('(auto mode: classifier gates write/shell)');
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
      onSetMode: (mode) => {
        agent.setMode(mode);
        ctrl.pushOutput(`(mode → ${mode})`);
      },
    },
    initialOutput,
  );
  unmount = unmountApp;

  // 版本升级检查：异步执行不阻塞启动，检查到远程 npm 有新版时在底部提示升级命令
  void checkForUpdate().then((info) => ctrl.setUpdateInfo(info));

  async function handle(input: string | { text: string; images?: ClipboardImage[] }) {
    if (running) return;
    running = true;
    try {
      // 结构化输入（带图片）：直接发送，跳过 slash 命令处理
      if (typeof input !== 'string') {
        const { text, images } = input;
        const displayText = text + (images && images.length > 0 ? ` [图片×${images.length}]` : '');
        ctrl.pushUser(displayText);
        await agent.chat({ text, images });
        await saveSession(agent.history(), sessionId);
        if (oneShot) quit(0);
        return;
      }

      const trimmed = input.trim();
      if (trimmed === 'exit' || trimmed === 'quit') {
        quit(0);
        return;
      }
      if (trimmed === '/clear') {
        agent.clearHistory();
        autoApprove = false; // 新一轮会话重新询问审批
        await clearSessionFile();
        ctrl.clearAll();
        ctrl.pushOutput('(history cleared)');
        return;
      }
      if (trimmed === '/plan' || trimmed === '/yolo' || trimmed === '/default' || trimmed === '/auto') {
        const mode = trimmed.slice(1) as Mode;
        agent.setMode(mode);
        ctrl.setMode(mode);
        ctrl.pushOutput(`(mode → ${mode})`);
        return;
      }
      if (trimmed === '/skills') {
        const skills = discoverSkills()
          .filter((s) => s.userInvocable)
          .map((s) => `/${s.name}: ${s.description}`)
          .join('\n');

        // 走 ctrl.pushOutput（而非 console.log 直写 stdout）——直写会与 Ink 的
        // live 帧抢占同一片终端区域，导致输出错位/被覆盖。
        ctrl.pushOutput(skills ? `Available skills:\n${skills}` : '(no skills)');
        return;
      }
      if (trimmed === '/mcp') {
        ctrl.pushOutput(formatMcpList(resolveMcpConfigs(), (name) => countMcpTools(agent.registry, name)));
        return;
      }
      if (trimmed === '/help') {
        ctrl.pushOutput(HELP_TEXT);
        return;
      }
      if (trimmed === '/cost') {
        ctrl.pushOutput(formatCost(agent.usageTotals()));
        return;
      }
      if (trimmed === '/todos') {
        ctrl.pushOutput(`任务清单:\n${renderTodos(agent.todoList())}`);
        return;
      }
      if (trimmed === '/model' || trimmed.startsWith('/model ')) {
        const arg = trimmed.slice('/model'.length).trim();
        if (!arg) {
          ctrl.pushOutput(`当前模型: ${agent.model}`);
        } else {
          agent.setModel(arg);
          ctrl.pushOutput(`(model → ${arg})`);
        }
        return;
      }
      if (trimmed === '/compact') {
        const did = await agent.compactNow();
        ctrl.pushOutput(did ? '(上下文已压缩)' : '(上下文较短，无需压缩)');
        return;
      }
      if (trimmed === '/rewind') {
        const n = agent.checkpointCount();
        if (n === 0) {
          ctrl.pushOutput('(没有可回退的文件改动)');
          return;
        }
        // 破坏性操作：先确认（Esc/No = 取消）
        const ok = await ctrl.ask(`回退 ${n} 个文件的改动？该操作会还原文件内容。`, [
          { label: 'No', value: 'no' },
          { label: 'Yes', value: 'yes' },
        ]);
        if (ok !== 'yes') {
          ctrl.pushOutput('(已取消回退)');
          return;
        }
        const { restored, deleted } = agent.rewind();
        const lines = [...restored.map((p) => `  还原 ${p}`), ...deleted.map((p) => `  删除 ${p}`)];
        ctrl.pushOutput(`(已回退 ${restored.length + deleted.length} 个文件)\n${lines.join('\n')}`);
        return;
      }
      if (trimmed.startsWith('/remember ')) {
        const fact = trimmed.slice('/remember '.length).trim();
        const name = fact.split(/\W+/).filter(Boolean).slice(0, 4).join('_').toLowerCase() || 'fact';
        saveMemory(name, fact, 'reference', fact);
        ctrl.pushOutput(`(saved to memory: ${name})`);
        return;
      }

      // 技能调用优先（含 $ARGUMENTS 替换），未命中走普通对话
      const effective = resolveSkill(trimmed) ?? trimmed;
      ctrl.pushUser(trimmed);

      if (args.goal) {
        await agent.pursueGoal(args.goal, effective || 'Continue working toward the goal.');
        await saveSession(agent.history(), sessionId);
        quit(0);
        return;
      }
      await chatWithClipboard(agent, effective);
      await saveSession(agent.history(), sessionId);

      if (agent.interruptedByUser) {
        // Esc 硬中断已生效：模型请求/shell 子进程被立即终止，此处仅提示可继续输入
        ctrl.pushOutput('(interrupted — 可以输入新指令或继续)');
      }

      if (args.loop > 0) {
        setTimeout(() => void handle(args.instruction ?? ''), args.loop * 1000);
      } else if (oneShot) {
        quit(0);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // P1：API 调用错误直接输出到 stderr，确保用户看到（UI 输出可能被滚动冲掉）
      console.error('\n\x1b[31m❌ 接口调用出错:\x1b[0m');
      console.error(`   ${msg.replace(/\n/g, '\n   ')}`);
      ctrl.pushOutput(`\x1b[31m❌ 接口调用出错: ${msg}\x1b[0m`);
    } finally {
      running = false;
    }
  }

  // 启动即执行模式（one-shot / goal / loop）；否则进入 REPL 等用户输入
  if (args.instruction || args.goal) {
    await handle(args.instruction || 'Continue working toward the goal.');
  }
}

/** 恢复会话命令提示（带会话 id），供退出口调用 */
function printResumeHint(sessionId: string): void {
  process.stdout.write(`\n想恢复本次会话，执行:\n  bcode --resume --session ${sessionId}\n`);
}

/** 从会话历史取最后一条 assistant 文本（JSON 输出用；工具轮次不算） */
export function finalAssistantText(messages: MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    const text = (m.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    if (text) return text;
  }
  return '';
}

/**
 * JSON 一次性模式（--output-format json）：headless 执行一条指令，
 * 把结果（最终文本 + 工具调用 + 用量）序列化为单个 JSON 对象打到 stdout。
 * 供 CI/脚本消费——不渲染 UI、不做 TTY 分流。
 */
async function runJsonOnce(args: CliArgs, sessionId: string): Promise<void> {
  const tools: { name: string; input: unknown; output?: string }[] = [];
  const agent = new Agent({
    mode: initialMode(args),
    hooks: loadHooks(loadSettings()), // 生命周期钩子
    print: () => {}, // 丢弃流式文本（结果从 history 取，避免中间态混入）
    askUser: async () => false, // headless：无法确认 → fail-closed
    events: (ev) => {
      if (ev.type === 'tool_start') tools.push({ name: ev.name, input: ev.input });
      else if (ev.type === 'tool_end') {
        // 匹配最近的同名且无 output 的记录（并行 read 也能对上）
        const slot = [...tools].reverse().find((t) => t.name === ev.name && t.output === undefined);
        if (slot) slot.output = ev.output;
      }
    },
  });
  await agent.initMcp();

  const instruction = resolveSkill(args.instruction) ?? args.instruction;
  let error: string | null = null;
  try {
    await agent.chat(instruction);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  await saveSession(agent.history(), sessionId);
  closeAllMcpConnections();

  const payload = {
    success: error === null,
    session_id: sessionId,
    model: agent.model,
    instruction,
    result: finalAssistantText(agent.history()),
    tools,
    usage: agent.usageTotals(),
    error,
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  process.exit(error === null ? 0 : 1);
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  /**  参数解析
   * 是否恢复会话：resume、session
     权限模式：plan、yolo、auto
     自动目标：goal
     循环执行：loop
     用户指令：instruction 
  */
  const { resume, plan, yolo, auto, goal, loop, session, instruction, outputFormat } = parseCliArgs(argv);

  /** 同时判断是否是普通 REPL：也就是没有一次性指令、目标或循环参数时，才进入交互式多轮模式。 */
  const replMode = !instruction && !goal && !(loop > 0);
  const sessionId = newSessionId(); // 本次会话 id（退出时打印恢复命令用）

  // --output-format json：headless 结构化输出（供 CI/脚本消费），不进入 TTY/REPL 分流。
  // 仅对一次性指令模式生效；无指令时忽略该标志。
  if (outputFormat === 'json' && instruction) {
    await runJsonOnce(
      { resume, plan, yolo, auto, goal, loop, session, outputFormat, instruction },
      sessionId,
    );
    return;
  }

  // 如果输入输出都是真实终端，就交给 runTtyCli，TTY 交互路径：ink 声明式渲染（思考/工具块/markdown/选择/斜杠菜单）。
  // 非 TTY（管道/CI/脚本）走下方 readline 分支，语义保持不变。
  if (process.stdout.isTTY && process.stdin.isTTY) {
    await runTtyCli({ resume, plan, yolo, auto, goal, loop, session, outputFormat, instruction }, sessionId);
    return; // 在这里直接结束，不再执行下面的非 TTY 逻辑。
  }

  /** 命令行输入接口 */
  let rl: readline.Interface | null = null;

  /** 等待权限确认的回调 */
  let awaitingAnswer: ((ok: boolean) => void) | null = null;

  /** Agent 是否正在执行任务 */
  let busy = false;

  /** 输入流是否已经关闭 */
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
    process.stdout.write('\n');
    rl.prompt();
  };

  /** 延迟创建共享 readline（REPL 一上来就建；one-shot 等首次 confirm 才建） */
  const getRl = (): readline.Interface => {
    /**
     * 普通 REPL 中会立即调用它；one-shot 模式则只有真正需要权限确认时才创建。
     * 每收到一行输入，会依次处理：
     *  是否是权限确认答案
        空输入
        exit / quit
        /clear
        /plan、/yolo、/default、/auto
        /skills
        /mcp
        /remember
        技能调用
        普通聊天请求
     */
    const existing = currentRl();
    if (existing) return existing;
    const created = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    created.on('line', async (raw) => {
      if (consumeAnswer(raw)) return;
      // 仅 REPL 模式处理命令行输入；one-shot 里到达的 stray 输入直接忽略
      if (!replMode) return;

      const input = raw.trim();
      if (!input) {
        created.prompt();
        return;
      }
      if (input === 'exit' || input === 'quit') {
        created.close();
        return;
      }
      if (input === '/clear') {
        agent.clearHistory();
        await clearSessionFile();
        process.stdout.write('(history cleared)\n');
        created.prompt();
        return;
      }
      if (input === '/plan' || input === '/yolo' || input === '/default' || input === '/auto') {
        agent.setMode(input.slice(1) as Mode);
        process.stdout.write(`(mode → ${input.slice(1)})\n`);
        created.prompt();
        return;
      }
      if (input === '/skills') {
        const skills = discoverSkills()
          .filter((s) => s.userInvocable)
          .map((s) => `/${s.name}: ${s.description}`)
          .join('\n');
        process.stdout.write(skills ? `Available skills:\n${skills}\n` : '(no skills)\n');
        created.prompt();
        return;
      }
      if (input === '/mcp') {
        process.stdout.write(
          `${formatMcpList(resolveMcpConfigs(), (name) => countMcpTools(agent.registry, name))}\n`,
        );
        created.prompt();
        return;
      }
      if (input === '/help') {
        process.stdout.write(`${HELP_TEXT}\n`);
        created.prompt();
        return;
      }
      if (input === '/cost') {
        process.stdout.write(`${formatCost(agent.usageTotals())}\n`);
        created.prompt();
        return;
      }
      if (input === '/todos') {
        process.stdout.write(`任务清单:\n${renderTodos(agent.todoList())}\n`);
        created.prompt();
        return;
      }
      if (input === '/model' || input.startsWith('/model ')) {
        const arg = input.slice('/model'.length).trim();
        if (!arg) process.stdout.write(`当前模型: ${agent.model}\n`);
        else {
          agent.setModel(arg);
          process.stdout.write(`(model → ${arg})\n`);
        }
        created.prompt();
        return;
      }
      if (input === '/compact') {
        const did = await agent.compactNow();
        process.stdout.write(`${did ? '(上下文已压缩)' : '(上下文较短，无需压缩)'}\n`);
        created.prompt();
        return;
      }
      if (input === '/rewind') {
        const n = agent.checkpointCount();
        if (n === 0) {
          process.stdout.write('(没有可回退的文件改动)\n');
        } else {
          const { restored, deleted } = agent.rewind();
          process.stdout.write(
            `(已回退 ${restored.length + deleted.length} 个文件)\n` +
              [...restored.map((p) => `  还原 ${p}`), ...deleted.map((p) => `  删除 ${p}`)].join('\n') +
              '\n',
          );
        }
        created.prompt();
        return;
      }
      if (input.startsWith('/remember ')) {
        const fact = input.slice('/remember '.length).trim();
        const name = fact.split(/\W+/).filter(Boolean).slice(0, 4).join('_').toLowerCase() || 'fact';
        saveMemory(name, fact, 'reference', fact);
        process.stdout.write(`(saved to memory: ${name})\n`);
        created.prompt();
        return;
      }
      const skillPrompt = resolveSkill(input);
      if (skillPrompt) {
        busy = true;
        try {
          try {
            await chatWithClipboard(agent, skillPrompt);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('\n\x1b[31m❌ 接口调用出错:\x1b[0m');
            console.error(`   ${msg.replace(/\n/g, '\n   ')}`);
            process.stdout.write(`\x1b[31m❌ 接口调用出错: ${msg}\x1b[0m\n`);
          }
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
        try {
          await chatWithClipboard(agent, input);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('\n\x1b[31m❌ 接口调用出错:\x1b[0m');
          console.error(`   ${msg.replace(/\n/g, '\n   ')}`);
          process.stdout.write(`\x1b[31m❌ 接口调用出错: ${msg}\x1b[0m\n`);
        }
        await saveSession(agent.history(), sessionId);
      } finally {
        busy = false;
        if (closing) finish();
        else nextPrompt(created);
      }
    });
    created.on('close', () => {
      closing = true;
      process.stdout.write('\n');
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
    allowlistStore: createSettingsAllowlistStore(), // 非 TTY 路径同样持久化白名单
    hooks: loadHooks(loadSettings()), // 生命周期钩子
    askUser: (question) =>
      new Promise<boolean>((resolve) => {
        process.stdout.write(`  ${question} `);
        if (!process.stdin.isTTY && !eofDenyInstalled) {
          eofDenyInstalled = true;
          process.stdin.on('end', () => {
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
          process.stdout.write('(no input — denied)\n');
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
    process.stdout.write(renderRecentTurns(recentTurns(saved))); // 回看最近 5 轮
  } else if (resume || session) {
    process.stdout.write('(no session to resume)\n');
  }

  // ── goal 模式：无人值守追条件（评估器回灌直到达成）────────────
  if (goal) {
    busy = true;
    try {
      await agent.pursueGoal(goal, instruction || 'Continue working toward the goal.');
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
      process.stdout.write('\n(loop stopped)\n');
      closeAllMcpConnections();
      process.exit(130);
    };
    process.on('SIGINT', stop);
    busy = true;
    try {
      for (;;) {
        await chatWithClipboard(agent, instruction);
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
      await chatWithClipboard(agent, effective);
    } finally {
      await saveSession(agent.history(), sessionId);
      busy = false;
    }
    process.stdout.write('\n(done)\n');
    closeAllMcpConnections(); // MCP 子进程不杀则进程永不退出
    if (closing)
      finish(); // chat 期间 EOF：现在补退出
    else currentRl()?.close();
    return;
  }

  // ── REPL ────────────────────────────────────────────────────
  getRl().prompt();
}
