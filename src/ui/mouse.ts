import { PassThrough } from 'node:stream';

/**
 * 终端鼠标滚轮支持。
 *
 * ## 为什么必须自己实现
 *
 * ink 8 没有鼠标 API，而且它**会主动丢弃未识别的控制序列**（release notes：
 * "useInput no longer receives unrecognized terminal control sequences"）。
 * 鼠标报告正是这类序列——所以不能指望 `useInput` 里拿到它，必须在**喂给 ink 之前**拦下来。
 *
 * ## 终端鼠标协议
 *
 * 开启 SGR 扩展模式（`\x1b[?1000h` + `\x1b[?1006h`）后，终端把鼠标事件作为
 * 转义序列写进 stdin：
 *
 *   `\x1b[<B;X;YM`  按下（M）
 *   `\x1b[<B;X;Ym`  释放（m）
 *
 * 其中 B 是按钮号 + 修饰位：
 *   - 64 = 滚轮上
 *   - 65 = 滚轮下
 *   - 32 = 按住 Shift（常与滚轮组合，如 64+32=96）
 *
 * 不需要按钮位之外的精度——只关心"滚轮上/下"。
 *
 * ## 注意
 *
 * 开启鼠标追踪后，终端的**原生选中复制**会被应用接管（点选不再选中文本）。
 * 这是终端应用的固有取舍（vim/htop 同样如此）；用户按住 Shift 拖动即可恢复原生选中。
 */

/** 滚轮上 / 下的按钮号（基线值，需先清掉修饰位） */
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;

/** 完整鼠标序列：CSI < B ; X ; Y M/m */
const MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
/** 可能是鼠标序列前缀（跨 chunk 断裂时留到下次） */
const MOUSE_PREFIX_RE = /^\x1b(\[<[\d;]*)?$/;
/** 未收全的残留上限：超过则当普通输入转发（防畸形序列卡死） */
const MAX_PENDING = 32;

export interface MouseEvent {
  /** 滚轮方向；非滚轮事件为 null */
  wheel: 'up' | 'down' | null;
  /** 终端列（1-based） */
  x: number;
  /** 终端行（1-based，相对当前视口） */
  y: number;
}

/** 剥出鼠标序列的解析器：从输入流里摘掉鼠标报告，其余原样转发 */
export class MouseParser {
  private pending = '';

  /** @returns 剩余可转发内容 + 解析到的鼠标事件 */
  push(chunk: string): { rest: string; events: MouseEvent[] } {
    const s = this.pending + chunk;
    const events: MouseEvent[] = [];
    let rest = '';
    let i = 0;

    while (i < s.length) {
      if (s[i] === '\x1b') {
        const tail = s.slice(i);
        const m = MOUSE_RE.exec(tail);
        if (m) {
          const button = Number.parseInt(m[1]!, 10);
          // 清掉修饰位（Shift=4, Alt=8, Ctrl=16, 追加位=32），只看基础按钮号
          const base = button & ~0b111100;
          const wheel = base === WHEEL_UP ? 'up' : base === WHEEL_DOWN ? 'down' : null;
          events.push({
            wheel,
            x: Number.parseInt(m[2]!, 10),
            y: Number.parseInt(m[3]!, 10),
          });
          i += m[0].length;
          continue;
        }
        // 疑似鼠标序列前缀（跨 chunk 断裂）：留到下次再试
        if (MOUSE_PREFIX_RE.test(tail) && tail.length < MAX_PENDING) {
          this.pending = tail;
          return { rest, events };
        }
      }
      rest += s[i];
      i++;
    }

    this.pending = '';
    return { rest, events };
  }

  /** 取出残留（销毁时调用，避免吞掉用户最后的输入） */
  flush(): string {
    const p = this.pending;
    this.pending = '';
    return p;
  }
}

/** 开启鼠标追踪（滚轮 + SGR 扩展模式，带坐标） */
export const MOUSE_ENABLE = '\x1b[?1000h\x1b[?1006h';
/** 关闭鼠标追踪 */
export const MOUSE_DISABLE = '\x1b[?1000l\x1b[?1006l';

/**
 * 构造一个过滤流：鼠标序列被摘出来走 `onMouse`，其余输入原样喂给 ink。
 *
 * isTTY / setRawMode / ref / unref 透传给真实 stdin——ink 靠这几项判断能否
 * 进入 raw mode 并接管终端。
 */
export function createMouseFilteredInput(
  stdin: NodeJS.ReadStream,
  onMouse: (ev: MouseEvent) => void,
): { input: NodeJS.ReadStream; dispose: () => void } {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const parser = new MouseParser();

  Object.defineProperties(input, {
    isTTY: { value: stdin.isTTY, configurable: true, enumerable: true },
    setRawMode: {
      value: (mode: boolean) => {
        if (typeof stdin.setRawMode === 'function') stdin.setRawMode(mode);
      },
      configurable: true,
    },
    ref: { value: () => stdin.ref(), configurable: true },
    unref: { value: () => stdin.unref(), configurable: true },
  });

  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const { rest, events } = parser.push(text);
    for (const ev of events) {
      if (ev.wheel) onMouse(ev);
    }
    if (rest) input.write(rest);
  };

  stdin.on('data', onData);

  return {
    input,
    dispose: () => {
      stdin.off('data', onData);
      const left = parser.flush();
      if (left) input.write(left);
    },
  };
}
