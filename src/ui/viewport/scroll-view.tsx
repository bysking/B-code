import React, { useEffect, useRef } from 'react';
import { Box, useBoxMetrics } from 'ink';
import {
  adjustForResize,
  clamp,
  maxScrollTop,
  scrollTopFor,
  scrollToBottom,
  type ScrollState,
} from './viewport.js';

/**
 * 应用内滚动视口（ink 8 的 `contentOffsetY` + `overflow="hidden"`）。
 *
 * 历史内容画在视口里，超出部分被裁剪，靠 `contentOffsetY` 平移——内容不进入终端
 * scrollback，因此窗口 resize 时不存在"按旧布局行数擦除新内容"这种必然花屏的路径。
 *
 * 高度交给 **Yoga flexGrow** 算（不传 height 时）：视口与底部面板是兄弟节点，
 * Yoga 把剩余高度分给视口。这比"终端行数减去估算的底栏行数"可靠得多——
 * 后者永远会估偏（面板折行、CJK 宽度、markdown 膨胀）。
 *
 * 两个必须照做的细节（来自 ink 官方 scroll 示例）：
 *   1. **每帧 clamp**：内容变短或视口变高会让最大偏移缩小，残留旧 offset 会把视口
 *      滚过内容末端，露出一片空白。
 *   2. 内容外层必须 `flexShrink={0}`：否则 Yoga 把内容压进视口高度里，
 *      内容永远不比视口高，就没得滚了。
 */
export function ScrollView({
  height,
  scroll,
  onScroll,
  children,
}: {
  /** 固定高度（行）。省略时用 flexGrow 让 Yoga 分配剩余空间 */
  height?: number;
  scroll: ScrollState;
  /** 需要修正滚动状态时回传（跟随贴底 / resize 后保位置） */
  onScroll?: (next: ScrollState) => void;
  /**
   * 内容。可以是函数形式 `({ scrollTop, viewportRows }) => ReactNode`——
   * 这样内容能知道自己该渲染哪一段（虚拟滚动用），避免把全部历史都塞进树里。
   */
  children:
    | React.ReactNode
    | ((info: { scrollTop: number; viewportRows: number }) => React.ReactNode);
}) {
  const viewportRef = useRef(null);
  const contentRef = useRef(null);
  const { clientHeight, hasMeasured: viewportMeasured } = useBoxMetrics(viewportRef);
  const content = useBoxMetrics(contentRef);

  // 视口高度变化（终端 resize / 面板出现消失）→ 修正距底行数，保持用户看到的内容不跳。
  // 这是新架构相对旧实现的核心优势：旧实现只能祈祷 ink 擦对位置，这里可以主动补偿。
  const lastHeightRef = useRef<number | null>(null);
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;
  const scrollRef = useRef(scroll);
  scrollRef.current = scroll;

  useEffect(() => {
    if (!viewportMeasured || clientHeight <= 0) return;
    const prev = lastHeightRef.current;
    lastHeightRef.current = clientHeight;
    if (prev === null || prev === clientHeight) return;
    const next = adjustForResize(scrollRef.current, clientHeight - prev);
    if (next !== scrollRef.current) onScrollRef.current?.(next);
  }, [clientHeight, viewportMeasured]);

  /**
   * 收敛超限的滚动位置。
   *
   * `scrollUp` 只做 `fromBottom += lines`，不知道内容有多高——所以长按/连滚上滚时
   * `fromBottom` 会一路涨到远超真实上限（实测：内容只能滚 240 行，fromBottom 却到了 900）。
   * 视觉上没问题（`scrollTopFor` 会把 offset clamp 回合法区间），但**用户体验是坏的**：
   * 上滚时前面一大段是"空转"，之后往下滚要还这笔债——按很久才动一下，
   * 这正是"来回滚动感觉不灵敏"的直接原因。
   *
   * 这里在容积确定后主动把 fromBottom 收回真实上限，让它永远等于"实际的距底行数"。
   * 依赖 `content.height` 与 `clientHeight`，二者都由 useBoxMetrics 实测，已含虚拟滚动的占位高度。
   */
  useEffect(() => {
    if (!content.hasMeasured || clientHeight <= 0) return;
    const realMax = maxScrollTop(content.height, clientHeight);
    const cur = scrollRef.current;
    // 跟随态由别的 effect 管；这里只管"超限但仍在手动滚动"的情形
    if (cur.following || cur.fromBottom <= realMax) return;
    onScrollRef.current?.({ fromBottom: realMax, following: realMax === 0 });
  }, [content.height, content.hasMeasured, clientHeight]);

  // 内容长高（新消息/工具块）→ 若仍在跟随态，继续贴底。
  //
  // 注意：只在**真的需要**时调用（fromBottom > 0 且 following）。若不加这个条件，
  // 虚拟滚动导致的 content.height 微变会反复触发 scrollToBottom（每次都是新对象），
  // 造成持续重渲染。scrollToBottom 返回常量形状的对象，但 fromBottom 已是 0 时
  // 调用等于空转，必须提前返回。
  useEffect(() => {
    const cur = scrollRef.current;
    if (!cur.following || cur.fromBottom === 0 || !content.hasMeasured) return;
    onScrollRef.current?.(scrollToBottom());
  }, [content.height, content.hasMeasured]);

  const viewportH = height ?? clientHeight;
  /**
   * 滚动偏移。
   *
   * ## 为什么死循环曾发生在这里
   *
   * 原实现把 `clamp(offset, 0, max)` 同时用于 `contentOffsetY` **和** 传给 children
   * 的 `scrollTop`。而 children（虚拟滚动）按 scrollTop 决定渲染哪几条，
   * 渲染出来的内容高度又反过来影响 `max`/`offset`：
   *
   *   offset → children 渲染窗口 → content.height 变 → offset 重算 → children …
   *
   * 虚拟滚动的占位高度是**估算**的，与实际渲染有偏差，于是每轮算出的 offset
   * 都略有不同，形成永不收敛的渲染循环——表现就是来回滚动时卡死。
   *
   * ## 现在的做法
   *
   * 让**滚动位置的唯一真源是 `scroll.fromBottom`**（用户意图），不再混入实测高度：
   *   - contentOffsetY 用实测高度 clamp（保证不滚过内容末端）
   *   - 但传给 children 的 scrollTop 用**请求值**（fromBottom 反推），不随实测高度抖动
   *
   * 这样 children 的渲染窗口只跟着用户操作变，不跟着自己的渲染结果变，闭环被打断。
   */
  const measuredMax = maxScrollTop(content.height, viewportH);
  const requestedOffset = scrollTopFor(scroll.fromBottom, content.height, viewportH);
  const offset = clamp(requestedOffset, 0, measuredMax);

  return (
    <Box
      ref={viewportRef}
      {...(height !== undefined ? { height } : { flexGrow: 1, flexShrink: 1 })}
      overflow="hidden"
      contentOffsetY={offset}
      flexDirection="column"
    >
      {/* flexShrink=0：保持内容自然高度才能溢出并滚动（否则被压进视口，无内容可滚） */}
      <Box ref={contentRef} flexDirection="column" flexShrink={0}>
        {typeof children === 'function'
          ? // scrollTop 传请求值（基于 fromBottom，不依赖实测高度），打断反馈环
            children({ scrollTop: requestedOffset, viewportRows: viewportH })
          : children}
      </Box>
    </Box>
  );
}
