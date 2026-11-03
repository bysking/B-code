/**
 * AppController —— TTY 模式下 CLI 与 ink 组件树之间的状态总线。
 *
 * 纯 TS（不依赖 ink/React），可单测。Agent 的 print/askUser/spinner/events
 * 都汇入这里；React 侧用 useSyncExternalStore(ctrl.subscribe, ctrl.getSnapshot)
 * 订阅渲染。非 TTY 路径不使用本类（保持 raw 直写）。
 */

import {
  estimateLines,
  findStreamSplit,
  isCompactTerminal,
  LIVE_TOOL_ROWS_MAX,
  liveLineBudget,
  terminalCols,
} from './scroll-budget.js';
import { todoPanelHeight } from './todo-panel.js';
import { taskPanelHeight } from './task-panel.js';
import type { Mode } from '../permissions.js';
import type { UserTodo } from '../user-todo.js';

export type ToolStatus = 'queued' | 'running' | 'done';

/** 工具/子项状态符号与配色（message-list 与 TaskPanel 共用） */
export const TOOL_SYMBOL: Record<ToolStatus, string> = {
  queued: '○',
  running: '⠒',
  done: '✓',
};
export const TOOL_COLOR: Record<ToolStatus, string | undefined> = {
  queued: undefined,
  running: 'yellow',
  done: 'green',
};

export interface ToolCallDisplay {
  /** 稳定键：模型下发的 tool_use id（恢复会话用 r-<i>） */
  id: string;
  name: string;
  input: string;
  status: ToolStatus;
  /** 工具/子 agent 的真实输出（Ctrl+O 面板回看用；可能被截断过） */
  output?: string;
}

export interface Turn {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  /** assistant 的思考块（extended thinking）逐字累计；非空时以灰色斜体渲染 */
  thinking?: string;
  tools: ToolCallDisplay[];
  /** assistant 正在流式输出中 */
  streaming: boolean;
  /** 真实 token 用量（模型调用完成回填；busy 行清空后仍可见） */
  usage?: { input_tokens: number; output_tokens: number };
  /** 该轮模型调用耗时（ms） */
  elapsedMs?: number;
  /** 流式防溢出：text 已提交进 <Static> 的前缀片段（按时序、只增不改），live 区只保留余量。
   * 见 enforceLiveHeight / scroll-budget.ts——live 帧超终端行数会触发 Ink 整屏清屏（连 scrollback 一起清）。 */
  chunks: string[];
  /** thinking 的已提交前缀片段（同 chunks；thinking 是纯文本，无 markdown 切分约束） */
  thinkingChunks: string[];
  /**
   * 已"落定"（必为 done）的工具数：其对应工具块已提交进 <Static>，live 区不再渲染。
   *
   * 为什么需要：一批工具里只要有一个还没跑完，整个 turn 就不能提交，于是**所有**
   * 工具块（含已完成的）都滞留在 live 区。一批 30 个工具就能把 live 帧撑到 48 行，
   * 超过终端行数 → ink 整屏清屏（ESC[3J 连 scrollback 一起清），用户回看位置丢失。
   * 工具一经 done 就不再变化，天然可提前提交；用计数而非布尔，因为提交是逐个推进的。
   */
  toolsCommitted: number;
}

/** 底部固定任务面板：子项（一个工具调用） */
export interface TaskPanelItem {
  id: string;
  label: string; // 子项展示名：file_path / pattern / command / 工具名
  status: ToolStatus;
}

/** 底部固定任务面板：模型返回的一批工具调用 = 一个 task。
 * 只在任务进行中存在：全部完成后 controller 移除面板。 */
export interface TaskPanelState {
  verb: string; // 读取 / 写入 / 编辑 / 搜索 / 执行
  title: string; // "读取 4 个文件" / "执行 4 个任务"（渲染时加"正在"前缀）
  items: TaskPanelItem[];
}

/** 工具名 → 动词 / 单位（整批同名时用于推导标题） */
const TASK_VERB: Record<string, string> = {
  read_file: '读取',
  write_file: '写入',
  edit_file: '编辑',
  list_files: '列出',
  grep_search: '搜索',
  file_content: '读取',
  run_shell: '执行',
};
const TASK_UNIT: Record<string, string> = {
  read_file: '文件',
  write_file: '文件',
  edit_file: '文件',
  list_files: '文件',
  grep_search: '文件',
  file_content: '文件',
  run_shell: '命令',
};

