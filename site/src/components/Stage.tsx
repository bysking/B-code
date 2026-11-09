import { useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import type { Stage } from '../content/journey';

/**
 * 一个「时刻」—— 任务时间线上的一步。
 *
 * 三拍结构,顺序是刻意的:
 *   ① 发生了什么(具体到命令 / 文件 / 报错)
 *   ② 为什么此刻需要它(一句话,回答「不加会怎样」)
 *   ③ 深入看(展开才有组件细节)
 *
 * 这样读者先有场景再看到机制,而不是先被灌一段架构说明。
 */
export function StageBlock({
  stage,
  children,
  defaultOpen = false,
}: {
  stage: Stage;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const reduce = useReducedMotion();

  return (
    <section
      id={`stage-${stage.id}`}
      style={{ scrollMarginTop: '4.5rem', padding: '0 0 3.5rem 0' }}
      aria-labelledby={`stage-${stage.id}-h`}
    >
      {/* 时刻标记 + 事件 */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.85rem' }}>
        <motion.div
          initial={reduce ? false : { scale: 0.6, opacity: 0 }}
          whileInView={{ scale: 1, opacity: 1 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: reduce ? 0 : 0.3 }}
          style={{
            flexShrink: 0,
            width: '2rem',
            height: '2rem',
            borderRadius: 999,
            background: 'var(--accent-bg)',
            border: '1px solid var(--accent-line)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--mono)',
            fontSize: '0.78rem',
            fontWeight: 700,
            color: 'var(--accent-text)',
            marginTop: 2,
          }}
        >
          {stage.n}
        </motion.div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap' }}>
            {stage.module && (
              <span
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: '0.68rem',
                  fontWeight: 700,
                  color: 'var(--accent-text)',
                  background: 'var(--accent-bg)',
                  border: '1px solid var(--accent-line)',
                  borderRadius: 999,
                  padding: '0.05em 0.5em',
                }}
              >
                {stage.module} 登场
              </span>
            )}
          </div>

          {/* ① 发生了什么 */}
          <motion.h3
            id={`stage-${stage.id}-h`}
            initial={reduce ? false : { opacity: 0, y: 6 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: reduce ? 0 : 0.3, delay: reduce ? 0 : 0.05 }}
            style={{
              margin: '0.3rem 0 0.5rem',
              fontSize: '1.15rem',
              lineHeight: 1.5,
              letterSpacing: 0,
              color: 'var(--text-strong)',
            }}
          >
            {stage.event}
          </motion.h3>

          {/* ② 为什么此刻需要它 */}
          <p
            style={{
              margin: '0 0 1rem',
              fontSize: '0.95rem',
              color: 'var(--text-dim)',
              borderLeft: '2px solid var(--accent-line)',
              paddingLeft: '0.75rem',
            }}
          >
            {stage.why}
          </p>

          {/* ③ 深入看 */}
          {children && (
            <>
              <button
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-controls={`stage-${stage.id}-body`}
                className="btn btn-sm btn-ghost"
                style={{ marginBottom: open ? '1rem' : 0 }}
              >
                {open ? '收起细节' : '深入看这个模块 ↓'}
              </button>

              {open && (
                <motion.div
                  id={`stage-${stage.id}-body`}
                  initial={reduce ? false : { opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  transition={{ duration: reduce ? 0 : 0.28, ease: [0.4, 0, 0.2, 1] }}
                  style={{ overflow: 'hidden' }}
                >
                  <div style={{ paddingTop: '0.2rem' }}>{children}</div>
                </motion.div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
