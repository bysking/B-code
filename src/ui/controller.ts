/**
 * AppController —— TTY 模式下 CLI 与 ink 组件树之间的状态总线。
 *
 * 纯 TS（不依赖 ink/React），可单测。Agent 的 print/askUser/spinner/events
 * 都汇入这里；React 侧用 useSyncExternalStore(ctrl.subscribe, ctrl.getSnapshot)
 * 订阅渲染。非 TTY 路径不使用本类（保持 raw 直写）。
 */

export interface ToolCallDisplay {
  id: number;
  name: string;
  input: string;
  done: boolean;
  /** 工具/子 agent 的真实输出（Ctrl+O 面板回看用；可能被截断过） */
  output?: string;
}

export interface Turn {
  id: number;
  role: "user" | "assistant";
  text: string;
  tools: ToolCallDisplay[];
  /** assistant 正在流式输出中 */
  streaming: boolean;
}

export interface AskOption {
  label: string;
  value: string;
}

export interface AskState {
  question: string;
  options: AskOption[];
}

/** 两级选择（tab 组 × 组内选项） */
export interface AskGroupState {
  question: string;
  groups: { title: string; options: AskOption[] }[];
}

export interface SlashItem {
  name: string;
  description: string;
}

function prettyInput(input: unknown): string {
  const s = JSON.stringify(input);
  if (!s || s === "{}") return "";
  return s.length > 80 ? s.slice(0, 77) + "…" : s;
}

export class AppController {
  turns: Turn[] = [];
  /** 固定输出行：(resumed…) / (done) / 告警等 */
  output: string[] = [];
  /** 顶部 busy/thinking 文案（null = 空闲） */
  busy: string | null = null;
  /** 待回答的选择（权限确认等）；null = 无（字段与方法 ask() 区分命名） */
  askState: AskState | null = null;
  /** 两级选择（tab 组）：非空时 TabsSelect 渲染，替代单层 Select */
  askGroup: AskGroupState | null = null;
  /** / 斜杠菜单状态 */
  slashOpen = false;
  slashQuery = "";
  slashItems: SlashItem[] = [];
  /** Ctrl+O 工具输出面板（展示全部已执行工具的真实输出） */
  outputPanel = false;
  /** 文本输入提问（askText）：null = 无 */
  askTextState: { question: string } | null = null;

  private askTextResolver: ((value: string | null) => void) | null = null;

  private nextToolId = 0;
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
  pushOutput(line: string) {
    this.output.push(line);
    this.bump();
  }

  /** /clear：重置对话与固定输出行 */
  clearAll() {
    this.turns = [];
    this.output = [];
    this.busy = null;
    this.bump();
  }

  pushUser(text: string) {
    const id = ++this.nextUserTurnId;
    this.turns.push({ id, role: "user", text, tools: [], streaming: false });
    this.bump();
  }

  /** 流式文本：首个 delta 开新 assistant turn，其后追加 */
  streamText(delta: string) {
    const last = this.turns[this.turns.length - 1];
    if (last && last.role === "assistant" && last.streaming) last.text += delta;
    else this.turns.push({ id: ++this.nextUserTurnId, role: "assistant", text: delta, tools: [], streaming: true });
    this.bump();
  }

  /** 恢复会话：把最近几轮灌进消息流渲染（id 重新分配，避免与后续新轮冲突） */
  loadTurns(turns: Array<Omit<Turn, "id">>) {
    this.turns = turns.map((t, i) => ({ ...t, id: i + 1 }));
    this.nextUserTurnId = Math.max(this.nextUserTurnId, this.turns.length);
    this.bump();
  }

  /** 模型本轮结束（assistant 不再追加） */
  finishStream() {
    const last = this.turns[this.turns.length - 1];
    if (last?.role === "assistant" && last.streaming) {
      last.streaming = false;
      this.bump();
    }
  }

  // ── 工具调用块 ──────────────────────────────────────────────
  private activeAssistant(): Turn | null {
    const last = this.turns[this.turns.length - 1];
    return last?.role === "assistant" ? last : null;
  }

  toolStart(name: string, input: unknown) {
    const turn = this.activeAssistant() ?? this.annotationTurn();
    turn.tools.push({ id: ++this.nextToolId, name, input: prettyInput(input), done: false });
    this.bump();
  }

  toolEnd(name: string, output?: string) {
    const turn = this.activeAssistant();
    const tool = turn?.tools.filter((t) => t.name === name && !t.done).at(-1);
    if (tool) {
      tool.done = true;
      if (output !== undefined) tool.output = output;
      this.bump();
    }
  }

  private annotationTurn(): Turn {
    const t: Turn = { id: ++this.nextUserTurnId, role: "assistant", text: "", tools: [], streaming: false };
    this.turns.push(t);
    return t;
  }

  // ── busy / thinking ─────────────────────────────────────────
  setBusy(text: string | null) {
    if (this.busy === text) return;
    this.busy = text;
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

  /** 由 Select 组件调用，交付答案并关闭 */
  resolveAsk(value: string) {
    const res = this.askResolver;
    this.askState = null;
    this.askResolver = null;
    this.bump();
    res?.(value);
  }

  /** 两级（tab 组）选择提问 */
  askGrouped(
    question: string,
    groups: { title: string; options: AskOption[] }[],
  ): Promise<string> {
    return new Promise((resolve) => {
      this.askGroup = { question, groups };
      this.askResolver = resolve;
      this.bump();
    });
  }

  /** 由 TabsSelect 调用交付并关闭 */
  resolveAskGroup(value: string) {
    const res = this.askResolver;
    this.askGroup = null;
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
  openSlash(query = "") {
    this.slashOpen = true;
    this.slashQuery = query;
    this.bump();
  }

  closeSlash() {
    if (!this.slashOpen) return;
    this.slashOpen = false;
    this.slashQuery = "";
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
}