import { useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { PAIN_POINTS } from '../content/knowledge';
import {
  PromptVisual,
  CheckpointVisual,
  SubagentVisual,
  EventsVisual,
  GoalVisual,
  AbortVisual,
} from './PainVisuals';
import { CompactionDemo } from './CompactionDemo';

/**
 * 七个痛点 —— 只在 PC 上做「侧栏选择 + 单条展示」。
 *
 * 原来七张卡片纵向平铺,总高 4283px,读者要滚很久才能看完;
 * 但真正的信息量并不大(每条 21~61 字)。所以问题在呈现方式,不在内容。
 * 改成左侧索引 + 右侧单条详情后,同一屏能看完一条的完整论证,
 * 且索引本身提供了「一共有哪些坑」的全景。
 */

const VISUALS: Record<string, React.ReactNode> = {
  prompt: <PromptVisual />,
  compaction: <CompactionDemo />,
  checkpoint: <CheckpointVisual />,
  subagent: <SubagentVisual />,
  events: <EventsVisual />,
  goal: <GoalVisual />,
  abort: <AbortVisual />,
};

const SHORT: Record<string, string> = {
  unstable: '表现不稳定',
  'context-full': '上下文会满',
  rewind: '改错了想反悔',
  subagent: '上下文会脏',
  visibility: '不知道在干嘛',
  goal: '不该问但需可控',
  abort: '中断响应要快',
};

export function PainPoints() {
  const [sel, setSel] = useState(0);
  const p = PAIN_POINTS[sel]!;
  const reduce = useReducedMotion();

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '15rem minmax(0, 1fr)',
        gap: '1.4rem',
        alignItems: 'start',
      }}
    >
      {/* 左:索引 */}
      <div
        style={{
          display: 'grid',
          gap: '0.25rem',
          position: 'sticky',
          top: '4.5rem',
        }}
      >
        {PAIN_POINTS.map((item, i) => {
          const on = i === sel;
          return (
            <button
              key={item.id}
              onClick={() => setSel(i)}
              aria-pressed={on}
              aria-controls="pain-detail"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.6rem',
                width: '100%',
                textAlign: 'left',
                padding: '0.5rem 0.65rem',
                borderRadius: 8,
                cursor: 'pointer',
                fontFamily: 'var(--sans)',
                fontSize: '0.84rem',
                border: `1px solid ${on ? 'var(--accent-line)' : 'var(--border)'}`,
                background: on ? 'var(--accent-bg)' : 'transparent',
                color: on ? 'var(--accent-text)' : 'var(--text-dim)',
                fontWeight: on ? 650 : 400,
                transition: 'all 0.16s',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: '0.68rem',
                  width: '1.1rem',
                  flexShrink: 0,
                  color: on ? 'var(--accent-text)' : 'var(--text-faint)',
                  fontWeight: 700,
                }}
              >
                {item.num}
              </span>
              <span style={{ lineHeight: 1.4 }}>{SHORT[item.id] ?? item.id}</span>
            </button>
          );
        })}

        <div
          style={{
            marginTop: '0.5rem',
            fontSize: '0.74rem',
            color: 'var(--text-faint)',
            lineHeight: 1.6,
            paddingLeft: '0.65rem',
            borderLeft: '2px solid var(--border)',
          }}
        >
          每加一个模块,
          <br />
          都要能回答它解决了
          <br />
          哪一个具体问题。
        </div>
      </div>

      {/* 右:详情 */}
      <div id="pain-detail">
        <AnimatePresence mode="wait">
          <motion.div
            key={p.id}
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: -8 }}
            transition={{ duration: reduce ? 0 : 0.2 }}
            className="card"
            style={{ padding: '1.3rem' }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: '0.65rem',
                marginBottom: '1rem',
                flexWrap: 'wrap',
              }}
            >
              <span className="section-num" style={{ fontSize: '0.72rem' }}>
                痛点 {p.num}
              </span>
              <h3 style={{ margin: 0, fontSize: '1.08rem' }}>{SHORT[p.id]}</h3>
              <span className="src-note" style={{ marginLeft: 'auto' }}>
                原文 {p.src}
              </span>
            </div>

            <TextField label="症状" text={p.symptom} fg="var(--red)" bg="var(--red-bg)" line="var(--red-line)" />
            <TextField label="成因" text={p.cause} fg="var(--amber)" bg="var(--amber-bg)" line="var(--amber-line)" />
            <TextField
              label="对策"
              text={p.solution}
              fg="var(--green)"
              bg="var(--green-bg)"
              line="var(--green-line)"
            />

            <div style={{ marginTop: '1rem' }}>{VISUALS[p.visual ?? 'events']}</div>

            <ul
              style={{
                margin: '1rem 0 0',
                paddingLeft: '1.15rem',
                fontSize: '0.85rem',
                color: 'var(--text-dim)',
                borderTop: '1px solid var(--border)',
                paddingTop: '0.8rem',
              }}
            >
              {p.keys.map((k) => (
                <li key={k} style={{ margin: '0.35em 0' }}>
                  {k}
                </li>
              ))}
            </ul>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

/** 一条带色带的三段说明(症状/成因/对策) */
function TextField({
  label,
  text,
  fg,
  bg,
  line,
}: {
  label: string;
  text: string;
  fg: string;
  bg: string;
  line: string;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '3rem minmax(0, 1fr)',
        alignItems: 'start',
        gap: '0.6rem',
        padding: '0.45rem 0.6rem',
        marginBottom: '0.35rem',
        borderRadius: 6,
        background: bg,
        border: `1px solid ${line}`,
      }}
    >
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontSize: '0.7rem',
          fontWeight: 700,
          color: fg,
          paddingTop: 2,
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: '0.85rem', color: 'var(--text-dim)' }}>{text}</span>
    </div>
  );
}
