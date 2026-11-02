/**
 * 智能跟随（Smart Follow）：视口停在底部时才滚动跟随，否则冻结画面让用户回看。
 *
 * 背景：终端应用无法直接读取用户的滚动位置。程序每次往终端写内容，终端都会把
 * 视口拉到光标处——这正是"用户向上回看历史时被拽回底部"的根因。要满足
 *
 *   "输出照常进行，但只有视口本来就在底部时才跟随"
 *
 * 必须做两件事：① 探测视口是否在底部；② 不在底部时让写入静默。
 *
 * 探测：CPR（Cursor Position Report）。向终端写 DSR 序列 `\x1b[6n`，终端立即回
 * `\x1b[{row};{col}R`，row 是光标相对视口顶部的行号。用户向上滚动后，光标落到
 * 视口下方，row 会超过终端行数，超出的行数≈距底部的距离。
 * 终端不支持上报屏幕外光标位置时会恒返回 row ≤ rows，此时判定恒在底部 →
 * 退化为"始终跟随"（等同改动前的行为，不会变差）；连续无响应则彻底停止探测。
 *
 * 冻结：判定离底后，UI 渲染"最后一份跟随态快照"——输出逐字节不变 → ink 的
 * log-update 判定无变化 → 零写入 → 视口不动。内容本身照常生成（controller 不受
 * 影响），回到底部后一次性补齐。
 *
 * CPR 响应必须从输入里剥离：否则会被输入框当成普通字符插进草稿。
 */
import { StringDecoder } from 'node:string_decoder';
import { PassThrough } from 'node:stream';

/** 距底部容差（行）：吸收尾部换行/渲染误差，避免边缘反复抖动 */
const DEFAULT_TOLERANCE = 2;
/** 探测间隔（ms）：太密造成响应洪水，太疏则回滚/回底响应迟钝 */
const DEFAULT_INTERVAL_MS = 600;
/** 单次 CPR 等待上限（ms）：超时视为本轮无响应 */
const CPR_TIMEOUT_MS = 200;
/** 连续无响应达到该次数 → 判定终端不支持，停止探测 */
const MAX_MISSES = 3;
/** 未收全的 CPR 前缀缓冲上限：超过则不再等待，直接转发（防畸形输入卡死） */
const MAX_PENDING = 32;