/** 从工具的 input 里抽展示名（file_path → pattern → command），没有就退回工具名 */
function taskItemLabel(it: { name: string; input: unknown }): string {
  const o = (it.input ?? {}) as Record<string, unknown>;
  for (const key of ['file_path', 'pattern', 'command']) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return it.name;
}

/** 纯推导：一批计划中的工具调用 → 任务面板（空批返回 null） */
export function deriveTaskPanel(
  items: { id: string; name: string; input: unknown }[],
): TaskPanelState | null {
  if (items.length === 0) return null;
  const first = items[0]!.name;
  const sameName = items.every((it) => it.name === first);
  // 整批同名且命中动词表 → 动词/单位随该工具；否则（混合/未知）退回通用「执行」
  const verb = sameName ? TASK_VERB[first] : undefined;
  const unit = sameName ? TASK_UNIT[first] : undefined;
  const title = verb && unit ? `${verb} ${items.length} 个${unit}` : `执行 ${items.length} 个任务`;
  return {
    verb: verb ?? '执行',
    title,
    items: items.map((it) => ({ id: it.id, label: taskItemLabel(it), status: 'queued' })),
  };
}

export interface AskOption {
  label: string;
  value: string;
}

export interface AskState {
  question: string;
  options: AskOption[];
}

/** 多步向导（进度条 + 每步单选/自定义 + Review 提交）——模型驱动的选择交互唯一形态 */
export interface WizardStepOption {
  label: string;
  value: string;
  description?: string;
}
export interface WizardStep {
  title: string;
  question: string;
  options: WizardStepOption[];
}
export interface AskWizardState {
  question: string;
  steps: WizardStep[];
  /** true = 分步多选（每步可勾选多个选项，Enter/Space 切换） */
  multi?: boolean;
}

export interface SlashItem {
  name: string;
  description: string;
}

/**
 * 工具块里展示的参数摘要。
 *
 * 不再整段 JSON：早期实现直接 `JSON.stringify(input)` 截 80 字符，结果工具块长这样
 * `⠒ read_file {"file_path":"/very/long/.../file-22.component.tsx"}` —— 一条占 2 行，
 * 一批 30 个工具就是 60 行，直接把 live 帧撑过终端高度 → ink 整屏清屏（ESC[3J
 * 连 scrollback 一起清），用户回看位置丢失。
 *
 * 现在只取最具辨识度的单个参数（file_path / pattern / command / url / name），
 * 且压成一行短摘要：30 个工具也只占 30 行以内，且一眼能看出操作对象。
 * 完整参数与输出仍在 Ctrl+O 面板。
 */
function prettyInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  // 按辨识度优先级挑一个关键参数展示
  for (const key of ['file_path', 'pattern', 'command', 'url', 'name', 'id']) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return clip(v.trim(), INPUT_LABEL_MAX);
  }
  // 没有白名单参数：退回第一个字符串值，仍受长度约束
  for (const v of Object.values(o)) {
    if (typeof v === 'string' && v.trim()) return clip(v.trim(), INPUT_LABEL_MAX);
  }
  return '';
}

/** 工具块参数展示上限：足够看清路径/命令主体，又不至于自己就折成两行 */
const INPUT_LABEL_MAX = 60;

