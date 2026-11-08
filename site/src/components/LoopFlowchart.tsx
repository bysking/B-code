import { motion, useReducedMotion } from 'motion/react';

/**
 * 核心循环流程图 —— 照 docs/SHARING.md §1 的 ASCII 图重建为带边的有向图。
 *
 * 图结构与原文一一对应:
 *   1 把消息发给模型 → 2 模型决定要不要用工具
 *      ├─ 2.1 要用工具 → 3 执行工具、结果喂回 → 回到 1
 *      └─ 2.2 不用工具 → 4 任务结束,把回答交给用户
 *
 * 每条边独立高亮,所以「现在走到哪条边」是可读的,而不是靠文字描述。
 */

export type FlowNodeId = 'n1' | 'n2' | 'n3' | 'n4';
export type FlowEdgeId = 'e1' | 'e2' | 'e3' | 'e4';

/**
 * 节点几何(viewBox 坐标系)。
 * 单行节点 h=52,双行节点 h=64 —— 副标题必须有独立行,不能和主标题重叠。
 */
const NODES: Record<FlowNodeId, { x: number; y: number; w: number; h: number; lines: string[]; sub?: string }> = {
  n1: { x: 220, y: 16, w: 260, h: 52, lines: ['1  把消息发给模型'] },
  n2: { x: 220, y: 118, w: 260, h: 52, lines: ['2  模型决定要不要用工具'] },
  n3: { x: 62, y: 244, w: 258, h: 64, lines: ['3  执行工具、结果喂回'], sub: '结果回到第 1 步' },
  n4: { x: 386, y: 244, w: 252, h: 64, lines: ['4  任务结束'], sub: '把回答交给用户' },
};

/** 主干分叉的 y 坐标 */
const SPLIT_Y = 208;

/** 边的路径。e2/e3 共用一段主干,分别包含它是为了让各自高亮时主干也亮。 */
const EDGES: Record<FlowEdgeId, { d: string; label: string; labelXY: [number, number]; anchor: 'start' | 'end' }> = {
  e1: { d: 'M 350 68 L 350 112', label: '', labelXY: [350, 90], anchor: 'start' },
  e2: {
    d: `M 350 170 L 350 ${SPLIT_Y} L 191 ${SPLIT_Y} L 191 238`,
    label: '2.1 要用工具',
    labelXY: [176, 197],
    anchor: 'end',
  },
  e3: {
    d: `M 350 170 L 350 ${SPLIT_Y} L 512 ${SPLIT_Y} L 512 238`,
    label: '2.2 不用工具',
    labelXY: [527, 197],
    anchor: 'start',
  },
  e4: {
    d: 'M 62 276 L 22 276 L 22 42 L 214 42',
    label: '回到 1',
    labelXY: [30, 165],
    anchor: 'start',
  },
};

interface Props {
  /** 当前所在的节点 */
  activeNode: FlowNodeId | null;
  /** 当前正在走的那条边 */
  activeEdge: FlowEdgeId | null;
  /** 已经走过的节点 / 边 */
  visitedNodes: FlowNodeId[];
  visitedEdges: FlowEdgeId[];
  /** 是否已结束(让 n4 呈完成态) */
  ended?: boolean;
}

export function LoopFlowchart({ activeNode, activeEdge, visitedNodes, visitedEdges, ended }: Props) {
  const reduce = useReducedMotion();
  const vN = new Set(visitedNodes);
  const vE = new Set(visitedEdges);

  return (
    <svg
      viewBox="0 0 700 322"
      role="img"
      aria-label="Agent 核心循环流程图:把消息发给模型,模型决定是否用工具;要用工具则执行后回到第一步,不用工具则任务结束"
      style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
    >
      <defs>
        <marker id="lf-arrow-muted" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border-strong)" />
        </marker>
        <marker id="lf-arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
        </marker>
        <marker id="lf-arrow-visited" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent-line)" />
        </marker>
      </defs>

      {/* ── 边 ── */}
      {(Object.keys(EDGES) as FlowEdgeId[]).map((id) => {
        const e = EDGES[id];
        const isActive = activeEdge === id;
        const isVisited = vE.has(id);

        const stroke = isActive
          ? 'var(--accent)'
          : isVisited
            ? 'var(--accent-line)'
            : 'var(--border-strong)';
        const width = isActive ? 2.5 : 1.6;
        const marker = isActive
          ? 'url(#lf-arrow-active)'
          : isVisited
            ? 'url(#lf-arrow-visited)'
            : 'url(#lf-arrow-muted)';

        return (
          <g key={id}>
            {/* 已走过的边:淡描边,表示轨迹 */}
            <path d={e.d} fill="none" stroke={stroke} strokeWidth={width} markerEnd={marker} />

            {/* 活跃边:叠一层流动虚线表示方向 */}
            {isActive && !reduce && (
              <path
                d={e.d}
                fill="none"
                stroke="#ffffff"
                strokeWidth={2.5}
                strokeLinecap="round"
                className="lf-flow"
              />
            )}

            {e.label && (
              <text
                x={e.labelXY[0]}
                y={e.labelXY[1]}
                textAnchor={e.anchor}
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  fill: isActive ? 'var(--accent-text)' : isVisited ? 'var(--text-dim)' : 'var(--text-faint)',
                  fontWeight: isActive ? 700 : 400,
                }}
              >
                {e.label}
              </text>
            )}
          </g>
        );
      })}

      {/* ── 节点 ── */}
      {(Object.keys(NODES) as FlowNodeId[]).map((id) => {
        const n = NODES[id];
        const isActive = activeNode === id;
        const isVisited = vN.has(id);
        const isEnd = id === 'n4' && ended;

        // 结束态优先于 active:n4 只会在「任务结束」那一步被激活,
        // 若让 isActive 覆盖 isEnd,绿色完成态就永远不可能出现。
        const fill = isEnd
          ? 'var(--green-bg)'
          : isActive
            ? 'var(--accent-bg)'
            : isVisited
              ? 'var(--bg-subtle)'
              : 'var(--bg-raised)';
        const stroke = isEnd
          ? 'var(--green)'
          : isActive
            ? 'var(--accent)'
            : isVisited
              ? 'var(--accent-line)'
              : 'var(--border-strong)';

        return (
          <g key={id}>
            {isActive && (
              <rect
                x={n.x - 4}
                y={n.y - 4}
                width={n.w + 8}
                height={n.h + 8}
                rx={11}
                fill="none"
                stroke="var(--accent)"
                strokeWidth={1}
                opacity={0.35}
              />
            )}
            <motion.rect
              animate={{ fill, stroke }}
              transition={{ duration: reduce ? 0 : 0.2 }}
              x={n.x}
              y={n.y}
              width={n.w}
              height={n.h}
              rx={8}
              strokeWidth={isActive ? 2 : 1.2}
            />
            {n.lines.map((line, i) => (
              <text
                key={line}
                x={n.x + n.w / 2}
                y={n.y + (n.sub ? 27 + i * 16 : n.h / 2 + 5)}
                textAnchor="middle"
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 13,
                  fontWeight: isActive || isEnd ? 700 : 500,
                  fill: isEnd ? 'var(--green)' : isActive ? 'var(--accent-text)' : 'var(--text)',
                }}
              >
                {line}
              </text>
            ))}
            {n.sub && (
              <text
                x={n.x + n.w / 2}
                y={n.y + 51}
                textAnchor="middle"
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  fill: isActive ? 'var(--accent-text)' : 'var(--text-faint)',
                  opacity: 0.85,
                }}
              >
                {n.sub}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
