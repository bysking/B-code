/**
 * 终端 UI 原语：spinner（模型思考 / 工具执行期间的 loading 提示）。
 *
 * 设计约束：
 * - 走 stderr：stdout 专供模型文本，管线/one-shot 输出不被动画污染。
 * - TTY 门控：进程未连接终端（管道/CI/测试）时自动静默，零写入——
 *   避免动画帧刷进日志/测试输出。Agent 默认实例即自动禁用，无需显式处理。
 * - 可注入 stream/enabled，供测试确定性验证。
 */

export interface SpinnerLike {
  start(msg: string): void;
  update?(msg: string): void;
  stop(): void;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;
const CLEAR = "\r\x1b[K"; // 擦除当前行并回到行首

export class Spinner implements SpinnerLike {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private msg = "";
  private active = false; // stop 幂等闸：未 start 或已 stop 时不写入

  constructor(
    private readonly stream: { write(s: string): unknown } = process.stderr,
    private readonly enabled: boolean = Boolean(process.stderr.isTTY),
  ) {}

  start(msg: string): void {
    this.msg = msg;
    if (!this.enabled) return;
    this.stop(); // 上一轮若残留先清掉
    this.active = true;
    this.frame = 0;
    this.render();
    this.timer = setInterval(() => {
      this.frame++;
      this.render();
    }, FRAME_MS);
  }

  update(msg: string): void {
    this.msg = msg;
  }

  /** 停止并擦除 spinner 行，光标回到行首（幂等：未 start / 已 stop 时零写入） */
  stop(): void {
    if (!this.enabled || !this.active) return;
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stream.write(CLEAR);
  }

  private render(): void {
    this.stream.write(`${CLEAR}${FRAMES[this.frame % FRAMES.length]} ${this.msg}`);
  }
}