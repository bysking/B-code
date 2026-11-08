import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion, useInView } from 'motion/react';

/**
 * §0 双轨竞速 —— 同一个任务,两种工具,同时开跑。
 *
 * 想表达的核心不是「谁步骤少」,而是**谁需要你动手**:
 *   聊天机器人:AI 跑到「生成代码」就到边界了,剩下复制/粘贴/保存/跑测试全是你的活。
 *   Agent:整条链路都在它手里,中间没有一步等你。
 *
 * 所以两条轨道的单元格节奏不同(AI 快、人慢),跑完的时间差本身就是论点。
 * 每个单元格标注执行者(AI / 你),跑完后各自统计「你需要动手几次」。
 */

type Actor = 'ai' | 'human';

interface Cell {
  label: string;
  actor: Actor;
}

interface Lane {
  id: 'chat' | 'agent';
  title: string;
  subtitle: string;
  cells: Cell[];
  outcome: string;
  outcomeTone: 'amber' | 'green';
}

/** 每档节奏(毫秒)。AI 快、人慢 —— 时间差就是论据。 */
const DUR: Record<Actor, number> = { ai: 520, human: 1100 };

const LANES: Lane[] = [
  {
    id: 'chat',
    title: '聊天机器人',
    subtitle: 'AI 走到「生成代码」就到边界',
    cells: [
      { label: '收到问题', actor: 'ai' },
      { label: '生成一段代码', actor: 'ai' },
      { label: '复制、粘贴', actor: 'human' },
      { label: '保存文件', actor: 'human' },
      { label: '跑测试', actor: 'human' },
    ],
    outcome: '还是挂的?回到第一步,继续由你传动',
    outcomeTone: 'amber',
  },
  {
    id: 'agent',
    title: 'Agent(自主执行)',
    subtitle: '整条链路都在它手里',
    cells: [
      { label: '读 package.json', actor: 'ai' },
      { label: '跑 bun test', actor: 'ai' },
      { label: '读报错文件', actor: 'ai' },
      { label: '改代码', actor: 'ai' },
      { label: '再跑测试', actor: 'ai' },
    ],
    outcome: '通过了 —— 中间没有一步等你',
    outcomeTone: 'green',
  },
];

/** 累计时刻表:第 i 格的结束时间 */
function timeline(cells: Cell[]) {
  let acc = 0;
  const ends: number[] = [];
  for (const c of cells) {
    acc += DUR[c.actor];
    ends.push(acc);
  }
  return { ends, total: acc };
}

const TL = LANES.map((l) => timeline(l.cells));
const MAX_TOTAL = Math.max(...TL.map((t) => t.total));

const ACTOR_STYLE: Record<Actor, { fg: string; bg: string; line: string; label: string }> = {
  ai: { fg: 'var(--accent-text)', bg: 'var(--accent-bg)', line: 'var(--accent-line)', label: 'AI' },
  human: { fg: 'var(--amber)', bg: 'var(--amber-bg)', line: 'var(--amber-line)', label: '你' },
};

