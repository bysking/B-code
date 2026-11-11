import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { LoopFlowchart, type FlowEdgeId, type FlowNodeId } from './LoopFlowchart';

/**
 * Agent 循环模拟器 —— 把 §1 的流程图变成可单步执行的轨迹。
 *
 * 每一步都要说清两件事:
 *   1. 现在停在哪个节点(高亮节点)
 *   2. 是哪条边把它送过来的(高亮边 + 边上的标签)
 * 所以流程图的节点与边都必须独立可寻址 —— 这正是把原 ASCII 图
 * 拆成 n1..n4 + e1..e4 的原因。
 *
 * 脚本化而非真实调模型:每一轮的「模型决策」是预设的,但轨迹形状来自一次
 * 真实任务(读 package.json → 跑测试 → 读文件 → 改代码 → 再跑测试 → 结束)。
 */

type ToolName = 'read_file' | 'run_shell' | 'edit_file';

interface Turn {
  text?: string;
  call?: { tool: ToolName; input: string };
  result?: string;
}

const SCRIPT: Turn[] = [
  {
    text: '先看看项目用什么测试框架。',
    call: { tool: 'read_file', input: '{"path":"package.json"}' },
    result: '{ "scripts": { "test": "bun test" }, ... }',
  },
  {
    text: '用 bun test。跑一下看哪个挂了。',
    call: { tool: 'run_shell', input: '{"command":"bun test"}' },
    result: '1 fail: auth.test.ts > rejects expired token',
  },
  {
    text: '读报错的那个文件。',
    call: { tool: 'read_file', input: '{"path":"src/auth.ts"}' },
    result: 'export function verify(t: string) { ... }',
  },
  {
    text: '过期判断用错了边界,改成 >=。',
    call: { tool: 'edit_file', input: '{"path":"src/auth.ts","old_string":"exp < now","new_string":"exp <= now"}' },
    result: 'edited src/auth.ts (+1 −1)',
  },
  {
    text: '再跑一次确认。',
    call: { tool: 'run_shell', input: '{"command":"bun test"}' },
    result: '578 pass, 0 fail',
  },
  {
    text: '修好了 —— 过期 token 的边界判断写反了,已改为 `exp <= now`,全部测试通过。',
  },
];

interface HistoryItem {
  kind: 'user' | 'assistant' | 'tool';
  label: string;
  body: string;
}

/**
 * 一步 = 停在某节点 + 沿某条边而来。
 * edge 为 null 表示「刚进入」,还没有边。
 */
interface Step {
  node: FlowNodeId;
  edge: FlowEdgeId | null;
  /** 这一步在转录里新增了什么 */
  history?: HistoryItem[];
  /** 状态栏说明 */
  note: string;
  noteTone: 'accent' | 'green' | 'amber' | 'dim';
  /** 是否为本轮最后一步(用于 n4 完成态) */
  ended?: boolean;
}

/** 把脚本展开成线性步骤序列:e1 进 n2 → 每个 turn 的 e2→n3 → e4 回 n1 → 最后 e3→n4 */
function buildSteps(): Step[] {
  const steps: Step[] = [];

  // 起点
  steps.push({
    node: 'n1',
    edge: null,
    history: [{ kind: 'user', label: 'user', body: '这个项目的测试挂了,帮我看看' }],
    note: '历史消息 + 可用工具清单,一起发给模型。',
    noteTone: 'accent',
  });

  steps.push({
    node: 'n2',
    edge: 'e1',
    note: '请求发出去了。现在轮到模型读上一步的结果。',
    noteTone: 'accent',
  });

  SCRIPT.forEach((turn, i) => {
    const hasTool = Boolean(turn.call);

    // 模型决策:有工具调用 → 走 e2
    steps.push({
      node: 'n2',
      edge: null,
      history: [
        ...(turn.text ? [{ kind: 'assistant' as const, label: 'assistant', body: turn.text }] : []),
        ...(turn.call
          ? [{ kind: 'assistant' as const, label: `tool_use · ${turn.call.tool}`, body: turn.call.input }]
          : []),
      ],
      note: hasTool
        ? `回复里有工具调用 → 走 2.1,执行 ${turn.call!.tool}。`
        : '回复里没有工具调用 → 走 2.2,循环结束。',
      noteTone: hasTool ? 'amber' : 'green',
    });

    if (!hasTool) {
      // 2.2 不用工具 → n4 结束
      steps.push({
        node: 'n4',
        edge: 'e3',
        note: '模型认为完事了 —— 任务结束,把回答交给用户。',
        noteTone: 'green',
        ended: true,
      });
      return;
    }

    // 2.1 要用工具 → n3 执行
    steps.push({
      node: 'n3',
      edge: 'e2',
      history: turn.result
        ? [{ kind: 'tool' as const, label: 'tool_result', body: turn.result }]
        : [],
      note: '工具执行完,结果 push 进历史消息 —— 它将成为下一轮的输入。',
      noteTone: 'green',
    });

    // 回到 1(最后一轮之后由 e3 结束,不再回)
    if (i < SCRIPT.length - 1) {
      steps.push({
        node: 'n1',
        edge: 'e4',
        note: `回到第 1 步 —— 带着新的历史(<b>${steps.filter((s) => s.history).length + 1}</b> 条)重来一轮。`,
        noteTone: 'accent',
      });
    }
  });

  return steps;
}