/** 截断并保证**单行**（换行会额外占行，是撑高 live 帧的隐形来源） */
function clip(s: string, max: number): string {
  const oneLine = s.replace(/\s*\n\s*/g, ' ⏎ ').replace(/\s+/g, ' ');
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

/** 内存里保留的系统日志行数上限（Ctrl+O 面板可翻页查看） */
export const MAX_LOG_LINES = 2000;

/** 固定输出行：id 与 Turn.id 共用同一自增序列，供 MessageList 按时序合并进同一个 <Static> */
export interface OutputLine {
  id: number;
  text: string;
}

export class AppController {
  turns: Turn[] = [];
  /** 固定输出行：(resumed…) / (done) / 告警等 */
  output: OutputLine[] = [];
  /**
   * 系统日志（log.info/warn/error）：TTY 下由 setLogSink 接管收进这里，
   * 供 Ctrl+O 面板查看。**刻意不写 stderr**——每写一次 stderr 终端就把视口
   * 拉到光标处，用户回看历史时会被日志拽回底部。
   */
  logs: string[] = [];
  /** 顶部 busy/thinking 文案（null = 空闲） */
  busy: string | null = null;
  /** busy 开始时间戳（elapsed 计算基准；null = 空闲） */
  busySince: number | null = null;
  /** 是否处于 thinking 相位（状态行追加 "· thinking" 标签） */
  busyThinking = false;
  /** busy 期间累计展示的 input token（调用前估算 → 结束后真实值覆盖） */
  busyInputTokens = 0;
  /** 待回答的系统权限确认（No/Yes 等）；null = 无（字段与方法 ask() 区分命名） */
  askState: AskState | null = null;
  /** 多步向导：非空时 Wizard 渲染（模型驱动的选择交互唯一形态） */
  askWizardState: AskWizardState | null = null;
  /** / 斜杠菜单状态 */
  slashOpen = false;
  slashQuery = '';
  slashItems: SlashItem[] = [];
  /** Ctrl+O 工具输出面板（展示全部已执行工具的真实输出） */
  outputPanel = false;
  /** 底部固定任务面板：模型返回的一批工具调用；null = 无活动任务 */
  task: TaskPanelState | null = null;
  /** 模型自管待办清单（todo_write 更新；空数组 = 无） */
  todos: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] = [];
  /**
   * 用户自管待办清单（/todo 手动维护）。与上面的**模型自管** todos 刻意分开：
   * 这份是用户自己的待办，跨会话存续，绝不喂给模型。存 user-todo.json（互不干扰）。
   */
  userTodos: UserTodo[] = [];
  /** /todo 交互编辑器是否打开（TTY 下无参 /todo 进入；开时 App 让出键盘） */
  userTodoOpen = false;
  /** 用户待办变更后的落盘钩子（cli 注入；缺省不落盘，便于单测纯内存跑） */
  persistUserTodos: ((todos: UserTodo[]) => void) | null = null;
  /** 文本输入提问（askText）：null = 无 */
  askTextState: { question: string } | null = null;
  /** 当前模式（plan / auto / bypass / default），UI 底部展示 */
  mode: Mode = 'default';
  /** 版本升级提示（启动异步检查填充；null = 无更新/检查中/已最新） */
  updateInfo: { current: string; latest: string } | null = null;
  /**
   * /clear 重置计数器：App 用它作 <Static>/<MessageList> 的 React key。
   * clearAll 后自增 → 整棵消息流 remount，丢弃 <Static> 内部"已打印"索引，
   * 避免清空瞬间 live 区高度骤变 + 旧内容残留导致的页面跳动。
   */
  resetEpoch = 0;

  private askTextResolver: ((value: string | null) => void) | null = null;

  private nextUserTurnId = 0;
  private version = 0;
  private listeners = new Set<() => void>();
  private askResolver: ((value: string) => void) | null = null;

  // ── React 订阅 ──────────────────────────────────────────────
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = (): number => this.version;
  private bump() {
    this.version++;
    for (const l of this.listeners) l();
  }

  // ── 输出与消息流 ────────────────────────────────────────────
  /**
   * 追加一条系统日志。只存内存、**不 bump()**：
   * 日志（MCP 连上/断开、hook 超时等）在后台随时可能发生，若触发重渲染
   * 会打断正在回看历史的用户。用户按 Ctrl+O 时才看到累积结果。
   */
  pushLog(line: string) {
    this.logs.push(line);
    // 上限保护：日志可能长期累积（长会话 + MCP 反复重连），只保留最近一段
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
  }

  pushOutput(line: string) {
    // id 与 turn 共用序列：MessageList 把 output 与 turn 统一按 id 排序进同一个 <Static>，
    // 保证输出行插在它发生的那一时点（而非永远堆在最前/最后）。
    this.output.push({ id: ++this.nextUserTurnId, text: line });
    this.bump();
  }

  /** /clear：重置对话与固定输出行（resetEpoch 自增 → 消息流 remount，防跳动） */
  clearAll() {
    this.turns = [];
    this.output = [];
    this.busy = null;
    this.busySince = null;
    this.busyThinking = false;
    this.busyInputTokens = 0;
    this.task = null;
    this.todos = [];
    this.resetEpoch++;
    this.bump();
  }

  pushUser(text: string) {
    const id = ++this.nextUserTurnId;
    this.turns.push({
      id,
      role: 'user',
      text,
      tools: [],
      streaming: false,
      chunks: [],
      thinkingChunks: [],
      toolsCommitted: 0,
    });
    this.task = null; // 新一轮输入 → 面板清空（已完成状态让位于新任务）
    this.bump();
  }

  /** 流式文本：首个 delta 开新 assistant turn，其后追加；超预算时提交前缀防溢出 */
  streamText(delta: string) {
    const last = this.turns[this.turns.length - 1];
    if (last && last.role === 'assistant' && last.streaming) last.text += delta;
    else
      this.turns.push({
        id: ++this.nextUserTurnId,
        role: 'assistant',
        text: delta,
        tools: [],
        streaming: true,
        chunks: [],
        thinkingChunks: [],
        toolsCommitted: 0,
      });
    this.enforceLiveHeight(this.turns[this.turns.length - 1]!);
    this.bump();
  }

  /** 恢复会话：把最近几轮灌进消息流渲染（id 重新分配，避免与后续新轮冲突） */
  loadTurns(turns: Array<Omit<Turn, 'id' | 'chunks' | 'thinkingChunks' | 'toolsCommitted'>>) {
    this.turns = turns.map((t, i) => ({
      chunks: [],
      thinkingChunks: [],
      ...t,
      id: i + 1,
      // 恢复的历史 turn 里工具全部已完成，整个 turn 本就是定稿 → 全部可提交
      toolsCommitted: t.tools.length,
    }));
    this.nextTurnIdEnsure();
    this.bump();
  }

  /** 保证 id 序列不落后于已灌入的 turn 数（loadTurns 后接续分配） */
  private nextTurnIdEnsure() {
    this.nextUserTurnId = Math.max(this.nextUserTurnId, this.turns.length);
  }

  /** 模型本轮结束（assistant 不再追加） */
  finishStream() {
    const last = this.turns[this.turns.length - 1];
    if (last?.role === 'assistant' && last.streaming) {
      last.streaming = false;
      this.bump();
    }
  }

  // ── 工具调用块 ──────────────────────────────────────────────
  private activeAssistant(): Turn | null {
    const last = this.turns[this.turns.length - 1];
    return last?.role === 'assistant' ? last : null;
  }

  /** 模型宣布一批工具调用：先记 pending，首个工具开始时整批落地（避免过早建空 turn 干扰流式） */
  private pendingTools: { id: string; name: string; input: unknown }[] | null = null;

  planTools(items: { id: string; name: string; input: unknown }[]) {
    if (items.length === 0) return;
    this.pendingTools = items;
    // 底部任务面板：宣布即建（全部 queued → 待…），不随 pendingTools 延后
    this.task = deriveTaskPanel(items);
    // 面板出现 → 底部占用变大 → live 预算变小，残留内容需提前切走（见 reflowLive）
    this.reflowLive();
    this.bump();
  }

  toolStart(id: string, name: string, input: unknown) {
    // 已关闭的 turn（不流式且工具全 done）不再承接新工具批：后续模型调用（纯工具批）会
    // 挂到上一轮已提交的 turn 上，污染已进 <Static> 的历史（Static 对已渲染项不可变）。
    // 此处改走 annotationTurn() 新建，保证每条 turn 只承载一轮模型调用的输出。
    const active = this.activeAssistant();
    const turn =
      active && !active.streaming && active.tools.every((t) => t.status === 'done')
        ? this.annotationTurn()
        : (active ?? this.annotationTurn());
    // 首个工具开始：把整批 queued 一次性挂上（列表全量展示，再逐个转 running/done）
    if (this.pendingTools && this.pendingTools.length > 0) {
      for (const it of this.pendingTools) {
        turn.tools.push({ id: it.id, name: it.name, input: prettyInput(it.input), status: 'queued' });
      }
      this.pendingTools = null;
    }
    const tool = turn.tools.find((t) => t.id === id);
    if (tool) {
      tool.status = 'running';
      tool.name = name;
      tool.input = prettyInput(input);
    } else {
      // 未预先 planTools（如恢复的旧会话）→ 兜底直接挂一条 running
      turn.tools.push({ id, name, input: prettyInput(input), status: 'running' });
    }
    // 任务面板同步：对应子项 → running
    const item = this.task?.items.find((t) => t.id === id);
    if (item) item.status = 'running';
    this.bump();
  }

  toolEnd(id: string, output?: string) {
    const turn = this.activeAssistant();
    const tool = turn?.tools.find((t) => t.id === id);
    if (tool && turn) {
      tool.status = 'done';
      if (output !== undefined) tool.output = output;
      // 已完成且**连续**的前缀工具可提前提交进 <Static>：工具 done 后不再变化，
      // 没必要因为它所在批次还有别的工具在跑就整批滞留在 live 区（会把帧撑爆）。
      // 只推进"连续 done 的前缀"——中间夹一个 running 就停下，保证 <Static> 里的
      // 工具顺序与真实执行顺序一致（Static 只追加，不能回头插入）。
      let n = 0;
      while (n < turn.tools.length && turn.tools[n]!.status === 'done') n++;
      turn.toolsCommitted = n;
      // 整批执行完 → 关掉 streaming，避免下一轮回复并进本 turn
      if (turn.tools.length > 0 && turn.tools.every((t) => t.status === 'done')) {
        turn.streaming = false;
      }
      this.bump();
    }
    // 任务面板同步：对应子项 → done；全部完成 → 面板移除（任务结束不再展示）
    const item = this.task?.items.find((t) => t.id === id);
    if (item) {
      item.status = 'done';
      if (this.task && this.task.items.every((t) => t.status === 'done')) {
        this.task = null;
      }
      this.bump();
    }
  }

  private annotationTurn(): Turn {
    const t: Turn = {
      id: ++this.nextUserTurnId,
      role: 'assistant',
      text: '',
      tools: [],
      streaming: false,
      chunks: [],
      thinkingChunks: [],
      toolsCommitted: 0,
    };
    this.turns.push(t);
    return t;
  }

  /** 思考块增量：累计到当前 streaming assistant turn，否则新建一个；超预算时提交前缀防溢出 */
  streamThinking(delta: string) {
    const last = this.turns[this.turns.length - 1];
    if (last && last.role === 'assistant' && last.streaming) {
      last.thinking = (last.thinking ?? '') + delta;
    } else {
      this.turns.push({
        id: ++this.nextUserTurnId,
        role: 'assistant',
        text: '',
        thinking: delta,
        tools: [],
        streaming: true,
        chunks: [],
        thinkingChunks: [],
        toolsCommitted: 0,
      });
    }
    this.enforceLiveHeight(this.turns[this.turns.length - 1]!);
    this.bump();
  }

  /**
   * 流式防溢出（滚动稳定性的核心）：turn 的 live 尾部（thinking 余量 + text 余量）
   * 超过预算时，把前缀按安全边界切出提交到 chunks / thinkingChunks（<Static> 只打印一次），
   * live 区只保留尾部。
   *
   * 为什么必须：Ink 的 live 帧一旦高于终端行数就整屏清屏（ESC[2J+3J+H，ESC[3J 连
   * scrollback 一起清）——用户向上滚动查看历史时会被弹回顶部、滚动位置丢失。
   *
   * 预算分配：thinking 与 text 都在时文本是主体多留（7:3）；单一内容独占整个预算。
   * 切分带滞回（保留约 60% 预算），避免逐 token 频繁提交。
   */
  /**
   * 底部浮动面板当前占用的行数（待办 + 任务面板）。
   * live 预算必须扣掉它，否则面板一变高整帧就溢出终端。
   */
  private footerChromeRows(): number {
    // 与 app.tsx 的渲染保持一致：矮终端下任务面板不渲染，预算就不能算它
    const task = isCompactTerminal() ? 0 : taskPanelHeight(this.task);
    return todoPanelHeight(this.todos) + task;
  }

  /**
   * live 区里**工具块**占用的行数。
   *
   * 工具块渲染在 live 区（未完成的那批），同样要占预算。之前 enforceLiveHeight
   * 只按 "面板 + 固定 chrome" 扣预算、把剩余全给正文，工具块再叠上去就溢出——
   * 表现为"任务清单/工具一出现，整帧冲过终端高度 → 整屏清屏"。
   *
   * 与 message-list 的 LIVE_TOOL_ROWS_MAX 保持一致：实际渲染是"上限内逐个 + 一行汇总"。
   */
  private liveToolBlockRows(): number {
    const last = this.turns[this.turns.length - 1];
    if (!last || last.role !== 'assistant') return 0;
    const pending = Math.max(last.tools.length - last.toolsCommitted, 0);
    if (pending === 0) return 0;
    return Math.min(pending, LIVE_TOOL_ROWS_MAX) + (pending > LIVE_TOOL_ROWS_MAX ? 1 : 0);
  }

  private enforceLiveHeight(turn: Turn) {
    const cols = terminalCols();
    const th = estimateLines(turn.thinking ?? '', cols);
    const tx = estimateLines(turn.text, cols);
    // 预算要扣掉两部分的**实测**高度：
    //   ① 底部面板（待办/任务）——随条数与折行浮动；
    //   ② live 区工具块——未完成的那批工具也渲染在 live 里，各占一行。
    // 用固定常量预留会在面板/工具变多时让整帧溢出终端 → ink 整屏清屏
    // （ESC[3J 连 scrollback 一起清），用户回看位置被重置。
    const budget = liveLineBudget(this.footerChromeRows() + this.liveToolBlockRows());
    if (th + tx <= budget) return;
    const keep = Math.max(Math.floor(budget * 0.6), 4);
    const thKeep = tx === 0 ? keep : Math.min(th, Math.floor(keep * 0.3));
    const txKeep = th === 0 ? keep : keep - thKeep;
    if (th > thKeep && turn.thinking) {
      const sp = findStreamSplit(turn.thinking, thKeep, { cols, markdown: false });
      if (sp) {
        turn.thinkingChunks.push(turn.thinking.slice(0, sp.cut));
        turn.thinking = turn.thinking.slice(sp.cut);
      }
    }
    if (tx > txKeep) {
      const sp = findStreamSplit(turn.text, txKeep, { cols, markdown: true });
      if (sp) {
        let prefix = turn.text.slice(0, sp.cut);
        let rest = turn.text.slice(sp.cut);
        // 切在代码块内部：前缀补闭合围栏、余量重开同语种围栏，两侧各自渲染正确
        if (sp.closeFence) prefix += sp.closeFence;
        if (sp.openFence) rest = sp.openFence + rest;
        turn.chunks.push(prefix);
        turn.text = rest;
      }
    }
  }

  /** 终端窗口变化：重新评估防溢出（缩小终端可能让原本合规的尾部超预算）；
   * 流式追加时也会自动重估，这里兜住"缩小后无新 delta"的空窗。 */
  handleResize() {
    const last = this.turns[this.turns.length - 1];
    if (last) this.enforceLiveHeight(last);
    this.bump();
  }

  // ── busy / thinking ─────────────────────────────────────────
  setBusy(text: string | null) {
    // 同文案且已启动 → 幂等跳过（避免重复 start 刷新计时基准）
    if (this.busy === text && (text === null || this.busySince !== null)) return;
    this.busy = text;
    if (text === null) {
      this.busySince = null;
      this.busyThinking = false;
      this.busyInputTokens = 0;
    } else {
      this.busySince = Date.now();
      this.busyThinking = false;
      this.busyInputTokens = 0;
    }
    this.bump();
  }

  /** thinking 相位标签：模型思考期置 true，状态行追加 "· thinking" */
  setBusyThinking(thinking: boolean) {
    if (this.busyThinking === thinking) return;
    this.busyThinking = thinking;
    this.bump();
  }

  /** busy 行 input token 回填（绝对值设置：估算 → 真实值覆盖） */
  setBusyTokens(inputTokens: number) {
    if (this.busyInputTokens === inputTokens) return;
    this.busyInputTokens = inputTokens;
    this.bump();
  }

  /** 模型调用完成：真实用量落当前 assistant turn（busy 清空后仍可见） */
  setTurnUsage(usage: NonNullable<Turn['usage']>, elapsedMs: number) {
    const turn = this.activeAssistant();
    if (!turn) return;
    turn.usage = usage;
    turn.elapsedMs = elapsedMs;
    this.bump();
  }

  // ── 交互选择（权限确认）─────────────────────────────────────
  ask(question: string, options: AskOption[]): Promise<string> {
    return new Promise((resolve) => {
      this.askState = { question, options };
      this.askResolver = resolve;
      this.bump();
    });
  }

  /** 由 Confirm 组件调用，交付答案并关闭 */
  resolveAsk(value: string) {
    const res = this.askResolver;
    this.askState = null;
    this.askResolver = null;
    this.bump();
    res?.(value);
  }

  /** 多步向导提问：resolve 值 = 各步答案文本，或 __cancel__（由 Wizard 拼）。
   * multi=true 时分步多选（每步勾选多个选项）。 */
  askWizard(question: string, steps: WizardStep[], multi = false): Promise<string> {
    return new Promise((resolve) => {
      this.askWizardState = { question, steps, multi };
      this.askResolver = resolve;
      this.bump();
    });
  }

  /** 由 Wizard 提交/取消时关闭 */
  resolveAskWizard(value: string) {
    const res = this.askResolver;
    this.askWizardState = null;
    this.askResolver = null;
    this.bump();
    res?.(value);
  }

  /** 文本输入提问：返回用户输入（Esc 取消 → null） */
  askText(question: string): Promise<string | null> {
    return new Promise((resolve) => {
      this.askTextState = { question };
      this.askTextResolver = resolve;
      this.bump();
    });
  }

  resolveAskText(value: string, cancelled = false) {
    const res = this.askTextResolver;
    this.askTextState = null;
    this.askTextResolver = null;
    this.bump();
    res?.(cancelled ? null : value);
  }

  // ── / 斜杠菜单 ─────────────────────────────────────────────
  openSlash(query = '') {
    this.slashOpen = true;
    this.slashQuery = query;
    this.bump();
  }

  closeSlash() {
    if (!this.slashOpen) return;
    this.slashOpen = false;
    this.slashQuery = '';
    this.bump();
  }

  setSlashQuery(query: string) {
    this.slashQuery = query;
    this.bump();
  }

  setSlashItems(items: SlashItem[]) {
    this.slashItems = items;
    this.bump();
  }

  /** Ctrl+O：切换工具输出面板（force 可指定开/关） */
  toggleOutputPanel(force?: boolean) {
    this.outputPanel = force ?? !this.outputPanel;
    this.bump();
  }

  /** 设置模型自管待办（Agent.onTodos 接线；UI 底部清单视图） */
  setTodos(todos: { content: string; status: 'pending' | 'in_progress' | 'completed' }[]) {
    this.todos = todos;
    // 待办面板变高 → live 预算变小 → 已流式的内容可能从"合规"变"超预算"。
    // 这里必须重估：否则残留的 live 正文会把整帧顶过终端高度，触发 ink 整屏清屏。
    this.reflowLive();
    this.bump();
  }

  /**
   * 按**当前**底部面板高度重估 live 高度。
   *
   * 面板出现/增高/消失都会改变 liveLineBudget()，而 enforceLiveHeight 只在流式
   * 追加时被调用——面板变化后若不重估，live 区残留内容（正文、thinking）就会
   * 超出新预算，整帧高于终端 → ink 走整屏清屏分支（ESC[3J 连 scrollback 一起清），
   * 用户回看位置被重置。这是"任务清单一出现就跳到最底部"的直接原因。
   */
  private reflowLive() {
    const last = this.turns[this.turns.length - 1];
    if (last) this.enforceLiveHeight(last);
  }

  // ── 用户自管待办（/todo）────────────────────────────────────

  /**
   * 覆盖用户待办（编辑器内每次变更传入全量新数组 → 内存 + 落盘）。
   * 不在 clearAll 里清：这是用户自己的清单，与对话历史无关，/clear 不该抹掉它。
   */
  setUserTodos(todos: UserTodo[]) {
    this.userTodos = todos;
    this.persistUserTodos?.(todos);
    this.bump();
  }

  /** 打开/关闭 /todo 交互编辑器 */
  setUserTodoOpen(open: boolean) {
    if (this.userTodoOpen === open) return;
    this.userTodoOpen = open;
    this.bump();
  }

  /** 设置版本升级提示（启动异步检查完成回填；触发底部 ModeBar 重渲染） */
  setUpdateInfo(info: { current: string; latest: string } | null) {
    this.updateInfo = info;
    this.bump();
  }

  /** 所有模式（按循环顺序排列） */
  static readonly MODE_CYCLE: Mode[] = ['default', 'plan', 'auto', 'bypass'];

  /** 切换模式：循环到下一个（Shift+Tab 向后循环） */
  cycleMode(forward = true) {
    const cycle = AppController.MODE_CYCLE;
    const idx = cycle.indexOf(this.mode);
    if (idx === -1) {
      this.mode = 'default';
      return;
    }
    const next = forward ? cycle[(idx + 1) % cycle.length]! : cycle[(idx - 1 + cycle.length) % cycle.length]!;
    this.mode = next;
    this.bump();
  }

  /** 设置模式（由 CLI 外部调用同步） */
  setMode(mode: Mode) {
    this.mode = mode;
    this.bump();
  }
}