export function RaceComparison() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: '-100px' });
  const [t, setT] = useState(0);
  const [running, setRunning] = useState(false);

  // 首次进入视口自动开跑;减少动效时直接给终态
  useEffect(() => {
    if (!inView) return;
    if (reduce) {
      setT(MAX_TOTAL);
      return;
    }
    setT(0);
    setRunning(true);
  }, [inView, reduce]);

  useEffect(() => {
    if (!running) return;
    if (t >= MAX_TOTAL) {
      setRunning(false);
      return;
    }
    const id = window.setTimeout(() => setT((v) => Math.min(v + 60, MAX_TOTAL)), 60);
    return () => window.clearTimeout(id);
  }, [running, t]);

  const replay = () => {
    setT(0);
    setRunning(true);
  };

  return (
    <div ref={ref}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.7rem',
          marginBottom: '0.9rem',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: '0.86rem', color: 'var(--text-dim)' }}>
          同一个任务:<strong>「这个 bug 帮我修一下」</strong>
        </span>
        <button
          className="btn btn-sm btn-ghost"
          onClick={replay}
          disabled={running}
          style={{ marginLeft: 'auto' }}
        >
          ⟲ 重放
        </button>
      </div>

      <div style={{ display: 'grid', gap: '0.9rem' }}>
        {LANES.map((lane, li) => {
          const tl = TL[li]!;
          const done = t >= tl.total;
          // 当前在第几格(0-based);已完成则停在最后一格
          let idx = tl.ends.findIndex((e) => t < e);
          if (idx === -1) idx = lane.cells.length - 1;
          const started = t > 0;
          const handCount = lane.cells.filter((c) => c.actor === 'human').length;

          return (
            <div
              key={lane.id}
              style={{
                border: `1px solid ${done ? (lane.outcomeTone === 'green' ? 'var(--green-line)' : 'var(--amber-line)') : 'var(--border)'}`,
                borderRadius: 'var(--radius-lg)',
                background: 'var(--bg-raised)',
                padding: '0.85rem 0.95rem',
                boxShadow: 'var(--shadow-sm)',
                transition: 'border-color 0.3s',
              }}
            >
              {/* 轨道头 */}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', marginBottom: '0.7rem' }}>
                <span
                  style={{
                    fontSize: '0.92rem',
                    fontWeight: 650,
                    color: lane.id === 'agent' ? 'var(--accent-text)' : 'var(--text)',
                  }}
                >
                  {lane.title}
                </span>
                <span style={{ fontSize: '0.76rem', color: 'var(--text-faint)' }}>{lane.subtitle}</span>
                <span
                  style={{
                    marginLeft: 'auto',
                    fontFamily: 'var(--mono)',
                    fontSize: '0.72rem',
                    color: done
                      ? lane.outcomeTone === 'green'
                        ? 'var(--green)'
                        : 'var(--amber)'
                      : 'var(--text-faint)',
                  }}
                >
                  {done ? `用时 ${(tl.total / 1000).toFixed(1)}s` : '进行中…'}
                </span>
              </div>

              {/* 轨道 —— 用 grid 而不是绝对定位引导线,避免线条穿过格子 */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${lane.cells.length}, minmax(0, 1fr))`,
                  gap: '0.35rem',
                  alignItems: 'stretch',
                }}
              >
                {lane.cells.map((cell, ci) => {
                  const passed = started && (t >= tl.ends[ci]! || ci < idx);
                  const isCurrent = started && ci === idx && !done;
                  const st = ACTOR_STYLE[cell.actor];
                  const active = passed || isCurrent;

                  return (
                    <div
                      key={cell.label}
                      style={{
                        position: 'relative',
                        border: `1px solid ${active ? st.line : 'var(--border)'}`,
                        background: active ? st.bg : 'var(--bg-raised)',
                        borderRadius: 7,
                        padding: '0.45rem 0.3rem 0.35rem',
                        textAlign: 'center',
                        transition: 'background 0.25s, border-color 0.25s, opacity 0.25s',
                        opacity: started && !active ? 0.5 : 1,
                        boxShadow: isCurrent ? `0 0 0 2px ${st.bg}` : 'none',
                      }}
                    >
                      {/* 当前格底部进度条(放在格内,不越界) */}
                      <div
                        aria-hidden="true"
                        style={{
                          position: 'absolute',
                          bottom: 0,
                          left: 0,
                          right: 0,
                          height: 2,
                          borderRadius: '0 0 7px 7px',
                          background: st.fg,
                          opacity: isCurrent ? 1 : 0,
                          transition: 'opacity 0.2s',
                        }}
                      />
                      <div
                        style={{
                          fontSize: '0.74rem',
                          color: active ? st.fg : 'var(--text-dim)',
                          fontWeight: isCurrent ? 650 : 500,
                          lineHeight: 1.4,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                        title={cell.label}
                      >
                        {cell.label}
                      </div>
                      <div
                        style={{
                          fontFamily: 'var(--mono)',
                          fontSize: '0.6rem',
                          color: active ? st.fg : 'var(--text-faint)',
                          opacity: 0.8,
                          marginTop: 1,
                        }}
                      >
                        {cell.actor === 'ai' ? 'AI' : '你'}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* 边界提示:聊天机器人在「生成代码」之后就交还给用户了 */}
              {lane.id === 'chat' && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.45rem',
                    marginTop: '0.55rem',
                    fontSize: '0.72rem',
                    color: 'var(--text-faint)',
                    fontFamily: 'var(--mono)',
                  }}
                >
                  <span
                    style={{
                      flex: '0 0 40%',
                      textAlign: 'right',
                      color: 'var(--accent-text)',
                      opacity: started ? 1 : 0.4,
                      transition: 'opacity 0.3s',
                    }}
                  >
                    ← AI 的边界
                  </span>
                  <span
                    aria-hidden="true"
                    style={{
                      width: 1,
                      height: 12,
                      background: 'var(--amber-line)',
                    }}
                  />
                  <span style={{ color: 'var(--amber)', opacity: started ? 1 : 0.4, transition: 'opacity 0.3s' }}>
                    你的活 →
                  </span>
                </div>
              )}

              {/* 结果行 */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.6rem',
                  marginTop: '0.6rem',
                  minHeight: '1.4rem',
                }}
              >
                {done ? (
                  <motion.span
                    initial={reduce ? false : { opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25 }}
                    style={{
                      fontSize: '0.82rem',
                      color: lane.outcomeTone === 'green' ? 'var(--green)' : 'var(--amber)',
                    }}
                  >
                    {lane.outcomeTone === 'green' ? '✓ ' : '⚠ '}
                    {lane.outcome}
                  </motion.span>
                ) : (
                  <span style={{ fontSize: '0.82rem', color: 'var(--text-faint)' }}>…</span>
                )}

                {done && (
                  <motion.span
                    initial={reduce ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.3, delay: 0.15 }}
                    style={{
                      marginLeft: 'auto',
                      fontFamily: 'var(--mono)',
                      fontSize: '0.74rem',
                      padding: '0.1em 0.55em',
                      borderRadius: 999,
                      border: `1px solid ${handCount === 0 ? 'var(--green-line)' : 'var(--amber-line)'}`,
                      background: handCount === 0 ? 'var(--green-bg)' : 'var(--amber-bg)',
                      color: handCount === 0 ? 'var(--green)' : 'var(--amber)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    你需要动手 {handCount} 次
                  </motion.span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
