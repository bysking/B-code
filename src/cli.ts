import * as readline from 'node:readline';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { Agent } from './agent.js';
import type { Registry } from './registry.js';
import { clearSessionFile, loadSession, saveSession } from './session.js';
import { resolveSkill, discoverSkills } from './skills.js';
import { saveMemory } from './memory.js';
import { closeAllMcpConnections, isMcpConnected } from './mcp.js';
import { formatMcpList, resolveMcpConfigs } from './mcp-config.js';
import type { CapabilityItem, CapabilityKind } from './ui/controller.js';
import { AppController } from './ui/controller.js';
import type { WizardStep } from './ui/controller.js';
import { createSettingsAllowlistStore, loadSettings } from './config.js';
import { writeFileSync } from 'node:fs';
import { formatCost } from './cost.js';
import { renderTodos } from './todo.js';
import {
  USER_TODO_HELP,
  addUserTodo,
  clearDoneUserTodos,
  indexToId,
  loadUserTodos,
  parseUserTodoCommand,
  removeUserTodo,
  renderUserTodos,
  saveUserTodos,
  toggleUserTodo,
  type UserTodo,
} from './user-todo.js';
import { loadHooks } from './hooks.js';
import { mountTtyApp } from './ui/render.js';
import { BUILTIN_SLASH_ITEMS } from './ui/slash.js';
import { newSessionId, recentTurns, renderRecentTurns } from './session.js';
import {
  collectTurns,
  defaultExportPath,
  renderMarkdown,
  renderForTerminal,
} from './session-export.js';
import type { SpinnerLike } from './ui.js';
import type { Mode } from './permissions.js';
import type { ClipboardImage } from './utils/clipboard.js';
import { checkForUpdate, localVersion } from './version-check.js';

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
  '  /export [路径]   导出会话为 markdown',
  '  /plan /auto /yolo /default   切换权限模式',
  '  /skills          技能面板（空格启用/禁用）',
  '  /mcp             MCP 面板（空格启用/禁用，R 重连）',
  '  /remember <事实> 保存长期记忆',
  '  exit | quit      退出',
  '快捷键:',
  '  Esc              硬中断当前对话（取消在飞请求/终止 shell）',
  '  Ctrl+O           工具输出面板',
  '  Shift+Tab        循环切换模式',
  '  PgUp / PgDn / 滚轮   回看历史',
  '  ↑ / ↓            输入历史导航（已滚离底部时优先滚回）',
  '  Ctrl+V           粘贴图片（文本走括号粘贴自动处理）',
  '  拖选 + Ctrl+Shift+C  复制选中的文本',
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

/**
 * /mcp：某 MCP server 在 registry 中已挂载的工具数（0 = 启动时连接失败，fail-open）。
 * 用 includeDisabled=true：管理视图要看真实挂载量，禁用只是"不发给模型"。
 */
function countMcpTools(registry: Registry, serverName: string): number | null {
  const n = registry.list((mp) => mp.name.startsWith(`mcp__${serverName}__`), true).length;
  return n > 0 ? n : null;
}

/**
 * 构建能力面板的列表数据（技能 / MCP）。
 *
 * 单一数据源：启用状态一律从 Agent 的快照读，不在 UI 侧另存一份——
 * 否则「空格切换」后两处状态会漂移（面板显示启用、实际已禁用）。
 */
export function buildCapabilityItems(
  kind: CapabilityKind,
  agent: Agent,
  cwd: string = process.cwd(),
): CapabilityItem[] {
  const disabled = agent.disabledSnapshot();
  if (kind === 'skill') {
    return discoverSkills(cwd)
      .filter((s) => s.userInvocable)
      .map((s) => ({
        name: s.name,
        enabled: !disabled.skills.includes(s.name),
        detail: s.description || undefined,
      }));
  }
  const configs = resolveMcpConfigs(cwd);
  return Object.keys(configs).map((name) => {
    const cfg = configs[name]!;
    const count = countMcpTools(agent.registry, name);
    const connected = isMcpConnected(name);
    const parts = [[cfg.command, ...(cfg.args ?? [])].join(' ')];
    if (!connected) parts.push('未连接');
    else if (count !== null) parts.push(`${count} 工具`);
    if (cfg.mode === 'read') parts.push('(read)');
    return {
      name,
      enabled: !disabled.mcpServers.includes(name),
      detail: parts.join(' · '),
      connected,
    };
  });
}

