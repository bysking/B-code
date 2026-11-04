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
  children: React.ReactNode;
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

  // 内容长高（新消息/工具块）→ 若仍在跟随态，继续贴底
  useEffect(() => {
    const cur = scrollRef.current;
    if (!cur.following || cur.fromBottom === 0 || !content.hasMeasured) return;
    onScrollRef.current?.(scrollToBottom());
  }, [content.height, content.hasMeasured]);

  const viewportH = height ?? clientHeight;
  const offset = scrollTopFor(scroll.fromBottom, content.height, viewportH);
  const max = maxScrollTop(content.height, viewportH);

  return (
    <Box
      ref={viewportRef}
      {...(height !== undefined ? { height } : { flexGrow: 1, flexShrink: 1 })}
      overflow="hidden"
      contentOffsetY={clamp(offset, 0, max)}
      flexDirection="column"
    >
      {/* flexShrink=0：保持内容自然高度才能溢出并滚动（否则被压进视口，无内容可滚） */}
      <Box ref={contentRef} flexDirection="column" flexShrink={0}>
        {children}
      </Box>
    </Box>
  );
}
