/**
 * 忙碌期输入分流与提示词队列（纯逻辑，不依赖 UI/Agent，便于单测）。
 *
 * ## 要解决的问题
 *
 * 模型在跑（`running`）时，用户的第二次输入曾经被 `cli.handle` 开头的
 * `if (running) return;` 整体丢弃——连带 `/skills`、`/mcp` 这类**纯本地**命令
 * 也打不开面板（它们根本不碰模型）。这里把输入分成两类：
 *
 *   - `local`：不涉及模型、随时都能立刻执行的命令（面板/查询/待办）。
 *     忙碌期**立即执行**，这是「思考中 /skills 打不开」的修复点。
 *   - `chat`：要发给模型（普通对话、/clear、技能调用…）。
 *     忙碌期**排队**，当前轮结束后按序自动发出，一条都不丢。
 *
 * 判定刻意用**白名单**而不是黑名单：新增命令默认走「排队」这条安全侧路径，
 * 不会因为忘了登记而在忙碌期误执行。
 */

/** 用户输入的分类结果 */
export type InputClass = 'local' | 'chat';

/**
 * 忙碌期可立即执行的命令名（不带 `/`）。
 *
 * 收录标准：**执行它不会与正在跑的这一轮抢 Agent 状态**。
 *   - `/skills` `/mcp`：只读快照 + 开关 settings，不碰 messages
 *   - `/help` `/cost` `/todos`：纯查询
 *   - `/todo`：改的是**用户自管**待办，与模型上下文无关
 *   - `/export`：只读当前历史写文件
 *   - `/model`：仅查询态安全；带参数切换模型会改动在飞调用的 model，
 *     因此**带参数时归 chat**（见 classifyInput）
 */
const LOCAL_COMMANDS = new Set([
  'skills',
  'mcp',
  'help',
  'cost',
  'todos',
  'todo',
  'todo_clear',
  'export',
  'model',
  'btw',
]);

/** 从 `/name args` 里取命令名（大小写敏感：内置命令都是小写） */
export function commandName(line: string): string | null {
  const m = /^\/(\S+)/.exec(line.trim());
  return m ? (m[1] ?? null) : null;
}

/**
 * 输入分类。
 *
 * `local` 的充分条件：是 `/` 命令、名字在白名单里，**且**没有「会改动在飞状态」的参数。
 * 其余一律 `chat`（含普通对话、技能、`/clear`、`/compact`、`/rewind`、`/plan` 等）。
 */
export function classifyInput(line: string): InputClass {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return 'chat';
  const name = commandName(trimmed);
  if (!name || !LOCAL_COMMANDS.has(name)) return 'chat';
  // `/model <名>` 会切换在飞调用的模型 → 归 chat；裸 `/model` 只是查询
  if (name === 'model') {
    const rest = trimmed.slice('/model'.length).trim();
    return rest ? 'chat' : 'local';
  }
  // `/btw` 要跑模型，但它**不写主历史、不打断主线**，所以仍归 local：
  // 忙碌期问一句旁支问题，本来就该立刻得到回答（这正是 /btw 的卖点）。
  // 这里显式写出来，避免后来的人把 btw 从白名单"优化"掉。
  return 'local';
}

/** 队列上限：防止脚本式狂刷把内存撑爆（正常交互远达不到） */
export const MAX_QUEUED_PROMPTS = 20;

/**
 * 忙碌期提示词队列（FIFO）。
 *
 * 只做数据容器，不持有任何回调：**谁把元素取走并发送**由 cli 决定——
 * 队列自己触发发送会让「UI 出队」与「cli 出队」两处竞争，变成发一次丢一条。
 */
export class PromptQueue {
  private items: string[] = [];

  /** 追加到队尾；空串忽略。超上限时**丢弃最旧的**（保留最近意图更符合直觉） */
  push(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    this.items.push(t);
    if (this.items.length > MAX_QUEUED_PROMPTS) {
      this.items.splice(0, this.items.length - MAX_QUEUED_PROMPTS);
    }
    return true;
  }

  /** 插到队首（Ctrl+Enter 强插用：打断后这条要最先发） */
  pushFront(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    this.items.unshift(t);
    if (this.items.length > MAX_QUEUED_PROMPTS) {
      this.items.length = MAX_QUEUED_PROMPTS;
    }
    return true;
  }

  /** 取队首并从队列移除；空队列返回 null */
  shift(): string | null {
    return this.items.shift() ?? null;
  }

  /** 只读快照（供 UI 展示队列条数/内容） */
  snapshot(): string[] {
    return [...this.items];
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }
}