/**
 * /todo 非交互子命令的纯处理（TTY 与非 TTY 共用，便于单测）。
 * 输入当前清单 + 参数串 → 新清单 + 待展示文本 + 是否请求打开交互编辑器。
 * 序号越界/非法 → 原样返回并给出提示（不静默吞掉，用户要知道为什么没反应）。
 */
export function applyUserTodoCommand(
  todos: UserTodo[],
  args: string,
): { todos: UserTodo[]; output: string; open: boolean } {
  const cmd = parseUserTodoCommand(args);
  const withList = (
    next: UserTodo[],
    head?: string,
  ): { todos: UserTodo[]; output: string; open: boolean } => ({
    todos: next,
    output: head ? `${head}\n${renderUserTodos(next)}` : renderUserTodos(next),
    open: false,
  });
  switch (cmd.kind) {
    case 'open':
      return { todos, output: '', open: true };
    case 'list':
      return withList(todos);
    case 'add':
      return withList(addUserTodo(todos, cmd.text));
    case 'clear-done':
      return withList(clearDoneUserTodos(todos));
    case 'help':
      return { todos, output: USER_TODO_HELP, open: false };
    case 'toggle': {
      const id = indexToId(todos, cmd.index);
      if (!id) return withList(todos, `(序号无效: ${cmd.index})`);
      return withList(toggleUserTodo(todos, id));
    }
    case 'remove': {
      const id = indexToId(todos, cmd.index);
      if (!id) return withList(todos, `(序号无效: ${cmd.index})`);
      return withList(removeUserTodo(todos, id));
    }
  }
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

  // 绿色欢迎文案（末尾附版本号，读不到时省略）
  const version = localVersion();
  process.stderr.write(`\x1b[32m🚀 您的AI编程助手，B Code 已就绪${version ? ` v${version}` : ''}\x1b[0m\n\n`);

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

  /**
   * loop 模式的累积输出。
   *
   * loop 跑在备用屏里，Ctrl-C 退出后屏幕上什么都不剩。用户要来的是"每一轮都
   * 输出了什么"，所以把每轮结果攒起来，退出时一次性补打到真实终端。
   *
   * 上限保护：长跑会攒出巨量文本，超过 MAX 就丢最早的（保留最近的更符合直觉）。
   */
  const LOOP_OUTPUT_MAX = 20000;
  let loopHarvest = '';

  let running = false;
  /**
   * 退出：先恢复终端状态，再退进程。
   *
   * unmount 现在是异步的（要等 OpenTUI 把鼠标追踪/备用屏/光标切回来）。
   * 不 await 直接 `process.exit()` 会让那些清理序列来不及写出——
   * 终端停在鼠标追踪模式，用户回到 shell 后一动鼠标就是满屏的 `35;41;30M`。
   */
  /**
   * @param afterExit 终端恢复后要补打的内容（one-shot 场景用）。
   *
   * 为什么需要：TTY 下 UI 渲染在**备用屏**里，退出备用屏后屏幕上什么都没有。
   * `bcode "今天是几号"` 这种 one-shot 调用，用户敲完命令期望直接看到答案，
   * 结果回到 shell 是空的——答案随备用屏一起被丢了。
   * 所以在退出后把最终回复重新打到真实终端上。
   */
  const quit = async (code: number, afterExit?: string): Promise<void> => {
    /**
     * 顺序很重要：**先卸载再打印提示**。
     *
     * OpenTUI 用备用屏（alternate screen）做全屏渲染。待在备用屏里打印的内容
     * 会随着退出备用屏一起被丢弃——用户回到 shell 后什么都看不到，
     * 于是"session id 打不出来，没法 --resume"。
     *
     * unmount() 内部会 `await renderer.closed`，等备用屏切回主屏、
     * 终端状态完全恢复后才返回；之后写 stdout 才是打在用户真实终端上的。
     */
    await unmount?.();
    // 先补打 one-shot 的结果（用户主要想看这个），再打 resume 提示
    if (afterExit) process.stdout.write(`${afterExit}\n`);

    /**
     * 交互退出时补打最近几轮对话。
     *
     * 备用屏退出即销毁——用户和助手聊了半天，回到 shell 什么都没留下。
     * 这里把最后 N 轮打到真实终端，用户至少能看到刚才聊了什么。
     * 完整历史仍可用 `--resume` 恢复，也可以用 `/export` 存成文件。
     *
     * one-shot 不重复打（afterExit 已经带了最终回复）。
     */
    if (!afterExit) {
      const recent = renderForTerminal(collectTurns(agent.history()), 3);
      if (recent) process.stdout.write(`\n${recent}\n`);
    }

    printResumeHint(sessionId);
    closeAllMcpConnections();
    process.exit(code);
  };
  let unmount: (() => void) | null = null;

  /** 能力面板：用 Agent 的最新状态回灌列表（每次操作后都调，UI 永远等于真源） */
  const refreshCapability = (): void => {
    const panel = ctrl.capabilityPanel;
    if (!panel) return;
    ctrl.setCapabilityItems(buildCapabilityItems(panel.kind, agent));
  };

  const { unmount: unmountApp } = await mountTtyApp(
    ctrl,
    {
      onExit: () =>
        // loop 模式下退出前补打累积输出（UI 在备用屏里，退出即销毁）
        void quit(130, args.loop > 0 && loopHarvest ? `本轮循环的输出：\n${loopHarvest}` : undefined),
      onInterrupt: () => agent.interrupt(), // Esc：软中断当前 chat
      onSubmit: (text) => void handle(text),
      onSetMode: (mode) => {
        agent.setMode(mode);
        ctrl.pushOutput(`(mode → ${mode})`);
      },
      // 空格：切换启停。切换后立即回灌（勾选框 + 行内提示同步刷新）
      onToggleCapability: (name) => {
        const panel = ctrl.capabilityPanel;
        if (!panel) return;
        if (panel.kind === 'skill') {
          const enabled = agent.toggleSkill(name);
          ctrl.setCapabilityNotice(name, enabled ? '✓ 已启用' : '✓ 已禁用（不再发送给模型）');
        } else {
          const enabled = agent.toggleMcpServer(name);
          ctrl.setCapabilityNotice(name, enabled ? '✓ 已启用' : '✓ 已禁用（工具不再发送给模型，进程保持）');
        }
        refreshCapability();
      },
      // R：重连（仅 MCP）。异步：先挂"重连中…"，完成后换成结果提示
      onReconnectCapability: (name) => {
        ctrl.setCapabilityNotice(name, '重连中…');
        void agent.reconnectMcp(name).then((r) => {
          ctrl.setCapabilityNotice(
            name,
            r.ok ? `✓ 已重连（${r.toolCount ?? 0} 工具）` : `✗ 重连失败：${r.error ?? '未知错误'}`,
          );
          refreshCapability();
        });
      },
      refreshCapability,
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
        if (oneShot) void quit(0, finalAssistantText(agent.history()));
        return;
      }

      const trimmed = input.trim();
      if (trimmed === 'exit' || trimmed === 'quit') {
        void quit(0);
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
        // 交互面板（空格启停）；非 TTY 走不了面板，那里仍打印文本
        ctrl.openCapability('skill', buildCapabilityItems('skill', agent));
        return;
      }
      if (trimmed === '/mcp') {
        ctrl.openCapability('mcp', buildCapabilityItems('mcp', agent));
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
      if (trimmed === '/export' || trimmed.startsWith('/export ')) {
        const arg = trimmed.slice('/export'.length).trim();
        const target = arg || defaultExportPath(sessionId);
        const turns = collectTurns(agent.history());
        if (turns.length === 0) {
          ctrl.pushOutput('(会话还没有内容可导出)');
          return;
        }
        try {
          writeFileSync(
            target,
            renderMarkdown(turns, {
              sessionId,
              model: agent.model,
              exportedAt: new Date(),
            }),
            'utf-8',
          );
          ctrl.pushOutput(`(已导出 ${turns.filter((t) => t.role === 'user').length} 轮到 ${target})`);
        } catch (err) {
          ctrl.pushOutput(`(导出失败: ${err instanceof Error ? err.message : String(err)})`);
        }
        return;
      }
      if (trimmed === '/todos') {
        ctrl.pushOutput(`任务清单:\n${renderTodos(agent.todoList())}`);
        return;
      }
      if (trimmed === '/todo' || trimmed.startsWith('/todo ')) {
        // 用户自管待办：无参 → 打开交互编辑器；有参 → 按子命令就地处理（list/add/done/rm/clear）
        const r = applyUserTodoCommand(ctrl.userTodos, trimmed.slice('/todo'.length));
        if (r.todos !== ctrl.userTodos) ctrl.setUserTodos(r.todos);
        if (r.open) ctrl.setUserTodoOpen(true);
        else ctrl.pushOutput(r.output);
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
        const met = await agent.pursueGoal(args.goal, effective || 'Continue working toward the goal.');
        await saveSession(agent.history(), sessionId);
        // 目标模式的结论必须带回真实终端：UI 在备用屏里，退出即销毁
        const verdict = met ? '✓ 目标达成' : '✗ 目标未达成';
        void quit(met ? 0 : 1, `${verdict}\n\n${finalAssistantText(agent.history())}`);
        return;
      }
      await agent.chat(effective);
      await saveSession(agent.history(), sessionId);

      if (agent.interruptedByUser) {
        // Esc 硬中断已生效：模型请求/shell 子进程被立即终止，此处仅提示可继续输入
        ctrl.pushOutput('(interrupted — 可以输入新指令或继续)');
        // one-shot 被中断时没有"后续对话"——已产出的部分回复要带回真实终端，
        // 否则用户敲完命令按 Esc，回到 shell 什么都看不到（连"我中断了什么"都不知道）
        if (oneShot) {
          const partial = finalAssistantText(agent.history());
          void quit(130, partial ? `(已中断) 部分回复：\n\n${partial}` : '(已中断，模型尚未产出内容)');
          return;
        }
      }

      if (args.loop > 0) {
        // 攒本轮结果（loop 退出后要补打到真实终端）
        const reply = finalAssistantText(agent.history());
        if (reply) {
          const stamp = new Date().toLocaleTimeString();
          loopHarvest += `\n[${stamp}] ${reply}\n`;
          if (loopHarvest.length > LOOP_OUTPUT_MAX) {
            loopHarvest = `…(更早的输出已省略)\n${loopHarvest.slice(-LOOP_OUTPUT_MAX)}`;
          }
        }
        setTimeout(() => void handle(args.instruction ?? ''), args.loop * 1000);
      } else if (oneShot) {
        // one-shot：把最终回复带回真实终端（UI 画在备用屏里，退出后会消失）
        void quit(0, finalAssistantText(agent.history()));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 错误走 ctrl.pushOutput（进 UI 消息流），**不能** console.error：
      // OpenTUI 接管后 console 输出进的是 console overlay，而 overlay 默认关闭，
      // 写进去等于石沉大海。UI 消息流是用户一定能看到的地方。
      ctrl.pushOutput(`❌ 接口调用出错: ${msg}`);
      // one-shot 场景没有"后续对话"，错误必须带到真实终端才算交付
      if (oneShot) void quit(1, `❌ 接口调用出错: ${msg}`);
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
        // 非 TTY 无交互能力：退回纯文本，但带上禁用标记
        // （管道/CI 场景没有空格键，至少让 /skills | cat 能看出当前状态）
        const items = buildCapabilityItems('skill', agent);
        const lines = items.map(
          (it) =>
            `${it.enabled ? '✓' : '✗'} /${it.name}${it.enabled ? '' : ' (disabled)'}: ${it.detail ?? ''}`,
        );
        process.stdout.write(lines.length ? `Available skills:\n${lines.join('\n')}\n` : '(no skills)\n');
        created.prompt();
        return;
      }
      if (input === '/mcp') {
        process.stdout.write(
          `${formatMcpList(resolveMcpConfigs(), (name) => countMcpTools(agent.registry, name), agent.disabledSnapshot().mcpServers)}\n`,
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
      if (input === '/export' || input.startsWith('/export ')) {
        // 非 TTY 同样支持导出——管道/脚本场景更需要把结果落成文件
        const arg = input.slice('/export'.length).trim();
        const target = arg || defaultExportPath(sessionId);
        const turns = collectTurns(agent.history());
        if (turns.length === 0) {
          process.stdout.write('(会话还没有内容可导出)\n');
        } else {
          try {
            writeFileSync(
              target,
              renderMarkdown(turns, { sessionId, model: agent.model, exportedAt: new Date() }),
              'utf-8',
            );
            process.stdout.write(
              `(已导出 ${turns.filter((t) => t.role === 'user').length} 轮到 ${target})\n`,
            );
          } catch (err) {
            process.stdout.write(`(导出失败: ${err instanceof Error ? err.message : String(err)})\n`);
          }
        }
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
            await agent.chat(skillPrompt);
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
          await agent.chat(input);
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