/** DSR：查询光标位置 */
const CPR_REQUEST = '\x1b[6n';
/** 完整 CPR 响应：CSI row ; col R */
const CPR_FULL_RE = /^\x1b\[(\d+);(\d+)R/;
/** 可能是 CPR 前缀的尾部：\x1b / \x1b[ / \x1b[12 / \x1b[12; / \x1b[12;3 */
const CPR_PARTIAL_RE = /^\x1b(\[\d*(;\d*)?)?$/;

/**
 * CPR 响应解析器：从输入流里剥掉 `\x1b[{row};{col}R`，其余字节原样吐出。
 *
 * 响应可能跨 chunk 断开（`\x1b[12` / `;1R`），因此把疑似未收全的尾部留到下次；
 * 但残留超过 MAX_PENDING 就不再等待——宁可把畸形序列当普通输入转发，也不卡住输入。
 */
export class CprParser {
  private pending = '';

  /** 剥离 CPR 响应；返回可转发内容与解析到的光标行号（同一 chunk 可能含多条） */
  push(chunk: string): { rest: string; rows: number[] } {
    const s = this.pending + chunk;
    const rows: number[] = [];
    let rest = '';
    let i = 0;
    while (i < s.length) {
      if (s[i] === '\x1b') {
        const tail = s.slice(i);
        const full = CPR_FULL_RE.exec(tail);
        if (full) {
          rows.push(Number.parseInt(full[1]!, 10));
          i += full[0].length;
          continue;
        }
        // 疑似未收全（或畸形）的转义序列：留到下次再试
        if (CPR_PARTIAL_RE.test(tail) && tail.length < MAX_PENDING) {
          this.pending = tail;
          return { rest, rows };
        }
      }
      rest += s[i];
      i++;
    }
    this.pending = '';
    return { rest, rows };
  }

  /** 取出残留（销毁时调用，避免吞掉用户最后的输入） */
  flush(): string {
    const p = this.pending;
    this.pending = '';
    return p;
  }
}

export interface ScrollFollowOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  intervalMs?: number;
  tolerance?: number;
}

export interface ScrollFollow {
  /** 交给 ink 的输入流：CPR 响应已剥离，其余输入原样透传 */
  readonly input: NodeJS.ReadStream;
  /** 当前是否跟随（false = 用户已滚离底部，画面冻结中） */
  isFollowing(): boolean;
  subscribe(cb: () => void): () => void;
  /** 强制回到跟随：用户主动交互（提交新消息/弹出确认框）时调用 */
  follow(): void;
  dispose(): void;
}

/**
 * 构造一个可替代 process.stdin 喂给 ink 的流：
 * PassThrough 承接过滤后的输入，isTTY/setRawMode/ref/unref 透传给真实 stdin
 * （ink 靠这几项判断能否进 raw mode 并接管终端）。
 *
 * onRawMode：ink 调用 setRawMode(true) 的时机就是"终端已由应用接管"，
 * 滚动探测必须等到这一刻之后才能发——否则在 cooked 模式下终端会把 CPR
 * 应答回显到屏幕上（用户会看到 "[37;1R" 之类的乱码，帧定位也被打乱）。
 */
function createFilteredInput(
  stdin: NodeJS.ReadStream,
  onRawMode?: () => void,
  onRawModeOff?: () => void,
): NodeJS.ReadStream {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.defineProperties(input, {
    isTTY: { value: stdin.isTTY, configurable: true, enumerable: true },
    setRawMode: {
      value: (mode: boolean) => {
        if (typeof stdin.setRawMode === 'function') stdin.setRawMode(mode);
        if (mode) onRawMode?.();
        else onRawModeOff?.();
      },
      configurable: true,
    },
    ref: { value: () => stdin.ref(), configurable: true },
    unref: { value: () => stdin.unref(), configurable: true },
  });
  return input;
}

/**
 * 创建智能跟随控制器。非 TTY（管道/CI/测试）时恒跟随且不探测——
 * 与改动前行为一致，零副作用。
 */
export function createScrollFollow(opts: ScrollFollowOptions = {}): ScrollFollow {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  const enabled = Boolean(stdout.isTTY && stdin.isTTY);

  const parser = new CprParser();
  const decoder = new StringDecoder('utf8');
  const listeners = new Set<() => void>();

  let following = true;
  let disposed = false;
  let awaiting = false; // 已发探测、等响应
  let misses = 0; // 连续无响应次数
  let timer: ReturnType<typeof setInterval> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  const notify = (): void => {
    for (const l of listeners) l();
  };

  const setFollowing = (next: boolean): void => {
    if (following === next) return;
    following = next;
    notify();
  };

  const clearTimeoutTimer = (): void => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
  };

  /** 收到 CPR 响应：row 超过终端行数 + 容差 → 光标在视口下方 → 用户已滚离底部 */
  const onCpr = (row: number): void => {
    awaiting = false;
    misses = 0;
    clearTimeoutTimer();
    const rows = stdout.rows || 40;
    setFollowing(row <= rows + tolerance);
  };

  const stopProbing = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    clearTimeoutTimer();
  };

  const probe = (): void => {
    if (disposed || awaiting) return; // 上一轮还没回，跳过，避免响应堆积
    awaiting = true;
    stdout.write(CPR_REQUEST);
    timeoutTimer = setTimeout(() => {
      awaiting = false;
      timeoutTimer = null;
      if (++misses >= MAX_MISSES) {
        // 终端不支持 CPR：停止探测，退化为恒跟随（不打扰用户）
        stopProbing();
        setFollowing(true);
      }
    }, CPR_TIMEOUT_MS);
    timeoutTimer.unref?.();
  };

  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    const { rest, rows } = parser.push(text);
    for (const r of rows) onCpr(r);
    if (rest) input.write(rest);
  };

  /**
   * 启动探测：只由 setRawMode(true) 触发（终端已接管，CPR 不会被回显）。
   *
   * 首次探测延后一个 interval：ink 在 setRawMode(true) 之后才挂 readable 监听器，
   * 若紧接着就发 CPR，应答可能早于监听器就绪到达；而 'readable' 只在"状态由空转
   * 非空"时触发一次，一旦错过就不会再触发，首个应答会被永久卡在缓冲里。
   * 延后一拍既避开竞态，也不影响体验（跟随判定晚 600ms 无感）。
   */
  const startProbing = (): void => {
    if (!enabled || timer || disposed) return;
    timer = setInterval(probe, intervalMs);
    timer.unref?.();
  };

  // 过滤流与探测开关都在此接线（startProbing/stopProbing 已定义，无 TDZ 顾虑）：
  // setRawMode(true) = ink 接管终端 → 开始探测；false = 交还终端 → 停止（否则回显）
  const input = createFilteredInput(
    stdin,
    () => startProbing(),
    () => stopProbing(),
  );

  // 输入过滤必须始终挂上（即使不探测）：CPR 响应若漏进过滤流会被输入框当普通
  // 字符插入，草稿里冒出 "[12;3R" 之类的垃圾。非 TTY 下不会有 CPR，纯透传。
  if (!disposed) stdin.on('data', onData);

  return {
    input,
    isFollowing: () => following,
    subscribe: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    follow: () => {
      misses = 0;
      setFollowing(true);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stopProbing();
      stdin.off?.('data', onData);
      const left = parser.flush();
      if (left) input.write(left);
      listeners.clear();
    },
  };
}
