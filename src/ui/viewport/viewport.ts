/**
 * 滚动视口的纯逻辑（不依赖 React/ink，便于单测）。
 *
 * 为什么需要它：ink 8 的 `contentOffsetY` + `overflow="hidden"` 让"应用内滚动"成为可能——
 * 历史由我们自己画在固定高度的视口里，滚动位置是自己的状态。这与之前"把历史交给终端
 * scrollback（<Static>）"是两套完全不同的模型。
 *
 * 旧模型必须保证 live 帧恒小于终端高度，为此堆了 CPR 探测、估算切片、分段提交三层补偿，
 * 且窗口 resize 时 ink 按旧布局行数擦除新布局内容，历史必然花掉。新模型下内容重排只是
 * "重新布局同一帧"，没有擦旧帧这一步，resize 天然正确。
 */

/** 滚动位置状态：距底部的行数 + 是否跟随（贴底自动滚动） */
export interface ScrollState {
  /** 距内容底部的行数。0 = 贴底；正数 = 向上滚了多少 */
  fromBottom: number;
  /** 是否跟随（新内容到来时自动贴底）。用户一旦上滚即置 false */
  following: boolean;
}

export const INITIAL_SCROLL: ScrollState = { fromBottom: 0, following: true };

/**
 * 由"距底部行数"算出实际 `contentOffsetY`。
 *
 * 存 distance-from-bottom 而非绝对 offset 是刻意的：
 * resize 后内容高度/视口高度都会变，绝对 offset 会让画面跳到毫不相干的位置；
 * 而"距底部 N 行"的语义在 resize 前后一致（用户看的是内容末尾附近）。
 */
export function scrollTopFor(fromBottom: number, contentHeight: number, viewportHeight: number): number {
  const max = maxScrollTop(contentHeight, viewportHeight);
  // fromBottom 越大越靠上，故 offset = max - fromBottom
  return clamp(max - fromBottom, 0, max);
}

/** 最大可滚动偏移（内容比视口矮时为 0） */
export function maxScrollTop(contentHeight: number, viewportHeight: number): number {
  return Math.max(0, contentHeight - viewportHeight);
}

/** 是否贴底（容差吸收布局抖动，避免边缘反复切换 following） */
export function isAtBottom(fromBottom: number, tolerance = 0): boolean {
  return fromBottom <= tolerance;
}

/**
 * 上滚 n 行。滚离底部即停止跟随——这是新模型下"用户要回看历史"的唯一信号，
 * 取代了旧实现里靠 CPR 问终端光标位置的做法。
 */
export function scrollUp(state: ScrollState, lines: number): ScrollState {
  return { fromBottom: state.fromBottom + Math.max(lines, 0), following: false };
}

/**
 * 下滚 n 行。滚到底部自动恢复跟随——这样用户回看后按 ↓/End 就能回到"实时"状态。
 */
export function scrollDown(state: ScrollState, lines: number): ScrollState {
  const fromBottom = Math.max(0, state.fromBottom - Math.max(lines, 0));
  return { fromBottom, following: fromBottom === 0 };
}

/** 回到贴底并恢复跟随（提交新消息、End 键、新内容到来时调用） */
export function scrollToBottom(): ScrollState {
  return { fromBottom: 0, following: true };
}

/**
 * 终端的行数变化后修正滚动状态。
 *
 * 这是新模型相对旧实现的核心优势：旧实现在 resize 时只能祈祷 ink 擦对位置；
 * 这里我们可以主动决策——视口变高就少滚几行（内容相对下移），保持用户看到的内容不跳。
 *
 * @param heightDelta 视口高度变化（正 = 变高）
 */
export function adjustForResize(state: ScrollState, heightDelta: number): ScrollState {
  if (heightDelta === 0 || state.following) return state;
  // 视口变高 → 同样内容占的行更少 → 距底部行数应等量减少（保持视觉位置）
  const fromBottom = Math.max(0, state.fromBottom - heightDelta);
  return { fromBottom, following: fromBottom === 0 };
}

/** clamp（内容变短或终端变高时，旧 offset 可能越界） */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 列表的滚动窗口：给定光标位置与可见条数，算出该渲染哪一段 [start, end)。
 *
 * 核心不变式：**光标项必须落在窗口内**。这是"被裁掉的项永远看不到"的解药——
 * 光标下移穿过窗口下沿时，窗口跟着一起滚，最后一项也能翻到。
 *
 * 窗口采用"光标居中偏下"策略（靠近末尾时贴底）：光标移动时内容不会每步都跳一整屏，
 * 同时又能保证末尾能看到足够的上下文。
 *
 * 斜杠菜单（`slashWindow`）与能力面板共用这套语义，行为一致用户才不会困惑。
 */
export function scrollWindow(idx: number, length: number, maxVisible: number): [number, number] {
  if (length <= maxVisible || maxVisible <= 0) return [0, length];
  // 居中：让光标大致在窗口中段，上下都留视野
  const half = Math.floor(maxVisible / 2);
  const start = clamp(idx - half, 0, length - maxVisible);
  return [start, Math.min(start + maxVisible, length)];
}