const STEPS = buildSteps();
const MAX_STEP = STEPS.length;

/** 伪代码 ↔ 节点映射:高亮哪行伪代码 */
function pseudoLinesFor(node: FlowNodeId, edge: FlowEdgeId | null) {
  return {
    while: node === 'n2' || edge === 'e1',
    call: node === 'n1' && edge !== 'e4' ? false : node === 'n1' || edge === 'e1',
    check: node === 'n2',
    exec: node === 'n3',
    push: node === 'n3',
  };
}

export function LoopSimulator() {
  /** 已推进到第几步(0 = 未开始,显示起点) */
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const reduce = useReducedMotion();
  const timer = useRef<number | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const done = step >= MAX_STEP;
  const cur = step === 0 ? null : STEPS[step - 1]!;

  // 累计历史(所有已执行步骤的 history 拼接)
  const history = useMemo<HistoryItem[]>(() => {
    const out: HistoryItem[] = [];
    for (let i = 0; i < step; i++) {
      const s = STEPS[i]!;
      if (s.history) out.push(...s.history);
    }
    return out;
  }, [step]);

  // 已访问的节点与边
  const { visitedNodes, visitedEdges } = useMemo(() => {
    const vn = new Set<FlowNodeId>();
    const ve = new Set<FlowEdgeId>();
    for (let i = 0; i < step; i++) {
      const s = STEPS[i]!;
      vn.add(s.node);
      if (s.edge) ve.add(s.edge);
    }
    return { visitedNodes: [...vn], visitedEdges: [...ve] };
  }, [step]);

  // 新消息进来时自动滚到底 —— 左图右消息并排时,不滚就见不到最新那条
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history.length]);

  useEffect(() => {
    if (!playing) return;
    if (done) {
      setPlaying(false);
      return;
    }
    timer.current = window.setTimeout(() => setStep((s) => s + 1), reduce ? 120 : 1100);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [playing, step, done, reduce]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      setPlaying(false);
      setStep((s) => Math.min(s + 1, MAX_STEP));
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setPlaying(false);
      setStep((s) => Math.max(s - 1, 0));
    }
  };

  const kindStyle: Record<HistoryItem['kind'], { color: string; border: string }> = {
    user: { color: 'var(--text)', border: 'var(--border-strong)' },
    assistant: { color: 'var(--accent-text)', border: 'var(--accent-line)' },
    tool: { color: 'var(--green)', border: 'var(--green-line)' },
  };

  const noteColor = {
    accent: 'var(--accent-text)',
    green: 'var(--green)',
    amber: 'var(--amber)',
    dim: 'var(--text-faint)',
  };

  const pseudo = cur ? pseudoLinesFor(cur.node, cur.edge) : null;

  return (
    <div
      tabIndex={0}
      onKeyDown={onKey}
      role="group"
      aria-label="Agent 核心循环流程图模拟器。使用左右方向键单步。"
      style={{
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--bg-raised)',
        overflow: 'hidden',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      {/* 控制栏 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          flexWrap: 'wrap',
          padding: '0.7rem 0.95rem',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-subtle)',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: '0.72rem',
            color: 'var(--text-faint)',
            marginRight: 'auto',
          }}
        >
          步骤 {step}/{MAX_STEP}
          {cur?.edge && (
            <span style={{ color: 'var(--accent-text)' }}> · 沿 {cur.edge.toUpperCase()}</span>
          )}
        </span>
        <button
          className="btn btn-sm"
          onClick={() => {
            setPlaying(false);
            setStep((s) => Math.max(s - 1, 0));
          }}
          disabled={step === 0}
        >
          ← 上一步
        </button>
        <button
          className="btn btn-sm btn-primary"
          onClick={() => {
            setPlaying(false);
            setStep((s) => Math.min(s + 1, MAX_STEP));
          }}
          disabled={done}
        >
          下一步 →
        </button>
        <button
          className="btn btn-sm"
          onClick={() => setPlaying((p) => !p)}
          disabled={done}
          aria-pressed={playing}
        >
          {playing ? '⏸ 暂停' : '▶ 播放'}
        </button>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => {
            setPlaying(false);
            setStep(0);
          }}
          disabled={step === 0}
        >
          ⟲ 重置
        </button>
      </div>

      {/* 左:流程图(节点 + 边高亮 / 伪代码)  右:消息(状态说明 + 历史消息[])
          并排的目的:每按一次「下一步」,高亮的那条边和它新增的那条消息
          在同一屏里同时看得到,不需要上下滚动去对齐。 */}
      <div className="loop-cols">
        {/* ══ 左:流程图 ══ */}
        <div className="loop-left">
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: '24rem' }}>
              <LoopFlowchart
                activeNode={cur?.node ?? null}
                activeEdge={cur?.edge ?? null}
                visitedNodes={visitedNodes}
                visitedEdges={visitedEdges}
                ended={cur?.ended}
              />
            </div>
          </div>

          {/* 伪代码 */}
          <div>
            <div className="loop-label" style={{ marginBottom: '0.4rem' }}>
              伪代码
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: '0.74rem', lineHeight: 1.9 }}>
              {[
                { l: 'while (true) {', on: pseudo?.while },
                { l: '  回复 = 模型调用(...)', on: pseudo?.call },
                { l: '  if (没有工具调用) break', on: pseudo?.check },
                { l: '  结果 = 执行工具(...)', on: pseudo?.exec },
                { l: '  历史消息.push(结果)', on: pseudo?.push },
                { l: '}', on: false },
              ].map((row, i) => (
                <motion.div
                  key={i}
                  animate={{
                    backgroundColor: row.on ? 'rgba(37,99,235,0.09)' : 'rgba(255,255,255,0)',
                    color: row.on ? 'var(--accent-text)' : 'var(--text-faint)',
                  }}
                  transition={{ duration: reduce ? 0 : 0.2 }}
                  style={{
                    borderRadius: 3,
                    padding: '0 0.4rem',
                    whiteSpace: 'pre',
                    borderLeft: row.on ? '2px solid var(--accent)' : '2px solid transparent',
                  }}
                >
                  {row.l}
                </motion.div>
              ))}
            </div>
          </div>
        </div>

        {/* ══ 右:消息 ══ */}
        <div className="loop-right">
          {/* 当前状态说明 —— 紧贴消息列表上方,和它讲的是同一步 */}
          <div style={{ fontSize: '0.82rem', minHeight: '2.6rem' }}>
            <AnimatePresence mode="wait">
              <motion.div
                key={step}
                initial={reduce ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? undefined : { opacity: 0, y: -4 }}
                transition={{ duration: reduce ? 0 : 0.16 }}
              >
                {step === 0 ? (
                  <span style={{ color: 'var(--text-faint)' }}>
                    按「下一步」开始 —— 左边高亮当前节点和送它过来的那条边,右边同步长出新的消息。
                  </span>
                ) : (
                  <span style={{ color: noteColor[cur!.noteTone] }}>
                    <span
                      style={{ fontWeight: 700, fontFamily: 'var(--mono)', fontSize: '0.74rem' }}
                    >
                      节点 {cur!.node.slice(1)}
                    </span>
                    <span style={{ color: 'var(--text-faint)', margin: '0 0.5rem' }}>·</span>
                    <span
                      style={{ color: 'var(--text-dim)' }}
                      dangerouslySetInnerHTML={{ __html: cur!.note }}
                    />
                  </span>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* 历史消息 */}
          <div>
            <div className="loop-label" style={{ marginBottom: '0.4rem' }}>
              历史消息[] <span style={{ color: 'var(--accent-text)' }}>({history.length})</span>
            </div>
            <div className="loop-log" ref={logRef}>
              {history.map((h, i) => (
                <motion.div
                  key={i}
                  initial={reduce ? false : { opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: reduce ? 0 : 0.2 }}
                  style={{
                    borderLeft: `2px solid ${kindStyle[h.kind].border}`,
                    paddingLeft: '0.6rem',
                    fontSize: '0.76rem',
                    flexShrink: 0,
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--mono)',
                      color: kindStyle[h.kind].color,
                      fontSize: '0.66rem',
                      display: 'block',
                    }}
                  >
                    {h.label}
                  </span>
                  <span style={{ color: 'var(--text-dim)', wordBreak: 'break-word' }}>{h.body}</span>
                </motion.div>
              ))}
              {history.length === 0 && (
                <div style={{ fontSize: '0.76rem', color: 'var(--text-faint)' }}>
                  按「下一步」开始
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
